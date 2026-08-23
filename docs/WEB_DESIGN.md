# WEB_DESIGN — ブラウザ側の設計

解析結果（`docs/DESIGN.md` / `docs/RESULTS.md`）をブラウザで見せるための設計。
**配信・描画・ネットワークをどう組んであるか**を書く。

実測値は `docs/WEB_RESULTS.md`、Cloudflare の挙動は `docs/PLATFORM.md`、
配信の構成と手順は `docs/INFRA.md`、生きているタスクは `docs/TODO.md`。

根拠区分は `docs/DATA.md` と同じ（**[実測]** / **[既知]** / **[仮説]** / **[未確認]**）。

---

## 層の分け方

依存は上から下への一方向だけ。下の層は上の層を知らない。

```
ui/          controls / inspector / section / perf panel
   ↓
view/        カメラのプリセット、ビューキューブ、測線
   ↓
three/       Viewer（カメラ・投影・描画ループ）、地形 / PLATEAU / 地物 / 点群のメッシュ
   ↓
pointcloud/  index / lod / decode / renderer   （view から差し替えられる）
   ↓
net/         scheduler / range fetch / cache
   ↓
assets/      catalog、タイルのパッキング、PNG 復号
   ↓
domain/      AOI・CRS・水位・地形条件・地物 assertion、wet(H) / depth(H)
```

守るルールは 4 つ。

| ルール | 理由 |
|---|---|
| `domain/` は three / @loaders.gl を **import しない** | ドメインモデルを描画ライブラリの API に縛らない。node でそのままテストできる |
| `net/` は描画を知らない。渡るのは URL・Range・優先度だけ | 取得の制御をレンダラの内部に埋めない |
| レンダラは `fetch` を直接呼ばない。**必要なものを宣言**して結果を受け取る | 3D Tiles も COPC も地形タイルも同じ scheduler を通す |
| `pointcloud/` の 4 要素（index / LOD / decode / render）は個別に差し替えられる | レンダラを替えても他の 3 つを再利用する |

**描画ライブラリに依存しない判断は `domain/` に置く。** レンダラの差し替えが
実際に控えている以上、描画側に分岐を書くと差し替えのたびに書き写して、そのたびに間違える。
`domain/terrain.ts`（surface → どのタイルを使うか）と `domain/camera.ts`
（地図のカメラ → ローカル ENU メートル）はこの理由で純関数として切り出してある。

---

## ドメインモデル

### 連結浸水開始水位 `h_conn`

このアプリの構造は `h_conn` を持っていることから決まっている（`docs/DESIGN.md`）。

```ts
const wet   = (hConn: MTP, H: MTP) => hConn <= H
const depth = (elev: MTP, hConn: MTP, H: MTP) => (wet(hConn, H) ? Math.max(0, H - elev) : 0)
```

セルごとに「そこが海と連結して浸水し始める最小水位」を 1 枚持つので、
任意の水位 H の判定と浸水深が定数時間で決まる。したがって

- **水位を変えてもサーバ往復も再計算も発生しない。** シェーダの uniform が変わるだけ
- 配信するタイルの枚数が水位の数に依存しない

同じ式を GLSL 側（`view/floodMeshLayer.ts`）にも書いている。
**両者が一致することはテストで守る**（後述）。

### 地形条件と差分

解析が持つ 4 条件と、2 組の差分をそのまま配信する。

| surface | 幾何を取るタイル | 色を取るタイル |
|---|---|---|
| `baseline` / `highres` / `control` / `pointcloud` | 同名の条件 | 同じタイル（RGB=標高, A=h_conn） |
| `diff` | `highres` | `diff`（R=h_conn(baseline), G=h_conn(highres)） |
| `diff_pc` | `pointcloud` | `diff_pc`（R=h_conn(highres), G=h_conn(pointcloud)） |

差分モードでも地形メッシュは要るので、**幾何は元の条件から取る**。
どちらから取るかは任意ではない。`diff_pc` の形を `highres` から取ると、
「点群で変わった場所」を点群の形の上に描けず、何を見ているのか分からなくなる。

この解決は `domain/terrain.ts` の `resolveSurface()` が持つ。

### 鉛直基準 **[実測]**

