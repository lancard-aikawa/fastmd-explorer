# ビルド手順

`git clone` / `git pull` した環境から配布用 exe をビルドする手順です。
利用者向けの説明は [README](README.md) を参照してください。

---

## 前提

| 必要なもの | 補足 |
|---|---|
| **Node.js 18 以上** | pkg のターゲットが `node22-win-x64`。ビルドマシンは v20〜24 が無難 |
| **pnpm**（corepack 経由） | `package.json` の `packageManager` で pin 済み（現在 pnpm 11.5.0）。corepack が自動で合わせる |
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
| 2. exe | `pnpm run build:exe` | Node 本体の複製にアイコンと版情報を入れ（`.cache/pkg-base/`）、`@yao-pkg/pkg` がそれを使って exe を生成 → `dist/fastmd-explorer.exe`（[`scripts/build-exe.mjs`](scripts/build-exe.mjs)） |
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

- **同梱アセットの定義は `scripts/build-bundle.mjs` が唯一の正**
  exe に同梱するアセット一覧は [`scripts/build-bundle.mjs`](scripts/build-bundle.mjs) が
  `src/.pkgrc.json` として生成し、pkg が entry の隣から auto-discover します。
  `/vendor` で配信する依存を追加したら**必ずここに追記**してください
  （漏れると dev では動くのに exe だけ 404 になります）。
  `package.json` の `pkg.assets` は pkg に読まれないため置いていません。

- **アイコンは pkg が包む前の Node 本体に入れる**
  pkg は同梱データの位置をファイル先頭からの絶対位置で exe に埋め込みます。
  できあがった exe のリソース（アイコン）を後から書き換えると位置がずれ、起動できなくなります。
  そのため [`scripts/build-exe.mjs`](scripts/build-exe.mjs) が、pkg-fetch で取った正規の Node 本体
  （ハッシュ照合済み）を `.cache/pkg-base/` に複製し、resedit でアイコンと版情報を入れてから、
  `PKG_NODE_PATH` でその複製を pkg に渡します。PE サブシステムの書き換え（3. patch）は
  ヘッダの 1 バイトだけなので、包んだあとでも問題ありません。
  アイコンの図案を変えるときは `uv run --no-project --with pillow python scripts/make-icon.py`
  で `assets/icon.ico` と `public/favicon.ico`（ウィンドウのアイコン）を作り直します。

- **ビルド中に `EPERM: operation not permitted, unlink 'dist\fastmd-explorer.exe'`**
  `dist/fastmd-explorer.exe` が動いています。そのウィンドウを全部閉じてからビルドします。

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
