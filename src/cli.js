#!/usr/bin/env node
import { resolve } from 'path';
import { networkInterfaces } from 'os';
import { createServer } from './server.js';
import { loadConfig, loadLocalConfig, serverConfig } from './configManager.js';

await Promise.all([loadLocalConfig(), loadConfig()]);

const cfg  = serverConfig();
const PORT = parseInt(process.env.PORT    ?? cfg.port,    10);
const MODE = (process.env.NETWORK ?? cfg.network ?? 'local').toLowerCase();
const HOST = MODE === 'lan' ? '0.0.0.0' : '127.0.0.1';

const app = createServer();

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

  if (!process.env.NO_OPEN) {
    try {
      const { default: open } = await import('open');
      await open(local);
    } catch { /* ignore */ }
  }
});

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
