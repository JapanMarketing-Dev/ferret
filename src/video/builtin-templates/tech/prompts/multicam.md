# 画面と顔の切り替え

区間ごとに、画面と顔のどちらを主にするかを決める。`ferret-video edit setVideo` でレイアウトを、`setCamera` でカメラを選ぶ。使えるレイアウトは screen-with-wipe / screen-full / camera-full / scene。

## 基本: screen-with-wipe
- 画面を操作している・画面について話している区間（demo、explain の大半）は screen-with-wipe。顔は右下の丸ワイプ
- ワイプが操作箇所（カーソル、入力位置、読ませたい文字）に重なるときは、その区間だけ corner を変える（ターミナルの入力が右下なら tl か tr）。重なりが 3 秒未満なら変えない

## screen-full（ワイプなし）
- 画面の右下まで読ませたい区間（長いコードやログ、表、エラーの全文）
- 自動ズームで 1.5 倍以上に寄っている区間（ワイプがあると狭く見える）
- 細かい操作が連続する区間（ドラッグ、範囲選択）で、ワイプが視線を奪う場合

## camera-full（カメラのみ）
- 章の頭の 3〜8 秒（その章で何をするかを話す部分）
- 動画の最初の挨拶と結論、最後のまとめ・cta
- 画面を見せず、考え方や注意点だけを話している区間が 5 秒以上続くとき
- 1 回の camera-full は長くても 20 秒。それより長く画面を見せずに話しているなら、scene（bullet-points や big-number）で要点を出す

## scene
- 手順の一覧、比較、数字は scene（bullet-points / compare-2col / big-number）
- 打ったコードを後から説明するときは code-focus（該当行を highlight）。コマンドを1行だけ見せたいときは terminal-typing
- 画面の一部（ボタン、設定項目）を指して説明するときは screen-zoom-callout

## 切り替えのルール
- 切り替えは文の切れ目で行う。言葉の途中、打鍵の途中、結果が出た直後 1.5 秒以内では切り替えない
- 3 秒未満でレイアウトを行き来しない（minShotSec 3）
- 同じレイアウトが 90 秒を超えたら、章の区切りか scene を挟めないか検討する
- 顔のカメラは、目線が外れている（画面を見ている）区間でもワイプなら使ってよい。camera-full にするのは、カメラを見て話している区間だけ

## 人物のカメラと顔の位置
- カメラが複数あるときは、take.json で役割が main のカメラ（素材の role が front。`ferret-video multicam material` の cameras[].role）が人物のカメラ。迷ったらこのカメラを選ぶ。ほかのカメラは、人物のカメラで顔が見えない区間や、手元・別の角度を見せたい区間だけに使う
- 人物のカメラでは、顔がカメラの枠の中央に来るように切り抜く。カメラを決めたら `ferret-video tracks apply` を実行すると、顔の解析からなめらかに追う切り抜き（全画面は軽い寄り、丸ワイプは中央合わせ）が入る
- 顔が見えない（faceVisible が低い）カメラを camera-full にしない
- 判定モデルは使わない。区間ごとの判断は material の数値（faceVisible、lookingAtCamera、speaking）を見て自分で決め、理由を --reason に書く。自信がない切り替えには needsReview を付ける