PLATEAU 3D Tiles は**楕円体高**、解析はすべて**標高 T.P.**。
差はジオイド高 N で、AOI 中心で **36.955 m**（PROJ 経由、GSIGEO2011）。
`catalog.json` の `vertical.geoid_undulation_m` に焼いてある。

**我々のレイヤ側を `z_render = z_TP + N` で持ち上げる。** 3D Tiles 側の行列は触らない。

---

## 描画層を自前で持つ

描画は three.js だけで組む。**ベースマップは 1 枚も描かない**（背景は単色）ので、
地図ライブラリが要る理由が「カメラ・投影・操作・ギズモ」の 4 つしか無かった。

| | 実体 |
|---|---|
| カメラ・投影・操作・描画ループ | `three/viewer.ts`（`Viewer`）。透視と正射を持つ |
| 地形・浸水・差分 | `three/terrainTiles.ts` + `three/floodMaterial.ts` |
| PLATEAU 建物 | `three/plateauTiles.ts`（b3dm のパースは `@loaders.gl/3d-tiles`） |
| 地物ポリゴン・点群被覆 | `three/semanticsMesh.ts`（picking も） |
| 点群 | `three/pointsRenderer.ts`（`Points` 1 つ / ノード） |

前身は MapLibre GL JS + deck.gl（`MapboxOverlay`, interleaved）だった。
外した理由は 1 つで、**初期チャンクの約 1/3 が MapLibre だったから**である
（`docs/WEB_RESULTS.md`「初期チャンクの内訳」）。細い回線で効くのはここしかない。
判断の経緯は `docs/adr/2026-08-23-three-js.md`。

### ズームの規約 **[実測]**

`Viewer.getZoom()` / `setZoom()` は **タイル 1 枚 = 256 px 基準**。
`Math.round(getZoom())` がそのまま要求するタイルの z になるように選んである。

**MapLibre の `getZoom()` は 512 px 基準で、同じ景色でも値が 1 小さい。**
移行直後にこれを取り違えていて、`INITIAL_ZOOM` に MapLibre の 15.6 をそのまま
渡していた。実測で m/px が 1.282 対 2.567（ちょうど 2 倍）、可視範囲が 4 倍、
要求するタイルが z17 25 枚から z16 9 枚と 1 段粗くなっていた。
**画面は「それらしく」出るので見て気づけない。** 数字が 1 ずれる箇所:

| 場所 | 基準 |
|---|---|
| `Viewer.getZoom()` / `setZoom()` / `jumpTo({zoom})` | 256 px（= 要求する z） |
| `domain/camera.ts` の `metresPerPixel(lat, zoom)` | 256 px |
| `docs/WEB_RESULTS.md` と `perf/*.mjs` に書いてある zoom 値 | **512 px（MapLibre 時代のまま）**。渡すときに +1 する |

### 操作系

- **ビューキューブ**（右上、`view/viewCube.ts`）。面 6 / 辺 12 / 角 8 の 26 方向を
  クリックで選び、ドラッグで自由回転する。カメラに追従する。
  **依存を増やさないために 2D canvas に 8 頂点を自前で投影して描く。**
  細い回線で効くのは初期チャンクのサイズだけ（`docs/WEB_RESULTS.md`）なので、
  ギズモのために描画ライブラリをもう 1 つ載せるのは筋が悪い。
  カメラの向きを受け取って向きを返すだけなので、メインのレンダラに依存しない
- ズームはホイールとピンチ、向きはキューブ。**+/− ボタンとコンパスは置かない**。
  小さいボタンが 3 つ並ぶより、押せる的が 1 つ大きいほうがよい
- **出典は下辺に常時出す**（`#attrib`）。PLATEAU / 京都府 DEM / 気象庁はいずれも
  表示を求めている。MapLibre の `AttributionControl` が担っていた分で、
  描画層を自前にした以上こちらで持つ
- **鉛直強調**（×1〜×20）。吉原は 1 km に対して起伏 3 m しかないので、
  強調なしでは横から見ても何も分からない。強調中は PLATEAU 建物を隠す
  （建物は実高のままなので地形と噛み合わなくなる）
- カメラプリセット（キーボード 1〜6）。キューブは面のクリックなので、
  俯瞰 52° のような決め打ちの視点は出せない。
  **軸方向のプリセットは正射投影に切り替える**（`O` キーでも切り替わる）。
  透視のままでは「CAD のように断面で見る」にならない
