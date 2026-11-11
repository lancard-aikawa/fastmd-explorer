import express from 'express';
import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync, appendFileSync } from 'fs';
import { timingSafeEqual } from 'crypto';
import { tmpdir, networkInterfaces, hostname } from 'os';
import { readFile, writeFile, stat, rename, mkdir, rm, access, readdir } from 'fs/promises';
import { join, dirname, relative, normalize, basename } from 'path';
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
import { isInside } from './pathGuard.js';
import { getConfig, addFolderToHistory, addUrlToHistory, serverConfig, saveWindowBounds } from './configManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = dirname(__dirname);

const execAsync     = promisify(exec);
const execFileAsync = promisify(execFile);

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
        // code は未エスケープの生テキスト。そのまま埋めると </div> で脱出できる。
        // mermaid.run() は要素の innerHTML を読んでから entityDecode() する
        // (escape → &,#,; だけ復元 → innerHTML/textContent → unescape) ので、
        // ここでエスケープしても図のソースは元通り復元される。
        return `<div class="mermaid">${escHtml(code)}</div>\n`;
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

// 属性値の中でも使う (wikilink の href など) ため、クォートまでエスケープする。
// " を落とすと [[a" onmouseover="alert(1)]] のような入力で属性を生やされる。
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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

/** 単体で開ける Markdown の拡張子 (fileScanner の MD_EXTS と同じ) */
export const MD_FILE_RE = /\.(md|markdown|mdown|mkd)$/i;

/** md ファイルを単体で開くページのパス (先にファイルを描き、ツリーは後から読む) */
export function fileViewPath(filePath) {
  return `/?file=${encodeURIComponent(filePath)}&root=${encodeURIComponent(dirname(filePath))}`;
}

/** filePath が currentRoot の中に収まっているか。判定の実体は pathGuard.js。 */
export function isAllowedPath(filePath, currentRoot) {
  return isInside(currentRoot, filePath);
}

// ---- アクセス制御 ---------------------------------------------------------
// このサーバはローカルのファイルを読み書きする API を持つため、到達できる
// = ファイルを触れる。以下 3 つを 1 つのミドルウェアで塞ぐ。
//
//  1. LAN モードの無認証アクセス  → トークン (loopback は従来どおり素通し)
//  2. DNS rebinding              → Host ヘッダの検証
//  3. 他サイトからの CSRF        → Origin ヘッダの検証
//
// Cookie の読み書きは依存を増やさないよう手書きで済ませる。

const TOKEN_COOKIE = 'mdx_token';

function parseCookies(header) {
  const out = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 長さの違いも含めて一定時間で比較する。 */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  return ba.length === bb.length && ba.length > 0 && timingSafeEqual(ba, bb);
}

