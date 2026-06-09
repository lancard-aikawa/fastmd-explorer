import express from 'express';
import { execSync, execFileSync } from 'child_process';
import { readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { readFile, writeFile, stat, rename, mkdir, rm, access, readdir } from 'fs/promises';
import { join, dirname, relative, normalize } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
import markedKatex from 'marked-katex-extension';
import hljs from 'highlight.js';
import {
  scanMarkdownFiles,
  invalidateCache,
  getCachedHtml,
  setCachedHtml,
} from './fileScanner.js';
import { loadTags, updateFileTags, renameFileTags } from './tagManager.js';
import { getConfig, addFolderToHistory, addUrlToHistory, serverConfig, saveWindowBounds } from './configManager.js';

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

// Wikilink extension: [[note]] or [[note|alias]] → <a href="note.md" class="wikilink">
marked.use({
  extensions: [{
    name: 'wikilink',
    level: 'inline',
    start(src) { return src.indexOf('[['); },
    tokenizer(src) {
      const match = src.match(/^\[\[([^\]|#\n]+?)(?:\|([^\]\n]+))?\]\]/);
      if (match) {
        return {
          type: 'wikilink',
          raw: match[0],
          target: match[1].trim(),
          label: (match[2] ?? match[1]).trim(),
        };
      }
    },
    renderer(token) {
      const href = /\.md$/i.test(token.target) ? token.target : token.target + '.md';
      return `<a href="${escHtml(href)}" class="wikilink">${escHtml(token.label)}</a>`;
    },
  }],
});

// LaTeX 数式: $...$ (インライン) / $$...$$ (ブロック) を KaTeX で HTML 化する。
// サーバ側でレンダリングするため、表示には KaTeX CSS とフォント (/vendor) が必要。
marked.use(markedKatex({ throwOnError: false }));

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ---- Front matter (YAML ヘッダー) -----------------------------------------
// ファイル先頭の `---` で囲まれた YAML を GitHub 風のテーブルとして表示する。
// 依存を増やさない軽量パーサ。フラットな key: value と簡単なリスト/インライン
// 配列に対応 (ドキュメントの front matter の大半はこの範囲)。

function stripQuotes(s) {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** YAML フローシーケンス `[a, b, c]` を配列に。それ以外はそのままの文字列。 */
function parseScalarOrInline(val) {
  const m = val.match(/^\[(.*)\]$/);
  if (m) {
    return m[1].trim() === ''
      ? []
      : m[1].split(',').map((x) => stripQuotes(x));
  }
  return stripQuotes(val);
}

/** front matter ブロックを [key, value] の配列に。value は文字列か配列。 */
function parseFrontMatter(block) {
  const entries = [];
  let cur = null; // ブロックリスト収集中の { key, list }
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && cur) {
      cur.list.push(stripQuotes(listItem[1]));
      continue;
    }

    const kv = line.match(/^([^:#\s][^:]*):\s*(.*)$/);
    if (kv) {
      if (cur) { entries.push([cur.key, cur.list]); cur = null; }
      const key = kv[1].trim();
      const val = kv[2].trim();
      if (val === '') {
        cur = { key, list: [] }; // 後続のブロックリストを待つ
      } else {
        entries.push([key, parseScalarOrInline(val)]);
      }
    }
  }
  if (cur) entries.push([cur.key, cur.list]);
  return entries;
}

function renderFrontMatterTable(entries) {
  if (!entries.length) return '';
  const rows = entries.map(([k, v]) => {
    let valHtml;
    if (Array.isArray(v)) {
      // GitHub と同様、配列は横並びで表示する
      valHtml = v.map((i) => `<span class="fm-item">${escHtml(String(i))}</span>`).join('');
    } else {
      valHtml = escHtml(String(v));
    }
    return `<tr><th scope="row">${escHtml(k)}</th><td>${valHtml}</td></tr>`;
  }).join('');
  return `<table class="front-matter"><tbody>${rows}</tbody></table>\n`;
}

/** 先頭の front matter を抽出。{ entries, body } を返す。 */
function extractFrontMatter(content) {
  const text = content.replace(/^﻿/, ''); // 先頭 BOM を除去
  const m = text.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/);
  if (!m) return { entries: [], body: content };
  return { entries: parseFrontMatter(m[1]), body: text.slice(m[0].length) };
}

/** front matter テーブル + 本文 (marked) をまとめてレンダリングする。 */
function renderMarkdown(content) {
  const { entries, body } = extractFrontMatter(content);
  return renderFrontMatterTable(entries) + marked.parse(body);
}

// ---- URL モード: リモート資産のリンク解決 ---------------------------------
// リモート md をレンダリングした HTML 内の相対 <img src> / <a href> を、
// ソース URL 基準で絶対 URL に解決する。ブラウザが画像を直接ロードでき、
// 相対リンク (.md など) のクリックも正しく辿れるようにする。
// 絶対URL / data: / mailto: / tel: / プロトコル相対(//) / アンカー(#) は対象外。

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

/** 相対リンクを baseUrl 基準で絶対 URL 化。解決不要/不可なら null。 */
function toAbsoluteUrl(raw, baseUrl) {
  if (!raw || /^(https?:|data:|mailto:|tel:|#|\/\/)/i.test(raw)) return null;
  try { return new URL(decodeEntities(raw), baseUrl).href; } catch { return null; }
}

function rewriteRemoteAssets(html, baseUrl) {
  html = html.replace(/<img([^>]*?)src="([^"]*)"([^>]*?)>/gi, (match, pre, src, post) => {
    const abs = toAbsoluteUrl(src, baseUrl);
    return abs ? `<img${pre}src="${escAttr(abs)}"${post}>` : match;
  });
  html = html.replace(/<a\b([^>]*?)\bhref="([^"]*)"([^>]*?)>/gi, (match, pre, href, post) => {
    const abs = toAbsoluteUrl(href, baseUrl);
    return abs ? `<a${pre}href="${escAttr(abs)}"${post}>` : match;
  });
  return html;
}

// ---- Link extraction / combined export helpers ---------------------------
// リンク図 (/api/linkgraph) と全md結合 (/api/combined) で共用するユーティリティ。

const MD_LINK_RE   = /\[(?:[^\]]*)\]\(\s*([^)\s]+?)(?:\s+"[^"]*")?\s*\)/g;
const WIKI_LINK_RE = /\[\[([^\]|#\n]+?)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;
const MD_EXT_RE    = /\.(md|markdown|mdown|mkd)$/i;

/** posix な相対パスを baseDir に結合し、`.`/`..` を解決して返す。 */
function posixJoin(baseDir, rel) {
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return parts.join('/');
}

/** 生の Markdown から発リンク先を抽出。{ kind: 'md'|'wiki', raw } の配列。 */
function extractLinkTargets(content) {
  const out = [];
  let m;
  MD_LINK_RE.lastIndex = 0;
  while ((m = MD_LINK_RE.exec(content)) !== null) {
    const raw = m[1];
    if (/^(https?:|mailto:|data:|tel:|#)/i.test(raw)) continue;
    out.push({ kind: 'md', raw });
  }
  WIKI_LINK_RE.lastIndex = 0;
  while ((m = WIKI_LINK_RE.exec(content)) !== null) {
    out.push({ kind: 'wiki', raw: m[1].trim() });
  }
  return out;
}

/**
 * リンク先を実在ファイルの (posix) 相対パスへ解決する。見つからなければ null。
 * @param srcDir       リンク元ファイルのディレクトリ (posix 相対パス)
 * @param fileSetLc    Map<小文字 rel, 実 rel>
 * @param basenameLc   Map<小文字 basename(.md付き), 実 rel>  (wikilink 用)
 */
function resolveLinkTarget(t, srcDir, fileSetLc, basenameLc) {
  if (t.kind === 'wiki') {
    let name = t.raw;
    if (!MD_EXT_RE.test(name)) name += '.md';
    return basenameLc.get(name.toLowerCase()) ?? null;
  }
  let raw = t.raw.split('#')[0];
  if (!raw) return null;
  try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
  if (!MD_EXT_RE.test(raw)) return null;
  const joined = posixJoin(srcDir, raw);
  return fileSetLc.get(joined.toLowerCase()) ?? null;
}

/** 結合PDF 用の見出し slug。GitHub 風 (小文字化・記号除去・空白→ハイフン)。 */
function slugify(text) {
  return String(text).trim().toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, '');
}

/** 結合PDF の目次 HTML を生成 (ファイル名=第1階層, 見出し=第2階層以降)。 */
function buildCombinedToc(toc) {
  let html = '<nav class="cb-toc"><h1 class="cb-toc-title">目次</h1><ol class="cb-toc-files">';
  for (const f of toc) {
    html += `<li class="cb-toc-file"><a href="#file-${f.idx}">${escHtml(f.rel)}</a>`;
    if (f.headings.length) {
      html += '<ol class="cb-toc-headings">';
      for (const h of f.headings) {
        html += `<li class="cb-toc-h cb-toc-h${h.level}"><a href="#${h.id}">${escHtml(h.text)}</a></li>`;
      }
      html += '</ol>';
    }
    html += '</li>';
  }
  html += '</ol></nav>';
  return html;
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

export function createServer(meta = {}) {
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Static public files
  app.use(express.static(join(ROOT_DIR, 'public')));

  // Vendor: mermaid UMD bundle
  app.get('/vendor/mermaid.min.js', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js'));
  });
  // Vendor: cytoscape UMD bundle (リンク図の力学レイアウト描画用)
  app.get('/vendor/cytoscape.min.js', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js'));
  });
  // Vendor: highlight.js CSS themes
  app.get('/vendor/hljs-light.css', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'highlight.js', 'styles', 'github.css'));
  });
  app.get('/vendor/hljs-dark.css', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'highlight.js', 'styles', 'github-dark.css'));
  });
  // Vendor: KaTeX CSS + フォント (LaTeX 数式表示用)
  app.get('/vendor/katex.min.css', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'katex', 'dist', 'katex.min.css'));
  });
  // katex.min.css は fonts/KaTeX_*.woff2 を相対参照する (= /vendor/fonts/...)
  app.get('/vendor/fonts/:file', (req, res) => {
    if (!/^KaTeX_[A-Za-z0-9-]+\.woff2$/.test(req.params.file)) return res.status(404).end();
    res.sendFile(join(ROOT_DIR, 'node_modules', 'katex', 'dist', 'fonts', req.params.file));
  });

  // -- State (per-process, single user) --
  let currentRoot = null;
  let currentMode = 'folder';   // 'folder' | 'url'
  let currentUrl  = null;       // URLモードで現在開いている md の URL

  // GET /api/config
  app.get('/api/config', (_req, res) => {
    const config = getConfig();          // 履歴・lastFolder・urlHistory・lastUrl・lastMode
    const srv    = serverConfig();       // port・network・theme (mdexplorer.config.json)
    res.json({ ...srv, ...config, currentRoot, currentMode, currentUrl });
  });

  // -- Heartbeat / lifecycle (window モード時のみ自動終了) --
  // クライアントが SSE 接続を保持し、ウィンドウを閉じて接続が切れたら
  // 数秒の猶予後に onIdle() を呼んでプロセスを終了させる。
  // リロード/ナビゲーションは猶予内に再接続するため終了しない。
  const sseClients = new Set();
  let everConnected = false;
  let idleTimer = null;
  const IDLE_GRACE_MS = 2500;

  app.get('/api/heartbeat', (req, res) => {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection:      'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1000\n\n');
    sseClients.add(res);
    everConnected = true;
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }

    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* ignore */ }
    }, 15000);

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
      if (meta.windowMode && everConnected && sseClients.size === 0) {
        idleTimer = setTimeout(() => {
          if (sseClients.size === 0 && meta.onIdle) meta.onIdle();
        }, IDLE_GRACE_MS);
      }
    });
  });

  // 起動後にウィンドウが開かない/接続されない場合のフェイルセーフ。
  // ゾンビプロセス化を防ぐため、一定時間 1 度も接続が無ければ終了する。
  if (meta.windowMode) {
    setTimeout(() => {
      if (!everConnected && meta.onIdle) meta.onIdle();
    }, 60000);
  }

  // GET /api/status
  app.get('/api/status', (_req, res) => {
    const srv = serverConfig();
    res.json({
      port:           meta.port ?? srv.port,
      host:           meta.host ?? '127.0.0.1',
      mode:           meta.mode ?? srv.network,
      pid:            process.pid,
      nodeVersion:    process.version,
      platform:       process.platform,
      arch:           process.arch,
      startedAt:      meta.startedAt ?? null,
      uptimeSec:      meta.startedAt ? Math.floor((Date.now() - meta.startedAt) / 1000) : null,
      currentFolder:  currentRoot,
      currentMode,
      currentUrl,
      execPath:       process.execPath,
      isPackaged:     !!process.pkg,
      windowMode:     !!meta.windowMode,
      configPath:     meta.localConfigPath ?? null,
      globalConfigPath: meta.globalConfigPath ?? null,
    });
  });

  // POST /api/window-bounds  — ウィンドウの位置・サイズを保存 (window モードで復元用)
  app.post('/api/window-bounds', async (req, res) => {
    const b = req.body;
    if (b && Number.isFinite(b.width) && Number.isFinite(b.height)) {
      await saveWindowBounds({
        width:  Math.round(b.width),
        height: Math.round(b.height),
        x: Number.isFinite(b.x) ? Math.round(b.x) : undefined,
        y: Number.isFinite(b.y) ? Math.round(b.y) : undefined,
      });
    }
    res.json({ ok: true });
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
    currentMode = 'folder';
    currentUrl  = null;
    invalidateCache(folderPath); // soft: keep disk cache for fast reload after restart
    const config = await addFolderToHistory(folderPath);

    res.json({ path: folderPath, warnings, config });
  });

  // ---- URL モード (リモート md の閲覧) -------------------------------------

  const URL_FETCH_TIMEOUT_MS = 15000;
  const URL_MAX_BYTES = 5 * 1024 * 1024; // 5MB

  function isHttpUrl(u) {
    try { const p = new URL(u); return p.protocol === 'http:' || p.protocol === 'https:'; }
    catch { return false; }
  }

  // POST /api/url  { url }  — URLモードに切替え、URL履歴に記録する (/api/folder と対称)
  app.post('/api/url', async (req, res) => {
    const url = (req.body?.url ?? '').trim();
    if (!url) return res.status(400).json({ error: 'url が必要です' });
    if (!isHttpUrl(url)) return res.status(400).json({ error: 'http(s):// の URL を指定してください' });
    currentMode = 'url';
    currentUrl  = url;
    const config = await addUrlToHistory(url);
    res.json({ url, config });
  });

  // GET /api/url/preview?url=...  — リモート md を取得して HTML 化する
  // 注: ユーザー自身が入力した URL をサーバ側 fetch する。単一ユーザーの localhost
  //     ツールのため SSRF リスクは低い。スキーム制限・タイムアウト・サイズ上限のみ施す。
  app.get('/api/url/preview', async (req, res) => {
    const url = req.query.url;
    if (!url || !isHttpUrl(url)) return res.status(400).json({ error: '不正な URL です' });
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
        headers: { Accept: 'text/markdown, text/plain, text/*;q=0.9, */*;q=0.5' },
        redirect: 'follow',
      });
      if (!resp.ok) return res.status(502).json({ error: `取得に失敗しました (HTTP ${resp.status})` });

      let content = await resp.text();
      let truncated = false;
      if (Buffer.byteLength(content, 'utf8') > URL_MAX_BYTES) {
        content = Buffer.from(content, 'utf8').subarray(0, URL_MAX_BYTES).toString('utf8');
        truncated = true;
      }

      const charCount = [...content.replace(/\s+/g, '')].length;
      const finalUrl  = resp.url || url; // リダイレクト後の URL を相対解決の基準にする
      const html = rewriteRemoteAssets(renderMarkdown(content), finalUrl);
      res.json({ html, charCount, lastModified: resp.headers.get('last-modified') ?? null, finalUrl, truncated });
    } catch (err) {
      const msg = err?.name === 'TimeoutError' ? 'タイムアウトしました' : err.message;
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/files
  app.get('/api/files', async (_req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    try {
      const t0 = performance.now();
      const [{ tree, fileCount, warnings }, tags] = await Promise.all([
        scanMarkdownFiles(currentRoot),
        loadTags(currentRoot),
      ]);
      const t1 = performance.now();
      console.log(`[perf] scan+tags: ${(t1 - t0).toFixed(0)}ms  files=${fileCount}`);
      const json = JSON.stringify({ tree, fileCount, warnings, tags });
      const t2 = performance.now();
      console.log(`[perf] JSON.stringify: ${(t2 - t1).toFixed(0)}ms  size=${(json.length / 1024).toFixed(0)}KB`);
      res.type('json').send(json);
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
      const rawHtml = cached ?? renderMarkdown(content);
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
      const rawHtml = renderMarkdown(content);
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
      invalidateCache(currentRoot, { hard: true });
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
      invalidateCache(currentRoot, { hard: true });
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
      invalidateCache(currentRoot, { hard: true });
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
      invalidateCache(currentRoot, { hard: true });
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
    if (currentRoot) invalidateCache(currentRoot, { hard: true }); // force fresh scan + update disk cache
    res.json({ ok: true });
  });

  // POST /api/folder/pick  — open native OS folder picker, return selected path
  app.post('/api/folder/pick', (_req, res) => {
    const path = pickFolderNative();
    res.json({ path }); // null if cancelled
  });

  // GET /api/linkgraph  → { nodes:[{rel,name}], edges:[{from,to}], total, isolatedCount }
  // 全 .md を走査し、md リンク / wikilink の相互参照グラフを構築する。
  // (リンクを 1 本以上持つファイルのみノード化。孤立ファイル数は別途返す)
  app.get('/api/linkgraph', async (_req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    try {
      const files = [];                 // { rel, name }
      const contents = new Map();       // rel -> content
      async function walk(dir) {
        let entries;
        try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = join(dir, entry.name);
          if (entry.isDirectory()) { await walk(full); continue; }
          if (!MD_EXT_RE.test(entry.name)) continue;
          const rel = relative(currentRoot, full).replace(/\\/g, '/');
          let content;
          try { content = await readFile(full, 'utf8'); } catch { continue; }
          files.push({ rel, name: entry.name });
          contents.set(rel, content);
        }
      }
      await walk(currentRoot);

      const fileSetLc  = new Map();
      const basenameLc = new Map();
      for (const f of files) {
        fileSetLc.set(f.rel.toLowerCase(), f.rel);
        const base = f.name.toLowerCase();
        if (!basenameLc.has(base)) basenameLc.set(base, f.rel);
      }

      const edges = [];
      const seen = new Set();
      const degree = new Map();
      for (const f of files) {
        const srcDir = f.rel.includes('/') ? f.rel.slice(0, f.rel.lastIndexOf('/')) : '';
        for (const t of extractLinkTargets(contents.get(f.rel) ?? '')) {
          const tgt = resolveLinkTarget(t, srcDir, fileSetLc, basenameLc);
          if (!tgt || tgt === f.rel) continue;
          const key = f.rel + '\n' + tgt;
          if (seen.has(key)) continue;
          seen.add(key);
          edges.push({ from: f.rel, to: tgt });
          degree.set(f.rel, (degree.get(f.rel) ?? 0) + 1);
          degree.set(tgt, (degree.get(tgt) ?? 0) + 1);
        }
      }

      const nodes = files
        .filter((f) => degree.has(f.rel))
        .map((f) => ({ rel: f.rel, name: f.name.replace(MD_EXT_RE, '') }));

      res.json({ nodes, edges, total: files.length, isolatedCount: files.length - nodes.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/combined  → { html, fileCount }
  // フォルダ内の全 .md をツリー順に 1 つの HTML へ結合する (印刷で PDF 化する想定)。
  //  - 各ファイルの前に扉 (パス・更新日時・文字数) を挿入し改ページ
  //  - 目次はファイル名を第1階層・見出しを第2階層以降にネスト
  //  - ファイル間の md リンクは結合先の節アンカー (#file-N) へ書き換え
  app.get('/api/combined', async (_req, res) => {
    if (!currentRoot) return res.status(400).json({ error: 'フォルダが未選択です' });
    try {
      const { tree } = await scanMarkdownFiles(currentRoot);
      const ordered = [];
      (function flatten(node) {
        if (!node) return;
        if (node.type === 'file') { ordered.push(node.relativePath.replace(/\\/g, '/')); return; }
        (node.children ?? []).forEach(flatten);
      })(tree);

      if (!ordered.length) return res.json({ html: '', fileCount: 0 });

      const idxByRelLc  = new Map();
      const idxByBaseLc = new Map();
      ordered.forEach((rel, i) => {
        idxByRelLc.set(rel.toLowerCase(), i);
        const base = rel.split('/').pop().toLowerCase();
        if (!idxByBaseLc.has(base)) idxByBaseLc.set(base, i);
      });

      const sections = [];
      const toc = [];

      for (let i = 0; i < ordered.length; i++) {
        const rel = ordered[i];
        const abs = join(currentRoot, rel);
        let content, fstat;
        try { fstat = await stat(abs); content = await readFile(abs, 'utf8'); } catch { continue; }

        const { entries, body } = extractFrontMatter(content);
        let rendered = renderFrontMatterTable(entries) + marked.parse(body);

        // 見出しにファイル単位で一意な id を付与しつつ目次用に収集
        const headings = [];
        const usedSlugs = new Set();
        rendered = rendered.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, (_all, lvl, attrs, inner) => {
          const text = stripTags(inner).trim();
          let base = slugify(text) || 'section';
          let slug = base, n = 1;
          while (usedSlugs.has(slug)) slug = `${base}-${n++}`;
          usedSlugs.add(slug);
          const id = `file-${i}--${slug}`;
          headings.push({ level: Number(lvl), text, id });
          return `<h${lvl}${attrs} id="${id}">${inner}</h${lvl}>`;
        });

        // ファイル間の md / wiki リンクを結合先の節アンカーへ書き換え
        const srcDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        rendered = rendered.replace(/<a\b([^>]*?)\bhref="([^"]*)"([^>]*)>/gi, (all, pre, href, post) => {
          if (/^(https?:|mailto:|data:|tel:)/i.test(href) || href.startsWith('#')) return all;
          const isWiki = /class="[^"]*wikilink/.test(pre + post);
          let targetIdx = null;
          if (isWiki) {
            let name = href.split('#')[0];
            if (!MD_EXT_RE.test(name)) name += '.md';
            targetIdx = idxByBaseLc.get(name.toLowerCase());
          } else {
            let raw = href.split('#')[0];
            try { raw = decodeURIComponent(raw); } catch { /* keep */ }
            if (MD_EXT_RE.test(raw)) targetIdx = idxByRelLc.get(posixJoin(srcDir, raw).toLowerCase());
          }
          if (targetIdx === undefined || targetIdx === null) return all;
          return `<a${pre}href="#file-${targetIdx}"${post}>`;
        });

        rendered = rewriteImageSrcs(rendered, dirname(abs));

        const d = new Date(fstat.mtimeMs);
        const dstr = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const charCount = [...content.replace(/\s+/g, '')].length;

        sections.push(
          `<section class="cb-file" id="file-${i}">` +
            `<div class="cb-sep">` +
              `<div class="cb-sep-path">${escHtml(rel)}</div>` +
              `<div class="cb-sep-meta">更新: ${dstr}　文字数: ${charCount}</div>` +
            `</div>` +
            `<div class="markdown-body cb-body">${rendered}</div>` +
          `</section>`
        );
        toc.push({ idx: i, rel, name: rel.split('/').pop(), headings });
      }

      const rootName = currentRoot.replace(/[/\\]+$/, '').split(/[/\\]/).pop();
      const cover = `<div class="cb-cover"><h1 class="cb-cover-title">${escHtml(rootName)}</h1>` +
        `<div class="cb-cover-meta">${ordered.length} ファイル結合</div></div>`;

      res.json({ html: cover + buildCombinedToc(toc) + sections.join('\n'), fileCount: ordered.length });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return app;
}

// ---- Native folder picker ------------------------------------------------

function pickerLog(...parts) {
  try {
    appendFileSync(
      join(tmpdir(), 'fastmd-explorer.log'),
      `[picker] ${parts.join(' ')}\n`,
    );
  } catch { /* ignore */ }
}

function pickFolderNative() {
  try {
    if (process.platform === 'win32') return pickFolderWindows();
    if (process.platform === 'darwin') return pickFolderMac();
    return pickFolderLinux();
  } catch (err) {
    pickerLog('ERROR', err?.message ?? String(err));
    if (err?.stderr) pickerLog('STDERR', String(err.stderr));
    if (err?.stdout) pickerLog('STDOUT', String(err.stdout));
    return null;
  }
}

function pickFolderWindows() {
  // src/picker.ps1 で IFileOpenDialog (Vista+ モダンエクスプローラ) を起動。
  //
  // pkg でパッケージ化すると picker.ps1 は仮想スナップショット内 (C:\snapshot\...)
  // に置かれ、外部の powershell.exe からは -File でアクセスできない。
  // そこで内容を読み取り (スナップショット内なら fs で読める)、
  // base64(UTF-16LE) エンコードして -EncodedCommand で直接渡す。
  //
  // 重要: execSync ではなく execFileSync を使う。
  // execSync は cmd.exe 経由で実行され、cmd のコマンドライン長上限 (約 8191 文字)
  // に -EncodedCommand (base64) が引っ掛かり "The command line is too long" で失敗する。
  // execFileSync はシェルを介さず CreateProcess で直接起動するため上限が 32767 文字になる。
  //
  // また、コンソール窓を隠す指定 (windowsHide:true / -WindowStyle Hidden) は使わない。
  // いずれもフォルダ選択ダイアログまで隠す/即閉じさせてしまうため
  // (SW_HIDE の子への継承 / 所有ウィンドウ無しモーダルの即終了)。
  // そのため powershell のコンソール窓はダイアログ表示中は出たままになる。
  const ps1     = join(__dirname, 'picker.ps1');
  const script  = readFileSync(ps1, 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result  = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
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
