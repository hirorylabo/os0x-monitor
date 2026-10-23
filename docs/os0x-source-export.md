# 対応ソースコードの公開

公開先は `hirorylabo/os0x-monitor`。private forkの履歴をpushせず、確認済みのコミットから独立した公開用リポジトリを作ります。
この手順はソースの準備用で、スクリプトはリポジトリの作成、Git初期化、commit、push、デプロイを行いません。

## 対象の固定と確認

1. 取り込む変更、生成物、LICENSE、READMEの出典・ソース導線を最終コミットへ含めます。ビルド・型検査・forkテスト・Preview確認の対象SHAを控えます。
2. 作業ツリーの候補スキャンは `node scripts/export-os0x-source.mjs --scan-worktree`。表示するのは種類、変数名、場所だけです。候補が出た場合はローカルで内容を確認し、実キーなら公開せず除去・必要な失効処理を行います。
3. 最終コミット後に `node scripts/export-os0x-source.mjs --ref HEAD` を実行します。`sourceCommit` が確認済みSHAと一致し、候補がなく、除外一覧が想定どおりであることを確認します。

スキャンは既知のキー形式と高エントロピーの認証情報リテラルを対象とする補助検査です。
一般的なサンプル値は除きますが、候補がないことだけで秘密情報がないと断定しません。
公開用ツリーを最後に人が確認し、環境ファイル、個人名・内部作業記録、画像・添付物も確認してください。

## 書き出し

```sh
node scripts/export-os0x-source.mjs --ref HEAD --write --output /tmp/os0x-corresponding-source
```

出力先はprivate checkoutの外にある、未作成のディレクトリを指定します。
`git archive` でコミット済みの許可パスだけを取り出し、ファイル一覧とSHA256を照合します。
出力には `.git` がなく、元リポジトリの履歴・remote・認証情報はコピーされません。
`SOURCE_EXPORT_MANIFEST.json` は対応元のcommit/tree、公開ファイルのhash、理由別の除外件数を記録します。内部ファイル名は公開manifestに残しません。

`src/`、`api/`、`server/`、`shared/`、`scripts/`、`public/`、`proto/`、schema、依存関係のlockfileとvendor、ビルド設定は保持します。
`AGENTS.md` は公開済み上流の文書契約として文書検証に必要なため保持します。
`.env.example` は設定項目のテンプレートとして保持します。
それ以外の `.env*`、`.vercel/`、認証・ローカル設定、agent作業領域、`task/`、内部メモ・検証画像は除外します。
シンボリックリンクとsubmoduleは黙って省略せず停止します。

## 公開前の確認

- 公開用ディレクトリで新しいGit履歴を開始し、ソースだけを最初のcommitにします。private forkのbranchやremoteを引き継ぎません。
- 公開用ツリーでもNode 24で `npm ci --ignore-scripts`、`npm run inventory:facts`、型検査、`npm run docs:check`、forkテスト、`npm run build:os0x` を確認します。本番の環境変数は渡しません。
- 公開先、README、LICENSE、アプリのソースリンクが一致していることを確認します。ビルドしたアプリの対応ソースが、認証なしで閲覧できる状態にしてから本番を切り替えます。
- 公開後は公開commit SHAと配備Deployment IDを記録します。以後の更新でも、private履歴を取り込まず、このexport手順で確認済みのソース差分だけを公開します。
