# fastmd-explorer

ドキュメントファーストなリポジトリのための、軽量 Markdown ファイルエクスプローラー。
フォルダを指定するだけで再帰的に `.md` ファイルを一覧表示し、GitHub ライクなプレビューを提供します。

---

## インストール

**動作要件:** Node.js 18 以上

```bash
git clone https://github.com/yourname/fastmd-explorer.git
cd fastmd-explorer
npm install
```

---

## 起動

```bash
# ブラウザを自動で開いて起動
npm start

# 開くフォルダをあらかじめ指定
npm start /path/to/your/docs
```

起動後、ブラウザで `http://127.0.0.1:13847` が開きます。

---

## 設定

プロジェクトルートに `mdexplorer.config.json` を作成して設定をカスタマイズできます。
サンプルをコピーして編集してください。

```bash
cp mdexplorer.config.json.sample mdexplorer.config.json
```

```jsonc
// mdexplorer.config.json
{
  "port": 13847,
  "network": "local",  // "local" = 自分のPCのみ | "lan" = LAN全体に公開
  "theme": "light"     // "light" | "dark"
}
```

> `mdexplorer.config.json` は `.gitignore` 済みです。環境ごとに異なる設定を安全に持てます。
> ポート・ネットワーク設定は環境変数でも上書きできます: `PORT=4000 NETWORK=lan npm start`

---

## 機能

### フォルダ選択と履歴

- ヘッダーのパス入力欄にフォルダパスを入力して **開く** または Enter
- 「履歴 ▾」ドロップダウンから過去に開いたフォルダをすぐに再選択
- 履歴は最大20件、`~/.mdexplorer/config.json` に自動保存

### ファイルツリー

- 選択フォルダを再帰的にスキャンし、`.md` ファイルを一覧表示
- `node_modules`、`.git`、隠しフォルダは自動スキップ
- ディレクトリはクリックで展開・折りたたみ
- `Ctrl+F` でファイル名・パスのインクリメンタル検索
- サイドバーの境界線をドラッグして幅を調整可能

### タブ表示

- ファイルを開くと VSCode 風のタブが追加される
- 複数ファイルを同時に開いておける
- 未保存の変更があるタブは `●` で表示
- タブの `×` ボタンまたは `Ctrl+W` で閉じる
- `Ctrl+Tab` / `Ctrl+Shift+Tab` でタブ切替

### Markdown プレビュー

- GitHub ライクなスタイルでレンダリング
- コードブロックのシンタックスハイライト（highlight.js）
- Mermaid 図（フローチャート、シーケンス図など）のレンダリング
- プレビュー内の `.md` リンクをクリックするとツリーからファイルを開く

### 編集

- `編集` ボタンまたは `Ctrl+E` でエディター表示に切替
- `Ctrl+S` で保存、保存後は自動的にプレビューに戻る
- `破棄` ボタンで編集内容を取り消し

### タグ・重要フラグ

- 各ファイルに自由なタグを付与（スペースはハイフンに自動変換）
- ☆ボタンまたは `Ctrl+I` で重要フラグを切替
- メモ欄に短いコメントを記入可能
- タグとフラグはフォルダ内の `.mdexplorer/tags.json` に保存
  - チームでリポジトリを共有する場合はこのファイルも commit すると共有できます

### テーマ

- `◐` ボタンでライト / ダーク テーマを切替

---

## キーボードショートカット

| ショートカット | 動作 |
|---|---|
| `Ctrl+F` | ファイル検索にフォーカス |
| `Ctrl+R` | ファイルツリーを再読み込み |
| `Ctrl+E` | 編集モードに入る |
| `Ctrl+S` | ファイルを保存（編集中のみ） |
| `Ctrl+I` | 重要フラグのオン/オフ |
| `Ctrl+Tab` | 次のタブへ |
| `Ctrl+Shift+Tab` | 前のタブへ |
| `Ctrl+W` | 現在のタブを閉じる |
| `Escape` | 編集を終了 / 検索をクリア |

---

## ファイル構成

```
fastmd-explorer/
├── src/
│   ├── cli.js               # エントリポイント
│   ├── server.js            # Express サーバー・API
│   ├── fileScanner.js       # 再帰スキャン・キャッシュ
│   ├── tagManager.js        # タグ管理
│   └── configManager.js     # 設定・履歴管理
├── public/
│   ├── index.html
│   ├── app.js
│   └── style.css
├── mdexplorer.config.json.sample   # 設定ファイルのテンプレート
└── package.json
```

---

## 注意事項

- **IPv6 無効:** サーバーは `127.0.0.1`（IPv4）にのみバインドします
- **ファイルシステム境界の警告:** WSL から Windows ネイティブFS（`/mnt/`）、ネットワークドライブ、異なるドライブへのアクセス時は警告を表示します
- **LAN 公開時のセキュリティ:** `"network": "lan"` はローカルネットワーク上の全端末からアクセス可能になります。信頼できるネットワークでのみ使用してください
