// LOD 選択。純関数。IO も GPU も触らないので node でテストできる。
// docs/web_design.md「LOD」

import type { LodBudget, NodeRequest, PcInfo, PcNode, ViewState } from './types'

function distanceToBox(p: [number, number, number], b: PcNode['bounds']): number {
  const dx = Math.max(b[0] - p[0], 0, p[0] - b[3])
  const dy = Math.max(b[1] - p[1], 0, p[1] - b[4])
  const dz = Math.max(b[2] - p[2], 0, p[2] - b[5])
  return Math.hypot(dx, dy, dz)
}

/** ノードの点間隔が画面上で何 px になるか */
/**
 * ノード 1 つの点間隔が画面上で何 px になるか。
 *
 * **投影で式が変わる。** 透視はカメラからの距離で割る。正射は 1 px が何メートルかが
 * 画面のどこでも同じなので、**距離に依らない**。
 *
 * 正射で透視の式を使うと `spacing / metresPerPixel x (dist / カメラ距離)` になり、
 * 視線方向に伸びた視野では端から端で偏る。実測（zoom 17.2 / 900 px、
 * 視線方向に 800 m）で **3.0 倍 = 1.6 LOD 段**ぶんの偏りだった:
 * 手前のノードは過剰に細かく、奥のノードは過剰に粗く選ばれる。
 */
export function screenSpaceError(
  node: PcNode, info: PcInfo, view: ViewState, dist: number,
): number {
  const spacing = info.spacing / 2 ** node.depth
  if (view.orthographic && view.metresPerPixel) return spacing / view.metresPerPixel
  const d = Math.max(dist, 1e-3)
  return (spacing * (view.viewportHeight / 2)) / (d * Math.tan(view.fovY / 2))
}

export interface SelectInput {
  info: PcInfo
  nodes: PcNode[]
  view: ViewState
  budget: LodBudget
  /** ローカル(メートル)への変換。視錐台判定を同じ空間で行うため */
  toLocal: (x: number, y: number) => [number, number]
  /** 画面内かどうか。undefined なら全部通す */
  isVisible?: (b: PcNode['bounds']) => boolean
}

export function selectNodes(inp: SelectInput): NodeRequest[] {
  const { info, nodes, view, budget } = inp
  const scored: NodeRequest[] = []
  for (const n of nodes) {
    if (inp.isVisible && !inp.isVisible(n.bounds)) continue
    const [ex, ey] = inp.toLocal((n.bounds[0] + n.bounds[3]) / 2, (n.bounds[1] + n.bounds[4]) / 2)
    const dist = distanceToBox(view.eye, [ex - 1, ey - 1, n.bounds[2], ex + 1, ey + 1, n.bounds[5]])
    const sse = screenSpaceError(n, info, view, dist)
    if (sse < budget.screenSpaceError && n.depth > 0) continue
    scored.push({
      key: n.key,
      byteRange: [n.byteOffset, n.byteOffset + n.byteLength],
      pointCount: n.pointCount,
      depth: n.depth,
      sse,
      coarse: n.depth <= budget.coarseDepth,
    })
  }
  // 浅い LOD から、そのあと画面で大きく効くものから。予算に収まるまで採用する。
  // coarse を先頭に並べるだけでは、coarse が多いと予算を食い潰して打ち切られる。
  // 予算は coarse にも等しく適用し、超えたらそこで止める。
  scored.sort((a, b) =>
    (a.coarse === b.coarse ? 0 : a.coarse ? -1 : 1) || a.depth - b.depth || b.sse - a.sse)
  const out: NodeRequest[] = []
  let pts = 0
  let bytes = 0
  for (const s of scored) {
    const nb = s.byteRange[1] - s.byteRange[0]
    if (pts + s.pointCount > budget.maxPoints || bytes + nb > budget.maxBytes) break
    out.push(s)
    pts += s.pointCount
    bytes += nb
  }
  return out
}
