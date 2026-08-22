// Worker プール。docs/WEB_DESIGN.md §3.5

import type { DecodedChunk } from './types'

type Pending = { resolve: (c: DecodedChunk) => void; reject: (e: unknown) => void }

export class DecodePool {
  private workers: Worker[] = []
  private pending = new Map<number, Pending>()
  private next = 0
  private rr = 0

  constructor(size = Math.min(4, Math.max(1, (navigator.hardwareConcurrency || 4) - 2))) {
    for (let i = 0; i < size; i++) {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (ev: MessageEvent) => {
        const p = this.pending.get(ev.data.id)
        if (!p) return
        this.pending.delete(ev.data.id)
        if (ev.data.error) p.reject(new Error(ev.data.error))
        else p.resolve(ev.data as DecodedChunk)
      }
      this.workers.push(w)
    }
  }

  get size() { return this.workers.length }

  decode(msg: Record<string, unknown>, transfer: Transferable[]): Promise<DecodedChunk> {
    const id = this.next++
    const w = this.workers[this.rr++ % this.workers.length]
    return new Promise<DecodedChunk>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      w.postMessage({ ...msg, id }, transfer)
    })
  }

  dispose() { for (const w of this.workers) w.terminate() }
}
