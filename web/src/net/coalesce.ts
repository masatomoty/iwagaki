// COPC のノード群を「連続した 1 本の Range」にまとめる（docs/WEB_DESIGN.md「range coalescing」）。
// R2 はマルチレンジ（bytes=a-b, c-d）に 400 を返すので、飛び地は結合できない。
// gap 分の「読むが使わないバイト」を許容するトレードオフになる。

export interface RangeMember<T> {
  item: T
  begin: number
  /** exclusive */
  end: number
}

export interface CoalescedGroup<T> {
  begin: number
  end: number
  members: RangeMember<T>[]
  /** 読むが使わないバイト */
  extraBytes: number
}

export function coalesce<T>(
  members: RangeMember<T>[],
  gapLimit: number,
  maxSpan: number,
): CoalescedGroup<T>[] {
  const sorted = [...members].sort((a, b) => a.begin - b.begin)
  const out: CoalescedGroup<T>[] = []
  let cur: CoalescedGroup<T> | null = null
  let useful = 0
  for (const m of sorted) {
    if (
      cur &&
      m.begin - cur.end <= gapLimit &&
      Math.max(cur.end, m.end) - cur.begin <= maxSpan
    ) {
      cur.end = Math.max(cur.end, m.end)
      cur.members.push(m)
      useful += m.end - m.begin
    } else {
      if (cur) cur.extraBytes = cur.end - cur.begin - useful
      cur = { begin: m.begin, end: m.end, members: [m], extraBytes: 0 }
      useful = m.end - m.begin
      out.push(cur)
    }
  }
  if (cur) cur.extraBytes = cur.end - cur.begin - useful
  return out
}
