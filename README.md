# Image Layer Lab

1枚の画像からAIが意味のある編集単位を判断し、生成で復元した画像レイヤーと編集可能な文字をSketchへ書き出すローカルツールです。人物・商品・背景・文字・白もやなどを分け、重なりで隠れている部分やアートボード外の範囲も推定します。

画像分離はCodex app-serverのimagegenを利用します。計画・文字認識・評価にもapp-serverを使用します。直接OpenAI APIを使う実装はまだ含みません。

## セットアップ

Node.js 25とPython 3.12で検証しています。固定されたPython依存に対応するPython 3.12以降と、Codexで使用するモデルとimagegenにアクセスできるアカウントが必要です。

```sh
npm ci
python3.12 -m venv .venv
.venv/bin/pip install -r requirements.txt
npx codex login
npm test
```

Pythonの依存は `requirements.txt`、Nodeの依存は `package-lock.json` で固定しています。認証情報はCodexが管理します。

## 任意の画像を分離する

```sh
npm run separate -- --input=/path/to/banner.png --out=runs/example --concurrency=6
```

`runs/example/layers.sketch` に書き出します。同じ出力先で再実行すると、完了済み計画・生成画像・文字確認・評価を再利用できます。別の画像や条件を最初から検証するときは新しい出力先を指定してください。

```sh
# 画像生成前の計画だけを確認
npm run separate -- --input=/path/to/banner.png --out=runs/plan-check --stage=plan

# 前方式の推論・実行設定で比較
npm run separate -- --input=/path/to/banner.png --out=runs/comparison --reasoning-profile=balanced --execution=ordered

# 保存済み素材でモデル別にOCR・評価を比較（画像再生成なし）
npm run evaluate -- --run=runs/example --out=runs/evaluation --profiles=quality,balanced,luna --stages=ocr,review
```

標準のfast設定は `accelerated` + `overlap` です。Sol 6.1 lowが計画と評価を行い、Luna lowが文字を読み取ります。必要な項目だけSol highで確認します。`model/list` に対象モデルがない場合はエラーにし、別のモデルに自動で置き換えません。

画像生成にはGPT Image 2.5希望を伝えます。ただし、app-serverには実際の画像モデルを固定・確認する引数が公開されていないため、このプロンプトによるモデル選択は保証できません。

## 処理フロー

1. AIによる編集単位の計画と、原画像の文字読み取りを並列実行。
2. 原画像と計画の文言を照合し、疑わしい数値は追加確認。
3. 背景・人物・商品を先行して最大6並列で生成。文字画像が揃った単位からOCRを開始。
4. 素材の位置合わせ・透明余白調整・再合成。
5. 全体と各レイヤーの視覚評価と、仮のSketch書き出しを並列実行。
6. 位置・大きさ・透明度の修正を優先し、画像の問題が確認された素材だけ再生成。
7. 修正後に再評価し、自己完結したSketchファイルを最後に配置。出力のハッシュを記録。

詳細は [構成と検証](docs/architecture.md) を参照してください。

## 出力と限界

元の見た目を優先する文字画像と、編集可能な文字を保持します。生成による形状・質感の変化やフォントの近似があります。隠れていた部分は推定であり、元画像の完全復元ではありません。Sketchの画像読み戻し検証はAI分離の精度とは別の指標です。

公開版の71件のテストが通過しています。テストはAPIを呼ばず、偽AI応答とローカル画像処理で検証します。実行結果・商品固有の写真や設定・共有リンク・認証情報・過去の実験履歴は含めていません。

Notoフォントのライセンスは `assets/` のOFLファイルに記載しています。
