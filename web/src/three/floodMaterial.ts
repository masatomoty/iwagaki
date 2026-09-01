// FloodMeshLayer（deck.gl + luma.gl）の three.js への移植。
// 判定式は src/domain/flood.ts と一致していること（test/parity で検証）。
//
// 元実装からの変更は 3 点だけで、判定・標高デコード・補間規則は 1 行も変えていない:
//   1. project_position_to_clipspace -> 自前のワールド座標（src/three/mercator.ts）
//   2. UBO (layout std140) -> three の個別 uniform
//   3. **テクスチャ v の反転**（下記）
//
// ## テクスチャの向き（実データで確認済み）
// タイル PNG は `scripts/80_build_web_tiles.py` が rasterio の
// `from_bounds(west, south, east, north, 256, 256)` で焼くので **row 0 = 北**。
//   z17/114808/51713 の実測: row0 平均 78.4 m / row255 平均 36.5 m
//   同じ緯度の dtm_highres_050.tif: 北端 80.4 m / 南端 28.0 m
// three は flipY を明示 false で上げるので t=0 が row 0 = 北を指す。
// 一方 aUv.y=0 は bounds の南側なので、**サンプルは 1-v で引く**。
//
// 移植時に「luma.gl が暗黙に上下反転して上げているから元実装は素の uv で
// 合っていたのだろう」と書いたが、**それは誤りだった**。luma.gl も
// UNPACK_FLIP_Y_WEBGL を立てない。元実装は本当に南北が反転しており、
// 独立に見つかって main で直された（`docs/web_results.md` §6.8 / commit b6b45d7）。
// 結論の式 `vec2(uv.x, 1.0 - uv.y)` は両者で一致している。

import {
  BufferAttribute, BufferGeometry, DoubleSide, GLSL3, NearestFilter,
  NoColorSpace, ShaderMaterial, Texture, Vector4,
} from 'three'

/** タイルあたりのメッシュ分割数。z18 で 124 m / 128 ≈ 1 m */
const GRID = 128
/** タイル境界のひび割れを隠すスカート（メートル、鉛直強調前） */
const SKIRT_M = 3
const TEX = 256

/**
 * 面を何で塗るか。`assumption` だけは 2 条件の差ではなく、**その土地が浸かると
 * 言うのにどこまで仮定が要るか**を 3 段で出す（`domain/types.ts` の
 * `ASSUMPTION_STEPS`）。差分タイルの R / G / B をそれぞれ
 * 「海から連結」「仮想排水路を逆流」「潮位以下なだけ」の閾値として引き、
 * いまの潮位で成立する段を数えるだけ。
 * **タイルは 1 バイトも増えず、潮位を動かしても再取得は起きない。**
 */
export const FLOOD_MODE = { terrain: 0, diff: 1, assumption: 2 } as const

/**
 * 描画パス。**同じタイル・同じテクスチャを 2 回描く。**
 *
 * - `ground` … 地形の面（従来どおり。標高で上下し、浸水色を面に塗る）
 * - `water`  … **水平な水面**。z = geoid + H * 鉛直強調 に置く
 *
 * 水面を別パスにしたのは、以前は水面という物体が無かったからである。
 * 浸水は地形メッシュのピクセルを深さランプで塗るだけだったので、
 * **潮位を動かすと色は変わるが高さは変わらない**（外部から
 * 「海面は潮位を変えると高さも変動しているのか」と質問が来た。2026-08）。
 *
 * 判定式は増やしていない。水面パスも `h_conn <= H` と `depth = H - 標高` を
 * そのまま使う（`src/domain/flood.ts` と同一）。**要求するタイルも増えない。**
 */
export const FLOOD_PASS = { ground: 0, water: 1 } as const

