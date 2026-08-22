# WEB_DESIGN — ブラウザ配信・描画・ネットワーク設計

`docs/DESIGN.md` / `docs/DATA.md` / `docs/RESULTS.md` の上に立つ。
解析仮説は `docs/RESULTS.md` で成立済み（GO）。**ここからの検証対象は
Web delivery / interaction / network performance** であって、解析の妥当性ではない。

根拠区分は `docs/DATA.md` と同じ（**[実測]** / **[既知]** / **[仮説]** / **[未確認]**）。

---

## 0. この段階で答えを出したい問い

1. cold cache で「意味のある最初の描画」までに何バイト・何秒かかるか。
2. PLATEAU 3D Tiles・COPC・terrain・解析結果が**同時に**帯域を奪い合うとき、
   何を先に出せば体感が最良か。優先度設計は実際に効くのか。
3. COPC + HTTP Range は「採用しただけ」でどこまで足りていないか。
   具体的には **range coalescing / cancellation / 帯域配分**が無いと何が起きるか。
4. deck.gl `PointCloudLayer` はどこで限界に達するか。custom runtime に移る境界はどこか。

**目標値は先に固定しない。** まず計測してボトルネックを特定する。

---

## 1. Browser layer architecture

依存は上から下への一方向のみ。下の層は上の層を知らない。

```
┌─ ui/          controls, inspector, perf overlay
│                     ↓ 依存
├─ view/        MapLibre map + deck.gl overlay + layer adapters
│                     ↓
├─ pointcloud/  index / lod / decode / renderer  （view から差し替え可能）
│                     ↓
├─ net/         scheduler / range fetcher / cache / metrics tap
│                     ↓
├─ assets/      catalog, tile URL schemes, packing/unpacking
│                     ↓
└─ domain/      AOI, CRS, WaterLevel, TerrainCondition, FeatureAssertion,
                wet(H) / depth(H) / decisionChanged(H)
```

**強制するルール**

| ルール | 理由 |
|---|---|
| `domain/` は maplibre-gl / deck.gl / @loaders.gl を **import しない** | ドメインモデルを描画ライブラリのAPIに依存させない。node でユニットテストできる |
| `net/` は描画を知らない。渡されるのは URL と Range と priority だけ | fetch scheduling を renderer 内部に密結合させない |
| renderer は `fetch` を直接呼ばない。**必要なもの（key + priority）を宣言**し、結果を受け取る | 同上。3D Tiles も COPC も同じ scheduler を通す |
| `pointcloud/` の 4 要素（index / LOD selection / decode / render）は個別に差し替え可能 | 将来 custom renderer へ移行するため |

`domain/` の中身（純TS、テスト対象）:

```ts
type MTP = number                    // 標高 [m T.P.]
type TerrainCondition = 'baseline' | 'highres' | 'pointcloud'

// h_conn は docs/DESIGN.md §1.2。ここが「サーバ再計算ゼロ」の根拠
const wet   = (hConn: MTP, H: MTP) => hConn <= H
const depth = (elev: MTP, hConn: MTP, H: MTP) => (wet(hConn, H) ? Math.max(0, H - elev) : 0)
const decisionChanged = (a: FeatureAssertion, b: FeatureAssertion, H: MTP) =>
  wet(a.hConn, H) !== wet(b.hConn, H)
```

同じ式を GLSL 側にも書く（`assets/packing.ts` と `view/shaders/flood.glsl.ts`）。
**両者が一致していることを build 時のゴールデンテストで検証する**（§8.4）。

---

## 2. MapLibre / deck.gl の責務境界

### 2.1 分担

| | MapLibre GL JS | deck.gl (`MapboxOverlay`, interleaved) |
|---|---|---|
| カメラ・投影 | **所有**。`Map` が single source of truth | 追従のみ |
| basemap | **所有** | — |
| 陰影（hillshade） | — | **所有**。`FloodTileLayer` のシェーダ内で計算（理由は §5.2） |
| ラベル | **所有** | — |
| 浸水・差分 | — | **所有**。`FloodTileLayer`（自作） |
| PLATEAU 建物 | — | **所有**。`Tile3DLayer` |
| 道路・地物ポリゴン | — | **所有**。`GeoJsonLayer`（picking も） |
| 点群 | — | **所有**（v1）。v2 で MapLibre `CustomLayer` へ逃がせるようにする |

### 2.2 重要な制約 —— MapLibre の 3D terrain は v1 では使わない

deck.gl 公式ドキュメントの記述 **[既知]**:

> Mapbox/MapLibre's terrain features are partially supported. When a terrain is used,
> the camera of deck.gl and the base map should synchronize, however the deck.gl data
> with z=0 are rendered at the sea level and not aligned with the terrain surface.

つまり `map.setTerrain()` を有効にすると、deck.gl 側のレイヤが地形に貼り付かない。
浸水ラスタ・道路ポリゴン・建物がすべてズレる。

**判断**: `setTerrain()` は**使わない**。ただし当初の「地面は平面（z=0）で hillshade だけ」は
**撤回した**（下記 2.2.1）。地形は deck.gl 側の自前メッシュで立てる。

- 吉原の浸水対象域は標高 0〜3 m にほぼ収まる（`docs/RESULTS.md`）ので、
  平面近似による見た目の損失は小さい。
- 建物は 3D Tiles で本物の3Dのまま立つ。
- 起伏を本当に立てたくなったら、MapLibre terrain ではなく **deck.gl 側のメッシュ地形**
  （`FloodTileLayer` をビットマップからメッシュに拡張）に進む。境界はこの層に閉じている。

### 2.2.1 地形は板ではなくメッシュにした（当初判断の撤回）

当初は「浸水域は標高 0〜3 m に収まるので平面近似で足りる」と書いた。
**実際に使うと足りなかった。** CAD のように真横・軸方向から見て
「どこが水面より低いか」を確かめる操作ができない。板は横から見れば線でしかない。

そこで `FloodMeshLayer`（`src/view/floodMeshLayer.ts`）を書いた。

- **アセットは作り直していない。** 既存の RGBA タイル（RGB=Terrarium 標高, A=h_conn）を
  そのまま使い、**頂点シェーダでテクスチャから標高を読んで**格子を変位させる。
- 自前でデコードするので、画像デコーダに premultiply されて標高が壊れる問題（§5.2）を踏まない。
  MapLibre `raster-dem` や loaders.gl の terrain loader に渡していたらこの問題に当たっていた。
