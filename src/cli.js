#!/usr/bin/env node
import { join } from 'path';
import { networkInterfaces, tmpdir } from 'os';
import { existsSync, createWriteStream } from 'fs';
import { spawn } from 'child_process';
import { createServer } from './server.js';
import { loadConfig, loadLocalConfig, serverConfig, getConfigPaths } from './configManager.js';

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

  const startedAt = Date.now();
  const { localConfigPath, globalConfigPath } = getConfigPaths();
  const app = createServer({
    port: PORT, host: HOST, mode: MODE, startedAt,
    localConfigPath, globalConfigPath,
    windowMode: WINDOW_MODE,
    onIdle: () => process.exit(0),
  });

  app.listen(PORT, HOST, async () => {
    const local = `http://127.0.0.1:${PORT}`;
    console.log(`\nfastmd-explorer`);
    console.log(`  local  →  ${local}`);

    if (MODE === 'lan') {
      console.log('\n  ⚠  LAN モード: ネットワーク上の全デバイスからアクセス可能です');
      getLanAddresses().forEach((ip) => {
        console.log(`  lan    →  http://${ip}:${PORT}`);
      });
    }

    console.log();

    if (process.env.NO_OPEN) return;

    if (WINDOW_MODE && launchAppWindow(local)) return;

    // 通常モード (またはアプリモード起動に失敗): 既定ブラウザのタブで開く
    try {
      const { default: open } = await import('open');
      await open(local);
    } catch { /* ignore */ }
  });
}

main();

/**
 * Edge / Chrome を「アプリモード」(--app) で起動し、アドレスバーの無い
 * 単体ウィンドウを開く。見つかれば true、無ければ false を返す。
 */
function launchAppWindow(url) {
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

  for (const exe of candidates) {
    if (!exe || !existsSync(exe)) continue;
    try {
      const child = spawn(exe, [`--app=${url}`, '--window-size=1280,860'], {
        detached: true,
        stdio: 'ignore',
      });
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
