import type { Point } from '@koma-rig/rig-core'

export interface SnapGuide { axis:0|1; value:number; peer?:number }

export type MeshPointerTarget =
  | { kind: 'vertex'; index: number; closes: boolean }
  | { kind: 'plot'; point: Point; guides: SnapGuide[] }
  | { kind: 'insert'; point: Point; guides: SnapGuide[]; a: number; b: number; onEdge: boolean }

interface PointerInput {
  cursor: Point
  local: Point
  points: Point[]
  screenPoints: Point[]
  edges: { a: number; b: number; uses: number }[]
  size: Point
  pixelsPerUnit: Point
  touch: boolean
  drawing: boolean
  insert: boolean
  triangles: boolean
  snap: boolean
}

export const snapRadius = (touch: boolean) => touch ? 7 : 3

export function projectToEdge(cursor: Point, start: Point, end: Point) {
  const dx = end[0] - start[0], dy = end[1] - start[1]
  const t = ((cursor[0] - start[0]) * dx + (cursor[1] - start[1]) * dy) / (dx * dx + dy * dy)
  if (!(t > 0 && t < 1)) return
  return { t, distance: Math.hypot(cursor[0] - start[0] - t * dx, cursor[1] - start[1] - t * dy) }
}

export const pointOnEdge = (a: Point, b: Point, t: number): Point =>
  [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]

/** Hover and pointer-down resolve the same destination, including after a zoom. */
export function meshPointerTarget(input: PointerInput): MeshPointerTarget | undefined {
  const { cursor, local, points, screenPoints, size } = input
  const radius = snapRadius(input.touch)
  let nearest = -1, distance = input.drawing || input.insert ? radius : input.touch ? 22 : 13
  for (const [index, p] of screenPoints.entries()) {
    const d = Math.hypot(p[0] - cursor[0], p[1] - cursor[1])
    if (d < distance) {
      if (index === 0 && input.drawing && points.length >= 3) return { kind: 'vertex', index, closes: true }
      nearest = index
      distance = d
    }
  }
  if (nearest >= 0) return { kind: 'vertex', index: nearest, closes: false }
  const inside = local.every((v, axis) => v >= 0 && v <= size[axis]!)
  if (input.drawing) return inside
    ? { kind: 'plot', ...snapHandle(local, points, undefined, size, input.pixelsPerUnit, input.snap, radius) } : undefined
  if (!input.insert) return

  let edge: { a: number; b: number; t: number } | undefined
  distance = Infinity
  for (const { a, b, uses } of input.edges) {
    if (uses !== 1 && !input.triangles) continue
    const projected = projectToEdge(cursor, screenPoints[a]!, screenPoints[b]!)
    if (projected && projected.distance < distance && (uses === 1 || projected.distance <= (input.snap ? radius : 0))) {
      edge = { a, b, t: projected.t }
      distance = projected.distance
    }
  }
  if (!edge) return
  const { a, b, t } = edge
  if (input.snap && distance <= radius)
    return { kind: 'insert', a, b, point: pointOnEdge(points[a]!,points[b]!,t), onEdge:true, guides: [] }
  if (inside) return { kind: 'insert', a, b, onEdge:false, ...snapHandle(local, points, undefined, size, input.pixelsPerUnit, input.snap, radius) }
}

/** Tolerance is in CSS pixels even at high zoom or on a Retina display. */
export function snapHandle(local:Point, points:Point[], exclude:number|undefined, size:Point, pixelsPerUnit:Point, enabled:boolean, radius = snapRadius(false)) {
  const point:Point = [Math.max(0,Math.min(size[0],local[0])), Math.max(0,Math.min(size[1],local[1]))]
  const guides:SnapGuide[]=[]
  if (enabled) for (const axis of [0,1] as const) {
    let best:SnapGuide|undefined, distance=Infinity
    function consider(value:number, peer?:number) {
      const d=Math.abs(point[axis]-value)*pixelsPerUnit[axis]
      if (d<=radius && d<distance) {distance=d;best={axis,value,peer}}
    }
    points.forEach((p,i)=>{if(i!==exclude)consider(p[axis],i)})
    consider(0); consider(size[axis]/2); consider(size[axis])
    if (best) { point[axis]=best.value;guides.push(best) }
  }
  return {point,guides}
}