- タイルあたり 128×128 の格子 + 外周スカート（3 m）。1 タイル 1 リクエストのまま。
- **鉛直強調**（×1〜×20）を uniform で持つ。吉原は 1 km に対して起伏 3 m なので、
  強調なしでは横から見ても何も分からない。
- 差分モードだけは「標高（メッシュ用）」と「2 条件の h_conn」で 2 テクスチャ必要。

実装して分かった副作用:

| 事象 | 対処 |
|---|---|
| 粗メッシュ（z14-15）と細メッシュ（z16-18）が z-fight する。板のときは重ね描きで済んでいた | 細が揃ったら粗を `visible: false` にする |
| nodata と有効セルをまたぐ三角形で標高が −9999 から実標高へ補間され、海側に平らな棚が生える | nodata フラグを別の varying にし、少しでも混ざった三角形は discard |
| 鉛直強調すると PLATEAU 建物（実高のまま）が地形と噛み合わない | 強調中は建物を非表示にし、理由を UI に出す |
| `Tile3DLayer` をレイヤ配列から外して戻すと deck.gl が assertion で落ちる | 外さず `visible` で切る |

**[未確認]** maplibre-gl 5.x + deck.gl 9.3 で MapLibre 側の terrain がどこまで使えるか。
自前メッシュで足りているので当面は確認しない。

### 2.3 鉛直基準の不一致 —— 3D Tiles は楕円体高

**[実測]** PLATEAU 3D Tiles (`bldg_lod1/tileset.json`) の root `boundingVolume.region` は
高さ `37.899 … 86.481` m。一方 CityGML / 我々の解析はすべて **標高 T.P.**。
差はジオイド高 N（舞鶴付近で概ね 37 m 前後）。

→ **我々のレイヤ側を +N して合わせる**（3D Tiles 側の行列をいじらない）。
`z_render = z_TP + N`。N は build 時に
「3D Tiles の region 最小高 − 対応する CityGML の最小標高」から実測して `catalog.json` に焼く。

**[未確認]** N の正確な値。暫定 37.0 m。実装時に測る。

---

## 3. Point-cloud runtime interface

### 3.1 4つに割る

```
COPC file (R2 / static)
      │  Range
      ▼
┌─────────────┐   pure data, no IO
│ PointCloudIndex │  octree nodes: key, bounds, pointCount, byteOffset, byteLength
└─────────────┘
      │
      ▼
┌─────────────┐   pure function, no IO / no GPU  → node でテスト可能
│ LodSelector │  (index, camera, budget) → NodeRequest[]（優先度つき）
└─────────────┘
      │
      ▼
┌─────────────┐   net/ の scheduler をそのまま使う
│  Scheduler  │  priority / coalescing / cancellation / cache
└─────────────┘
      │  compressed bytes
      ▼
┌─────────────┐   Worker pool。laz-perf(WASM)
│ DecodePool  │  → { positions: Float32Array, colors: Uint8Array, ... } (Transferable)
└─────────────┘
      │
      ▼
┌──────────────────┐
│ PointCloudRenderer │  ← ここだけ差し替える
└──────────────────┘
   ├ DeckPointCloudRenderer   (v1: deck.gl PointCloudLayer)
   └ CustomPointCloudRenderer (v2: maplibre CustomLayerInterface + 自前バッファプール)
```

### 3.2 なぜこの割り方で成立するか —— copc.js の Getter **[実測]**

`copc@0.0.9` の型定義:

```ts
export type Getter = (begin: number, end: number) => Promise<Uint8Array>
declare function create(filename: string | Getter): Promise<Copc>
declare function loadHierarchyPage(filename: string | Getter, page: Hierarchy.Page): Promise<Hierarchy.Subtree>
declare function loadPointDataBuffer(filename: string | Getter, header, node, lazPerf?): Promise<Binary>
namespace Hierarchy { type Node = { pointCount: number; pointDataOffset: number; pointDataLength: number } }
```

- **`Getter` を差し込めるので、COPC の IO を全部 `net/` の scheduler に通せる。**
  copc.js が勝手に fetch することはない。
- `Hierarchy.Node` が `pointDataOffset` / `pointDataLength` を持つので、
  **どのノードがファイルのどこにあるか事前に分かる** → 我々が range coalescing を実装できる。
- decode は main thread からは `loadPointDataBuffer(getter, header, node, lazPerf)` の形で、
  「すでに取得済みのバイト列を返すだけの getter」を渡して Worker 内で実行する。
  → **fetch と decode が完全に分離する。**

### 3.3 インターフェース

```ts
interface PointCloudIndex {
  readonly info: { cube: Bounds; spacing: number; pointCount: number; crs: string }
  node(key: NodeKey): PcNode | undefined
  children(key: NodeKey): NodeKey[]
  ensureHierarchy(key: NodeKey): Promise<void>   // 子ページの遅延読み込み
}

interface LodSelector {
  select(index: PointCloudIndex, view: ViewState, budget: LodBudget): NodeRequest[]
}
type LodBudget = { maxPoints: number; maxBytes: number; screenSpaceError: number }
type NodeRequest = { key: NodeKey; byteRange: [number, number]; priority: Priority; est: number }

interface PointCloudRenderer {
  readonly kind: 'deck' | 'custom'
  upsert(chunks: DecodedChunk[]): void
  evict(keys: NodeKey[]): void
  setStyle(s: PointStyle): void
  stats(): { residentPoints: number; drawCalls: number; gpuBytes: number }
  dispose(): void
}
type DecodedChunk = {
  key: NodeKey
  positions: Float32Array      // AOI ローカル原点からの相対 [m]（Float32 精度落ち回避）
  colors?: Uint8Array
  classification?: Uint8Array
  intensity?: Uint16Array
  decodeMs: number
}
```

`positions` を**AOIローカル原点相対**にするのが重要。EPSG:6674 の値は −6万台なので
Float32 のまま world 座標を入れると 0.5m 級の微地形が丸まる。原点は `catalog.json` に持つ。
deck.gl 側は `coordinateSystem: COORDINATE_SYSTEM.METER_OFFSETS` + `coordinateOrigin: [lon, lat]` で受ける。

### 3.4 LOD selection の具体

標準的な octree の screen-space error で選ぶ。COPC の `info.spacing` はルートノードの
点間隔なので、深さ `d` のノードの点間隔は `spacing / 2^d`。

```
sse(node) = (spacing / 2^node.depth) * (viewportHeight / 2) / (distance * tan(fovY / 2))
include(node) = 視錐台と交差 かつ sse(node) > SSE_THRESHOLD (既定 1.0 px)
priority(node) = depth <= D0(既定 3) ? P_PC_COARSE : P_PC_FINE
              内での順序は sse 降順（画面で大きいものを先に）
```

