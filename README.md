# RelaPDF

ブラウザの中だけで動くPDFアプリです。ファイルは端末の外に出ません。

- **スマホ・タブレット（かんたんモード）**：撮った写真を3ステップでPDFに。「撮る/選ぶ → 確認・補正 → 保存/送る」
- **PC（詳細モード）**：結合・ページ整理・分割などのPDF編集

単一HTMLのPWAとして作り、オフラインでも動きます。

> 開発中です（現在 M1：土台）。進み具合は [docs/handover.md](docs/handover.md) を見てください。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/handover.md](docs/handover.md) | 引継書。今の状態・次にやること・注意点 |
| [docs/design.md](docs/design.md) | 設計の基本方針と決定事項 |
| [docs/page-list.md](docs/page-list.md) | ページリスト（中心となるデータ構造）の仕様 |
| [docs/roadmap.md](docs/roadmap.md) | 機能一覧・段階ごとの計画・今後の課題 |

## フォルダ構成

```
index.html              アプリ本体（画面の骨組みとCSS）
manifest.webmanifest    PWAの設定（アプリ名・アイコン）
sw.js                   Service Worker（オフライン対応）
precache-manifest.js    キャッシュするファイルの一覧（自動生成）
src/core/               Core層：ページリストの操作やPDF生成。画面に触らない
src/web/                ブラウザ側の部品：画像の読み込み、PDFの表示、保存
src/app/                画面の動き
vendor/                 同梱ライブラリ（pdf-lib、PDF.js）
icons/                  アイコン
scripts/                開発用の道具（キャッシュ一覧・アイコンの作成）
tests/                  テスト（core・web・tools は Node.js、e2e は Playwright）
docs/                   設計書・引継書
```

## 動かす・テストする

Node.js 22 以上が必要です。

```sh
npm install          # 画面テスト用の Playwright を入れる（初回だけ）
npm run serve        # http://localhost:4173/ でアプリを開ける
npm test             # Core などのテスト（速い）
npm run test:e2e     # 画面テスト（PC・Android・iPhone の画面を再現）
npm run precache     # ファイルを変えたあと、オフライン用のキャッシュ一覧を作り直す
```

## ライセンス

[MIT](LICENSE)