function isLoopback(req) {
  const ip = req.socket?.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** 'example.com:1234' / '[::1]:1234' → 'example.com' / '::1' */
function hostnameOf(hostHeader) {
  const h = String(hostHeader ?? '').trim().toLowerCase();
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'));
  return h.replace(/:\d+$/, '');
}

/** 自分に対する正当な宛先ホスト名の集合。 */
function buildAllowedHosts(mode) {
  const hosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (mode === 'lan') {
    for (const ifaces of Object.values(networkInterfaces())) {
      for (const iface of ifaces ?? []) {
        if (!iface.internal) hosts.add(iface.address.toLowerCase());
      }
    }
    hosts.add(String(hostname()).toLowerCase()); // マシン名でのアクセスも許す
  }
  return hosts;
}

// ---- Server factory -------------------------------------------------------

export function createServer(meta = {}) {
  const app = express();

  const authToken    = meta.authToken ?? null;   // LAN モード時のみ発行される
  const allowedHosts = buildAllowedHosts(meta.mode);

  // 認証・ホスト検証は静的配信も含めて全てに掛けるため最初に置く
  app.use((req, res, next) => {
    // 1. Host: 攻撃者のドメインが 127.0.0.1 に解決されても Host が違うので弾ける
    if (!allowedHosts.has(hostnameOf(req.headers.host))) {
      return res.status(403).type('text/plain').send('Forbidden: unexpected Host header');
    }

    // 2. Origin: 他サイトのページから叩かれた場合は Origin が付く。
    //    アドレスバーからの通常の遷移には付かないので、付いていて不一致なら拒否。
    const origin = req.headers.origin;
    if (origin && origin !== 'null') {
      let ok = false;
      try { ok = allowedHosts.has(new URL(origin).hostname.toLowerCase()); } catch { ok = false; }
      if (!ok) return res.status(403).type('text/plain').send('Forbidden: cross-origin request');
    }

    // 3. トークン (LAN モードのみ)。loopback は単一ユーザー想定なので従来どおり。
    if (!authToken || isLoopback(req)) return next();

    const cookies = parseCookies(req.headers.cookie);
    if (safeEqual(cookies[TOKEN_COOKIE], authToken)) return next();

    if (safeEqual(req.query?.token, authToken)) {
      // 以降は Cookie で通す。URL からトークンを消すため GET はリダイレクトする
      // (ブラウザ履歴やリファラにトークンを残さない)。
      res.setHeader('Set-Cookie',
        `${TOKEN_COOKIE}=${authToken}; Path=/; HttpOnly; SameSite=Strict`);
      if (req.method === 'GET') {
        const u = new URL(req.originalUrl, 'http://localhost');
        u.searchParams.delete('token');
        return res.redirect(302, u.pathname + (u.search || ''));
      }
      return next();
    }

    res.status(401).type('text/plain').send(
      'Unauthorized: このサーバは LAN 公開モードです。' +
      'サーバ起動時に表示された ?token=... 付きの URL からアクセスしてください。'
    );
  });

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
  // Vendor: DOMPurify (URLモードで取得したリモート md のサニタイズ用)
  app.get('/vendor/purify.min.js', (_req, res) => {
    res.sendFile(join(ROOT_DIR, 'node_modules', 'dompurify', 'dist', 'purify.min.js'));
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
  // 起動引数 (initialRoot / initialUrl) があれば初期表示に使う。
  let currentRoot = meta.initialRoot ?? null;
  let currentMode = meta.initialUrl ? 'url' : 'folder';   // 'folder' | 'url'
  let currentUrl  = meta.initialUrl ?? null;              // URLモードで現在開いている md の URL

  // ウィンドウごとのルート。
  // md をダブルクリックで開くと、同じサーバにウィンドウが増え、ウィンドウごとに
  // 違うフォルダを開く。クライアントは自分のルートを X-Root ヘッダ (EventSource は
  // ?root=) で送り、各 API はそれを使う。ヘッダが無ければ従来どおり currentRoot。
  // 受け付けるのは、このプロセスで開いたことのあるルートだけ
  // (Origin を検査する POST /api/folder・起動引数・POST /api/open-file で登録)。
  // 任意のルートを受け付けると、Origin の付かない <img> などの GET から
  // ルート外のファイルを読めてしまうため。
  const openedRoots = new Map(); // key (Windows は小文字) → path
  const rootKey = (p) => {
    const n = normalize(p);
    return process.platform === 'win32' ? n.toLowerCase() : n;
  };
  function registerRoot(p) {
    if (p) openedRoots.set(rootKey(p), normalize(p));
  }
  function rootOf(req) {
    let raw = req.get('x-root');
    if (raw) { try { raw = decodeURIComponent(raw); } catch { raw = null; } }
    raw ??= req.query?.root;
    if (typeof raw === 'string' && raw) {
      const hit = openedRoots.get(rootKey(raw));
      if (hit) return hit;
    }
    return currentRoot;
  }
  const isInsideAnyRoot = (p) => [...openedRoots.values()].some((r) => isAllowedPath(p, r));

  // 起動引数で開くフォルダも「開き直し」なので、初回スキャンはキャッシュを使わない。
  if (currentRoot) {
    registerRoot(currentRoot);
    invalidateCache(currentRoot, { hard: true });
  }

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
      app:            'fastmd-explorer', // 2 つ目のプロセスが相手を見分けるため
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
    registerRoot(folderPath);
    currentRoot = folderPath;
    currentMode = 'folder';
    currentUrl  = null;
    // 履歴・入力・ピッカーから開き直した時は必ず再スキャンする。
    // ルート直下の mtime しか見ない disk キャッシュだと、アプリを閉じている間の
    // 深い階層の増減が反映されず古いツリーが出るため hard で捨てる。
    invalidateCache(folderPath, { hard: true });
    const config = await addFolderToHistory(folderPath);

    res.json({ path: folderPath, warnings, config });
  });

  // POST /api/open-file  { path }  → { url, root }
  // md のダブルクリックで起動した 2 つ目のプロセスが、動いているサーバに
  // ファイルを渡すための口。親フォルダをルートとして登録し、そのファイルを
  // 開くページの URL を返す (ウィンドウは呼んだ側がブラウザで開く)。
  // currentRoot は変えない (既に開いているウィンドウに影響させない)。
  app.post('/api/open-file', async (req, res) => {
    const rawPath = req.body?.path;
    if (!rawPath) return res.status(400).json({ error: 'path が必要です' });
    const filePath = normalize(rawPath);
    if (!MD_FILE_RE.test(filePath)) return res.status(400).json({ error: 'Markdown ファイルではありません' });
    try {
      if (!(await stat(filePath)).isFile()) return res.status(400).json({ error: 'ファイルではありません' });
    } catch {
      return res.status(400).json({ error: 'ファイルが見つかりません' });
    }
    const root = dirname(filePath);
    registerRoot(root);
    invalidateCache(root, { hard: true });
    res.json({ url: fileViewPath(filePath), root });
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
      res.setHeader('Cache-Control', 'no-store'); // 履歴から開き直した時に古い内容を出さない
      res.json({ html, charCount, lastModified: resp.headers.get('last-modified') ?? null, finalUrl, truncated });
    } catch (err) {
      const msg = err?.name === 'TimeoutError' ? 'タイムアウトしました' : err.message;
      res.status(500).json({ error: msg });
    }
  });

  // GET /api/files
  app.get('/api/files', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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
    // <img src> からの要求でヘッダを付けられないため、開いたどれかのルート内なら許す
    if (!imgPath || !(isAllowedPath(imgPath, currentRoot) || isInsideAnyRoot(imgPath)))
      return res.status(403).send('Forbidden');
    try {
      res.setHeader('Cache-Control', 'no-store'); // 画像は URL が同一なのでブラウザキャッシュで古い版が出やすい
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
    const currentRoot = rootOf(req); // window ごとのルート
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    res.setHeader('Cache-Control', 'no-store'); // 外部更新後の再取得でブラウザキャッシュの古い内容を出さない
    try {
      const fileStat = await stat(filePath);
      const content = await readFile(filePath, 'utf8');
      const charCount = [...content.replace(/\s+/g, '')].length;
      // .html / .htm はそのまま (sandbox iframe で隔離描画するため markdown 化しない)
      if (/\.html?$/i.test(filePath)) {
        const html = rewriteImageSrcs(content, dirname(filePath));
        return res.json({ html, mtime: fileStat.mtimeMs, charCount, isHtml: true });
      }
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
    const currentRoot = rootOf(req); // window ごとのルート
    const { base64, filename, dir } = req.body ?? {};
    if (!base64 || !filename || !dir) return res.status(400).json({ error: 'base64 / filename / dir が必要です' });
    if (!isAllowedPath(normalize(dir), currentRoot)) return res.status(403).json({ error: '不正なパスです' });
    // filename にディレクトリ成分を持たせない。拡張子チェックだけだと
    // '../../evil.png' が通り、dir の検証を迂回してルート外へ書けてしまう。
    const safeName = basename(filename);
    // Only allow image extensions
    if (!/\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(safeName)) return res.status(400).json({ error: '画像ファイルのみ対応です' });
    const savePath = join(normalize(dir), safeName);
    // basename 後も join 結果を検証する (dir と結合して初めて確定するため)
    if (!isAllowedPath(savePath, currentRoot)) return res.status(403).json({ error: '不正なパスです' });
    try {
      const data = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
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
    const currentRoot = rootOf(req); // window ごとのルート
    const filePath = req.query.path;
    if (!filePath || !isAllowedPath(filePath, currentRoot)) {
      return res.status(403).json({ error: '不正なパスです' });
    }
    res.setHeader('Cache-Control', 'no-store'); // 編集開始時に外部更新後の最新内容を読むため
    try {
      const content = await readFile(filePath, 'utf8');
      res.json({ content });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /api/file?path=...  { content }
  app.put('/api/file', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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
  app.get('/api/tags', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    const currentRoot = rootOf(req); // window ごとのルート
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
    // 被参照はファイルを開くたびに全ツリーを走査する。ツリーを矢印キーで
    // 素早く辿ると走査が積み上がるので、クライアントが離れたら止める。
    let aborted = false;
    req.on('close', () => { aborted = true; });

    async function walk(dir) {
      if (aborted) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (aborted) return;
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
      if (!aborted) res.json({ links });
    } catch (err) { if (!aborted) res.status(500).json({ error: err.message }); }
  });

  // GET /api/search?q=...  (SSE: progress + results streaming)
  app.get('/api/search', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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

    // クライアントは入力のたびに EventSource を張り替える (400ms デバウンス)。
    // 中断を見ないと、捨てられた検索がフルツリー走査を続けたまま何本も並走する。
    let aborted = false;
    req.on('close', () => { aborted = true; });

    async function walk(dir) {
      if (aborted || found >= MAX_FILES) return;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (aborted || found >= MAX_FILES) break;
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
      if (!aborted) send({ type: 'done', scanned, found, truncated: found >= MAX_FILES });
    } catch (err) {
      if (!aborted) send({ type: 'error', message: err.message });
    }
    res.end();
  });

  // POST /api/refresh
  app.post('/api/refresh', (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
    if (currentRoot) invalidateCache(currentRoot, { hard: true }); // force fresh scan + update disk cache
    res.json({ ok: true });
  });

  // POST /api/folder/pick  — open native OS folder picker, return selected path
  app.post('/api/folder/pick', async (_req, res) => {
    const path = await pickFolderNative();
    res.json({ path }); // null if cancelled
  });

  // GET /api/linkgraph  → { nodes:[{rel,name}], edges:[{from,to}], total, isolatedCount }
  // 全 .md を走査し、md リンク / wikilink の相互参照グラフを構築する。
  // (リンクを 1 本以上持つファイルのみノード化。孤立ファイル数は別途返す)
  app.get('/api/linkgraph', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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
  app.get('/api/combined', async (req, res) => {
    const currentRoot = rootOf(req); // window ごとのルート
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

  // 全ルートの後に置くエラーハンドラ (4 引数にしないと express が認識しない)。
  // 既定のハンドラは HTML のスタックトレースを返し、node_modules の絶対パスまで
  // 露出する。LAN モードだと外から丸見えになるのでログに落として JSON だけ返す。
  app.use((err, _req, res, _next) => {
    console.error('[error]', err?.stack ?? err);
    if (res.headersSent) return;
    res.status(err?.status ?? err?.statusCode ?? 500)
       .json({ error: err?.message ?? 'サーバエラーが発生しました' });
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

async function pickFolderNative() {
  try {
    if (process.platform === 'win32') return await pickFolderWindows();
    if (process.platform === 'darwin') return await pickFolderMac();
    return await pickFolderLinux();
  } catch (err) {
    pickerLog('ERROR', err?.message ?? String(err));
    if (err?.stderr) pickerLog('STDERR', String(err.stderr));
    if (err?.stdout) pickerLog('STDOUT', String(err.stdout));
    return null;
  }
}

// 非同期 (execFile) で起動する。同期版 (execFileSync) だとダイアログを開いている
// 最大 2 分間 Node のイベントループが完全に止まり、ハートビート SSE を含む
// 全リクエストが待たされる。呼び出し側はレスポンスを待つだけなので await で十分。
async function pickFolderWindows() {
  // src/picker.ps1 で IFileOpenDialog (Vista+ モダンエクスプローラ) を起動。
  //
  // pkg でパッケージ化すると picker.ps1 は仮想スナップショット内 (C:\snapshot\...)
  // に置かれ、外部の powershell.exe からは -File でアクセスできない。
  // そこで内容を読み取り (スナップショット内なら fs で読める)、
  // base64(UTF-16LE) エンコードして -EncodedCommand で直接渡す。
  //
  // 重要: exec ではなく execFile を使う。
  // exec は cmd.exe 経由で実行され、cmd のコマンドライン長上限 (約 8191 文字)
  // に -EncodedCommand (base64) が引っ掛かり "The command line is too long" で失敗する。
  // execFile はシェルを介さず CreateProcess で直接起動するため上限が 32767 文字になる。
  //
  // また、コンソール窓を隠す指定 (windowsHide:true / -WindowStyle Hidden) は使わない。
  // いずれもフォルダ選択ダイアログまで隠す/即閉じさせてしまうため
  // (SW_HIDE の子への継承 / 所有ウィンドウ無しモーダルの即終了)。
  // そのため powershell のコンソール窓はダイアログ表示中は出たままになる。
  const ps1     = join(__dirname, 'picker.ps1');
  const script  = readFileSync(ps1, 'utf8');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { encoding: 'utf8', timeout: 120_000 }
  );
  return stdout.trim() || null;
}

async function pickFolderMac() {
  const { stdout } = await execAsync(
    `osascript -e 'POSIX path of (choose folder with prompt "フォルダを選択してください")'`,
    { encoding: 'utf8', timeout: 120_000 }
  );
  // osascript は末尾に / を付けるので除去
  const result = stdout.trim();
  return result ? result.replace(/\/$/, '') : null;
}

async function pickFolderLinux() {
  // zenity → kdialog → yad の順で試す
  const candidates = [
    `zenity --file-selection --directory --title="フォルダを選択"`,
    `kdialog --getexistingdirectory "$HOME"`,
    `yad --file --directory --title="フォルダを選択"`,
  ];
  for (const cmd of candidates) {
    try {
      const { stdout } = await execAsync(cmd, { encoding: 'utf8', timeout: 120_000 });
      return stdout.trim() || null;
    } catch { /* 次を試す */ }
  }
  return null;
}
