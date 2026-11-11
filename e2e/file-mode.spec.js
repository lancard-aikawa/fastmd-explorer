import { test, expect } from '@playwright/test';
import { join } from 'path';
import { makeTempRoot, openFolder } from './helpers.js';

// md のダブルクリック (fastmd-explorer.exe <file.md>) で開く「単体」表示。
// 2 つ目以降は cli.js が POST /api/open-file で動いているサーバにファイルを渡し、
// 返った URL (/?file=...&root=...) をウィンドウで開く。ここではその URL を直接開く。

let a, b;
test.beforeEach(() => {
  a = makeTempRoot({ 'a1.md': '# 文書A1\n' });
  b = makeTempRoot({
    'readme.md': '# 単体で開く\n\n```mermaid\ngraph LR\n  X --> Y\n```\n',
    'other.md': '# 別の文書\n',
    'sub/deep.md': '# 深い文書\n',
  });
});
test.afterEach(() => { a.dispose(); b.dispose(); });

async function openFileUrl(request, absPath) {
  const res = await request.post('/api/open-file', { data: { path: absPath } });
  expect(res.ok()).toBeTruthy();
  return (await res.json()).url;
}

test('md ファイルを単体で開くと、そのファイルと親フォルダのツリーが出る', async ({ page, request }) => {
  const url = await openFileUrl(request, join(b.root, 'readme.md'));
  await page.goto(url);

  await expect(page.locator('#preview-content h1')).toHaveText('単体で開く');
  // mermaid は遅延読み込みでも描ける
  await expect(page.locator('#preview-content .mermaid svg')).toBeVisible();
  // ツリーは後から読まれる
  await expect(page.locator('.tree-file[data-rel="other.md"]')).toBeVisible();
  await expect(page.locator('.tree-file[data-rel="readme.md"]')).toHaveClass(/active/);
});

test('図の無いページでは mermaid を読み込まない', async ({ page, request }) => {
  const url = await openFileUrl(request, join(b.root, 'other.md'));
  await page.goto(url);
  await expect(page.locator('#preview-content h1')).toHaveText('別の文書');
  expect(await page.evaluate(() => typeof window.mermaid)).toBe('undefined');
});

test('別フォルダのウィンドウ同士でツリーが混ざらない', async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const pageA = await ctx.newPage();
  await openFolder(pageA, a.inputPath);
  await expect(pageA.locator('.tree-file[data-rel="a1.md"]')).toBeVisible();

  // 別ウィンドウで B の md を単体で開く
  const pageB = await ctx.newPage();
  await pageB.goto(await openFileUrl(request, join(b.root, 'readme.md')));
  await expect(pageB.locator('.tree-file[data-rel="other.md"]')).toBeVisible();
  // ステータスバーはサーバの「最後に開いたフォルダ」(A) でなく、このウィンドウのフォルダ
  const tail = (p) => p.slice(-20);
  await expect(pageB.locator('#status-folder')).toContainText(tail(b.root));

  // A のウィンドウで再読み込み相当 (ツリー再取得) をしても A のまま
  await pageA.locator('#btn-refresh').click();
  await expect(pageA.locator('.tree-file[data-rel="a1.md"]')).toBeVisible();
  await expect(pageA.locator('.tree-file[data-rel="other.md"]')).toHaveCount(0);

  // B 側で全文検索しても B のファイルが当たる
  const r = await pageB.evaluate(async (root) => {
    const res = await fetch('/api/files', { headers: { 'X-Root': encodeURIComponent(root) } });
    return (await res.json()).fileCount;
  }, b.root);
  expect(r).toBe(3);
  await ctx.close();
});

test('登録していないルートを X-Root に書いても使われない', async ({ request }) => {
  const res = await request.get(`/api/file?path=${encodeURIComponent(join(a.root, 'a1.md'))}`, {
    headers: { 'X-Root': encodeURIComponent(a.root) },
  });
  // a はまだ開いていない (open-file も /api/folder もしていない) → 現在のルート扱いになり範囲外
  expect(res.status()).toBe(403);
});

test('md 以外は単体で開けない', async ({ request }) => {
  const res = await request.post('/api/open-file', { data: { path: b.root } });
  expect(res.status()).toBe(400);
});
