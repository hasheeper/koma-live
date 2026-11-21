import type { Point } from '@koma-rig/rig-core'

function smoothStep(value: number) {
  const t = Math.max(0, Math.min(1, value))
  return t * t * (3 - 2 * t)
}

export function paintWorkspaceGrid(canvas: HTMLCanvasElement, width: number, height: number, dpr: number, scale: number, origin: Point) {
  const w = Math.round(width * dpr), h = Math.round(height * dpr)
  if (canvas.width !== w) canvas.width = w
  if (canvas.height !== h) canvas.height = h
  const ctx = canvas.getContext('2d', {alpha:false})
  if (!ctx) return
  const css = getComputedStyle(canvas)
  ctx.fillStyle = css.getPropertyValue('--canvas-bg').trim()
  ctx.fillRect(0, 0, w, h)

  // In overview, reserve the space between major graduations for the artwork.
  // From 75% to 300%, progressively admit finer document lines for close work.
  const detail = smoothStep(Math.log2(scale / .75) / 2)
  const cutoff = 48 + (10 - 48) * detail
  const level = Math.max(0, Math.ceil(Math.log2(cutoff / scale) / 2))
  const pitch = scale * 4 ** level
  const minor = new Path2D(), major = new Path2D()
  function lines(vertical: boolean, offset: number, extent: number) {
    const first = Math.ceil(-offset / pitch), last = Math.floor((extent-offset) / pitch)
    for (let i=first; i<=last; i++) {
      const path = i % 4 === 0 ? major : minor
      const pixel = Math.round((offset + i*pitch) * dpr)
      if (vertical) path.rect(pixel, 0, 1, h)
      else path.rect(0, pixel, w, 1)
    }
  }
  lines(true, origin[0], width)
  lines(false, origin[1], height)
  // A major ruling owns its intersections, including on high-DPI canvases.
  ctx.fillStyle = css.getPropertyValue('--grid-minor').trim()
  ctx.fill(minor)
  ctx.fillStyle = css.getPropertyValue('--grid-major').trim()
  ctx.fill(major)
}
