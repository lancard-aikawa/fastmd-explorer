import { readdir, stat, readlink } from 'fs/promises';
import { join, relative, extname, resolve } from 'path';

// In-memory file tree cache keyed by root path
// Entry: { mtime: number, tree: TreeNode | null }
const treeCache = new Map();

// In-memory rendered HTML cache keyed by absolute file path
// Entry: { mtime: number, html: string }
const htmlCache = new Map();

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.next', '.nuxt']);
const MD_EXTS    = new Set(['.md', '.markdown', '.mdown', '.mkd']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

/**
 * Scan a root directory for Markdown files recursively.
 * Returns the cached tree if the root mtime is unchanged.
 * @returns {{ tree: TreeNode|null, fileCount: number, warnings: string[] }}
 */
export async function scanMarkdownFiles(rootPath) {
  let rootStat;
  try {
    rootStat = await stat(rootPath);
  } catch (err) {
    throw new Error(`フォルダにアクセスできません: ${err.message}`);
  }

  const cached = treeCache.get(rootPath);
  if (cached && cached.mtime === rootStat.mtimeMs) {
    return { tree: cached.tree, fileCount: cached.fileCount, warnings: cached.warnings };
  }

  const warnings = [];
  let fileCount = 0;

  const tree = await scanDir(rootPath, rootPath, rootPath, warnings, () => {
    fileCount++;
  });

  treeCache.set(rootPath, { mtime: rootStat.mtimeMs, tree, fileCount, warnings });
  return { tree, fileCount, warnings };
}

async function scanDir(dirPath, rootPath, originalRoot, warnings, onFile) {
  let entries;
  try {
    entries = await readdir(dirPath, { withFileTypes: true });
  } catch {
    return null;
  }

  const dirEntries = [];
  const files = [];

  for (const entry of entries) {
    const name = entry.name;

    // Skip hidden directories (except .mdexplorer which holds our tags)
    if (name.startsWith('.') && name !== '.mdexplorer') continue;
    if (SKIP_DIRS.has(name)) continue;

    const fullPath = join(dirPath, name);

    if (entry.isSymbolicLink()) {
      // Resolve symlink and check if it crosses root boundary
      try {
        const resolved = resolve(await readlink(fullPath));
        const rel = relative(originalRoot, resolved);
        if (rel.startsWith('..') || rel.startsWith('/')) {
          warnings.push(`シンボリックリンクがルート外を指しています: ${relative(originalRoot, fullPath)} → ${resolved}`);
        }
      } catch { /* ignore unresolvable symlinks */ }
      continue;
    }

    if (entry.isDirectory()) {
      dirEntries.push(fullPath);
    } else if (entry.isFile()) {
      const ext = extname(name).toLowerCase();
      if (MD_EXTS.has(ext)) {
        onFile();
        files.push({ type: 'file', name, path: fullPath, relativePath: relative(rootPath, fullPath) });
      } else if (IMAGE_EXTS.has(ext)) {
        files.push({ type: 'image', name, path: fullPath, relativePath: relative(rootPath, fullPath) });
      }
    }
  }

  // Scan subdirectories in parallel
  const dirs = (await Promise.all(
    dirEntries.map((p) => scanDir(p, rootPath, originalRoot, warnings, onFile))
  )).filter(Boolean);

  if (dirs.length === 0 && files.length === 0) return null;

  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return {
    type: 'dir',
    name: relative(rootPath, dirPath) || '.',
    path: dirPath,
    children: [...dirs, ...files],
  };
}

/** Invalidate tree cache (and optionally html cache) for a root path */
export function invalidateCache(rootPath) {
  if (rootPath) {
    treeCache.delete(rootPath);
  } else {
    treeCache.clear();
    htmlCache.clear();
  }
}

/** Store rendered HTML in cache */
export function setCachedHtml(filePath, mtime, html) {
  htmlCache.set(filePath, { mtime, html });
}

/** Retrieve cached HTML if mtime matches */
export function getCachedHtml(filePath, mtime) {
  const cached = htmlCache.get(filePath);
  if (cached && cached.mtime === mtime) return cached.html;
  return null;
}