`maxPoints` / `maxBytes` に収まるまで sse 降順で採用し、超えたら打ち切る。
`maxBytes` は §4.3 の帯域推定から毎秒更新するので、**遅い回線では自動的に浅い LOD で止まる。**

### 3.5 decode pool

`min(4, max(1, navigator.hardwareConcurrency - 2))` 本の Worker。
各 Worker は laz-perf WASM を1つ持ち、`Copc.loadPointDataBuffer` を
「取得済みバイトを返すだけの getter」で呼ぶ。返りは Transferable。

---

## 4. Network request scheduler の責務

```
Camera / viewport
        ↓  (epoch++)
Visibility / LOD selection      ← pure。IO しない
        ↓  NodeRequest[] / TileRequest[]
Request Scheduler
  ├ priority queue (class ごと)
  ├ per-class concurrency cap + global cap
  ├ byte budget (token bucket, rolling window)
  ├ range coalescing        ← COPC で効く
  ├ cancellation (epoch 比較 + AbortController)
  ├ cache (memory LRU → Cache API)
  └ prefetch (最低優先度・最初に捨てる)
        ↓
HTTP Range fetch (streaming, 受信バイトを逐次カウント)
        ↓
decode worker pool
        ↓
GPU resident data
```

### 4.1 優先度クラス

| P | class | 中身 | 概算バイト | 打ち切り |
|---|---|---|---|---|
| 0 | `catalog` | `catalog.json` | < 10 kB | しない |
| 0 | `terrain-coarse` | 視野を覆う**最小ズームの** elev+h_conn タイル（数枚） | 数十 kB | しない |
| 1 | `terrain-fine` | 同じ視野の高ズームタイル | 〜7 MB | epoch 変化で不可視分 |
| 1 | `pc-index` | COPC header + root hierarchy page | 数 kB | しない |
| 2 | `semantics` | `objects.geojson` | 〜250 kB (br) | しない |
| 2 | `plateau` | 可視 3D Tiles (b3dm) | 〜数十 MB | epoch 変化で不可視分 |
| 3 | `pc-coarse` | COPC 上位ノード（depth ≤ D0） | | epoch 変化で |
| 4 | `pc-fine` | COPC 下位ノード | | epoch 変化で即 |
| 5 | `prefetch` | 隣接タイル、非アクティブ条件のタイル、次段 LOD | | 圧力がかかれば即 |

**`objects.geojson` を P0 に置かない**のが設計上の要点。
1 Mbps では 250 kB でも 2 秒かかり、`first_meaningful_render` を丸ごと押し出す。
地物のクリック情報は初回描画に不要なので P2 に落とす。
（クリックが `semantics` 到着前なら「読み込み中」を出す。）

**`terrain-coarse` だけを P0 の実データにする。** 視野を覆う z14〜15 のタイルは
合計数十 kB なので、どのプロファイルでも 1 秒以内に出せる見込み **[仮説→§8で実測]**。

**`first_meaningful_render` が立つまで、P≥3 は完全に停止する。**
これが「解析結果は点群全ロードを待たずに表示する」の実装上の担保。
`pc-index`（数 kB）だけは先に取っておき、FMR 直後に LOD selection を即実行できるようにする。

### 4.2 同時実行数

`PerformanceResourceTiming.nextHopProtocol` で HTTP/1.1 か h2/h3 かを判定し切り替える **[仮説→実測で確定]**。

| | h1 | h2/h3 |
|---|---|---|
| global | 6 | 12 |
| catalog + terrain-coarse | 4 | 6 |
| terrain-fine | 4 | 6 |
| semantics + plateau | 3 | 4 |
| pc-coarse + pc-fine | 3 | 6 |
| prefetch | 1 | 2 |

h2 でも無制限にしないのは、多重化してもボトルネックが帯域なら
**低優先のバイトが高優先のバイトを押し出す**から。多重化は優先度制御の代わりにならない。

### 4.3 byte budget

- 帯域推定: 完了リクエストの `bytes / elapsed` の EWMA（α=0.3）。
- `first_meaningful_render` 後、`pc-fine` は推定帯域の 50% を上限とする token bucket。
- LOD budget（`maxPoints` / `maxBytes`）は推定帯域から毎秒更新する。
  遅い回線では自動的に粗い LOD で止まる。**「遅いと永遠に読み続ける」を防ぐ。**

### 4.4 range coalescing —— COPC で最も効くはずの一手 **[仮説]**

COPC のノードはファイル上でおおむね深さ順・空間順に並ぶ。
LOD selection が選んだノード群を `pointDataOffset` でソートし、

```
gap < COALESCE_GAP (既定 64 KiB) かつ 合計 <= MAX_MERGED (既定 4 MiB)
  → 1 本の Range リクエストにまとめ、受信後にローカルで slice
```

**COPC + Range を採用しただけでは、可視ノードの数だけリクエストが飛ぶ。**
高 RTT ではこれが支配的になる。coalescing の on/off を切り替えられるようにして、
§8 で「リクエスト数」「TTFB 合計」「first useful point cloud」の差を実測する。

**マルチレンジは使えない [既知]**: R2 は複数バイトレンジ指定（`Range: bytes=a-b, c-d`）に
400 を返す（単一レンジは 206 で正常）。したがって **coalescing は「連続した1本のレンジに
まとめる」方式のみ**。飛び地をまとめる余地は無いので、`COALESCE_GAP` の分だけ
「読むが使わないバイト」を許容するトレードオフになる。
**まとめる前提条件 [実測]**: まとめた range を「全部届いてからデコード」にすると、
リクエスト数は減っても**最初の点が出るのは遅くなる**。実測でそうなった。
`FetchTask.parts` による逐次払い出しを入れて初めて coalescing が速い側になる。
**この 2 つはセットで初めて意味を持つ。**

### 4.5 cancellation と wasted bytes

- カメラ操作のたびに `epoch++`。
- `epoch` が古く、かつ class ≥ 1 で、新しい可視集合に含まれないタスクを abort。
- **受信済みバイトを数えるため、`fetch` の `response.body.getReader()` でストリーム読みする。**
  abort 時点までに読めたバイト数を `wastedBytes` に積む。
  `Content-Length` 分を丸ごと wasted と数えるのは過大評価になる。
- 途中まで読めたデータは**捨てずに** partial cache に置き、同じ range が再要求されたら
  残りだけ Range で取りに行く（`Range: bytes=(start+got)-end`）。
  → wasted bytes を実際に減らせるか実測する。**未実装**。