- **断面の測線**（`view/sectionTool.ts`）。画面 2 点のクリックを
  `Viewer.unproject`（地面 z=0 との交点）で経緯度に直す。
  作図中は断面パネルの `pointer-events` を切る。**パネルが画面下半分を覆っていて、
  2 点目がそこに来ると canvas に届かない**（実測で無視されていた）

---

## 地形の描き方

`three/terrainTiles.ts` はタイルのピラミッド（可視集合の決定・取得の宣言・
best-available のフォールバック）を持ち、1 枚 1 枚は `three/floodMaterial.ts` の
シェーダで描く。RGBA タイル 1 枚から
**頂点シェーダでテクスチャを読んで格子を変位させる**。

- タイルあたり 128×128 の格子 + 外周スカート。**1 タイル 1 リクエストのまま**
- 陰影は同じテクスチャの隣接テクセルから法線を作って計算する。
  別ピラミッドも追加リクエストも要らない
- 粗メッシュ（z14-15）と細メッシュ（z16-18）はメッシュ同士で z-fight するので、
  細が揃ったら粗を隠す。板なら重ね描きで済んでいた

板（`BitmapLayer`）ではなくメッシュにしたのは、真横・軸方向から見て
「どこが水面より低いか」を確かめるためである。板は横から見れば線でしかない。

### タイルの読み方で守ること

3 つとも**絵を見ても間違いに気づけない**種類なので、明示しておく。

| | 内容 |
|---|---|
| **area-registered** | タイルは 1 画素 = 1 セルで焼いてある（`scripts/80` が `from_bounds(..., 256, 256)`）。セル k は uv `[k/256, (k+1)/256)` を占め、**中心は `(k+0.5)/256`**。point-registered として引くと半セルずれ、ずれ量がズームで変わるので、複数ズームが同時に描かれる俯瞰視で段差になる |
| **南北の向き** | タイルは 1 行目が北。テクスチャの `t=0` が北辺になる一方、格子の uv は **`v=0` が南**。引く前に `1-v` する。法線の y 成分も同じ向きに揃える（面 `z = f(x,y)` の法線は `(-fx, -fy, 1)`）。**画面と焼いたタイルを直接照合しないと捕まらない**ので `perf/tileorient.mjs` で見る |
| **nodata を補間しない** | 標高は 4 点の双線形で読むが、1 点でも nodata（`R=G=B=0`）が混ざったら最寄りに落とす。混ぜると −9999 から実標高へのランプができ、海際に平らな棚が生える。`h_conn` は判定値なので**常に最寄り**で引く |

---

## 点群の実行時

### 4 つに割る

```
COPC (R2) ──Range──▶ CopcIndex ──▶ LodSelector ──▶ Scheduler ──▶ DecodePool ──▶ Renderer
                     octree        純関数         優先度        Worker+WASM    差し替え対象
```

この割り方が成立するのは copc.js の形のおかげである **[実測]**。

- `Getter = (begin, end) => Promise<Uint8Array>` を差し込めるので、
  **COPC の IO を全部 scheduler に通せる。** copc.js が勝手に fetch することはない
- `Hierarchy.Node` が `pointDataOffset` / `pointDataLength` を持つので、
  どのノードがファイルのどこにあるか事前に分かる。range coalescing を自前で書ける
- decode は「取得済みバイトを返すだけの getter」を Worker 内で渡す。
  **取得とデコードが完全に分かれる**

### hierarchy は 1 リクエストで取る

COPC の octree 索引は「1 ページ読む → 子ページの位置が分かる → また読む」という
**依存チェーン**で、素朴に辿ると往復回数がそのまま待ち時間になる。

仕様上、全ページは `user_id='copc'` / `record_id=1000` の EVLR 1 個に連続して入っている。
そこを 1 リクエストで取り、以後はメモリから切り出す（`pointcloud/copcIndex.ts`）。
EVLR が見つからない場合や大きすぎる場合はページ単位取得に戻す。

### LOD

深さ `d` のノードの点間隔は `spacing / 2^d`。それが画面で何 px になるか
（screen-space error）で採否を決める。

```
sse(node) = (spacing / 2^depth) * (viewportHeight / 2) / (distance * tan(fovY / 2))
```

