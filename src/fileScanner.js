import { readdir, stat, readlink, readFile, writeFile, mkdir, unlink } from 'fs/promises';
import { join, relative, extname, resolve } from 'path';
import { homedir } from 'os';
import { createHash } from 'crypto';

// In-memory file tree cache keyed by root path
// Entry: { mtime: number, tree: TreeNode | null }
const treeCache = new Map();

// In-memory rendered HTML cache keyed by absolute file path
// Entry: { mtime: number, html: string }
const htmlCache = new Map();

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '__pycache__', 'dist', 'build', '.next', '.nuxt']);
const MD_EXTS    = new Set(['.md', '.markdown', '.mdown', '.mkd']);
export const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

// ---- Disk cache -----------------------------------------------------------
const TREE_CACHE_DIR = join(homedir(), '.mdexplorer', 'tree-cache');

function diskCachePath(rootPath) {
  const key = rootPath.toLowerCase().replace(/\\/g, '/');
  const hash = createHash('sha1').update(key).digest('hex');
  return join(TREE_CACHE_DIR, hash + '.json');
}

async function loadDiskCache(rootPath, mtime) {
  try {
    const raw = await readFile(diskCachePath(rootPath), 'utf8');
    const data = JSON.parse(raw);
    if (data.mtime === mtime) return data;
  } catch { /* miss or stale */ }
  return null;
}

function saveDiskCache(rootPath, data) {
  // Fire-and-forget: don't block the response
  mkdir(TREE_CACHE_DIR, { recursive: true })
    .then(() => writeFile(diskCachePath(rootPath), JSON.stringify(data), 'utf8'))
    .catch(() => {});
}

async function deleteDiskCache(rootPath) {
  try { await unlink(diskCachePath(rootPath)); } catch { /* ok if missing */ }
}

// ---- Public API -----------------------------------------------------------

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

  // 1. In-memory cache hit
  const cached = treeCache.get(rootPath);
  if (cached && cached.mtime === rootStat.mtimeMs) {
    return { tree: cached.tree, fileCount: cached.fileCount, warnings: cached.warnings };
  }

  // 2. Disk cache hit (survives server restarts)
  const disk = await loadDiskCache(rootPath, rootStat.mtimeMs);
  if (disk) {
    treeCache.set(rootPath, disk);
    return { tree: disk.tree, fileCount: disk.fileCount, warnings: disk.warnings };
  }

  // 3. Full scan
  const warnings = [];
  let fileCount = 0;

  const tree = await scanDir(rootPath, rootPath, rootPath, warnings, () => {
    fileCount++;
  });

  const result = { mtime: rootStat.mtimeMs, tree, fileCount, warnings };
  treeCache.set(rootPath, result);
  saveDiskCache(rootPath, result);   // persist for next server start
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

    if (name.startsWith('.')) continue;
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
        // path is omitted here — client reconstructs from currentRoot + relativePath
        files.push({ type: 'file', name, relativePath: relative(rootPath, fullPath) });
      } else if (IMAGE_EXTS.has(ext)) {
        files.push({ type: 'image', name, relativePath: relative(rootPath, fullPath) });
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

  const hasMd     = files.some((f) => f.type === 'file')   || dirs.some((d) => d.hasMd);
  const hasImages = files.some((f) => f.type === 'image')  || dirs.some((d) => d.hasImages);

  return {
    type: 'dir',
    name: relative(rootPath, dirPath) || '.',
    // path omitted — client reconstructs
    children: [...dirs, ...files],
    hasMd,
    hasImages,
  };
}

/**
 * Invalidate tree cache for a root path.
 * hard=true : also delete disk cache (used on explicit refresh / file operations)
 * hard=false: only clear in-memory cache (used on folder open — disk cache survives for next restart)
 */
export function invalidateCache(rootPath, { hard = false } = {}) {
  if (rootPath) {
    treeCache.delete(rootPath);
    if (hard) deleteDiskCache(rootPath);
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