**COPC については 1 リクエスト内も逐次処理する**（`docs/WEB_RESULTS.md` §4.2）。
`FetchTask.parts` に「まとめた range の中の各ノードの絶対オフセット」を渡すと、
`Scheduler` が終端を越えたノードから順に `onPart` へ払い出し、
点群側はそのノードだけを decode worker に渡して即座に描画する。
Range 要求は長さが確定しているので受信バッファを事前確保できる、という性質を使っている。

`objects.geojson` は未対応（単発取得 + 一括 `JSON.parse`）。

**キャンセル暴走の防止**（連続パン中に epoch が毎フレーム進むため）
- LOD selection は `moveend` ではなく **60 ms デバウンス**で回す。epoch もそこで進める。
- 進行中タスクは、次のいずれかなら**キャンセルしない**:
  - 受信済み ≥ 80%（もう捨てる方が損）
  - 新しい可視集合にまだ含まれている
  - class ≤ 1
- キャンセル判定は「新可視集合に無い」ことを条件にする。epoch が古いだけでは切らない。

### 4.7 retry

- ネットワークエラー / 5xx: 最大 2 回、指数バックオフ（250 ms, 1 s, ±20% ジッタ）。
- 4xx: 再試行しない（416 は range 計算のバグなので即座にログへ）。
- Range を要求したのに **200 が返ってきた場合はエラー扱いにする。**
  黙って全体をダウンロードすると、そこが最大のネットワーク事故になる（§6 の Pages の件）。

### 4.6 cache

| 層 | 実体 | 目的 |
|---|---|---|
| L0 | in-flight map | 同一 key の重複リクエスト合流 |
| L1 | memory LRU（decoded / GPU 手前） | カメラ往復での再デコード回避 |
| L2 | `Cache API` | リロード跨ぎ |
| L3 | HTTP cache | `immutable` 付き。asset は content hash 付き URL |

**cold cache 計測時は L2/L3 を明示的に消す**（Playwright + CDP）。

---

## 5. Asset formats

### 5.1 一覧

| asset | 形式 | 配信 | 備考 |
|---|---|---|---|
| catalog | `catalog.json` | 1 GET | 全アセットの URL・bbox・zoom 範囲・バイト数・ジオイド高 N・AOIローカル原点 |
| terrain + h_conn | **RGBA PNG タイル（自前パッキング）** | XYZ | §5.2。条件ごとに1ピラミッド |
| PLATEAU 建物 | 3D Tiles 1.0（配布物の AOI サブセット） | tileset.json + b3dm | 再生成しない |
| 建物・道路 + assertion | `objects.geojson`（gzip/br） | 1 GET | 911 地物・1.1 MB。**閾値を超えたら PMTiles へ**（§5.4） |
| 判定変化ポリゴン | `changed_H*.geojson` | 遅延 | ブラウザ側で `h_conn` から再計算できるので v1 では使わない |
| 点群 | **COPC** (`.copc.laz`) | Range | §5.3 |

### 5.2 RGBA タイルパッキング —— elevation と h_conn を1枚に

**1タイル = 1条件**。RGB に標高、A に `h_conn` を入れる。

```
RGB : Terrarium 方式   elev_m = (R * 256 + G + B / 256) - 32768      精度 1/256 m
A   : h_conn コード    A == 0            → 未到達（どの水位でも浸水しない）
                       A in [1, 255]     → h_conn = (A - 1) * H_STEP   (H_STEP = 0.05 m)
nodata(elev) : R=G=B=0 （= -32768 m）を予約
```

- Terrarium を選ぶ理由: 1/256 m。Mapbox terrain-RGB の 0.1 m 刻みでは、
  我々が問題にしている 0.25 m 級の差に対して量子化が粗すぎる。
- 同じ PNG に入れるので **elev と h_conn が必ず同一ピクセルで整合**し、リクエストも半分。

**このタイルを MapLibre の `raster-dem` に渡してはいけない。**
MapLibre は DEM タイルを通常のイメージデコード経路で読むため alpha が premultiply され、
A < 255 の画素（= ほぼ全ての浸水域）で RGB が壊れて標高が狂う。
→ **hillshade は `FloodTileLayer` のフラグメントシェーダ内で、
同じテクスチャの隣接テクセルから法線を作って計算する。**
別ピラミッドも追加リクエストも要らず、premultiply 問題も回避できる。

**必ず踏む落とし穴 [既知]**: ブラウザは既定でテクスチャアップロード時に alpha を premultiply する。
A < 1 の画素で RGB が壊れて標高が狂う。

```ts
createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
```

を必ず使い、**build 時に往復テスト**（元 GeoTIFF → PNG → デコード → 値一致）を回す（§8.4）。
壊れるようなら RGB 2枚（elev / h_conn）に分割する。フォールバックはこれ。

**ズーム範囲**（AOI 1 km × 1 km, 緯度 35.455°）**[実測: 分解能計算]**

| 条件 | ネイティブ分解能 | 必要最大 z | 実装 |
|---|---|---|---|
| highres (0.5 m) | 0.5 m | z18 (0.487 m/px) | z14–z18 |
| baseline (5 m) | 5 m | z15 (3.89 m/px) | z14–z15、上位は overzoom |

z18 で 9×9=81 枚 + 下位 ≈ 計 110 枚/ピラミッド。

### 5.3 点群 —— LAS 入手前の扱い

**[実測] 舞鶴の公開 LAS/LAZ は存在しない**（`docs/DATA.md` §3）。実点群は別途提供予定。

それまでの間、**配信・スケジューリングの検証用に、0.5 m DTM の各セルを 1 点に変換した
COPC を生成する**（2000×2000 = 400 万点、4 点/m² 相当）。

- ファイル名・catalog・UI すべてで **`synthetic-from-dtm` と明示**する。
- **観測データとしては絶対に扱わない。** 解析には使わない。ネットワーク負荷源としてのみ使う。
- 実 LAS が来たら `scripts/15_pointcloud_dtm.py` の出力に差し替えるだけ。catalog のキーは同じ。

### 5.4 全条件の低ズームタイルを先読みする

地形条件の切替（baseline / highres / 差分）が「押してから数秒待つ」になると使い物にならない。
z14〜z15 のタイルは 1 条件あたり数枚・数十 kB しかないので、
**全条件の低ズームタイルを `prefetch` クラスで最初にまとめて取る**。
切替は常に即座に粗い絵が出て、そこから refine する。

