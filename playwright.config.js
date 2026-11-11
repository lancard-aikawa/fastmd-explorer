import { defineConfig } from '@playwright/test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// E2E 用のポート。開発中のインスタンス (既定 13847) と衝突させない。
const PORT = Number(process.env.E2E_PORT ?? 13998);

// ユーザーデータ (履歴・タグ・キャッシュ) の隔離先。
// これを渡さないとテストのたびに実際の ~/.mdexplorer が書き換わる。
const DATA_HOME = mkdtempSync(join(tmpdir(), 'mdx-e2e-home-'));

export default defineConfig({
  testDir: './e2e',
  // 同じサーバの currentRoot / タブ状態を共有するため直列実行する。
  // X-Root を送らない要求は、サーバの「最後に開いたフォルダ」を使うため。
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    // 既にインストール済みのシステム Chrome を使う。
    // Playwright 同梱ブラウザを落とすと 150MB 超のダウンロードが要る。
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  webServer: {
    command: 'node src/cli.js',
    url: `http://127.0.0.1:${PORT}/api/status`,
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      NO_OPEN: '1',        // 既定ブラウザを開かない
      WINDOW: '0',         // ウィンドウモード無効 (アイドル自動終了を避ける)
      NETWORK: 'local',
      MDEXPLORER_HOME: DATA_HOME,
    },
  },
});