export interface FloodUniformValues {
  /** ワールドメートルでのタイル境界 [xWest, ySouth, xEast, yNorth] */
  worldBounds: [number, number, number, number]
  waterLevel: number
  hStep: number
  /** 0 = 地形, 1 = 差分 */
  mode: number
  exaggeration: number
  geoid: number
  metersPerTexel: number
  floodOpacity: number
  groundOpacity: number
  showGround: number
  /** 平常時に水がある範囲の閾値 [m T.P.]。MSL を渡す */
  waterBase: number
  /**
   * 水面パスを描くか。`TerrainTiles` が水面メッシュの `visible` に使い、
   * **地形パスにも uniform として渡る**。
   *
   * 水面を出しているときに地形の面へ浸水深ランプを塗ると、
   * **水面の青と地面の青が重なって水面の高さが読めなくなる**（実測: 真横から見ても
   * 水面 ON / OFF の絵が区別できなかった）。だから水面 ON のときは地形を
   * 乾いた地面として描き、**水は水面メッシュだけが持つ**。
   */
  waterSurface: boolean
  /**
   * **窪地**（標高 ≤ 潮位 だが `h_conn > 潮位`）を出すか。判定式は
   * `domain/flood.ts` の `ponded()` と同一で、test/parity が一致を見ている。
   *
   * タイルは 1 バイトも増えない。標高（RGB）と `h_conn`（A）はもともと
   * **同じ画素に入っている**ので、両方を引けばこの画素で判定できる。
   */
  ponded: boolean
  /**
   * **単純モデル**（潮位 − 地盤高）で塗るか。`domain/types.ts` の `FloodModel`。
   *
   * 立てると `h_conn` を見ずに `標高 < 潮位` だけで浸水を決める。
   * **タイルは 1 バイトも変わらない**（`h_conn` を引かなくなるだけ）。
   * 既定はこちら（市の回答、2026-08）。
   */
  simple: boolean
  /** 仮想排水モデル。diff タイルの G チャンネルを h_conn として使う */
  drainage: boolean
  /**
   * **地盤高そのもの**をグラデーションで塗るか（`domain/types.ts` の `TerrainPaint`）。
   * 標高はもともとタイルの RGB に入っているので、これも配信物は増えない。
   */
  elevPaint: boolean
  /**
   * **水みち**（flow accumulation）で塗るか。専用タイル `flowTexture`（`catalog.flow`）の
   * R = log 正規化した集水、B = 充填深コード。**潮位を一切使わない**
   * （`elevation` と同じく浸水色を出さない面。`docs/todo.md`「FARR のロジックを取り込む」）。
   */
  catchmentPaint: boolean
}

const DECODE = /* glsl */ `
const float TEX = ${TEX}.0;

/**
 * aUv (y=0 が南) -> テクスチャ座標 (t=0 が北)。上記のとおり v を反転する。
 * area-registered なので、さらに最寄りセル中心へ 0.5 ずらす。
 */
vec2 flipV(vec2 uv) { return vec2(uv.x, 1.0 - uv.y); }

vec2 cellUv(vec2 uv) {
  vec2 v = flipV(clamp(uv, 0.0, 1.0));
  return (clamp(floor(v * TEX), 0.0, TEX - 1.0) + 0.5) / TEX;
}

float decodeElev(vec3 c) {
  if (c.r == 0.0 && c.g == 0.0 && c.b == 0.0) return -9999.0;   // nodata
  return (c.r * 255.0) * 256.0 + (c.g * 255.0) + (c.b * 255.0) / 256.0 - 32768.0;
}
float decodeHConn(float a) {
  float code = floor(a * 255.0 + 0.5);
  return code < 0.5 ? 1e9 : (code - 1.0) * uHStep;
}

/** 水みちタイル B チャネル（充填深コード, h_step 刻み。0 = 窪地でない）*/
float decodeFillDepth(float b) {
  float code = floor(b * 255.0 + 0.5);
  return code < 0.5 ? 0.0 : (code - 1.0) * uHStep;
}
`

