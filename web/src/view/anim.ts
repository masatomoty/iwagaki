// 測線を引くときの見せかけ（`docs/todo.md` U4）。
//
// 断面ツールで測線が確定した瞬間に「どこを切ったか」を目で追えるよう、3D の
// リボンと 2D の断面 canvas を数百 ms かけて左から立ち上げる。ここに置くのは
// **描画ライブラリに依存しない補間だけ**（three も ui も import しない）。
// 進捗を回す rAF ループは呼び出し側（`view/map.ts` と `main.ts`）が持つ。

/** 端点の lerp・プロファイルの reveal 幅に使う */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * ease-out（U4: 「数百 ms、ease-out」）。終端に近づくほど緩やかに止まる。
 * `t` は 0〜1 の想定だが、範囲外でも連続になるようにしてある。
 */
export const easeOutCubic = (t: number): number => {
  const c = Math.max(0, Math.min(1, t))
  return 1 - (1 - c) ** 3
}

/**
 * OS の「視差効果を減らす」が有効なら true。呼び出し側はこのとき rAF を回さず
 * 即時に最終状態を描く（U4 制約: `prefers-reduced-motion: reduce` を尊重）。
 */
export function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function'
    && matchMedia('(prefers-reduced-motion: reduce)').matches
}
