# RelaPDF 開発メモ

- 作業を始める前に `docs/handover.md`（引継書）を読み、終わったら更新する
- 設計方針と決定事項は `docs/design.md`、データ構造は `docs/page-list.md`
- `src/core/` はDOMやブラウザ専用APIに触らない。操作は元の状態を変更せず新しい状態を返す
- コードのコメント・ドキュメントは日本語。テストは `npm test`
- ライブラリは `vendor/` に同梱する（CDNは使わない）。MIT/Apache/OFL系のみ、AGPL系は使わない
