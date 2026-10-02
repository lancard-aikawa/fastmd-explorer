# 変更履歴

本ファイルの形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、
本プロジェクトは [セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

各リリースの配布物 (exe) は [Releases](https://github.com/lancard-aikawa/fastmd-explorer/releases) を参照してください。

## [未リリース]

## [1.8.1] - 2026-10-02

依存パッケージの脆弱性に対応したリリース。機能の変更はない。

### セキュリティ
- 依存パッケージを更新し、`pnpm audit` で報告されていた脆弱性（critical 1 / high 4 / moderate 19 / low 7）を解消した。主なものは mermaid 10.9.8（設定 API のプロトタイプ汚染、および同梱の DOMPurify・lodash-es・uuid）、DOMPurify 3.4.16、express 4.22.3（path-to-regexp・body-parser・qs）。
- ビルドツールの @yao-pkg/pkg 6.22.0（同梱の tar）と esbuild 0.28.2 を更新した。配布する exe には影響しないが、ビルド環境の脆弱性を解消する。

## [1.8.0] - 2026-07-27

コードレビューで見つかった問題をまとめて修正したリリース。ローカルのファイルを
読み書きする API を持つツールとして、到達経路の検証を全面的に見直した。

### セキュリティ
- **ルート外のファイルを読み書き・削除できる問題を修正。** パス検証がドライブをまたぐと無効化されていた。Windows の `path.relative()` はドライブが違うと相対パスを作れず引数をそのまま返すため、開いているフォルダが `C:` のときに `D:` 以下のパスが検証を素通りしていた。`/api/file`（読み書き）・`/api/preview`・`/api/image`・`/api/fs/rename`・`DELETE /api/fs` が対象。
- **画像の貼り付けでルート外へ書き込める問題を修正。** ファイル名の検証が拡張子のみだったため、`../../evil.png` のような名前でフォルダの検証を迂回できた。
- **Markdown から HTML を注入できる問題を修正。** mermaid ブロックの中身が未エスケープで埋め込まれており `</div>` で脱出できた。また wikilink（`[[...]]`）のリンク先で `"` がエスケープされておらず、属性を追加できた。
- **URL モードで開いたリモート Markdown をサニタイズするようにした。** 取得した HTML をアプリと同一オリジンにそのまま展開していたため、悪意ある Markdown を 1 つ開くだけでファイル操作 API をアプリの権限で叩けた。DOMPurify で `script` / `on*` / `javascript:` を除去する（サニタイザを読み込めない場合は表示しない）。ローカルフォルダの Markdown はこれまでどおり生の HTML を活かす。
- **LAN 公開モード（`network: "lan"`）にアクセストークンを追加。** 従来は同一ネットワークの誰でも認証なしでファイルの閲覧・編集・削除ができた。起動ごとにトークンを発行し、起動時に表示される URL からアクセスする。ローカル（127.0.0.1）からは従来どおりトークン不要。
- **DNS リバインディングと CSRF への対策を追加。** `Host` ヘッダと `Origin` ヘッダを検証する。ローカルモードでも有効。
- 警告バーがサーバのエラーメッセージを HTML として解釈していた問題を修正。ファイル名に HTML を含めることで注入できた。
- エラー応答がスタックトレースと内部の絶対パスを返さないようにした。

### 追加
- ユーザーデータ（履歴・タグ・ツリーキャッシュ・ブラウザプロファイル）の保存先を環境変数 `MDEXPLORER_HOME` で変更できるようにした。既定はこれまでどおり `~/.mdexplorer`。

### 修正
- **編集中の内容が無警告で失われる問題を修正。** 未保存のままフォルダを開き直す・モードを切り替える・ウィンドウを閉じると、確認なしに編集内容が破棄されていた。
- 本文中の相対リンクで `..` が解決されず、リンクを辿った後にタグの表示やツリーの選択状態がずれる問題を修正。
- フォルダ選択ダイアログを開いている間、サーバ全体が応答しなくなる問題を修正（最大 2 分間）。
- 全文検索と被参照の走査が、画面を離れた後もバックグラウンドで走り続ける問題を修正。検索は入力のたびに走査が積み重なっていた。
- 設定とタグの保存を中断に強くした。書き込み中にプロセスが終了すると内容が失われる可能性があった。
- 図（Mermaid）を含むファイルを開くたびにイベントリスナーが蓄積する問題を修正。
- シンボリックリンクの参照先判定が誤っていた問題を修正。
- ファイル名に `$` を含むフォルダやファイルをリネームすると、開いているタブのパスが壊れる問題を修正。
- ツリーとレンダリング結果のキャッシュに上限を設けた（長時間の使用でメモリが増え続けていた）。

## [1.7.1] - 2026-07-24

### 修正
- 外部でファイルが更新されても古い表示のままになる問題を修正。更新ボタン（`↺` / `Ctrl+R`）でツリーの再スキャンに加えて開いているファイルも再描画するようにし、`/api/preview`・`/api/image`・`/api/file` に `Cache-Control: no-store` を付与してブラウザキャッシュ由来の古い内容（特に画像）が出ないようにした。

## [1.7.0] - 2026-07-23

### 追加
- 起動引数の対応。`pnpm start <フォルダ|URL>` / `fastmd-explorer.exe <フォルダ|URL>` で指定した場所を開いた状態で起動する。不正な引数は警告して従来どおり前回状態で起動する。
- ツリーの矢印キー操作（↑↓ でカーソル移動 / Enter で開く / ←→ で展開・折りたたみ）。行クリックでもカーソルが追従する。

### 修正
- 履歴やフォルダピッカーから開き直した時に、古いツリー（キャッシュ）が表示される問題を修正。ルート直下の更新日時しか見ていなかったため、アプリを閉じている間の深い階層のファイル増減が反映されなかった。開き直しと起動引数での起動時は必ず再スキャンする。あわせて URL モードの取得結果をブラウザにキャッシュさせないようにした。

## [1.6.0] - 2026-07-03

### 追加
- HTML ファイル (.html/.htm) の閲覧表示（既定 OFF、ツールバーの「HTML」ボタンで表示/非表示を切替）。ページ自身の CSS/JS を保ったまま sandbox iframe で隔離表示するため、アプリのスタイルと衝突しない。Markdown 内のローカル html リンクからも同一ウィンドウ内で開ける。

## [1.5.2] - 2026-06-19

### 修正
- exe 版でリンク図 (🕸) が「cytoscape の読み込みに失敗しました」となる問題を修正。ビルド時のアセット一覧 (`.pkgrc.json`) に cytoscape と katex (CSS・フォント) が含まれておらず、exe に同梱されていなかった（dev では発生せず、v1.2.0〜v1.5.1 の exe が対象）。あわせて exe 版の LaTeX 数式のスタイル／フォントも修正。

## [1.5.1] - 2026-06-18

### 追加
- 印刷設定「YAMLヘッダー (front matter) の後で改ページする」（既定 OFF）。メタ情報を1ページ目に分離できる。

## [1.5.0] - 2026-06-18

### 追加
- 印刷設定（設定 ＞ 印刷タブ）。印刷／PDF出力時に反映され、印刷ボタン・Ctrl+P 双方で有効。
  - 見出しで改ページ（見出し1〜6から選択、2つ目以降が対象）
  - 水平線 (---) で改ページ
  - コード・表・画像・図をページ途中で分割しない
  - 見出しをページ末尾に単独で残さない
  - リンクの URL を併記
- 設定パネルを「印刷」「システム情報」の2タブ構成に変更。
- 印刷設定を試せるサンプル `PRINT-SAMPLE.md` を同梱。

### 変更
- 印刷時の水平線 (hr) を、縮小される印刷プレビューでも見えるよう濃く表示。

## [1.4.1] - 2026-06-17

### 変更
- 印刷／PDF出力時の既定保存名を、固定名から開いているファイル名に変更。

## [1.4.0] - 2026-06-09

### 追加
- URLモード。Webサーバ上の Markdown を直接閲覧できる。

## [1.3.0] - 2026-06-09

### 追加
- LaTeX 数式表示 (KaTeX) に対応。
- 機能サンプル `SAMPLE.md` を追加。

## [1.2.0] - 2026-06-09

### 変更
- リンク図を Cytoscape.js に置き換え、ズーム操作と PNG 保存を追加。

## [1.1.0] - 2026-06-08

### 追加
- リンク図（md 間の相互リンクの可視化）。
- 全 md 結合 PDF 出力。

### 変更
- 印刷を改善（ページ送り・図の配色・速度）。

## [1.0.3] - 2026-06-06

### 追加
- front matter (YAML ヘッダー) を GitHub 風テーブルで表示。

## [1.0.2] - 2026-05-29

### セキュリティ
- 脆弱性対応のため express・mermaid を更新。

## [1.0.1] - 2026-05-29

### 追加
- 単体ウィンドウ起動 (window モード)。
- テーマ・ウィンドウサイズの永続化、専用ブラウザプロファイル。

## [1.0.0] - 2026-05-29

### 追加
- 初回リリース。軽量な Markdown ファイルエクスプローラ／プレビューア。
  - フォルダ閲覧・ファイルツリー・ドラッグ&ドロップ
  - Markdown プレビュー（Mermaid 図、シンタックスハイライト）
  - タブ、アウトライン (ToC) の階層折り畳み、全文検索（リアルタイム進捗）
  - タグ・重要フラグ・メモ、Wiki リンク、バックリンク、ナビ履歴
  - 画像サムネイル・ビューワ、全画面表示、フォントサイズ調整、テーマ
  - 設定パネル・ステータスバー
  - 単一 exe ビルド (@yao-pkg/pkg + esbuild)、pnpm 化

[未リリース]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.8.1...HEAD
[1.8.1]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.8.0...v1.8.1
[1.8.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.7.1...v1.8.0
[1.7.1]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.7.0...v1.7.1
[1.7.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.6.0...v1.7.0
[1.6.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.5.2...v1.6.0
[1.5.2]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.5.1...v1.5.2
[1.5.1]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.5.0...v1.5.1
[1.5.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.4.1...v1.5.0
[1.4.1]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.4.0...v1.4.1
[1.4.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.3.0...v1.4.0
[1.3.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.2.0...v1.3.0
[1.2.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.1.0...v1.2.0
[1.1.0]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.0.3...v1.1.0
[1.0.3]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/lancard-aikawa/fastmd-explorer/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/lancard-aikawa/fastmd-explorer/releases/tag/v1.0.0