- 閾値を下回るノードは落とす。加えて**視野の外接矩形**で絞る
- `maxPoints` / `maxBytes` に収まるまで、粗い順・画面で大きい順に採る
- `maxBytes = clamp(帯域推定 * 2, 1 MB, 20 MB)`。
  **係数 2 = 「点群に使ってよいのは 12 秒の窓のうち 2 秒ぶん」**で、
  残りは地形・建物・地物に要る（`docs/WEB_RESULTS.md`）

### 帯域推定は「回線の容量」を測る **[実測]**

直近 4 秒の完了分を合計し、**その間に実際に取得が走っていた時間**（区間の和集合）で割る。
並列に走った分はここで足し合わされる。待ち時間で割らないのは、アイドルを挟むと
容量を過小に見積もるため。

**1 リクエストごとに `wireBytes / 所要時間` を測ってはいけない。** 11 本並列なら
1 本あたりは 1/11 に見える。旧実装がこれで、実効の 1/5 以下しか出ておらず、
**点群の LOD 予算は下限に張り付いていた**。回帰は `perf/bwcheck.mjs` が見る
（実効帯域が分かっているプロファイルで推定と突き合わせる）。

速い回線ほど低めに出る（`fatpipe-highrtt` で 0.55 倍）。和集合の中に
「1〜2 本しか飛んでいない待ち時間」が入るためで、**過小に倒れるので
予算を甘くする方向には効かない。**

### 予算は増える方向にだけ組み直す

`budget()` を評価するのは点群の起動時とカメラ移動時だけだった。
**カメラを動かさなければ、推定が最も当てにならない起動直後の値が最後まで残る。**
1 秒ごとに見て、1.5 倍を超えて増えたときだけ組み直す。

**減る方向には組み直さない。** 選び直すと常駐していたノードが捨てられ、
取得済みのバイトが無駄になる。実測で、下げ直すと転送が増えるのに常駐点数が減った。
視野が変わったときは別で、カメラ移動の経路が改めて評価する。

**カメラは `domain/camera.ts` でローカル ENU メートルに直してから渡す。**
地図の `cameraToCenterDistance` は px 単位で、しかもキャンバス高さと fov だけで決まり
**ズームに依存しない**。これをそのまま高度として使うと視点が定数になり、
LOD が「近くは細かく遠くは粗く」を一切やらなくなる。

常駐点数の上限は描画コストから決める。実測値は `docs/WEB_RESULTS.md`。
**`Points` は 6.0 M 点まで 60 fps を保つ**（deck.gl `PointCloudLayer` は 3.0 M で 68〜82 ms）。
既定は 200 万点。測った上限をそのまま採らないのは、計測が開発機で、
配信先の GPU が分かっていないため [未確認]。
`three/pointsRenderer.ts` はノード 1 つを `Points` 1 つで持ち、ジオメトリは
decode の返り（Transferable）をそのまま `BufferAttribute` にする。

**セッタは値が変わったときだけ通知する。** 通知は `main.ts` の `refresh()` を呼び、
`refresh()` はセッタを無条件に呼ぶので、素直に毎回通知すると相互再帰で
`RangeError: Maximum call stack size exceeded` になる（`?pc=1` で実測）。

### decode pool

`min(4, max(1, hardwareConcurrency - 2))` 本の Worker。各 Worker が laz-perf(WASM) を 1 つ持つ。
返りは Transferable。

`positions` は **AOI ローカル原点からの相対 [m]** にする。EPSG:6674 の値は −6 万台なので、
Float32 に world 座標を入れると 0.5 m 級の微地形が丸まる。原点と回転行列は
`catalog.json` の `local_frame` に持つ。描画側はローカル原点をワールド原点として扱う。

---

## リクエストスケジューラ

すべての取得が 1 つの choke point を通る（`net/scheduler.ts`）。
3D Tiles も COPC も地形タイルも例外を作らない。

```
カメラ / 視野
   ↓ epoch++
LOD・可視判定（純関数、IO しない）
   ↓ リクエスト
Scheduler ─ 優先度キュー / 並列上限 / byte budget / coalescing
          ─ cancellation / memory LRU / retry
   ↓
Range fetch（ストリーム読み、受信バイトを逐次カウント）
   ↓
decode worker pool → GPU
```

### 優先度クラス