const VS = /* glsl */ `
in vec2 aUv;
in float aSkirt;

uniform sampler2D elevTexture;
uniform vec4 uWorldBounds;
uniform float uHStep;
uniform float uExaggeration;
uniform float uGeoid;
uniform float uMetersPerTexel;
uniform float uPass;
uniform float uWaterLevel;
uniform float uWaterBase;
uniform float uElevPaint;
uniform float uCatchmentPaint;
uniform float uMode;

out vec2 vUv;
out float vElev;
out float vValid;
out vec3 vNormal;

${DECODE}

/** 最寄りセルの値。nodata 判定にはこちらを使う（補間すると nodata が混ざる） */
float sampleElevNearest(vec2 uv) {
  return decodeElev(texture(elevTexture, cellUv(uv)).rgb);
}

/**
 * セル中心を格子点とみなした双線形補間。**デコードしてから混ぜる**
 * （パックされた RGB を線形補間すると別の標高になるので GPU の LINEAR は使えない）。
 * 4 点のどれかが nodata なら補間せず最寄りセルに落とす。混ぜると
 * -9999 と実標高のランプができ、海際に平らな棚が生える。
 */
float sampleElev(vec2 uv) {
  vec2 t = clamp(flipV(clamp(uv, 0.0, 1.0)) * TEX - 0.5, vec2(0.0), vec2(TEX - 1.0));
  vec2 b = floor(t);
  vec2 f = t - b;
  vec2 b1 = min(b + 1.0, TEX - 1.0);
  float e00 = decodeElev(texture(elevTexture, (b + 0.5) / TEX).rgb);
  float e10 = decodeElev(texture(elevTexture, (vec2(b1.x, b.y) + 0.5) / TEX).rgb);
  float e01 = decodeElev(texture(elevTexture, (vec2(b.x, b1.y) + 0.5) / TEX).rgb);
  float e11 = decodeElev(texture(elevTexture, (b1 + 0.5) / TEX).rgb);
  float lo = min(min(e00, e10), min(e01, e11));
  if (lo < -9000.0) return sampleElevNearest(uv);
  return mix(mix(e00, e10, f.x), mix(e01, e11, f.x), f.y);
}

void main() {
  vUv = aUv;
  float e = sampleElev(aUv);
  vElev = e;
  vValid = sampleElevNearest(aUv) < -9000.0 ? 0.0 : 1.0;

  float d = 1.0 / TEX;
  float hl = sampleElev(aUv - vec2(d, 0.0));
  float hr = sampleElev(aUv + vec2(d, 0.0));
  float hu = sampleElev(aUv - vec2(0.0, d));
  float hd = sampleElev(aUv + vec2(0.0, d));
  // aUv.y は北向きなので、hu が南・hd が北。法線の y 成分は (hu - hd) になる
  vNormal = normalize(vec3(
    (hl - hr) * uExaggeration,
    (hu - hd) * uExaggeration,
    2.0 * uMetersPerTexel));

  float base = e < -9000.0 ? 0.0 : e;
  float z = uGeoid + (base - aSkirt * ${SKIRT_M}.0) * uExaggeration;

  // **水面は水平面。** 標高ではなく潮位そのものを高さにする。
  // スカートも下げない（隣のタイルの水面と同じ z なので継ぎ目が開かない）。
  // 鉛直強調は地形と同じ係数を掛ける。掛けないと ×5 で地面が水面を突き抜ける
  // **地盤高モードでは水面を平常時の海面に置く。** 潮位まで張ると、
  // いちばん見せたい低地がすべて青に隠れて「どこが低いか」が読めない。
  // 水面そのものを消すと、航空レーザが値を返さない港と湾が穴になる
  // **仮定の段階でも水面は平常時の海面に置く。** 潮位まで張ると、いちばん
  // 見せたい「仮定が要る土地」が青に隠れて段の色が読めない（地盤高モードと同じ理由）
  // **水みちモードも平常時の海面に置く**（潮位まで張ると集水の色が青に隠れる）
  bool flatSea = uElevPaint > 0.5 || uCatchmentPaint > 0.5 || uMode > 1.5;
  if (uPass > 0.5) z = uGeoid + (flatSea ? uWaterBase : uWaterLevel) * uExaggeration;

  // XYZ タイルは Web メルカトル上で正方なので、ワールド（= メルカトルの線形変換）で
  // 線形補間してよい。経緯度で補間すると緯度方向が非線形になる
  vec2 xy = mix(uWorldBounds.xy, uWorldBounds.zw, aUv);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(xy, z, 1.0);
}
`

