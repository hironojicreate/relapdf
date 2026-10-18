# RelaPDF

ブラウザの中だけで動くPDFアプリです。ファイルは端末の外に出ません。

- **スマホ・タブレット（かんたんモード）**：撮った写真を3ステップでPDFに。「撮る/選ぶ → 確認・補正 → 保存/送る」
- **PC（詳細モード）**：結合・ページ整理・分割などのPDF編集

単一HTMLのPWAとして作り、オフラインでも動きます。

> 開発中です（現在 M0：設計とテスト環境）。進み具合は [docs/handover.md](docs/handover.md) を見てください。

## ドキュメント

| ファイル | 内容 |
|---|---|
| [docs/handover.md](docs/handover.md) | 引継書。今の状態・次にやること・注意点 |
| [docs/design.md](docs/design.md) | 設計の基本方針と決定事項 |
| [docs/page-list.md](docs/page-list.md) | ページリスト（中心となるデータ構造）の仕様 |
| [docs/roadmap.md](docs/roadmap.md) | 機能一覧・段階ごとの計画・今後の課題 |

## フォルダ構成

```
index.html      アプリ本体（画面）
src/core/       Core層：ページリストの操作やPDF生成。画面に触らない
tests/core/     Core層のテスト（Node.jsで実行）
docs/           設計書・引継書
```

## テストの実行

Node.js 22 以上が必要です。外部のパッケージは使っていません。

```sh
npm test
```

## ライセンス

[MIT](LICENSE)