差分モードは baseline と highres の両方のテクスチャを同時に使うので、
このプリフェッチが無いと差分表示が一番遅くなる。差分は本プロジェクトの主眼なので、
ここは優先度を上げる価値がある。

### 5.5 GeoJSON → PMTiles の移行閾値

v1 は `objects.geojson` 1本（gzip 後およそ 250 kB **[仮説]**）。
これは**単発のブロッキング取得**なので、§8 で「first meaningful render への寄与」を実測する。

移行トリガ（どれか1つで PMTiles + MVT に切り替える）:
- 地物数 > 10,000、または gzip 後 > 1 MB
- AOI を吉原の外へ広げる
- 実測で `objects.geojson` の取得が `first_meaningful_render` の 20% 以上を占める

---

## 6. Cloudflare / external compute の責務境界

```
                    ┌────────────────────── Cloudflare ──────────────────────┐
Browser ──静的────→ │ Pages / Workers Assets   viewer + 生成済みアセット      │
        ──Range───→ │   （catalog / tiles / 3dtiles / geojson / copc → R2）  │
        ──API─────→ │ Workers      control plane（upload 発行 / job 状態）    │
                    │ D1           dataset・job メタデータ                    │
                    │ Queues       ジョブ投入                                 │
                    │ R2           raw LAS + processed assets                 │
                    └───────────────────────┬────────────────────────────────┘
                                            │ Queue consumer が起動
                    ┌───────────────────────▼────────────────────────────────┐
                    │ External compute (Cloud Run job / container)            │
                    │   PDAL + GDAL + 本リポジトリの scripts/                 │
                    │   R2 から読み、R2 へ書く                                │
                    └─────────────────────────────────────────────────────────┘
```

**Workers 側でやらないこと**: PDAL / GDAL / COPC 生成 / ラスタ処理。
CPU 時間とメモリの制約に合わないうえ、既存の Python パイプラインをそのまま使えなくなる。

**Workers 側でやること**: 静的配信、multipart upload の発行と完了、
ジョブ状態、catalog の組み立て。すべて I/O バウンドで軽い。

### 6.1 配信先の分岐 —— Pages は Range を返さない **[既知]**

**Cloudflare Pages は Range リクエストに 200 を返す（206 非対応）。**
COPC を Pages に置くと、1 ノード取るたびにファイル全体が落ちてくる。
つまり **COPC を採用した意味が消える。** これは「COPC にしたから大丈夫」が
成り立たない具体例そのもの。

| asset | 置き場所 | 理由 |
|---|---|---|
| viewer (html/js/wasm), catalog, タイル, geojson | Pages / Workers Assets | Range 不要。小さく数が多い |
| **`.copc.laz`** | **R2**（206 を返す） | Range 必須 |
| 3D Tiles (b3dm) | どちらでも可 | ファイル単位取得で Range 不要 |

**同一オリジンに揃える**（`PerformanceResourceTiming.transferSize` はクロスオリジンだと 0）。
Worker で `/{assets}` を Pages、`/data/*.copc.laz` を R2 binding にパスルーティングするか、
R2 カスタムドメインを同一ゾーンに置いて `Timing-Allow-Origin` を付ける。
**v1 のローカルサーバは 206 を正しく返すので、この差は「Cloudflare に載せる時の条件」として記録する。**

**v1 ではこれを構築しない。** ローカルの静的サーバ（§9.2）で viewer を完成させ、
`catalog.json` の URL を差し替えるだけで Cloudflare に載る形にしておく。
**境界は「catalog.json が指す URL」1点**。

> **実装済み（`docs/INFRA.md`）**: 静的配信は Workers Assets、`/data/pointcloud/*.copc.laz` だけ
> Worker → R2 binding。結果として catalog.json の URL は相対のまま変えずに済んだ。
> なお **Workers Assets も Range に 200 を返す** ことをローカル workerd で実測しており、
> ここで Pages について書いた条件は Workers Assets にも当てはまる。

---

## 7. Upload lifecycle

LAS/LAZ は **API server / Worker を経由させない**。ブラウザ → R2 直接 multipart。

```
1. POST /api/uploads            { name, size, sha256Prefix }
     Worker: D1 に row 作成 → R2 (S3 API) CreateMultipartUpload
     ← { datasetId, uploadId, partSize, key }

2. POST /api/uploads/:id/parts  { partNumbers: [n...] }        （数十本ずつまとめて）
     Worker: aws4fetch で presigned PUT URL を生成（signQuery: true）
     ← { urls: { n: url } }

3. Browser: File.slice(part) を並列 PUT（3〜6本, 指数バックオフ retry）
     進捗 = 完了パート数 × partSize。ETag を IndexedDB に保存

4. POST /api/uploads/:id/complete  { parts: [{n, etag}] }
     Worker: CompleteMultipartUpload → D1 更新 → Queue へ enqueue
     ← { jobId }

5. GET /api/jobs/:jobId （polling）
     PDAL inspect → ground filter → DTM → COPC → flood/semantic analysis
     ← { state, steps[], catalogUrl? }

6. 完了後、browser は新しい catalog.json を読み、同じ画面にデータセットを追加
```

**注意点 [既知]**
- **R2 の CORS 設定が必須。** presigned URL が正しくてもブラウザは弾かれる。
- `aws4fetch` の `signQuery: true` は host しか署名しない。
  **ブラウザから `Content-Type` を手で付けない**（未署名ヘッダで R2 が拒否する）。
- Workers から presigned URL を作るのは `aws4fetch`（AWS SDK は Workers で動かない）。

**resumable を将来入れるための最低条件**（v1 では実装しないが、妨げない設計にする）
- `uploadId` + ファイル指紋（size + 先頭/末尾 1 MiB の SHA-256）を IndexedDB に保存
- 再開時は `ListParts` で済んだパートを確認し、残りだけ送る
- パートサイズを固定（既定 16 MiB）してパート番号を決定的にする

**[未確認]** R2 のマルチパート最小パートサイズと最大パート数の現行値。実装時に確認する。

---

## 8. Performance instrumentation

### 8.1 FPS は指標にしない

測るのは「いつ・どれだけのバイトで・何が見えたか」。

### 8.2 マイルストーン