const FS = /* glsl */ `
precision highp float;

uniform sampler2D elevTexture;
uniform sampler2D diffTexture;
uniform sampler2D flowTexture;
uniform float uHStep;
uniform float uWaterLevel;
uniform float uMode;
uniform float uFloodOpacity;
uniform float uGroundOpacity;
uniform float uShowGround;
uniform float uWaterBase;
uniform float uHasDiff;
uniform float uPass;
uniform float uWaterSurface;
uniform float uPonded;
uniform float uSimple;
uniform float uDrainage;
uniform float uElevPaint;
uniform float uCatchmentPaint;
uniform float uHasFlow;

in vec2 vUv;
in float vElev;
in float vValid;
in vec3 vNormal;
out vec4 fragColor;

${DECODE}

/** 地面の色。窪地の下地にも使うので関数にしてある */
vec3 groundColor(float shade) {
  return vec3(clamp(0.30 + vElev * 0.010, 0.22, 0.72)) * vec3(1.00, 0.99, 0.95) * shade;
}

/**
 * **窪地**（標高 ≤ 潮位 だが海と地表面ではつながっていない）の印。
 *
 * 浸水域と同じ「面の色」にはしない。**根拠が違うものを同じ強さで塗らない**ためで、
 * 地面の上に**画面座標の斜線**を重ねる。画面座標で振るのはズームしても縞の太さが
 * 変わらないようにするためで、そうすると「地形の属性」ではなく
 * 「こちらが重ねた印」として読める。
 *
 * 色は浸水の青（0.45,0.79,0.95 → 0.03,0.18,0.55）より彩度を落とした水色にする。
 * 画面の色の枠は 地面＝暗い灰 / 建物＝灰・黄・赤 / 水＝青 / 道路＝ほぼ白 で
 * 埋まっているので、**新しい色相は足さず、水の色相を薄めて借りる**
 * （docs/web_design.md「画面の色は 1 つの予算である」。**この文字列はテンプレート
 * リテラルの中なので backtick は書けない**）。
 */
vec4 pondedFill(float shade) {
  const vec3 PONDED = vec3(0.44, 0.75, 0.80);
  float s = fract((gl_FragCoord.x + gl_FragCoord.y) / 11.0);
  float stripe = smoothstep(0.40, 0.50, s) * (1.0 - smoothstep(0.90, 1.0, s));
  vec3 base = uShowGround > 0.5 ? groundColor(shade) : PONDED * 0.34;
  return vec4(mix(base, PONDED, 0.28 + 0.52 * stripe),
              max(uGroundOpacity, 0.70));
}

/**
 * **仮定の段階の色。** その土地が浸かると言うのに、どこまでこちらが仮定を
 * 置いているか（domain/types.ts の ASSUMPTION_STEPS）。
 * **この文字列はテンプレートリテラルの中なので backtick は書けない。**
 *
 * - 3 段 … 仮定なし。海から地表面をたどって届く → **面の色で塗る**
 * - 2 段 … 吐口があるという仮定が要る → 斜線
 * - 1 段 … 潮位以下なだけで到達経路を示せない → 弱い斜線
 *
 * **仮定が要るものを面の色で塗らない。** 窪地の印と同じ理由づけで、
 * 画面座標の斜線に寄せて「こちらが重ねた印」として読めるようにする
 * （docs/web_design.md「画面の色は 1 つの予算である」）。新しい色相は足さず、
 * 浸水の青を薄める方向だけを使う。
 */
vec4 assumptionFill(float steps, float shade) {
  const vec3 SURE = vec3(0.16, 0.34, 0.58);      // 差分の「どちらも浸水」と同じ青
  const vec3 GATED = vec3(0.30, 0.56, 0.76);
  const vec3 UNSURE = vec3(0.55, 0.74, 0.86);
  if (steps > 2.5) return vec4(SURE * shade, uFloodOpacity);
  vec3 c = steps > 1.5 ? GATED : UNSURE;
  float s = fract((gl_FragCoord.x + gl_FragCoord.y) / 11.0);
  float stripe = smoothstep(0.40, 0.50, s) * (1.0 - smoothstep(0.90, 1.0, s));
  vec3 base = uShowGround > 0.5 ? groundColor(shade) : c * 0.34;
  // 段が下がるほど地面が透ける。塗りの強さが仮定の度合いそのものになる
  float amt = steps > 1.5 ? 0.42 : 0.24;
  return vec4(mix(base, c, amt + 0.50 * stripe), max(uGroundOpacity, 0.70));
}

/**
 * **地盤高のグラデーション。**
 *
 * 市の提案（2026-08）「浸水深を見せる前に、どの場所の地盤が低いのかを
 * 色のグラデーションで」。標高はタイルの RGB にあるので配信物は増えない。
 *
 * 一般的な地形図に合わせ、低地を青、高地を緑〜黄〜茶で表す。
 * 浸水深の青とは異なり、標高の順序を色相の変化で読めるようにする。
 *
 * 振れ幅は **0〜3 m**。潮位スライダの帯（0.00〜3.00 m T.P.）と揃えてある。
 * 3 m を超えると地面の灰へ抜ける。ここを 0〜150 m（AOI の実レンジ）で振ると、
 * 市街の 0.5〜3 m がランプの最下端に固まって一様な紫になる。
 */
vec3 elevRamp(float e) {
  // **低い側を暗くしすぎない。** 0 m を黒紫に置いたら、暗い画面の地の色や
  // nodata の穴と見分けがつかず、**いちばん見せたい土地がいちばん沈んだ**。
  // 明度ではなく彩度で高さを送る（低い＝鮮やか、高い＝地面の灰へ抜ける）
  const vec3 C0 = vec3(0.18, 0.43, 0.64);   // 0 m: 青
  const vec3 C1 = vec3(0.30, 0.65, 0.43);   // 1 m: 緑
  const vec3 C2 = vec3(0.94, 0.83, 0.31);   // 2 m: 黄
  const vec3 C3 = vec3(0.65, 0.38, 0.16);   // 3 m: 茶
  const vec3 HI = vec3(0.60, 0.61, 0.59);   // 5 m 以上は地面の灰
  vec3 c = e < 1.0 ? mix(C0, C1, clamp(e, 0.0, 1.0))
         : e < 2.0 ? mix(C1, C2, e - 1.0)
         : e < 3.0 ? mix(C2, C3, e - 2.0)
                   : mix(C3, HI, clamp((e - 3.0) / 2.0, 0.0, 1.0));
  // **いまの潮位の等高線を白く重ねる。** 地盤高の絵と潮位スライダを
  // 1 枚でつなぐのはこの線だけなので、面の色より 1 段強く出してよい
  float line = 1.0 - smoothstep(0.0, 0.05, abs(e - uWaterLevel));
  return mix(c, vec3(1.0), line * 0.85);
}

/**
 * 水みちの色。引数 t は水みちタイルの R チャネル（= log 正規化済みの集水、[0,1]）。
 * docs/images/flow_accum.png の cubehelix_r に寄せて、低い側は地面へ抜け、
 * 集水が集まるほど水色 -> 紺 -> 紺黒へ深くする。新しい色相は足さない
 * （画面の色は 1 つの予算。水の青を借りる。docs/web_design.md）。
 * この文字列はテンプレートリテラルの中なので backtick は書けない。
 */
vec3 catchmentRamp(float t) {
  const vec3 A = vec3(0.85, 0.86, 0.82);   // 0: ほぼ地面
  const vec3 B = vec3(0.38, 0.69, 0.74);   // 中: 水色
  const vec3 C = vec3(0.09, 0.29, 0.53);   // 高: 紺
  const vec3 D = vec3(0.03, 0.08, 0.22);   // 最高: 紺黒
  return t < 0.40 ? mix(A, B, t / 0.40)
       : t < 0.75 ? mix(B, C, (t - 0.40) / 0.35)
                  : mix(C, D, (t - 0.75) / 0.25);
}

vec3 depthRamp(float d) {
  vec3 c0 = vec3(0.42, 0.80, 0.95);
  vec3 c1 = vec3(0.15, 0.50, 0.90);
  vec3 c2 = vec3(0.05, 0.16, 0.52);
  float t = clamp(d / 3.0, 0.0, 1.0);
  return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
}

void main() {
  // h_conn は判定値なので絶対に補間しない。必ず最寄りセルで引く
  vec2 cu = cellUv(vUv);

  // **nodata の discard は地形パスだけ。** 水面は地面の標高を知らなくても張れる。
  // 詳細は下の水面パスの枝を見ること

  // ---- 水面パス ------------------------------------------------------
  //
  // **差分モードでも elevTexture のアルファを見る。** そこに入っているのは
  // 「いま形を取っている条件」の h_conn なので、差分タイルが欠けている区画でも
  // 水面は張れる（domain/terrain.ts の resolveSurface が返す condition と一致する）。
  if (uPass > 0.5) {
    float hConn = decodeHConn(texture(elevTexture, cu).a);
    // 地盤高／水みち／仮定の段階モードの水面は平常時の海面（VS の z と揃えること）
    bool flatSea = uElevPaint > 0.5 || uCatchmentPaint > 0.5 || uMode > 1.5;
    float wl = flatSea ? uWaterBase : uWaterLevel;
    // **単純モデルは連結性を問わない**（標高が潮位を下回れば水面を張る）。
    // ただし **nodata のセルは標高が無いので判定できない**。港と湾は
    // 航空レーザが水面から反射を返さず nodata になるので、そこだけは
    // 従来どおり h_conn に任せる。任せないと湾が穴になる
    // 仮定の段階モードでは水面は「平常時の水域」を埋めるだけなので、
    // 排水モデルの h_conn に差し替えない（段の色は地形パスが持つ）
    if (uDrainage > 0.5 && uHasDiff > 0.5 && uMode < 1.5) {
      hConn = decodeHConn(texture(diffTexture, cu).g);
    }
    bool conn = hConn <= wl;
    if (!(uSimple > 0.5 && !flatSea && vValid > 0.999) && !conn) discard;
    float depth = wl - vElev;
    if (depth <= 0.0) discard;                 // 潮位より高い地面
    // **汀線を白く出す。** 潮位を動かしたときに動くものは面の色ではなく
    // 水際の位置なので、そこが読めないと「高さが変わった」ことが伝わらない
    float shore = 1.0 - smoothstep(0.0, 0.10, depth);
    // 以降は wl を基準にした depth だけで決まるので、モードで分岐しない
    // **ランプは 0〜2 m で振る**（0〜3 m だと吉原の浸水深がほぼ最浅端に固まって
    // 一様な水色になる。市街の標高が 0.5〜3 m しかないため）
    vec3 col = mix(vec3(0.45, 0.79, 0.95), vec3(0.03, 0.18, 0.55),
                   clamp(depth / 2.0, 0.0, 1.0));
    col = mix(col, vec3(0.95, 0.99, 1.00), shore * 0.85);
    // 地面の陰影を残しすぎると水に見えない。**道路と建物は水面より後に描く**ので、
    // ここを不透明側に寄せても地物の判定色は隠れない
    float a = mix(0.46, 0.84, clamp(depth / 1.5, 0.0, 1.0));
    fragColor = vec4(col, mix(a, 0.92, shore));
    return;
  }

  if (vValid < 0.999) discard;   // 少しでも nodata が混ざった三角形は捨てる
  vec3 n = normalize(vNormal);
  vec3 sun = normalize(vec3(-0.6, 0.7, 0.75));
  float shade = clamp(0.45 + 0.75 * dot(n, sun), 0.25, 1.35);

  // ---- 地盤高で塗る --------------------------------------------------
  //
  // **浸水の色を一切出さない。** 「どこが低いか」を見る画面なので、
  // 浸水域・窪地・判定差をここで重ねると、結局どちらを読む絵なのか決まらない。
  // 潮位との関係は elevRamp() が引く白い等高線 1 本だけが担う。
  if (uElevPaint > 0.5) {
    if (uShowGround < 0.5) discard;
    fragColor = vec4(elevRamp(vElev) * mix(1.0, shade, 0.55), uGroundOpacity);
    return;
  }

  // ---- 水みち（flow accumulation）で塗る ---------------------------------
  //
  // 潮位を一切使わない。一様降雨で地表流がどこに集まるか（src/iwagaki/flow.py）。
  // 専用タイル（flowTexture）の R = log 正規化した集水、B = 充填深コード。
  // 窪地セル（B > 0）は水色へ寄せ、充填深でランプ（面の上でも窪地が分かる。
  // 越流点マーカーは別レイヤ three/pourPoints.ts）。
  // タイルが欠けている区画は地面だけ（uHasFlow < 0.5。差分の欠損と同じ扱い）。
  if (uCatchmentPaint > 0.5) {
    if (uShowGround < 0.5) discard;
    if (uHasFlow < 0.5) { fragColor = vec4(groundColor(shade), uGroundOpacity); return; }
    vec4 fc = texture(flowTexture, cu);
    if (fc.a < 0.5) { fragColor = vec4(groundColor(shade), uGroundOpacity); return; }
    vec3 col = catchmentRamp(fc.r);
    float fill = decodeFillDepth(fc.b);
    if (fill > 0.0) {
      const vec3 PONDED = vec3(0.44, 0.75, 0.80);
      col = mix(col, PONDED, clamp(0.30 + fill * 0.45, 0.30, 0.80));
    }
    fragColor = vec4(col * mix(1.0, shade, 0.45), uGroundOpacity);
    return;
  }

  // ---- 仮定の段階 ------------------------------------------------------
  //
  // **3 段はすべて差分タイルに既に入っている**（R = 海から連結の h_conn、
  // G = 仮想排水路の h_conn、B = 地盤高）。単純モデルでは「浸水し始める水位」が
  // そのまま地盤高なので、B も h_conn と同じ符号化・同じ比較で判定できる。
  // **S1 ⊆ S2 ⊆ 潮位以下 が入れ子なので、成立した段の数がそのまま段の名前になる**
  // （domain/types.ts の表。解析側で入れ子を検算済み）。
  if (uMode > 1.5) {
    if (uHasDiff < 0.5) {
      // 差分タイルが欠けている区画。段が「無い」のではなく「分からない」
      if (uShowGround < 0.5) discard;
      fragColor = vec4(groundColor(shade), uGroundOpacity);
      return;
    }
    vec4 d = texture(diffTexture, cu);
    float hS1 = decodeHConn(d.r);
    float steps = 0.0;
    if (hS1 <= uWaterLevel) steps += 1.0;
    if (decodeHConn(d.g) <= uWaterLevel) steps += 1.0;
    if (decodeHConn(d.b) <= uWaterLevel) steps += 1.0;
    // 平常時から水域のところは段の色に混ぜない（差分モードと同じ規則）。
    // 混ぜると潮位 0 で湾が「3 段そろって浸水」の青になる
    if (hS1 <= uWaterBase && uWaterLevel - vElev <= 0.0) {
      fragColor = vec4(vec3(0.20, 0.31, 0.40) * shade, uGroundOpacity);
      return;
    }
    if (steps < 0.5) {
      if (uShowGround < 0.5) discard;
      fragColor = vec4(groundColor(shade), uGroundOpacity);
      return;
    }
    fragColor = assumptionFill(steps, shade);
    return;
  }

  vec4 outColor;

  // **平常時に水がある範囲**の下地。
  //
  // 潮位を下げると海と川が「乾いた地面」として描かれ、地形が読めなくなっていた。
  // 原因は 2 つの実測事実の組み合わせ [実測]:
  //   - h_conn = 0.00 の画素が **19.26 %** ある（= 海と川。z17 の 25 枚で計測）
  //   - **標高は 0 m にクリップされている**（同計測の最小値が 0.0 m）
  // したがって潮位 0 では h_conn <= H は真だが depth = H - elev = 0 になり、
  // 浸水色の条件（depth > 0）を外れて地面の分岐に落ちていた。
  //
  // なので「濡れているか」ではなく **「平常時の海面より低いか」** で下地を決める。
  // 閾値は catalog の MSL（気象庁 公表・天文潮の年平均と一致で検算済み）。

  if (uMode > 0.5 && uHasDiff < 0.5) {
    // 差分モードだが差分タイルが無い区画。判定差が「無い」のではなく
    // 「分からない」ので、浸水色は出さず地面だけ描く
    if (uShowGround < 0.5) discard;
    fragColor = vec4(groundColor(shade), uGroundOpacity);
    return;
  }
  if (uMode > 0.5 && uHasDiff > 0.5) {
    vec4 d = texture(diffTexture, cu);
    // **単純モデルの判定差には 2 条件の地盤高が要る。**
    // 到達する側（右）の地盤高は elevTexture の RGB にある。出発する側（左）は
    // 差分タイルの **B** に入れてある（scripts/80 の elev_code。h_conn と同じ刻み）。
    // **B が 0 のタイルは B を焼く前の配信物**なので、その画素だけ連結モデルに
    // 落とす。落とさないと古いタイルで全画素が「浸水しない」になる
    float ebCode = floor(d.b * 255.0 + 0.5);
    bool simpleDiff = uSimple > 0.5 && ebCode > 0.5;
    float elevFrom = (ebCode - 1.0) * uHStep;
    bool wb = simpleDiff ? elevFrom < uWaterLevel : decodeHConn(d.r) <= uWaterLevel;
    bool wh = simpleDiff ? vElev < uWaterLevel : decodeHConn(d.g) <= uWaterLevel;
    // 平常時の水域で、まだ水深が付かない潮位のときは下地を出す。
    // ここを先に見ないと、潮位 0 で海が「どちらも浸水」の青になる
    bool permWater = min(decodeHConn(d.r), decodeHConn(d.g)) <= uWaterBase;
    if (permWater && max(0.0, uWaterLevel - vElev) <= 0.0) {
      outColor = vec4(vec3(0.20, 0.31, 0.40) * shade, uGroundOpacity);
    } else if (!wb && !wh) {
      if (uShowGround < 0.5) discard;
      outColor = vec4(groundColor(shade), uGroundOpacity);
    } else if (wb && wh) outColor = vec4(vec3(0.16, 0.34, 0.58) * shade, uFloodOpacity);
    else if (wh)         outColor = vec4(vec3(0.93, 0.22, 0.18) * shade, 0.95);
    else                 outColor = vec4(vec3(0.97, 0.82, 0.16) * shade, 0.95);
  } else {
    float a = texture(elevTexture, cu).a;
    float hConn = decodeHConn(a);
    if (uDrainage > 0.5 && uHasDiff > 0.5) {
      hConn = decodeHConn(texture(diffTexture, cu).g);
    }
    // **単純モデルは h_conn を見ない**（潮位 − 地盤高がそのまま浸水深）。
    // 判定式は domain/flood.ts の depth() と同一
    bool isWet = uSimple > 0.5 ? vElev < uWaterLevel : hConn <= uWaterLevel;
    bool baseWater = a > 0.0 && hConn <= uWaterBase;
    float depth = isWet ? max(0.0, uWaterLevel - vElev) : 0.0;

    // **窪地。** 標高は潮位以下だが h_conn > 潮位 = 地表面では海とつながらない。
    // 水面パスはここを捨てる（つながっていないので水位面まで水があるとは言えない）
    // ので、**地面の上に**印を重ねる。水面 ON / OFF のどちらでも同じ絵になる。
    // 判定式は domain/flood.ts の ponded() と同一
    if (uPonded > 0.5 && !isWet && !baseWater && vElev < uWaterLevel) {
      fragColor = pondedFill(shade);
      return;
    }

    // **水面メッシュを出しているときは、地形に水の色を塗らない。**
    // 水面パスの青とランプの青がほぼ同色なので、両方塗ると
    // 「水面が潮位の高さに張られている」ことが絵から消える
    if (uWaterSurface > 0.5) {
      if (uShowGround < 0.5) discard;
      fragColor = vec4(groundColor(shade), uGroundOpacity);
      return;
    }
    if (isWet && depth > 0.0) {
      outColor = vec4(depthRamp(depth) * mix(1.0, shade, 0.35), uFloodOpacity);
    } else if (baseWater) {
      // 判定の色（浸水深ランプ = 鮮やかな水色〜紺）とは別に、**彩度を落とした鋼色**。
      // 「我々の判定」ではなく「普段から水域」であることを色で分ける。
      // 暗くしすぎると地面に見えるので、水面として読める明るさに置く
      outColor = vec4(vec3(0.20, 0.31, 0.40) * shade, uGroundOpacity);
    } else if (uShowGround > 0.5) {
      outColor = vec4(groundColor(shade), uGroundOpacity);
    } else {
      discard;
    }
  }
  fragColor = outColor;
}
`