| P | class | 中身 | 群 |
|---:|---|---|---|
| 0 | `catalog` | `catalog.json` | a |
| 0 | `terrainCoarse` | 視野を覆う**最小ズーム**の地形タイル | a |
| 1 | `terrainFine` | 同じ視野の高ズームタイル | b |
| 1 | `pcIndex` | COPC の header と hierarchy | b |
| 2 | `semantics` | `objects.geojson` | c |
| 2 | `plateau` | 可視の b3dm | c |
| 3 | `pcCoarse` | 点群の粗ノード | d |
| 4 | `pcFine` | 点群の細ノード | d |
| 5 | `prefetch` | 先読み（点群の被覆輪郭など） | e |

設計上の要点が 2 つある。

**`objects.geojson` を P0 に置かない。** 地物のクリック情報は初回描画に要らない。
細い回線では単発の数百 kB が `first_meaningful_render` を丸ごと押し出す。

**FMR が立つまで `pcCoarse` / `pcFine` は発行しない。**
これが「解析結果は点群の全ロードを待たずに出す」の実装上の担保。
`pcIndex` だけは先に取り、FMR 直後に LOD を回せるようにしておく。

### 並列上限

`PerformanceResourceTiming.nextHopProtocol` で h1 か h2 かを判定して切り替える。

| | 全体 | a | b | c | d | e |
|---|---:|---:|---:|---:|---:|---:|
| h1 | 6 | 4 | 4 | 3 | 3 | 1 |
| h2 | 12 | 6 | 6 | 4 | 6 | 2 |

h2 でも無制限にしない。多重化してもボトルネックが帯域なら
**低優先のバイトが高優先のバイトを押し出す**。多重化は優先度制御の代わりにならない。

数値はすべて初期値であって根拠は無い。実測でチューニングする前提のものである。

### range coalescing

LOD が選んだノードを `pointDataOffset` でソートし、gap と合計サイズが閾値内なら
1 本の Range にまとめる。COPC のノードはファイル上でほぼ連続して並ぶので、
まとめても「読むが使わないバイト」はほとんど出ない。

R2 はマルチレンジを受け付けない（`docs/PLATFORM.md`）ので、**連続 1 本への結合だけ**。
飛び地は結合できない。

**まとめた range は届いた分から順にノード単位でデコードする**
（`FetchTask.parts` / `onPart`）。1 本の完了を待つと、まとめたことが
そのまま「最初の点が出るまでの遅延」になる。**この 2 つはセットでないと意味を持たない。**

### cancellation

視野から外れた要求を切る。切ってよいのは次の 3 つをすべて満たすときだけ。

1. 発行時より epoch が進んでいる
2. `stillNeeded()` が偽（= いま必要とされていない）
3. 受信が 8 割未満（8 割超なら捨てるほうが損）

**epoch が古いだけでは切らない。** 連続パン中は毎フレーム epoch が進むので、
それだけを条件にすると 9 割受信済みの要求まで捨てる。
LOD の再計算は 60 ms デバウンスで回し、epoch もそこで進める。

順序にも制約がある。**点群の `stillNeeded()` は LOD の結果を見る**ので、
LOD を更新する前に reap すると古い集合を見て「まだ必要」と答えてしまう。
地形は可視判定が地図を直接見るのでこの制約が無い。

受信済みバイトはストリーム読みで数える。`Content-Length` を丸ごと無駄と数えると過大になる。

### retry と cache

- ネットワークエラーと 5xx は最大 2 回、指数バックオフ（ジッタつき）
- 4xx は再試行しない
- **Range を要求したのに 200 が返ったらエラーにする。** 黙って全体を落とすのが
  最大のネットワーク事故で、しかもクライアントは正常に見える（`docs/PLATFORM.md`）

| 層 | 実体 | 目的 |
|---|---|---|
| L0 | in-flight map | 同一キーの重複要求を合流させる |
| L1 | メモリ LRU（バイト上限） | カメラ往復での再取得・再デコードを避ける |
| L2 | HTTP キャッシュ | `immutable` + 内容ハッシュつき URL |

cold cache で測るときは L2 を明示的に消す。

---

## アセットの形式

