#!/usr/bin/env node
import { join, resolve, dirname } from 'path';
import { networkInterfaces, tmpdir } from 'os';
import { existsSync, statSync, createWriteStream } from 'fs';
import { randomBytes } from 'crypto';
import { spawn } from 'child_process';
import { createServer, MD_FILE_RE, fileViewPath } from './server.js';
import { loadConfig, loadLocalConfig, serverConfig, getConfigPaths, getConfig } from './configManager.js';
import { appHomePath } from './appHome.js';

// window モード: 単体ウィンドウ (ブラウザのアプリモード) で起動し、
// ウィンドウを閉じるとプロセスごと終了する。
// パッケージ版 exe では既定で有効、開発時 (node 実行) では既定で無効。
// WINDOW=1 / WINDOW=0 で明示上書きできる。
const WINDOW_MODE = process.env.WINDOW != null
  ? process.env.WINDOW !== '0'
  : !!process.pkg;

// GUI サブシステムにパッチした exe には標準出力が無い。
// stdout への書き込みで EPIPE が出るのを防ぎ、ログはテンポラリに退避する。
if (WINDOW_MODE) {
  try {
    const stream = createWriteStream(join(tmpdir(), 'fastmd-explorer.log'), { flags: 'a' });
    const write = (...args) => { try { stream.write(args.join(' ') + '\n'); } catch { /* ignore */ } };
    console.log = write;
    console.error = write;
    console.warn = write;
  } catch { /* ignore */ }
}

async function main() {
  await Promise.all([loadLocalConfig(), loadConfig()]);

  const cfg  = serverConfig();
  const PORT = parseInt(process.env.PORT    ?? cfg.port,    10);
  const MODE = (process.env.NETWORK ?? cfg.network ?? 'local').toLowerCase();
  const HOST = MODE === 'lan' ? '0.0.0.0' : '127.0.0.1';

  // 起動引数: フォルダパス または http(s) URL を初期表示に使う。
  //   例) fastmd-explorer C:\docs   /   fastmd-explorer https://example.com/README.md
  //   md ファイルなら親フォルダを開いてそのファイルを表示する (関連付けのダブルクリック用)
  const { initialRoot, initialUrl, initialFile } = parseTargetArg(process.argv[2]);

  // LAN 公開時だけアクセストークンを発行する。
  // ローカル (127.0.0.1) からは従来どおりトークン無しで開ける。
  const authToken = MODE === 'lan' ? randomBytes(16).toString('hex') : null;

  const startedAt = Date.now();
  const { localConfigPath, globalConfigPath } = getConfigPaths();
  const app = createServer({
    port: PORT, host: HOST, mode: MODE, startedAt,
    localConfigPath, globalConfigPath,
    windowMode: WINDOW_MODE,
    initialRoot, initialUrl,
    authToken,
    onIdle: () => process.exit(0),
  });

  const httpServer = app.listen(PORT, HOST, async () => {
    const local = `http://127.0.0.1:${PORT}`;
    console.log(`\nfastmd-explorer`);
    console.log(`  local  →  ${local}`);

    if (MODE === 'lan') {
      console.log('\n  ⚠  LAN モード: 下記 URL (トークン付き) を知る端末からアクセスできます');
      getLanAddresses().forEach((ip) => {
        console.log(`  lan    →  http://${ip}:${PORT}/?token=${authToken}`);
      });
      console.log('\n  ※ トークンは起動のたびに変わります。URL の共有先にご注意ください。');
    }

    console.log();

    if (process.env.NO_OPEN) return;

    const target = initialFile ? local + fileViewPath(initialFile) : local;
    if (WINDOW_MODE && launchAppWindow(target, getConfig().windowBounds)) return;

    // 通常モード (またはアプリモード起動に失敗): 既定ブラウザのタブで開く
    await openInBrowser(target);
  });

  // 既に動いている fastmd-explorer がポートを使っている (md を続けてダブルクリック
  // したときなど) → 新しくサーバを立てず、そちらにファイルを渡してウィンドウだけ開く。
  // 同じブラウザプロファイルの --app は既存のブラウザに相乗りするので、2 つ目以降は速い。
  httpServer.on('error', async (err) => {
    if (err.code === 'EADDRINUSE' && await forwardToRunning(PORT, initialFile)) process.exit(0);
    console.error(`起動に失敗しました: ${err.message}`);
    process.exit(1);
  });
}