/** uv グリッド + 外周スカート。全タイルで共有できるので 1 度だけ作る */
let sharedGeometry: BufferGeometry | undefined

export function floodGeometry(): BufferGeometry {
  if (sharedGeometry) return sharedGeometry
  const n = GRID
  const side = n + 1
  const uv: number[] = []
  const skirt: number[] = []
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) { uv.push(i / n, j / n); skirt.push(0) }
  }
  const indices: number[] = []
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const a = j * side + i
      indices.push(a, a + 1, a + side, a + 1, a + side + 1, a + side)
    }
  }
  // 外周をもう 1 周ぶん複製して下げる（タイル境界のひび割れ隠し）
  const ringStart = uv.length / 2
  const edge: number[] = []
  for (let i = 0; i <= n; i++) edge.push(i)
  for (let j = 1; j <= n; j++) edge.push(j * side + n)
  for (let i = n - 1; i >= 0; i--) edge.push(n * side + i)
  for (let j = n - 1; j >= 1; j--) edge.push(j * side)
  for (const idx of edge) { uv.push(uv[idx * 2], uv[idx * 2 + 1]); skirt.push(1) }
  for (let k = 0; k < edge.length; k++) {
    const a = edge[k]
    const b = edge[(k + 1) % edge.length]
    const a2 = ringStart + k
    const b2 = ringStart + ((k + 1) % edge.length)
    indices.push(a, b, a2, b, b2, a2)
  }
  const g = new BufferGeometry()
  g.setAttribute('aUv', new BufferAttribute(new Float32Array(uv), 2))
  g.setAttribute('aSkirt', new BufferAttribute(new Float32Array(skirt), 1))
  g.setIndex(new BufferAttribute(new Uint32Array(indices), 1))
  // 頂点で標高を引くので CPU 側に position が無い。three の視錐台カリングは使わない
  g.boundingSphere = null
  sharedGeometry = g
  return g
}