| asset | 形式 | 配信 |
|---|---|---|
| catalog | `catalog.json` | 1 GET。全アセットの URL・zoom 範囲・ジオイド高・ローカル原点 |
| 地形 + `h_conn` | **RGBA PNG タイル**（自前パッキング） | XYZ。条件ごとに 1 ピラミッド |
| PLATEAU 建物 | 3D Tiles 1.0（AOI サブセット） | tileset.json + b3dm |
| 地物 + assertion | `objects.geojson` | 1 GET（edge で br 圧縮） |
| 点群 | **COPC** | Range |

### RGBA タイルのパッキング

**1 タイル = 1 条件**。RGB に標高、A に `h_conn` を入れる。

```
RGB : Terrarium 方式   elev_m = (R*256 + G + B/256) - 32768     精度 1/256 m
A   : h_conn コード    A == 0        → どの水位でも浸水しない
                       A in [1,255]  → h_conn = (A-1) * h_step  (h_step = 0.05 m)
nodata(elev) : R=G=B=0 を予約
```

Terrarium を選ぶのは 1/256 m の分解能のため。Mapbox terrain-RGB の 0.1 m 刻みでは、
問題にしている 0.25 m 級の差に対して量子化が粗い。

同じ PNG に入れるので **標高と `h_conn` が必ず同一画素で整合**し、リクエストも半分になる。

**このタイルを地図ライブラリの `raster-dem` 相当に渡してはいけない [既知]。**
通常のイメージデコード経路を通るとアルファが乗算され、
A < 255 の画素（＝ほぼ全ての浸水域）で RGB が壊れて標高が狂う。
陰影を自前シェーダで計算しているのはこれを避けるためでもある。

GPU に上げる分には問題ない。`createImageBitmap(blob, { premultiplyAlpha: 'none',
colorSpaceConversion: 'none' })` で読み、テクスチャは非乗算のまま渡す。
`mipmaps: false` と nearest フィルタも必須で、パックした値を線形補間すると別の標高になる。

### 3D Tiles

配布物をそのまま使う。ただし切り出し時に **batch table を使うキーだけに絞る**
（`scripts/82`）。PLATEAU の全属性は 70 キー近くあり、viewer が読むのは
`gml_id` と塗り分け用の 2 キーだけである。glTF チャンクはバイト列のまま移すので
ジオメトリも見た目も変わらない。

b3dm には色が無い（texture・頂点色・`baseColorFactor` すべて無し）ので、
属性で塗り分けるには **primitive を色ごとに分割して material を与える**
（`view/plateau.ts`）。draw call はタイルあたり「出現した色数」まで増える。

---

## CPU 側でタイルを読む

断面図（`ui/section.ts`）は、測線に沿って標高と `h_conn` を CPU 側で読む。
**追加の通信は起きない。** 画面に出ているのと同じタイルを scheduler 経由で取るので、
取得済みならメモリキャッシュから返る。

**canvas を経由してはいけない [実測]。**
2D canvas はアルファ乗算した状態で画素を保持するので、`drawImage` → `getImageData` の
往復で A < 255 の画素の RGB が壊れる。`h_conn` コードはほぼ常に 255 未満なので、
ほぼ全画素が壊れる（標高 1.5 m の画素が 32512 m として読めた）。
`premultiplyAlpha: 'none'` で作った `ImageBitmap` でも、canvas に描いた時点で同じである。

`assets/png.ts` に 8bit RGBA / 非インタレース PNG の復号を持つ。
展開はブラウザ内蔵の `DecompressionStream('deflate')` を使うので依存は増えない。
**GPU に上げる経路（`decodeTileImage`）と CPU で読む経路（`decodeRgba8`）は別物**で、
前者は canvas を通らないので従来どおりでよい。

断面の塗りは **`h_conn <= H` を満たす区間だけ**にする。標高が水位より低いだけでは塗らない。
連結していない窪地を塗ると、このリポジトリの主張と逆のことを言うことになる。

---

## 計測のしかけ

### FPS は指標にしない

測るのは「いつ・何バイトで・何が見えたか」。計測パネルは既定で非表示で、
`?perf=1` か `P` キーで開く。`PerfRecorder` は常に動いているので、
パネルを閉じていてもハーネスが読む値は変わらない。

### マイルストーンの定義

曖昧さを残さないことが要点である。