| name | 定義（曖昧さを残さない） |
|---|---|
| `app_start` | `performance.timeOrigin` |
| `catalog_loaded` | `catalog.json` のパース完了 |
| `first_meaningful_render` | **視野を覆う `terrain-coarse`（最小ズーム）タイルが全て GPU に乗り、浸水色が1フレーム描かれた時刻**。高ズームの到着は待たない |
| `time_to_terrain` | 可視範囲の terrain タイルが**そのカメラでのネイティブ z** まで揃った |
| `time_to_plateau` | 可視 3D Tiles の b3dm が全て描画された |
| `time_to_first_useful_pc` | 可視領域の点群が `USEFUL_POINTS`（既定 200k）以上描画された |
| `time_to_pc_refined` | LOD budget を満たす全ノードが常駐 |
| `camera_settle_latency` | `moveend` → 新カメラでの `terrain-fine` 全タイル + `pc-coarse` 全ノードが常駐するまで（`pc-fine` は待たない） |

### 8.3 収集する量

| 量 | 取り方 |
|---|---|
| initial bytes transferred | `PerformanceObserver('resource')` の `transferSize` 合計（`app_start`→`first_meaningful_render`） |
| bytes @10s | 同上、10 s 時点 |
| HTTP Range request count | scheduler が自分で数える（class 別） |
| peak concurrent requests | scheduler の in-flight 最大値（class 別） |
| cancelled requests / wasted bytes | scheduler。**wasted は abort までに実際に読めたバイト**（§4.5） |
| decode time | Worker 内で計測して postMessage に載せる。class 別 p50/p95 |
| GPU upload time | バッファ/テクスチャアップロード周りの `performance.now()`。可能なら `EXT_disjoint_timer_query_webgl2`（**[未確認]** 利用可否） |
| nextHopProtocol | `PerformanceResourceTiming`。h1/h2 の判定と結果解釈に使う |

`transferSize` はクロスオリジンだと 0 になる。**同一オリジン配信**にするか
`Timing-Allow-Origin` を付ける。ローカル計測サーバは同一オリジンで揃える。

### 8.4 検証テスト（性能とは別に、正しさを守るもの）

| テスト | 内容 |
|---|---|
| packing round-trip | GeoTIFF → PNG タイル → ブラウザでデコード → 元の値と一致（許容 1/256 m） |
| TS ↔ GLSL 一致 | `wet/depth` の TS 実装と GLSL 実装が同一入力で一致 |
| assertion 一致 | `objects.geojson` の `decision_changed@H` が、ブラウザ側 `h_conn` 再計算と一致 |

**水位変更でサーバ再計算が起きないことは、テストで担保する**
（水位スライダ操作中の scheduler リクエスト数 == 0 をアサート）。

### 8.5 ネットワークプロファイル

Playwright + CDP `Network.emulateNetworkConditions`。数値は本リポジトリの定義とする
（Chrome DevTools のプリセットを模したもの。プリセットそのものではない）。

| profile | down | up | RTT |
|---|---|---|---|
| `normal` | 無制限 | 無制限 | 0 ms |
| `fast4g` | 4 Mbps | 3 Mbps | 70 ms |
| `slow-highrtt` | 1 Mbps | 0.5 Mbps | 400 ms |

各プロファイルで:
- `Network.clearBrowserCache` + `Cache API` クリア（cold cache）
- 固定カメラで初期ロード → 10 s 待つ
- 決まったカメラ操作スクリプト（パン → ズームイン → 停止）を再生し `camera_settle_latency` を取る
- `web/perf/results/{profile}.json` に書く

`scripts/90_perf.mjs`（Playwright）で 3 プロファイルを回し、比較表を Markdown で出す。

---

## 9. 最小 vertical slice

> 吉原サンプルを production 相当の HTTP 配信から cold cache で開き、
> PLATEAU + terrain + flood + point cloud を progressive に表示し、水位変更が即応する。

### 9.1 スコープ

含む:
- `catalog.json` + RGBA タイル（baseline / highres）+ 3D Tiles AOI サブセット
  + `objects.geojson` + 合成 COPC
- MapLibre + deck.gl（interleaved）、`FloodTileLayer`（自作シェーダ）
- scheduler（優先度 / 並列上限 / cancellation / coalescing / cache / prefetch）
- COPC: index → LOD → scheduler → worker decode → `PointCloudLayer`
- UI: terrain 切替 / 水位スライダ / レイヤ ON-OFF / 差分 / 地物クリック
- instrumentation + Playwright ハーネス + 3 プロファイル実測

含まない（v1 では作らない）:
- Cloudflare 実インフラ、upload、job orchestration
- custom point-cloud renderer
- 3D terrain メッシュ
- resumable upload

### 9.1.1 二重スケジューラの解消 **[既知]**

`Tile3DLayer` の裏にいる loaders.gl `Tileset3D` は**自前の RequestScheduler を持つ**
（`maxRequests` 既定 64、`throttleRequests`、視野外タイルのキャンセル機能つき）。
放置すると我々の scheduler と二重になり、優先度制御が効かない。

対処: `loadOptions.tileset.throttleRequests = false` にして Tileset3D 側の絞りを外し、
`loadOptions.fetch` に**我々の scheduler を呼ぶ fetch 実装**を渡す。
choke point を1箇所に統一する。Tileset3D の視野外キャンセルは
`AbortSignal` として我々の fetch に伝わるので、そのまま活かす。

### 9.2 production 相当の配信

計測の結論が配信条件に強く依存するので、ローカルサーバは次を満たす:

- **HTTP/2**（自己署名 TLS + Playwright の `--ignore-certificate-errors`）
  と **HTTP/1.1** を切り替えられる。h1/h2 で並列度の結論が変わるため両方測る。
- `Range` 対応（206 / `Accept-Ranges`）
- 事前圧縮した `.br` / `.gz` を `Accept-Encoding` で出し分け
- `Cache-Control: public, max-age=31536000, immutable`（content hash 付き URL）
- `Timing-Allow-Origin` 不要（同一オリジン）

`web/serve.mjs` に実装する。Cloudflare Pages にも同じアセットをそのまま置ける。

### 9.3 進行順（各段で計測してから次へ）

1. アセット生成 → サイズ実測 → catalog
2. サーバ + scheduler + instrumentation（**描画より先に**。数えられないものは直せない）
3. `FloodTileLayer` + 水位スライダ → `first_meaningful_render` 計測
4. 3D Tiles → `time_to_plateau`
5. COPC → `time_to_first_useful_pc`、coalescing on/off 比較
6. 3 プロファイル × h1/h2 で実測 → 本書に結果を追記 → 次の設計判断

---

## 10. custom point-cloud renderer へ移行する判断条件

`PointCloudRenderer` インターフェースを挟んであるので、判断は**実測後**でよい。
以下のいずれかが実測で成立したら移行する。

