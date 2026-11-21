import type { Point } from '@koma-rig/rig-core'

/** Screen-space drawing grammar from Koma Edit's polygon annotation. */
export function drawPlacement(ctx: CanvasRenderingContext2D, anchors: Point[], end: Point, closing: boolean,
  colors: { ink: string; rim: string; candidate: string }, snapped: boolean) {
  const first = anchors[0], last = anchors.at(-1)
  ctx.save()
  ctx.lineJoin = 'round'
  if (first && last) {
    if (anchors.length > 1) {
      ctx.beginPath()
      ctx.moveTo(...first)
      for (const p of anchors.slice(1)) ctx.lineTo(...p)
      ctx.lineTo(...end)
      ctx.closePath()
      ctx.fillStyle = colors.ink
      ctx.globalAlpha = 0.07
      ctx.fill()
    }
    const edge = (p: Point, pattern: number[], opacity: number) => {
      ctx.beginPath()
      ctx.moveTo(...p)
      ctx.lineTo(...end)
      ctx.setLineDash(pattern)
      ctx.globalAlpha = opacity
      ctx.lineWidth = 3.5
      ctx.strokeStyle = colors.rim
      ctx.stroke()
      ctx.lineWidth = 1.6
      ctx.strokeStyle = colors.ink
      ctx.stroke()
    }
    edge(last, [5, 4], 1)
    if (anchors.length > 1 && !closing) edge(first, [2, 4], 0.8)
  }
  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.beginPath()
  ctx.arc(...end, snapped ? 3.5 : 5.5, 0, 2 * Math.PI)
  ctx.fillStyle = colors.candidate
  ctx.fill()
  ctx.strokeStyle = colors.rim
  ctx.lineWidth = 2
  ctx.stroke()
  if (closing) {
    ctx.beginPath()
    ctx.arc(...end, 9, 0, 2 * Math.PI)
    ctx.strokeStyle = colors.candidate
    ctx.stroke()
  }
  ctx.restore()
}