| name | 定義 |
|---|---|
| `app_start` | `performance.timeOrigin` |
| `catalog_loaded` | `catalog.json` のパース完了 |
| `first_meaningful_render` | **視野を覆う最小ズームの地形タイルが GPU に乗り、浸水色が 1 フレーム描かれた**時刻。高ズームの到着は待たない |
| `time_to_terrain` | 細メッシュが視野を満たした |
| `time_to_plateau` | tileset の 22 タイルが揃った。**塗り替え（属性色の切り替え）では測り直さない**。初回描画の指標 |
| `time_to_first_useful_pc` | **LOD がその視点に必要と判断した点数の一定割合**が常駐した |
| `time_to_pc_refined` | 選ばれたノードが出揃った |
| `camera_settle_latency` | カメラ停止 → 新しい視点の地形と粗ノードが常駐するまで（細ノードは待たない） |

`time_to_first_useful_pc` を絶対点数ではなく割合で定義するのは、
データ密度と LOD 予算を変えるたびに意味が変わるのを避けるためである。

### 収集する量

| 量 | 取り方 |
|---|---|
| 転送バイト | `PerformanceObserver('resource')`。**wire（回線を流れた量）で数える** |
| shell コスト | 同上を code/font と data に分けて数える。FMR を決めているのはコード側なので、毎回見る |
| リクエスト数・並列ピーク | scheduler がクラス別に数える |
| キャンセルと無駄バイト | scheduler。無駄は **abort までに実際に読めたバイト** |
| decode 時間 | Worker 内で測って postMessage に載せる |
| `nextHopProtocol` | h1/h2 の判定と結果の解釈に使う |

**バイトはデコード後ではなく wire で数える。** br が効くアセットでは大きくずれる。
Cloudflare は br 応答に `content-length` を付けない（`docs/PLATFORM.md`）ので、
`PerformanceResourceTiming.encodedBodySize` を URL と開始時刻で引き当てる。
引き当てられない場合はデコード後の値に戻す。**過大に出る方に倒す。**
小さく見せる方に倒すと判断を誤る。帯域推定にも同じ値を使う。

クロスオリジンだと `transferSize` も `encodedBodySize` も 0 になるので、
**同一オリジンで配信する**（`docs/INFRA.md`）。これは計測の都合であると同時に、
**外部に出られない回線で動くための条件**でもある。`deploy/check.mjs` の MUST
「外部オリジンへのリクエストが 0 件」がここを守る（ブラウザを立てて数える。
`fetch` では分からない）。

### 正しさを守るテスト

性能とは別に、**画面に出ている値が解析と一致するか**を検査する。

| テスト | 内容 |
|---|---|
| `test/parity.test.mjs` | タイルの RGBA パッキング往復。地物の `depth` と判定が Python 側と一致するか |
| `test/camera.test.mjs` | カメラ → ローカル座標の換算（純関数） |
| `test/png.test.mjs` | 自前 PNG 復号が Pillow と全画素一致するか |
| `perf/bwcheck.mjs` | 帯域推定が実効帯域と合っているか（絞りが既知のプロファイルで突き合わせる） |
| `perf/tileorient.mjs` | **画面の画素**と焼いたタイルの同じ座標の値が一致するか |
| `perf/waterlevel.mjs` | 水位を変えると浸水域が単調に増え、かつリクエストが増えないか |

前の 3 つは「値が正しいか」しか見ない。**「その値が画面のどこに出ているか」**は
`tileorient.mjs` が見る。値の検査だけでは、南北反転も半セルずれも捕まらない。

`waterlevel.mjs` が 2 つの性質を同時に見るのも同じ理由である。
「リクエストが増えない」だけを見ると、**何も起きていなくても通ってしまう。**

### ネットワークプロファイル

Playwright + CDP `Network.emulateNetworkConditions`。本リポジトリの定義で、
Chrome DevTools のプリセットそのものではない。

| profile | down | up | RTT | 用途 |
|---|---|---|---|---|
| `normal` | 無制限 | 無制限 | 0 ms | 上限 |
| `fast4g` | 4 Mbps | 3 Mbps | 70 ms | 一般的なモバイル |
| `slow-highrtt` | 1 Mbps | 0.5 Mbps | 400 ms | 細い回線 |
| `fatpipe-highrtt` | 20 Mbps | 5 Mbps | 400 ms | **往復回数の影響を帯域から切り離す** |