async function openInBrowser(url) {
  try {
    const { default: open } = await import('open');
    await open(url);
  } catch { /* ignore */ }
}

/**
 * ポートを使っているのが fastmd-explorer なら、ファイルを渡して新しいウィンドウを開く。
 * 相手が fastmd-explorer でない / 応答しないときは false。
 */
async function forwardToRunning(port, file) {
  const base = `http://127.0.0.1:${port}`;
  let status;
  try {
    const r = await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(3000) });
    status = await r.json();
  } catch { return false; }
  if (status?.app !== 'fastmd-explorer') return false;

  let path = '/';
  if (file) {
    try {
      const r = await fetch(`${base}/api/open-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
        signal: AbortSignal.timeout(3000),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? r.statusText);
      path = j.url;
    } catch (e) {
      console.error(`ファイルを渡せませんでした: ${e.message}`);
    }
  }
  const url = base + path;
  if (status.windowMode && launchAppWindow(url, getConfig().windowBounds)) return true;
  await openInBrowser(url);
  return true;
}

main();

/**
 * 起動引数 (argv[2]) を初期表示ターゲットに解釈する。
 * - http(s):// で始まれば URL モード
 * - それ以外は絶対パス化し、実在するフォルダならフォルダモード、
 *   md ファイルなら親フォルダを開いてそのファイルを表示する
 * 不正な引数は無視して従来どおり (前回状態の復元) 起動する。
 */
function parseTargetArg(arg) {
  const none = { initialRoot: null, initialUrl: null, initialFile: null };
  if (!arg) return none;
  if (/^https?:\/\//i.test(arg)) return { ...none, initialUrl: arg };
  try {
    const abs = resolve(arg);
    const st = existsSync(abs) ? statSync(abs) : null;
    if (st?.isDirectory()) return { ...none, initialRoot: abs };
    if (st?.isFile() && MD_FILE_RE.test(abs)) {
      return { ...none, initialRoot: dirname(abs), initialFile: abs };
    }
    console.error(`指定パスが見つからないか、フォルダでも md ファイルでもありません: ${arg}`);
  } catch (err) {
    console.error(`起動引数の解釈に失敗しました: ${err.message}`);
  }
  return none;
}

/**
 * Edge / Chrome を「アプリモード」(--app) で起動し、アドレスバーの無い
 * 単体ウィンドウを開く。見つかれば true、無ければ false を返す。
 */
function launchAppWindow(url, bounds) {
  const pf   = process.env['ProgramFiles'] ?? '';
  const pf86 = process.env['ProgramFiles(x86)'] ?? '';
  const local = process.env['LOCALAPPDATA'] ?? '';

  const candidates = [
    join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(pf,   'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(local,'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  // アプリ専用のブラウザプロファイルを使う。
  // 理由: 既定プロファイルだと (1) ユーザーが普段 Edge を開いていると --app が
  // 既存プロセスに相乗りしてウィンドウサイズが記憶/復元されない、
  // (2) 既存セッションのサイズ記憶とも競合する。専用プロファイルなら常に独立
  // プロセスで起動し、そのプロファイル内でブラウザがアプリウィンドウのサイズ・
  // 位置を自前で記憶・復元する。localStorage (テーマ等) もここで永続化される。
  //
  // --disable-sync: 専用プロファイルに個人データが同期されるのを防ぐ
  //   (Edge の「同期しています」通知も出なくなる)。
  const profileDir = appHomePath('browser-profile');
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--disable-sync',
    '--no-first-run',
    '--no-default-browser-check',
  ];

  // 前回保存したウィンドウの位置・サイズを明示復元する。
  // 専用プロファイルは毎回独立プロセスで起動するため、これらの起動フラグが
  // 確実に効く (ブラウザ任せの記憶は環境により効かないため明示指定する)。
  if (bounds && Number.isFinite(bounds.width) && Number.isFinite(bounds.height)) {
    args.push(`--window-size=${Math.round(bounds.width)},${Math.round(bounds.height)}`);
    if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
      args.push(`--window-position=${Math.round(bounds.x)},${Math.round(bounds.y)}`);
    }
  }

  for (const exe of candidates) {
    if (!exe || !existsSync(exe)) continue;
    try {
      const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    } catch { /* 次の候補へ */ }
  }
  return false;
}

function getLanAddresses() {
  const addrs = [];
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      // IPv4 のみ、loopback 除外
      if (iface.family === 'IPv4' && !iface.internal) {
        addrs.push(iface.address);
      }
    }
  }
  return addrs;
}
