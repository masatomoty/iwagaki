// 浸水描画のフラグメントシェーダ。
//
// 水位スライダはこの uniform を 1 つ書き換えるだけ。ネットワークも CPU 再計算も発生しない。
// これが docs/DESIGN.md §1.2 の h_conn を 1 枚のラスタに持つ設計の見返り。
//
// 陰影も同じテクスチャの隣接テクセルから計算する。MapLibre の raster-dem に
// この RGBA タイルを渡すと premultiply で標高が壊れるので使えない（docs/WEB_DESIGN.md §5.2）。

export const FLOOD_MODE = { terrain: 0, diff: 1 } as const

/** TS 側（domain/flood.ts, assets/packing.ts）と同じ式であること */
export const floodDecl = /* glsl */ `
float iw_decodeElev(vec3 c) {
  if (c.r == 0.0 && c.g == 0.0 && c.b == 0.0) return -9999.0;
  return (c.r * 255.0) * 256.0 + (c.g * 255.0) + (c.b * 255.0) / 256.0 - 32768.0;
}
float iw_decodeHConn(float a) {
  float code = floor(a * 255.0 + 0.5);
  if (code < 0.5) return 1e9;
  return (code - 1.0) * flood.hStep;
}
vec3 iw_depthRamp(float d) {
  vec3 c0 = vec3(0.42, 0.80, 0.95);
  vec3 c1 = vec3(0.15, 0.50, 0.90);
  vec3 c2 = vec3(0.05, 0.16, 0.52);
  float t = clamp(d / 3.0, 0.0, 1.0);
  return t < 0.5 ? mix(c0, c1, t * 2.0) : mix(c1, c2, (t - 0.5) * 2.0);
}
float iw_hillshade(sampler2D tex, vec2 uv, vec2 texel) {
  float hl = iw_decodeElev(texture(tex, uv - vec2(texel.x, 0.0)).rgb);
  float hr = iw_decodeElev(texture(tex, uv + vec2(texel.x, 0.0)).rgb);
  float hu = iw_decodeElev(texture(tex, uv - vec2(0.0, texel.y)).rgb);
  float hd = iw_decodeElev(texture(tex, uv + vec2(0.0, texel.y)).rgb);
  if (hl < -9000.0 || hr < -9000.0 || hu < -9000.0 || hd < -9000.0) return 1.0;
  vec3 n = normalize(vec3((hl - hr), (hd - hu), 2.0 * flood.metersPerTexel));
  vec3 sun = normalize(vec3(-0.6, 0.7, 0.75));
  return clamp(0.45 + 0.75 * dot(n, sun), 0.25, 1.35);
}
`

export const floodMain = /* glsl */ `
  vec4 t = texture(bitmapTexture, uv);
  vec4 outColor;

  if (flood.mode > 0.5) {
    // 差分モード: R=h_conn(baseline) code, G=h_conn(highres) code
    float hb = iw_decodeHConn(t.r);
    float hh = iw_decodeHConn(t.g);
    bool wb = hb <= flood.waterLevel;
    bool wh = hh <= flood.waterLevel;
    if (!wb && !wh) discard;
    if (wb && wh)  outColor = vec4(0.16, 0.34, 0.58, 0.50);
    else if (wh)   outColor = vec4(0.93, 0.22, 0.18, 0.92);
    else           outColor = vec4(0.97, 0.82, 0.16, 0.92);
  } else {
    // 地形モード: RGB=標高(Terrarium), A=h_conn code
    float elev  = iw_decodeElev(t.rgb);
    float hConn = iw_decodeHConn(t.a);
    if (elev < -9000.0) discard;

    float shade = iw_hillshade(bitmapTexture, uv, flood.texel);
    bool  isWet = hConn <= flood.waterLevel;
    float d     = isWet ? max(0.0, flood.waterLevel - elev) : 0.0;

    if (isWet && d > 0.0) {
      outColor = vec4(iw_depthRamp(d) * mix(1.0, shade, 0.25), flood.floodOpacity);
    } else if (flood.showGround > 0.5) {
      float g = clamp(0.30 + elev * 0.010, 0.22, 0.72) * shade;
      outColor = vec4(vec3(g) * vec3(1.00, 0.99, 0.95), flood.groundOpacity);
    } else {
      discard;
    }
  }
  fragColor = outColor;
`