各プロファイルで cold cache から測る。計測時の注意（headed で測る、1 回で判断しない、
wire で数える）は `docs/WEB_RESULTS.md`。

ローカルの `web/serve.mjs` は production 相当の条件を再現する
（HTTP/2 と HTTP/1.1 の切替、Range 206、事前圧縮、immutable、マルチレンジは 400）。
**開発サーバでネットワークを測っても意味が無い。**

---

## 配信の境界

ブラウザから見た境界は **`catalog.json` が指す URL** の 1 点だけである。
アセットがどこに置かれていても、catalog の URL が相対のままなら
アプリ側に分岐は要らない。

Cloudflare 側の構成（静的アセットは Workers Assets、COPC だけ Worker → R2）は
`docs/INFRA.md`、プラットフォームの挙動は `docs/PLATFORM.md`。

PDAL / GDAL / COPC 生成 / ラスタ処理は Workers では動かさない。
CPU 時間とメモリの制約に合わず、既存の Python パイプラインをそのまま使えなくなる。

LAS のアップロード経路（ブラウザ → R2 直接 multipart）はまだ作っていない。
設計上の要点は「API サーバを経由させない」ことで、詳細は `docs/TODO.md`。

---

## レンダラを差し替える条件

`PointCloudRenderer` インターフェースを挟んである。deck.gl `PointCloudLayer` から
three.js の `Points` への差し替えは**この境界だけで済んだ**（`CopcIndex` /
`LodSelector` / `Scheduler` / `DecodePool` は 1 行も変えていない）。
4 つをレンダラから分離してあるのはそのためである。

いま `Points` で足りていない兆候は無い（常駐 12,174 点 / draw call 1）。
次のいずれかが実測で成立したら、さらに自前のレンダラに移す。

| # | 条件 | なぜ限界の徴候か |
|---|---|---|
| 1 | 予算内の常駐点数でドラッグ中の frame time が 16.7 ms を超える | `Points` は 1 点 1 頂点なのでここが出たら本当に点数の問題 |
| 2 | EDL・密度連動の点サイズ・ノード単位のフェードイン・ノード内 progressive refinement のいずれかが要る | `PointsMaterial` で表現できない |
| 3 | GPU メモリ上限に当たり、自前の LRU eviction が要る | いまはノード単位の `dispose()` で足りている |

---

## 既知の制約

| 事項 | 区分 | 内容 |
|---|---|---|
| **ズームの基準が 256 px と 512 px で 1 ずれる** | **[実測]** | 上記「ズームの規約」。画面は成立してしまうので、`perf/tileorient.mjs` と `perf/zmix.mjs` で要求タイルの z ごと照合する |
| b3dm の `_BATCHID` は size:1 の属性で来る | **[実測]** | loaders.gl が `CUSTOM_ATTRIBUTE_2` に改名するので**名前ではなく `size === 1` で拾う** |
| glTF は Y-up、3D Tiles は Z-up | **[既知]** | loaders.gl は変換せず `rotateYtoZ` を立てて渡してくる。受け側で回す |
| 点群レンダラのセッタが毎回 `onChange` を出すと相互再帰する | **[実測]** | `refresh()` ⇄ セッタで `Maximum call stack size exceeded`。値が変わったときだけ通知する |
| **loaders.gl は Draco を外部 CDN から取る** | **[実測]** | 既定で `unpkg.com` と `www.gstatic.com` に worker 1 本あたり 1 組（実測 3 本 / 計 1.15 MB）。**外部に出られない回線では建物が 1 棟も出ない。** `scripts/vendor-draco.mjs` が `public/vendor/draco@<version>/` に複製し、`options.CDN` をそこへ向ける。`options.modules` に URL を渡す道は worker へ渡る途中で落ちて効かない |
| RGBA パッキングのアルファ乗算 | **[既知]** | GPU 経路は `premultiplyAlpha: 'none'`、CPU 経路は canvas を通さない |
| `EXT_disjoint_timer_query_webgl2` の可用性 | **[未確認]** | 無ければ CPU 側の壁時計で代用し、その旨を結果に明記する |
| 正射投影での点群 LOD の screen-space error | **[未確認]** | `sse` の式は透視のカメラ距離を前提にしている。正射では距離が効かないので、軸方向プリセットのときの採否は検証していない |
