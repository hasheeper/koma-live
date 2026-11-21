import { meshFromAlpha, type TraceOptions } from '@koma-rig/rig-core'

let source: {alpha:Uint8Array; width:number; height:number} | undefined
type Job = {source: NonNullable<typeof source>} | {id:number; options:TraceOptions}
self.onmessage = ({data}: MessageEvent<Job>) => {
  if ('source' in data) { source = data.source; return }
  if (!source) return
  try {
    const mesh = meshFromAlpha(source.alpha, source.width, source.height, data.options)
    self.postMessage({id:data.id, mesh})
  } catch (err) {
    self.postMessage({id:data.id, error:err instanceof Error ? err.message : String(err)})
  }
}