/**
 * パックした値を線形補間すると標高が別の値になる。ミップマップも同じ理由で作らない。
 * premultiplyAlpha は decodeTileImage 側で切ってある（docs/web_design.md §5.2）。
 */
export function makeTileTexture(img: ImageBitmap): Texture {
  const t = new Texture(img)
  t.magFilter = NearestFilter
  t.minFilter = NearestFilter
  t.generateMipmaps = false
  t.flipY = false               // 暗黙の反転を禁止する。向きはシェーダ側で決める
  t.premultiplyAlpha = false
  t.colorSpace = NoColorSpace   // sRGB 変換が入ると標高が静かに狂う
  t.needsUpdate = true
  return t
}

export function createFloodMaterial(pass: number = FLOOD_PASS.ground): ShaderMaterial {
  const water = pass > 0.5
  return new ShaderMaterial({
    glslVersion: GLSL3,
    vertexShader: VS,
    fragmentShader: FS,
    transparent: true,
    // **水面は深度を書かない。** 書くと後から描く地物ポリゴンと PLATEAU 建物が
    // 水面に隠れる。深度テスト自体は残すので、不透明な建物が先に埋めた画素は
    // 水面に上書きされない（= 建物は水面を突き抜けて見える）
    depthWrite: !water,
    side: DoubleSide,       // CAD 視点では裏からスカートを見ることがある
    uniforms: {
      elevTexture: { value: null },
      diffTexture: { value: null },
      flowTexture: { value: null },
      uWorldBounds: { value: new Vector4() },
      uWaterLevel: { value: 0 },
      uHStep: { value: 0.05 },
      uMode: { value: 0 },
      uExaggeration: { value: 1 },
      uGeoid: { value: 0 },
      uMetersPerTexel: { value: 1 },
      uFloodOpacity: { value: 0.82 },
      uGroundOpacity: { value: 0.95 },
      uShowGround: { value: 1 },
      uWaterBase: { value: 0 },
      uHasDiff: { value: 0 },
      uPass: { value: pass },
      uWaterSurface: { value: 0 },
      uPonded: { value: 1 },
      uSimple: { value: 1 },
      uDrainage: { value: 0 },
      uElevPaint: { value: 0 },
      uCatchmentPaint: { value: 0 },
      uHasFlow: { value: 0 },
    },
  })
}

export function applyFloodUniforms(m: ShaderMaterial, v: FloodUniformValues) {
  const u = m.uniforms
  ;(u.uWorldBounds.value as Vector4).set(...v.worldBounds)
  u.uWaterLevel.value = v.waterLevel
  u.uHStep.value = v.hStep
  u.uMode.value = v.mode
  u.uExaggeration.value = v.exaggeration
  u.uGeoid.value = v.geoid
  u.uMetersPerTexel.value = v.metersPerTexel
  u.uFloodOpacity.value = v.floodOpacity
  u.uGroundOpacity.value = v.groundOpacity
  u.uShowGround.value = v.showGround
  u.uWaterBase.value = v.waterBase
  u.uWaterSurface.value = v.waterSurface ? 1 : 0
  u.uPonded.value = v.ponded ? 1 : 0
  u.uSimple.value = v.simple ? 1 : 0
  u.uDrainage.value = v.drainage ? 1 : 0
  u.uElevPaint.value = v.elevPaint ? 1 : 0
  u.uCatchmentPaint.value = v.catchmentPaint ? 1 : 0
  // uHasFlow は TerrainTiles が build() でタイル有無から設定する（uHasDiff と同じ）
}