**実測で条件 1 は既に成立している**（`docs/WEB_RESULTS.md` §6.2）。
ただし律速は当初想定した layer 管理ではなく **描画そのもの**だった。条件の書き方を実測に合わせて直す。

| # | 条件 | 状態 | なぜそれが限界の徴候か |
|---|---|---|---|
| 1 | 常駐 200 万点でドラッグ中 frame p50 > 16.7 ms | **成立**（2.13 M で 57 ms、2.97 M で 68〜82 ms。約 23 ns/点/frame） | deck.gl `PointCloudLayer` は 1 点をインスタンス化クアッドで描く（300 万点 = 1,800 万頂点/frame）。`gl.POINTS` + 単一 VBO なら 1/6 の頂点・1 draw call にできる |
| 1b | ~~layer diff / attribute 更新が 40% 超~~ | 解消済み | レイヤ実体をキャッシュして解決（毎回 new すると全属性が再アップロードされていた）。**律速は描画側だった** |
| 2 | 可視ノード数が 200 を超え、`PointCloudLayer` の sub-layer 更新が 5 ms/frame を超える | 未成立（現状 15〜75） | ノード = レイヤの対応が破綻 |
| 3 | ノード追加のたびに既存バッファが作り直され、GPU アップロードが増加し続ける | 解消済み（レイヤキャッシュ） | 明示的なバッファプール/eviction が必要 |
| 4 | EDL・密度連動の点サイズ・ノード単位のフェードイン・ノード内 progressive refinement のいずれかが必要になった | 未 | deck.gl の `PointCloudLayer` で表現できない |
| 5 | GPU メモリ上限に当たり、LRU eviction を自前で持つ必要が出た | 未 | 同上 |

**現時点の判断**: LOD 予算を 60 万点に下げて 60 fps を確保した（`docs/WEB_RESULTS.md` §6.2）ので、
custom renderer への移行は**急がない**。ただし
「実 LAS を入れて 60 万点では足りない」と分かった時点で条件 1 が実運用上の制約になる。
そのときの移行先と、`PointCloudIndex` / `LodSelector` / `Scheduler` / `DecodePool` を
そのまま再利用する方針は変えない。

移行先は **maplibre-gl の `CustomLayerInterface`（`renderingMode: '3d'`）**。
MapLibre からは投影行列だけを受け取り、頂点バッファ・シェーダ・LOD フェードは自前で持つ。
`PointCloudIndex` / `LodSelector` / `Scheduler` / `DecodePool` は**そのまま再利用する**
（だからこの4つを renderer から分離してある）。

---

## 11. 既知のリスクと未確認事項

| # | 事項 | 区分 | 対処 |
|---|---|---|---|
| 1 | **maplibre-gl 6 と @deck.gl/mapbox 9.3 は組み合わせられない** | **[実測]** | maplibre-gl 6 は `map.transform` を廃止しており、`deck-utils.js` の `map.transform.height` で毎フレーム例外。interleaved 描画が一切出ない。**maplibre-gl は 5.x に固定**（5.24.0 で正常動作を確認） |
| 1b | maplibre-gl 5 + deck.gl 9.3 で MapLibre terrain がどこまで使えるか | **[未確認]** | v1 は terrain 無し（§2.2）。必要になったら実機確認 |
| 1c | 手で作った `Response` を `loadOptions.fetch` から返すと loaders.gl が loader を選べない | **[実測]** | `response.url` が空になり tileset.json が b3dm として解釈されて `3DTileLoader: unknown type` になる。`Object.defineProperty(res, 'url', {value: url})` で解決 |
| 1d | PLATEAU の b3dm の一部で deck.gl の `ScenegraphLayer` が `size: 1` で初期化に失敗する | **[実測]** | 22 タイルすべて取得・パースは成功するが、一部のサブレイヤが luma.gl の vertex format 変換で落ちる。**未解決**。バイト転送は発生するのでネットワーク計測には影響しない |
| 2 | RGBA パッキングの premultiply 破壊 | **[既知]** | `premultiplyAlpha:'none'` + 往復テスト。ダメなら RGB 2枚に分割 |
| 3 | ジオイド高 N の実値 | **[未確認]** | build 時に実測して catalog に焼く。暫定 37.0 m |
| 4 | R2 はマルチレンジに 400 を返す | **[既知]** | 連続 1 レンジへの coalescing のみ。`COALESCE_GAP` を実測で決める |
| 4b | **Cloudflare Pages は Range に 200 を返す（206 非対応）** | **[既知]** | COPC は R2 から配信。§6.1 |
| 4c | loaders.gl `Tileset3D` が独自 RequestScheduler を持つ | **[既知]** | `throttleRequests:false` + `loadOptions.fetch` で choke point を一本化。§9.1.1 |
| 5 | `EXT_disjoint_timer_query_webgl2` の可用性 | **[未確認]** | 無ければ CPU 側の壁時計で代用し、その旨を結果に明記 |
| 6 | AOI が 1 km 四方と小さく、ネットワーク設計を十分に追い込めない可能性 | **[仮説]** | 合成 COPC 400 万点 + 3D Tiles で総量 60〜100 MB を見込む。足りなければ AOI を拡張して再測 |
| 6b | 合成点群は DTM の規則格子なので LAZ が異常に良く効き、ファイルが小さくなりすぎる恐れ | **[仮説]** | 生成後にサイズを実測。負荷源として不足なら AOI 拡張または実 LAS を待つ。**水増しでサイズを作らない** |
| 9 | MapLibre の DEM 経路に RGBA タイルを渡すと premultiply で標高が壊れる | **[既知]** | `raster-dem` を使わない。hillshade は自前シェーダ。§5.2 |
| 7 | 合成点群を観測データと誤認されるリスク | — | catalog・UI・ファイル名すべてに `synthetic-from-dtm` を明示 |
| 8 | `transferSize` がクロスオリジンで 0 | **[既知]** | 同一オリジン配信 |

---

## 12. 自己レビュー

初稿を書いたあとに自分で洗い直した。**設計が自分で自分の首を絞めていた箇所が 5 つあった。**
以下は指摘と、それを受けて本書に入れた修正。修正は既に本文に反映済み。

