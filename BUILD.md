# ビルド手順

`git clone` / `git pull` した環境から配布用 exe をビルドする手順です。
利用者向けの説明は [README](README.md) を参照してください。

---

## 前提

| 必要なもの | 補足 |
|---|---|
| **Node.js 18 以上** | pkg のターゲットが `node22-win-x64`。ビルドマシンは v20〜24 が無難 |
| **pnpm**（corepack 経由） | `package.json` の `packageManager: pnpm@11.1.3` で pin 済み。corepack が自動で合わせる |
| **インターネット接続** | 初回 `pnpm install` と、pkg が Node バイナリ (`node22-win-x64`) を初回 DL するため |
| **Windows**（推奨） | exe 実行・フォルダピッカー (powershell) は Windows 前提。クロスビルドは下記参照 |

---

## 手順

```powershell
# 1. 取得
git clone https://github.com/lancard-aikawa/fastmd-explorer.git
cd fastmd-explorer

# 2. pnpm を有効化 (Node 16.10+ に corepack 同梱)
corepack enable

# 3. 依存をインストール
pnpm install

# 4. exe をビルド
pnpm run build
```

完了後、`dist/fastmd-explorer.exe`（約 64MB）が生成されます。

---

## ビルドの内訳（`pnpm run build`）

| ステップ | スクリプト | 内容 |
|---|---|---|
| 1. bundle | `pnpm run build:bundle` | esbuild が ESM を CJS にバンドル → `src/_bundle.cjs` + `src/.pkgrc.json` を生成 |
| 2. exe | `pnpm run build:exe` | `@yao-pkg/pkg` が Node ランタイム同梱の exe を生成 → `dist/fastmd-explorer.exe` |
| 3. patch | `pnpm run build:patch` | exe の PE サブシステムを GUI 化（ダブルクリック時にコンソール窓を出さない） |

中間生成物（`src/_bundle.cjs`、`src/.pkgrc.json`、`dist/`）は `.gitignore` 済みです。

---

## 注意点・ハマりどころ

- **サプライチェーン cooldown が効く**
  [`pnpm-workspace.yaml`](pnpm-workspace.yaml) の `minimumReleaseAge: 10080`（7日）により、
  公開後 7 日未満のパッケージは解決対象外になります（意図的な設定）。
  緊急で最新版が要るときは `pnpm add <pkg> --config.minimumReleaseAge=0` で個別上書き。

- **esbuild の postinstall 許可**
  同じく `pnpm-workspace.yaml` の `allowBuilds: { esbuild: true }` で許可済み。
  リポジトリをそのまま pull していれば追加設定は不要です。

- **pkg の初回ダウンロード**
  1 回目のビルドのみ、pkg が `node22-win-x64` のベースバイナリを取得するため時間がかかります
  （以降は `PKG_CACHE_PATH`、既定で `~/.pkg-cache` にキャッシュ）。

- **`Cannot resolve 'mod'` という警告**
  Express の view engine 由来の警告で、このアプリでは無害です（`res.render` を使っていない）。

- **再現性を厳密にしたい場合**
  CI 等では `pnpm install --frozen-lockfile` を使ってロックファイルを尊重します。

- **exe がロックされてビルドが失敗する場合**
  起動中の `fastmd-explorer.exe` が `dist/` の exe をロックしていることがあります。
  プロセスを終了してから再ビルドしてください（`EPERM: operation not permitted, unlink` が目印）。

---

## クロスビルド（Linux / macOS から Windows exe）

`@yao-pkg/pkg` はクロスビルド対応で、`build:patch`（PE 書換）も OS 非依存のため、
Linux / macOS から `node22-win-x64` の exe を生成できます。
ただし確実性を重視するなら **Windows 環境（または Windows CI ランナー）** での
ビルドを推奨します。

---

## CI（GitHub Actions）の骨子

```yaml
- uses: actions/checkout@v4
- uses: pnpm/action-setup@v4          # package.json の packageManager pin を読む
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm }
- run: pnpm install --frozen-lockfile
- run: pnpm run build
- uses: actions/upload-artifact@v4
  with: { name: fastmd-explorer-exe, path: dist/fastmd-explorer.exe }
```

---

## リリース（参考）

```powershell
# バージョンを上げる (package.json の version)
# 変更を main にマージ後:
git tag -a v1.0.x -m "..."
git push origin v1.0.x
pnpm run build
gh release create v1.0.x dist/fastmd-explorer.exe --title "..." --notes "..."
```
