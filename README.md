# os0x Monitor — 日本語ダッシュボード

[os0x.com](https://os0x.com/) から利用する、日本語向けのセルフホスト版です。
[World Monitor v2.11.3](https://github.com/koala73/worldmonitor/releases/tag/v2.11.3)
を基に、日本語ニュース、匿名で使える見出し翻訳と要約、国内市場表示、既存設定の移行を加えています。
上流の公式サービスとは別の運用です。

**対応するソースコード：[hirorylabo/os0x-monitor](https://github.com/hirorylabo/os0x-monitor)。**
ライセンスは [AGPL-3.0-only](LICENSE) です。上流の著作権・ライセンス・出典表示を保持します。
World Monitor の公式クラウドサービス、商用プラン、名称・ロゴの利用条件は、ソースコードのライセンスとは別です。
[上流プロジェクト](https://github.com/koala73/worldmonitor) と
[上流ドキュメント](https://www.worldmonitor.app/docs/documentation) にも帰属します。

## この配備で扱う機能

- 日本語UIと日本語ニュース。海外の見出し・本文抜粋は日本語に翻訳し、失敗時は原文を表示します。
- 日本語のニュース要約。配備先自身のGemini/Groqキーと予算を使い、上流の有料API判定は変更しません。
- 地図、主要市場、暗号資産、地震、自然災害、予測市場。取得に失敗したデータや未設定の機能は空欄・利用不可になる場合があります。
- ニュースキャッシュと、主要データ5系統の定期更新。更新結果は書き込みと実際のRPC読取まで確認します。

通常パネルの表示数はこのforkのカタログ全体を許容し、画面外のパネルは順次描画します。保存済みの非表示設定、ソース件数の上限、有料APIの利用条件は維持します。

最新版の画面が表示されても、上流サービスと同じデータがそろうわけではありません。
軍用機・船舶、紛争データ、CII/CRI、各国の詳細統計、AI予測などには、それぞれの取得元、APIキー、Redisシード、継続実行するworkerが必要です。
このforkのキャッシュ更新は**市場・暗号資産・地震・予測市場・自然災害**を対象とし、すべての上流シーダーを置き換えるものではありません。
FREDとAISはサーバーの設定状況を確認して有効化します。
デスクトップ版、公式MCP/APIプラン、Clerk/Convex/Dodoによる課金基盤の運営は、この配備の対象に含めていません。

## 開発とビルド

Node.js 24（[.nvmrc](.nvmrc)）を使用します。

```sh
nvm use
npm ci --ignore-scripts
npm run inventory:facts
npm run dev
```

開発サーバーは通常 [localhost:3000](http://localhost:3000) です。`npm run dev` は画面の開発用で、VercelのサーバーAPIや実データ取得の証明にはなりません。
APIを含む確認はVercel Previewで行います。秘密情報は配備先の環境変数、またはGit管理外の `.env.local` に設定してください。

```sh
npm run typecheck
npm run typecheck:middleware
npm run typecheck:api
npm run lint:boundaries
npm run test:os0x
node --import tsx --test tests/os0x-cache-warm.test.mts tests/os0x-runtime-capabilities.test.mts tests/os0x-qstash-schedule.test.mjs
npm run build:os0x
```

`build:os0x` は、この配備向けのViteダッシュボードを `dist/` に作ります。
上流の `build:full` は公式サイトのマーケティング・ブログ・公開コーパスなども生成するため、このforkのVercel Build Commandには使いません。
フロントだけの静的公開では `/api/*` は動きません。Vercelにはリポジトリ全体からデプロイしてください。

## 環境変数

値やキーをREADME、ログ、コミットに書かないでください。設定項目の全体は [.env.example](.env.example) を参照します。

| 用途 | 変数名 |
|---|---|
| 日本語の初期表示 | `VITE_LOCALE` |
| RedisキャッシュとAI制限 | `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` |
| 匿名ブラウザーセッション | `WM_SESSION_SECRET` |
| Gemini認証 | `GEMINI_API_KEY` または `GEMINI_AISTUDIO_API_KEY`、既存の `GEMINI_AISTUDIO_API_KEY_01`〜`03` / `gemini_aistudio_api_key_01`〜`03` も使用可能 |
| Groq認証 | `GROQ_API_KEY` または `GROQ_API_KEY_01` |
| 使用モデルと日次上限 | `OS0X_GEMINI_MODEL`, `OS0X_GROQ_MODEL`, `OS0X_AI_DAILY_LIMIT` |
| キャッシュ更新の認証・接続先 | `CACHE_WARM_SECRET`, `APP_BASE_URL` |
| QStash操作 | `QSTASH_TOKEN`、必要に応じて `QSTASH_URL`, `QSTASH_SCHEDULE_ID` |
| 追加データ | `FINNHUB_API_KEY`, `ALPHA_VANTAGE_API_KEY`, `FRED_API_KEY`, `WS_RELAY_URL` など、使う機能の設定のみ |

既定のAI経路はGemini 3.5 Flash-Lite、失敗時はGroq GPT-OSS 20Bです。
モデルは環境変数で変更でき、1リクエストにつき各providerへ最大1回だけ試行します。
翻訳は最大12件をまとめて処理し、入力を黙って切り捨てません。
AIの制限判定に必要なRedisへ接続できない場合は、providerへの課金対象呼出しを停止します。

## Previewから本番への更新

1. 現在の本番Deployment ID、Git SHA、変更する環境変数名、対象QStashジョブのIDと送信先を控えます。値を作業記録へ転記しないでください。
2. 更新ブランチをPreviewへデプロイします。Node 24、Build Command `npm run build:os0x`、Output Directory `dist` を使用します。Preview用の変数はPreview環境に設定します。
3. 画面を実際に開き、JA表示、ニュース、12件を超える翻訳、匿名要約、日経・為替などの市場表示、地図操作、保存済み設定を確認します。providerやAPIが停止している場合は原文・利用不可表示への復帰も確認します。
4. `/api/runtime-capabilities` は機能の真偽値のみを返します。`/api/refresh-cache` の認証付きGETはdry-runです。認証付きPOSTは実際にシードを書き込むため、対象DeploymentとRedisを確認してから実行します。
5. キャッシュ更新のレスポンスにある各 `results[].ok`、件数、日時、および画面が読むRPCの内容を確認します。HTTP 200だけ、画面の起動だけを成功条件にしないでください。
6. Previewの確認後に本番へ切り替え、同じ確認を本番URLで実施します。既存のQStash送信先が本番エイリアスなら、Deploymentの変更だけでジョブを書き換える必要はありません。

Previewで本番Redisを共有する場合、POSTによる更新は本番データにも反映されます。
可能ならPreview用Redisを分け、上流公式サービスのRedisや認証情報を流用しないでください。

## QStashジョブの管理

`QSTASH_URL` はコンソールのQuickstartに表示されたリージョンのAPI originを指定します。
未指定時は `https://qstash.upstash.io`、EUの例は `https://qstash-eu-central-1.upstash.io` です。
HTTPSのQStashホストのみ受け付け、パス・認証情報・クエリ付きURLは拒否します。

```sh
npm run setup:qstash-schedule -- --dry-run
```

これは既存ジョブを読み取り、変更対象を確認するだけです。`--apply` を付けた場合だけ登録・更新します。
対象は `APP_BASE_URL` の `/api/refresh-cache` と完全一致するジョブに限定されます。
同じ送信先が複数ある場合は `QSTASH_SCHEDULE_ID` を指定し、別サービスのジョブを削除しないでください。

```sh
npm run setup:qstash-schedule -- --apply
```

適用後のジョブは30分ごとのPOST、再試行は2回です。`CACHE_WARM_SECRET` をAuthorizationに転送します。
送信先は確認済みの本番配備を指定し、Previewの一時URLを定期ジョブに残さないでください。
QStash操作はCIやビルドから自動実行しません。

## ロールバック

問題が出たらVercelで控えておいた正常なDeploymentを本番へ戻し、JA画面・ニュース・RPCを再確認します。
コードのロールバックはRedisやQStashの変更を戻さないため、送信先やシークレットも変更した場合は、対象ジョブだけを以前の設定へ戻してください。
キャッシュは名前空間とTTLで分離し、ロールバック時にもRedis全体の削除は行いません。

## CIと上流追従

有効なGitHub Actionsは [.github/workflows/os0x-ci.yml](.github/workflows/os0x-ci.yml) のみです。
Node 24で依存関係を固定インストールし、型検査、境界lint、fork向けテスト、`build:os0x` を実行します。
CIには本番キーを渡さず、公開・デプロイ・QStash変更は行いません。
ニュース取得元やAPIの参照先を変えた場合は `npm run sources:generate` と
`npm run inventory:facts` で出典・生成情報を更新し、`npm run docs:check` を通してください。

上流の定期監視、Railway/Cloudflare/Convexデプロイ、desktop release、package publishingは
[.github/upstream-workflows/](.github/upstream-workflows/) に移して保存しています。
復帰するときは必要なファイルだけをレビューし、送信先・権限・トリガーを確認します。
上流追従は安定版タグを固定し、日本語・翻訳・要約・市場・設定移行・更新ジョブの差分を確認してから取り込みます。