| # | 指摘 | 深刻度 | 修正 |
|---|---|---|---|
| 1 | **`objects.geojson`（250 kB）を P0 に置いていた。** 1 Mbps では 2 秒かかり、`first_meaningful_render` を丸ごと押し出す。「解析を先に出す」つもりの優先度設計が、逆に最初の描画を遅くしていた | 高 | クラスを分割。P0 の実データは `terrain-coarse`（数十 kB）だけにし、`objects.geojson` は P2 に降格（§4.1） |
| 2 | **RGBA タイルを MapLibre の `raster-dem` に流用する設計にしていた。** MapLibre は DEM を通常のイメージ経路で読むので alpha が premultiply され、A<255 の画素（＝ほぼ全ての浸水域）で標高が壊れる。静かに間違った絵が出る最悪の型 | 高 | `raster-dem` をやめ、hillshade を `FloodTileLayer` のシェーダ内で計算（§2.1, §5.2）。副次的に追加ピラミッドもリクエストも不要になった |
| 3 | **`first_meaningful_render` の定義が「可視範囲のタイルが全部」だった。** これでは最大ズームの到着を待つことになり、progressive loading を測る指標として意味を失う | 中 | 「視野を覆う**最小ズーム**タイルが描かれた時刻」に変更。最大 z 到達は `time_to_terrain` として別に測る（§8.2） |
| 4 | **キャンセル条件が「epoch が古い」だけだった。** 連続パン中に毎フレーム epoch が進み、9 割受信済みのリクエストまで捨てる。wasted bytes を測る仕組みが wasted bytes を作る | 中 | LOD selection を 60 ms デバウンス、「新可視集合に無い」かつ「受信 < 80%」かつ「class ≥ 2」でのみキャンセル（§4.5） |
| 5 | **3D Tiles の裏に別のスケジューラがいることを見落としていた。** loaders.gl `Tileset3D` が `maxRequests: 64` の自前 RequestScheduler を持つ。我々の優先度制御は素通りされる | 中 | `throttleRequests:false` + `loadOptions.fetch` で choke point を一本化（§9.1.1） |

**調べ直して判明し、設計を変えた事実**

| 事実 | 影響 |
|---|---|
| **Cloudflare Pages は Range に 200 を返す（206 非対応）** | COPC を Pages に置くと 1 ノード取るたびに全ファイルが落ちる。**「COPC を採用したからネットワークは解決」がまさに成り立たない実例。** COPC は R2 配信に確定（§6.1）。scheduler は「Range を要求したのに 200 が返ったらエラー」を実装する（§4.7） |
| **R2 はマルチレンジ（`bytes=a-b, c-d`）に 400 を返す** | coalescing は連続 1 レンジのみ。飛び地は結合できないので `COALESCE_GAP` 分の無駄バイトを許容するトレードオフになる（§4.4） |
| **copc.js の `Getter` は `(begin, end) => Promise<Uint8Array>`** | COPC の IO を全部我々の scheduler に通せることが確定。`Hierarchy.Node` が `pointDataOffset`/`pointDataLength` を持つので coalescing も自前で書ける（§3.2） |
| **deck.gl 公式が「terrain 使用時に z=0 のデータが海面に描かれる」と明記** | v1 で MapLibre terrain を使わない判断の根拠（§2.2） |
| **PLATEAU 3D Tiles の region 高さが 37.9〜86.5 m** | 楕円体高。T.P. との差（ジオイド高 ≈ 37 m）を実測して合わせる必要がある（§2.3） |

**まだ弱いと自覚している点**

1. **AOI が 1 km 四方しかない。** 総量 60〜100 MB を見込んでいるが **[仮説]** であり、
   実測して足りなければネットワーク設計の追い込みが甘くなる。その場合は AOI 拡張が必要。
2. **合成点群は本物の点群ではない。** 密度分布・ノイズ・classification の偏りが実データと違うので、
   LOD selection と decode コストの結論は実 LAS で測り直す必要がある。
3. **優先度クラスの数値（並列上限・budget 比率）はすべて初期値であって根拠がない。**
   §8 の実測でチューニングする前提。本書の数値を「決まった仕様」として扱わない。
4. **`camera_settle_latency` の「必要ノード」の定義は恣意的。** `pc-fine` を含めないのは
   体感に寄せた判断であり、別の定義なら別の結論になりうる。結果にはこの定義を必ず併記する。

### 12.1 実装・計測して初めて分かったこと（`docs/WEB_RESULTS.md`）

**設計レビューでは 1 つも予見できていなかった最大の問題**:

> **ボトルネックは地理データではなく、アプリの JS バンドルだった。**
> `slow-highrtt`(1 Mbps/400 ms) では 12 秒経っても一度も描画されず、
> 発行されたリクエストは `catalog.json` の 1 本だけだった。
> 地形タイルを取りに行く前に、610 kB(gz) の初期チャンクで時間を使い切っていた。

本書は §4 で優先度クラスを細かく設計し、§4.4 で coalescing を用意し、§5.2 で
リクエスト数を半分にするパッキングまで考えたが、**それら全部の手前に一番大きな壁があった。**
`@loaders.gl/3d-tiles` と `copc`/`laz-perf` を動的 import に出すだけで、
FMR までの転送は 4.17 MB → 0.74 MB、`slow-highrtt` は「描画されず」→ 3.1 秒になった。

→ **本書に足りていなかった観点**: 「配信するデータ」だけでなく
**「そのデータを描くためのコード」も優先度設計の対象**である。
アセットのクラス分けと同じ粒度で、バンドルの分割境界を設計に含めるべきだった。
§4.1 の優先度表に `app-shell` という行が最初から要る。

その他、実装して分かったこと:

| 事項 | 内容 |
|---|---|
| coalescing は無損失だった | COPC のノードはファイル上でほぼ連続しており、42 ノードを 4 リクエストにまとめても「読むが使わないバイト」は 0 だった |
| **coalescing はストリーミングとセットでないと逆効果** | まとめた range を全部待ってからデコードすると、リクエスト数が減っても最初の点が遅れる。実測で一度否定し、逐次払い出しを実装したら符号が反転した（`docs/WEB_RESULTS.md` §4.1）。**「1 リクエストの完了」を暗黙の処理単位にしていた設計の穴** |
| キャンセル経路は未検証のまま | テストのカメラ操作では可視集合がほとんど変わらず、キャンセル 0 件。§4.5 の防御が効きすぎている可能性もある。**シナリオ不足で評価できていない** |
| 水位スライダのリクエスト 0 は確認できた | ただし静止状態で測れた `normal` のみ。スロットル下は初期ロードが静止せず測定条件を満たさなかった |
| ライブラリの組み合わせが最大の実装リスクだった | maplibre-gl 6 × deck.gl 9.3 は動かない（§11 #1）。手製 `Response` は loaders.gl が loader を選べない（§11 #1c）。一部 b3dm は deck.gl で描けない（§11 #1d） |
