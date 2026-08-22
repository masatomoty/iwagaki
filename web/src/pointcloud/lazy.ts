// 点群一式（copc / laz-perf / decode worker / renderer）の遅延ロード入口。
// 初回描画までのバンドルに入れないための境界。

import type { Scheduler } from '../net/scheduler'
import type { PerfRecorder } from '../perf/recorder'
import { PointCloudController } from './controller'
import { DeckPointCloudRenderer } from './deckRenderer'

export interface PcBundle {
  controller: PointCloudController
  renderer: DeckPointCloudRenderer
}

export function createPointCloud(opts: {
  url: string
  scheduler: Scheduler
  perf: PerfRecorder
  origin6674: [number, number]
  originWgs84: [number, number]
  matrix: [number, number, number, number]
  geoid: number
  coalesceGap: number
  usefulFraction: number
  onChange: () => void
}): PcBundle {
  const renderer = new DeckPointCloudRenderer(opts.originWgs84, opts.onChange)
  const controller = new PointCloudController({
    url: opts.url,
    scheduler: opts.scheduler,
    perf: opts.perf,
    renderer,
    origin6674: opts.origin6674,
    matrix: opts.matrix,
    geoid: opts.geoid,
    coalesceGap: opts.coalesceGap,
    maxSpan: 4 * 1024 * 1024,
    usefulFraction: opts.usefulFraction,
  })
  return { controller, renderer }
}
