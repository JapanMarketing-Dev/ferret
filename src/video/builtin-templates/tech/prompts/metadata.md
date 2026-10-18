# 投稿の内容（publish.json）

投稿する内容は、すべてプロジェクト直下の `publish.json` に書く。アプリの投稿画面はこのファイルを表示し、人が「OK・投稿する」を押すと、このファイルの内容で投稿される。

```json
{
  "video": "renders/youtube/final.mp4",
  "thumbnail": "thumbnails/thumb-1.png",
  "title": "…",
  "description": "…",
  "tags": ["…"],
  "youtube": { "categoryId": "28", "privacy": "private", "madeForKids": false, "containsSyntheticMedia": false, "chapters": true },
  "tiktok": { "enabled": false, "caption": "…", "privacy": "SELF_ONLY", "allowComment": false, "allowDuet": false, "allowStitch": false, "isAigc": false }
}
```

- `ferret-video meta set --title "…" --description "…" --tags a,b` で書ける（`--file meta.json` で一度に渡してもよい）。`ferret-video meta show` で確認する。直接編集してもよいが、最後に `ferret-video meta check` で形を確かめる
- タイトルは 100 字まで（目安 30〜45 字）。動画で分かること・できるようになることを具体的に。誇張・釣りは書かない
- 説明文は 5000 字まで。最初の 2 行に要点。チャプター（`youtube.chapters: true` なら outline から 00:00 形式で自動で足される）と、素材のクレジットは CLI が最後に足す
- タグは 5〜15 個。製品名・技術名・やったこと
- 公開範囲（privacy）は、人が指定していなければ private のまま。TikTok に出すかどうか（tiktok.enabled）も、人が指定していなければ false のまま
- 動画は1本だけ。縦型の別バージョンや、ほかの投稿は作らない
- 投稿はしない。投稿は人が投稿画面で OK を押してから行う
