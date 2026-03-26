import express from 'express';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { readFile, writeFile, stat, rename, mkdir, rm, access, readdir } from 'fs/promises';
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
import { loadTags, updateFileTags, renameFileTags } from './tagManager.js';
import { getConfig, addFolderToHistory, serverConfig } from './configManager.js';

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

// markedHighlight が旧形式 (code, lang) でレンダラーを呼ぶため位置引数で受け取る
marked.use({
  renderer: {
    code(code, lang) {
      if (lang === 'mermaid') {
        return `<div class="mermaid">${code}</div>\n`;
      }
      return false;
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
    const config = getConfig();          // 履歴・lastFolder
    const srv    = serverConfig();       // port・network・theme (mdexplorer.config.json)
    res.json({ ...srv, ...config, currentRoot });
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

  // GET /api/image?path=...  (proxy for images under currentRoot)
  app.get('/api/image', async (req, res) => {
    const imgPath = normalize(req.query.path ?? '');
    if (!imgPath || !isAllowedPath(imgPath, currentRoot))
      return res.status(403).send('Forbidden');
    try {
      res.sendFile(imgPath);
    } catch (err) { res.status(404).send('Not found'); }
  });

  // Rewrite relative <img src> to /api/image?path=... so the browser can load them
  function rewriteImageSrcs(html, fileDir) {
    return html.replace(/<img([^>]*?)src="([^"]*)"([^>]*?)>/gi, (match, pre, src, post) => {
      if (!src || /^(https?:\/\/|data:|\/)/i.test(src)) return match;
      const decoded = decodeURIComponent(src);
      const absPath = join(fileDir, decoded).replace(/\\/g, '/');
      return `<img${pre}src="/api/image?path=${encodeURIComponent(absPath)}"${post}>`;
    });
  }

  // GET /api/preview?path=...
  app.get('/api/preview', async (req, res) => {
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    try {
      const fileStat = await stat(filePath);
      const content = await readFile(filePath, 'utf8');
      const charCount = [...content.replace(/\s+/g, '')].length;
      const cached = getCachedHtml(filePath, fileStat.mtimeMs);
      const rawHtml = cached ?? marked.parse(content);
      if (!cached) setCachedHtml(filePath, fileStat.mtimeMs, rawHtml);
      const html = rewriteImageSrcs(rawHtml, dirname(filePath));
      res.json({ html, mtime: fileStat.mtimeMs, charCount });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/upload-image  { base64, filename, dir }  → { relativePath, path }
  app.post('/api/upload-image', async (req, res) => {
    const { base64, filename, dir } = req.body ?? {};
    if (!base64 || !filename || !dir) return res.status(400).json({ error: 'base64 / filename / dir が必要です' });
    if (!isAllowedPath(normalize(dir), currentRoot)) return res.status(403).json({ error: '不正なパスです' });
    // Only allow image extensions
    if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(filename)) return res.status(400).json({ error: '画像ファイルのみ対応です' });
    try {
      const data = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      const savePath = join(normalize(dir), filename);
      await writeFile(savePath, data);
      res.json({ path: savePath, relativePath: relative(currentRoot, savePath).replace(/\\/g, '/') });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/render  { content, filePath? }  → { html }  (live preview while editing)
  app.post('/api/render', (req, res) => {
    const { content, filePath } = req.body ?? {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content が必要です' });
    try {
      const rawHtml = marked.parse(content);
      const html = filePath ? rewriteImageSrcs(rawHtml, dirname(normalize(filePath))) : rawHtml;
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

  // POST /api/fs/file  { dir, name }
  app.post('/api/fs/file', async (req, res) => {
    const { dir, name } = req.body ?? {};
    if (!dir || !name) return res.status(400).json({ error: 'dir と name が必要です' });
    const fileName = name.match(/\.[^.]+$/) ? name : name + '.md';
    const filePath = normalize(join(dir, fileName));
    if (!isAllowedPath(filePath, currentRoot)) return res.status(403).json({ error: '不正なパスです' });
    try {
      await access(filePath).then(() => { throw new Error('同名のファイルが既に存在します'); }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      await writeFile(filePath, '', 'utf8');
      invalidateCache(currentRoot);
      res.json({ path: filePath });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/fs/folder  { dir, name }
  app.post('/api/fs/folder', async (req, res) => {
    const { dir, name } = req.body ?? {};
    if (!dir || !name) return res.status(400).json({ error: 'dir と name が必要です' });
    const folderPath = normalize(join(dir, name));
    if (!isAllowedPath(folderPath, currentRoot)) return res.status(403).json({ error: '不正なパスです' });
    try {
      await access(folderPath).then(() => { throw new Error('同名のフォルダが既に存在します'); }).catch((e) => { if (e.code !== 'ENOENT') throw e; });
      await mkdir(folderPath);
      invalidateCache(currentRoot);
      res.json({ path: folderPath });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // PATCH /api/fs/rename  { oldPath, newPath }
  app.patch('/api/fs/rename', async (req, res) => {
    const { oldPath, newPath } = req.body ?? {};
    if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath と newPath が必要です' });
    if (!isAllowedPath(normalize(oldPath), currentRoot) || !isAllowedPath(normalize(newPath), currentRoot))
      return res.status(403).json({ error: '不正なパスです' });
    try {
      // リネーム先が既に存在する場合は拒否
      try {
        await access(normalize(newPath));
        return res.status(409).json({ error: '同名のファイル/フォルダが既に存在します' });
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      await rename(normalize(oldPath), normalize(newPath));
      invalidateCache(currentRoot);
      // タグのキーも旧パス→新パスに移動
      if (currentRoot) {
        const oldRel = relative(currentRoot, normalize(oldPath));
        const newRel = relative(currentRoot, normalize(newPath));
        await renameFileTags(currentRoot, oldRel, newRel);
      }
      res.json({ ok: true, newPath: normalize(newPath) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // DELETE /api/fs  { path }
  app.delete('/api/fs', async (req, res) => {
    const filePath = req.body?.path;
    if (!filePath || !isAllowedPath(normalize(filePath), currentRoot))
      return res.status(403).json({ error: '不正なパスです' });
    try {
      const s = await stat(normalize(filePath));
      await rm(normalize(filePath), { recursive: s.isDirectory(), force: true });
      invalidateCache(currentRoot);
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/backlinks?path=...  → { links: [{ path, relativePath, name, lineNum, text }] }
  app.get('/api/backlinks', async (req, res) => {
    const targetPath = req.query.path;
    if (!targetPath || !currentRoot) return res.status(400).json({ error: 'path またはフォルダが未設定です' });

    const targetRel  = relative(currentRoot, normalize(targetPath)).replace(/\\/g, '/');
    const targetName = targetRel.split('/').pop();         // e.g. "note.md"
    const targetBase = targetName.replace(/\.md$/i, '');  // e.g. "note"

    // Match only actual Markdown link / Wiki-link syntax:
    //   [label](note.md)  [label](path/note.md)  [[note]]  [[note.md]]
    const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkRe = new RegExp(
      `\\[\\[${escRe(targetBase)}(?:\\.md)?\\]\\]` +          // [[note]] or [[note.md]]
      `|\\]\\((?:[^)]*\\/)?${escRe(targetBase)}(?:\\.md)?\\)`, // ](note.md) or ](path/note.md)
      'i'
    );

    const links = [];
    async function walk(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) { await walk(fullPath); continue; }
        if (!entry.name.endsWith('.md')) continue;
        if (normalize(fullPath) === normalize(targetPath)) continue; // skip self

        let content;
        try { content = await readFile(fullPath, 'utf8'); } catch { continue; }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (linkRe.test(lines[i])) {
            links.push({
              path: fullPath,
              relativePath: relative(currentRoot, fullPath).replace(/\\/g, '/'),
              name: entry.name,
              lineNum: i + 1,
              text: lines[i].trim().slice(0, 120),
            });
            break; // one entry per file
          }
        }
      }
    }
    try {
      await walk(currentRoot);
      res.json({ links });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/search?q=...  (SSE: progress + results streaming)
  app.get('/api/search', async (req, res) => {
    const q = req.query.q?.trim();
    if (!q || !currentRoot) {
      res.setHeader('Content-Type', 'application/json');
      return res.status(400).json({ error: 'q またはフォルダが未設定です' });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

    const query = q.toLowerCase();
    const MAX_FILES = 50;
    const MAX_MATCHES_PER_FILE = 3;
    const CONTEXT_LEN = 120;
    let scanned = 0;
    let found = 0;

    async function walk(dir) {
      if (found >= MAX_FILES) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found >= MAX_FILES) break;
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.name.endsWith('.md')) {
          scanned++;
          if (scanned % 50 === 0) send({ type: 'progress', scanned, found });
          let content;
          try { content = await readFile(fullPath, 'utf8'); } catch { continue; }
          const lines = content.split('\n');
          const matches = [];
          for (let i = 0; i < lines.length && matches.length < MAX_MATCHES_PER_FILE; i++) {
            const lower = lines[i].toLowerCase();
            const idx = lower.indexOf(query);
            if (idx === -1) continue;
            const start = Math.max(0, idx - 30);
            const text = lines[i].slice(start, start + CONTEXT_LEN);
            matches.push({ lineNum: i + 1, text: (start > 0 ? '…' : '') + text });
          }
          if (matches.length) {
            found++;
            send({ type: 'result', path: fullPath, relativePath: relative(currentRoot, fullPath).replace(/\\/g, '/'), name: entry.name, matches });
          }
        }
      }
    }

    try {
      await walk(currentRoot);
      send({ type: 'done', scanned, found, truncated: found >= MAX_FILES });
    } catch (err) {
      send({ type: 'error', message: err.message });
    }
    res.end();
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
