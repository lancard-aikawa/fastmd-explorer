import express from 'express';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { readFile, writeFile, stat } from 'fs/promises';
import { join, dirname, relative, normalize } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import hljs from 'highlight.js';
import {
  scanMarkdownFiles,
  invalidateCache,
  getCachedHtml,
  setCachedHtml,
} from './fileScanner.js';
import { loadTags, updateFileTags } from './tagManager.js';
import { getConfig, addFolderToHistory } from './configManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);

// ---- Marked setup --------------------------------------------------------

marked.use(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight(code, lang) {
      if (lang === 'mermaid') return code; // handled by renderer
      const language = hljs.getLanguage(lang) ? lang : 'plaintext';
      return hljs.highlight(code, { language, ignoreIllegals: true }).value;
    },
  })
);

marked.use({
  renderer: {
    code({ text, lang }) {
      if (lang === 'mermaid') {
        // Escape only minimal chars so mermaid.js can parse it
        return `<div class="mermaid">${escHtml(text)}</div>\n`;
      }
      return false; // fall through to markedHighlight renderer
    },
  },
});

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Filesystem crossing detection ---------------------------------------

function detectFsCrossing(targetPath) {
  const warnings = [];

  if (process.platform === 'win32') {
    // Different drive letter
    const cwdDrive = process.cwd().slice(0, 2).toUpperCase();
    const tgtDrive = targetPath.slice(0, 2).toUpperCase();
    if (/^[A-Z]:$/.test(cwdDrive) && /^[A-Z]:$/.test(tgtDrive) && cwdDrive !== tgtDrive) {
      warnings.push(`ドライブが異なります (${cwdDrive} → ${tgtDrive})。アクセスが遅くなる可能性があります。`);
    }
    // UNC / network path
    if (targetPath.startsWith('\\\\') || targetPath.startsWith('//')) {
      warnings.push('ネットワークパスが検出されました。アクセスが遅くなる可能性があります。');
    }
    return warnings;
  }

  // Linux / macOS / WSL
  try {
    const version = readFileSync('/proc/version', 'utf8').toLowerCase();
    if (version.includes('microsoft')) {
      // Running in WSL
      if (targetPath.startsWith('/mnt/')) {
        warnings.push('WSL から Windows ファイルシステム (/mnt/...) へのアクセスが検出されました。I/O が著しく遅くなる場合があります。');
      }
    }
  } catch { /* not Linux/WSL */ }

  return warnings;
}

// ---- Security helper -----------------------------------------------------

function isAllowedPath(filePath, currentRoot) {
  if (!currentRoot) return false;
  const rel = relative(currentRoot, normalize(filePath));
  return !rel.startsWith('..') && !rel.startsWith('/') && !rel.startsWith('\\');
}

// ---- Server factory -------------------------------------------------------

export function createServer() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Static public files
  app.use(express.static(join(ROOT_DIR, 'public')));

  // Vendor: mermaid UMD bundle
  app.get('/vendor/mermaid.min.js', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'));
  });
  // Vendor: highlight.js CSS themes
  app.get('/vendor/hljs-light.css', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'highlight.js', 'styles', 'github.css'));
  });
  app.get('/vendor/hljs-dark.css', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'));
  });

  // -- State (per-process, single user) --
  let currentRoot = null;

  // GET /api/config
  app.get('/api/config', (_req, res) => {
    const config = getConfig();
    res.json({ ...config, currentRoot });
  });

  // POST /api/folder  { path }
  app.post('/api/folder', async (req, res) => {
    const rawPath = req.body?.path;
    if (!rawPath) return res.status(400).json({ error: 'path が必要です' });

    const folderPath = normalize(rawPath);
    try {
      const s = await stat(folderPath);
      if (!s.isDirectory()) return res.status(400).json({ error: 'ディレクトリではありません' });
    } catch {
      return res.status(400).json({ error: 'ディレクトリが見つかりません' });
    }

    const warnings = detectFsCrossing(folderPath);
    currentRoot = folderPath;
    invalidateCache(folderPath);
    const config = await addFolderToHistory(folderPath);

    res.json({ path: folderPath, warnings, config });
  });

  // GET /api/files
  app.get('/api/files', async (_req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    try {
      const [{ tree, fileCount, warnings }, tags] = await Promise.all([
        scanMarkdownFiles(currentRoot),
        loadTags(currentRoot),
      ]);
      res.json({ tree, fileCount, warnings, tags });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/preview?path=...
  app.get('/api/preview', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    try {
      const fileStat = await stat(filePath);
      const cached = getCachedHtml(filePath, fileStat.mtimeMs);
      if (cached) return res.json({ html: cached });

      const content = await readFile(filePath, 'utf8');
      const html = marked.parse(content);
      setCachedHtml(filePath, fileStat.mtimeMs, html);
      res.json({ html });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/file?path=...
  app.get('/api/file', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    try {
      const content = await readFile(filePath, 'utf8');
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/file?path=...  { content }
  app.put('/api/file', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    const { content } = req.body;
    if (typeof content !== 'string') return res.status(400).json({ error: 'content が必要です' });
    try {
      await writeFile(filePath, content, 'utf8');
      // Invalidate html cache for this file (mtime changed)
      setCachedHtml(filePath, -1, '');
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tags
  app.get('/api/tags', async (_req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    try {
      const tags = await loadTags(currentRoot);
      res.json(tags);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/tags  { relativePath, tags, flagged, note }
  app.put('/api/tags', async (req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    const { relativePath, tags, flagged, note } = req.body;
    if (!relativePath) return res.status(400).json({ error: 'relativePath が必要です' });
    try {
      const updated = await updateFileTags(currentRoot, relativePath, { tags, flagged, note });
      res.json(updated ?? {});
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/refresh
  app.post('/api/refresh', (_req, res) => {
    if (currentRoot) invalidateCache(currentRoot);
    res.json({ ok: true });
  });

  // POST /api/folder/pick  — open native OS folder picker, return selected path
  app.post('/api/folder/pick', (_req, res) => {
    const path = pickFolderNative();
    res.json({ path }); // null if cancelled
  });

  return app;
}

// ---- Native folder picker ------------------------------------------------

function pickFolderNative() {
  try {
    if (process.platform === 'win32') return pickFolderWindows();
    if (process.platform === 'darwin') return pickFolderMac();
    return pickFolderLinux();
  } catch {
    return null;
  }
}

function pickFolderWindows() {
  // src/picker.ps1 で IFileOpenDialog (Vista+ モダンエクスプローラ) を起動
  const ps1 = join(__dirname, 'picker.ps1');
  const result = execSync(
    `powershell.exe -NoProfile -STA -ExecutionPolicy Bypass -File "${ps1}"`,
    { encoding: 'utf8', timeout: 120_000 }
  ).trim();
  return result || null;
}

function pickFolderMac() {
  const result = execSync(
    `osascript -e 'POSIX path of (choose folder with prompt "フォルダを選択してください")'`,
    { encoding: 'utf8', timeout: 120_000 }
  ).trim();
  // osascript は末尾に / を付けるので除去
  return result ? result.replace(/\/$/, '') : null;
}

function pickFolderLinux() {
  // zenity → kdialog → yad の順で試す
  const candidates = [
    `zenity --file-selection --directory --title="フォルダを選択"`,
    `kdialog --getexistingdirectory "$HOME"`,
    `yad --file --directory --title="フォルダを選択"`,
  ];
  for (const cmd of candidates) {
    try {
      return execSync(cmd, { encoding: 'utf8', timeout: 120_000 }).trim() || null;
    } catch { /* 次を試す */ }
  }
  return null;
}
