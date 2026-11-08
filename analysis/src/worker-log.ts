import { open } from 'node:fs/promises'

/** Stream a bounded log to disk; callers await writes to avoid buffering output. */
export async function openWorkerLog(path: string, maxBytes: number) {
  const file = await open(path, 'w')
  const marker = Buffer.from('\n[worker log truncated]\n').subarray(0, maxBytes)
  const contentLimit = maxBytes - marker.length
  let written = 0
  let truncated = false
  let pending = Promise.resolve()
  return {
    write(text: string): Promise<void> {
      pending = pending.then(async () => {
        if (truncated) return
        const bytes = Buffer.from(text)
        const kept = bytes.subarray(0, contentLimit - written)
        if (kept.length) await file.writeFile(kept)
        written += kept.length
        if (kept.length < bytes.length) {
          await file.writeFile(marker)
          truncated = true
        }
      })
      return pending
    },
    async close(): Promise<void> {
      try { await pending } finally { await file.close() }
    },
  }
}
