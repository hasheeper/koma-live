import { z } from 'zod'

export const point = z.tuple([z.number(), z.number()])
export type Point = z.infer<typeof point>
const common = { parameter: z.string(), minArea: z.number().positive(), minRatio: z.number().positive() }
export const deformer = z.discriminatedUnion('kind', [
  z.strictObject({
    ...common,
    kind: z.literal('ffd'),
    size: z.union([z.literal(3), z.literal(4)]),
    offsets: z.array(point),
    locked: z.array(z.int().nonnegative()).optional(),
    maxDisplacementPx: z.number().nonnegative().optional(),
  }),
  z.strictObject({
    ...common,
    kind: z.literal('ribbon'),
    line: z.array(z.tuple([z.number(), z.number(), z.number().positive()])).min(2),
    bend: z.number(),
    maxBend: z.number().nonnegative().optional(),
  }),
])
export type Deformer = z.infer<typeof deformer>
export interface Geometry {
  vertices: number[]
  uv: number[]
  indices: number[]
}

export const attachmentMesh = z.strictObject({
  points: z.array(point).min(3),
  indices: z.array(z.int().nonnegative()).min(3),
})
export type AttachmentMesh = z.infer<typeof attachmentMesh>

/** The saved rest topology is in cropped texture pixels; UVs follow the source image. */
export function restMesh(mesh: AttachmentMesh, width: number, height: number): Geometry {
  const { points, indices } = mesh
  if (indices.length % 3 || indices.some(i => i >= points.length) || new Set(indices).size !== points.length)
    throw new Error('网格存在缺失顶点或无效的三角索引')
  if (points.some(([x,y]) => x < 0 || y < 0 || x > width || y > height))
    throw new Error('网格顶点超出切片范围')
  const faces = new Set<string>()
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i]!, b = indices[i+1]!, c = indices[i+2]!
    if (orient(points[a]!,points[b]!,points[c]!) <= 2e-8) throw new Error('网格三角形翻面或退化 ' + i/3)
    const face = [a,b,c].sort((x,y) => x-y).join(',')
    if (faces.has(face)) throw new Error('网格三角形重复 ' + i/3)
    faces.add(face)
  }
  const vertices = points.flat()
  checkGeometry(vertices, vertices, indices, 1e-8, 0)
  return { vertices, indices, uv: points.flatMap(([x,y]) => [x / width, y / height]) }
}

/** Polygons are in slice-local pixels until pose evaluation places them on the canvas. */
export class GeometryError extends Error {
  constructor(
    message: string,
    readonly polygons: Point[][],
  ) {
    super(message)
  }
}

function orient(a: Point, b: Point, c: Point) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
}
function orientXY(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}
function betweenXY(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  return (
    orientXY(ax, ay, bx, by, px, py) === 0 &&
    px >= (ax < bx ? ax : bx) &&
    px <= (ax > bx ? ax : bx) &&
    py >= (ay < by ? ay : by) &&
    py <= (ay > by ? ay : by)
  )
}
function insideXY(px: number, py: number, ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  const s0 = orientXY(ax, ay, bx, by, px, py)
  const s1 = orientXY(bx, by, cx, cy, px, py)
  const s2 = orientXY(cx, cy, ax, ay, px, py)
  return (s0 > 0 && s1 > 0 && s2 > 0) || (s0 < 0 && s1 < 0 && s2 < 0)
}
interface TriRecord {
  tri: number
  ids: [number, number, number]
  xs: [number, number, number]
  ys: [number, number, number]
  minX: number
  minY: number
  maxX: number
  maxY: number
}
function triPoints(t: TriRecord): Point[] {
  return [
    [t.xs[0], t.ys[0]],
    [t.xs[1], t.ys[1]],
    [t.xs[2], t.ys[2]],
  ]
}
export function checkGeometry(
  rest: number[],
  current: number[],
  indices: number[],
  minArea: number,
  minRatio: number,
) {
  const triCount = indices.length / 3
  const triangles: TriRecord[] = new Array(triCount)
  for (let tri = 0; tri < triCount; tri++) {
    const base = tri * 3
    const a = indices[base]!,
      b = indices[base + 1]!,
      c = indices[base + 2]!
    const initial =
      orientXY(rest[2 * a]!, rest[2 * a + 1]!, rest[2 * b]!, rest[2 * b + 1]!, rest[2 * c]!, rest[2 * c + 1]!) * 0.5
    const ax = current[2 * a]!,
      ay = current[2 * a + 1]!,
      bx = current[2 * b]!,
      by = current[2 * b + 1]!,
      cx = current[2 * c]!,
      cy = current[2 * c + 1]!
    const area = orientXY(ax, ay, bx, by, cx, cy) * 0.5
    if (!(Math.abs(initial) > minArea && area * Math.sign(initial) > minArea && area / initial > minRatio)) {
      throw new GeometryError('三角形 ' + tri + ' 翻面或退化', [
        [
          [ax, ay],
          [bx, by],
          [cx, cy],
        ],
      ])
    }
    triangles[tri] = {
      tri,
      ids: [a, b, c],
      xs: [ax, bx, cx],
      ys: [ay, by, cy],
      minX: ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx,
      minY: ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy,
      maxX: ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx,
      maxY: ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy,
    }
  }
  // X-axis sweep-and-prune with Y-AABB reject keeps 16x16 (512+ triangles) meshes fast at 60fps.
  if (triCount > 1) triangles.sort((p, q) => p.minX - q.minX)
  for (let i = 0; i < triCount; i++) {
    const a = triangles[i]!
    const aMaxX = a.maxX,
      aMinY = a.minY,
      aMaxY = a.maxY
    const axs = a.xs,
      ays = a.ys,
      aids = a.ids
    for (let j = i + 1; j < triCount; j++) {
      const b = triangles[j]!
      if (b.minX > aMaxX) break
      if (aMinY > b.maxY || b.minY > aMaxY) continue
      const bxs = b.xs,
        bys = b.ys,
        bids = b.ids
      let hit =
        insideXY(axs[0], ays[0], bxs[0], bys[0], bxs[1], bys[1], bxs[2], bys[2]) ||
        insideXY(axs[1], ays[1], bxs[0], bys[0], bxs[1], bys[1], bxs[2], bys[2]) ||
        insideXY(axs[2], ays[2], bxs[0], bys[0], bxs[1], bys[1], bxs[2], bys[2]) ||
        insideXY(bxs[0], bys[0], axs[0], ays[0], axs[1], ays[1], axs[2], ays[2]) ||
        insideXY(bxs[1], bys[1], axs[0], ays[0], axs[1], ays[1], axs[2], ays[2]) ||
        insideXY(bxs[2], bys[2], axs[0], ays[0], axs[1], ays[1], axs[2], ays[2])
      for (let m = 0; m < 3 && !hit; m++) {
        const k = m === 2 ? 0 : m + 1
        const px = axs[m]!,
          py = ays[m]!,
          qx = axs[k]!,
          qy = ays[k]!,
          idM = aids[m]!,
          idK = aids[k]!
        const eMinX = px < qx ? px : qx,
          eMaxX = px > qx ? px : qx,
          eMinY = py < qy ? py : qy,
          eMaxY = py > qy ? py : qy
        for (let n = 0; n < 3 && !hit; n++) {
          const l = n === 2 ? 0 : n + 1
          const rx = bxs[n]!,
            ry = bys[n]!,
            sx = bxs[l]!,
            sy = bys[l]!,
            idN = bids[n]!,
            idL = bids[l]!
          // Edge-pair AABB fast reject before orientation cross products
          if (
            eMaxX < (rx < sx ? rx : sx) ||
            (rx > sx ? rx : sx) < eMinX ||
            eMaxY < (ry < sy ? ry : sy) ||
            (ry > sy ? ry : sy) < eMinY
          ) {
            continue
          }
          hit =
            orientXY(px, py, qx, qy, rx, ry) * orientXY(px, py, qx, qy, sx, sy) < 0 &&
            orientXY(rx, ry, sx, sy, px, py) * orientXY(rx, ry, sx, sy, qx, qy) < 0
          if (!hit && idM !== idN && idM !== idL) hit = betweenXY(rx, ry, sx, sy, px, py)
          if (!hit && idN !== idM && idN !== idK) hit = betweenXY(px, py, qx, qy, rx, ry)
        }
      }
      if (hit) {
        const first = a.tri < b.tri ? a : b
        const second = a.tri < b.tri ? b : a
        throw new GeometryError('三角形 ' + first.tri + ' / ' + second.tri + ' 自交', [
          triPoints(first),
          triPoints(second),
        ])
      }
    }
  }
}

function weights(n: number, u: number) {
  const v = 1 - u
  return n === 3 ? [v * v, 2 * u * v, u * u] : [v * v * v, 3 * u * v * v, 3 * u * u * v, u * u * u]
}
function cells(columns: number, rows: number) {
  const indices: number[] = []
  for (let y = 0; y < rows - 1; y++)
    for (let x = 0; x < columns - 1; x++) {
      const i = y * columns + x
      indices.push(i, i + 1, i + columns, i + 1, i + columns + 1, i + columns)
    }
  return indices
}
function spline(a: number, b: number, c: number, d: number, t: number) {
  return (
    0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t)
  )
}
export function prepareGeometry(def: Deformer, width: number, height: number, topology?: Geometry, diagnose = true) {
  const rest: number[] = [], delta: number[] = [], uv: number[] = []
  let indices: number[]
  if (def.kind === 'ffd') {
    if (def.offsets.length !== def.size ** 2) throw new Error('晶格控制点数量不符')
    for (const i of def.locked ?? [])
      if (!def.offsets[i] || def.offsets[i]!.some((v) => v !== 0))
        throw new Error('锁定晶格点必须属于网格并保持原位 ' + i)
    const n = 2 * def.size - 1
    const coords = topology?.uv ?? Array.from({length: n*n}, (_, i) => [i%n/(n-1), Math.floor(i/n)/(n-1)]).flat()
    for (let i = 0; i < coords.length; i += 2) {
      const u = coords[i]!, v = coords[i+1]!, wx = weights(def.size, u), wy = weights(def.size, v)
      let dx = 0, dy = 0
      def.offsets.forEach(([ox, oy], j) => {
        const w = wx[j % def.size]! * wy[Math.floor(j / def.size)]!
        dx += w * ox
        dy += w * oy
      })
      rest.push(u * width, v * height)
      delta.push(dx, dy)
      uv.push(u, v)
    }
    indices = topology?.indices ?? cells(n, n)
  } else {
    const line = def.line,
      count = 4 * (line.length - 1) + 1
    const centers = Array.from({ length: count }, (_, i) => {
      const k = Math.min(Math.floor(i / 4), line.length - 2),
        t = i / 4 - k
      const a = line[Math.max(0, k - 1)]!,
        b = line[k]!,
        c = line[k + 1]!,
        d = line[Math.min(line.length - 1, k + 2)]!
      return [
        spline(a[0], b[0], c[0], d[0], t),
        spline(a[1], b[1], c[1], d[1], t),
        b[2] * (1 - t) + c[2] * t,
      ] as const
    })
    centers.forEach(([x, y, w], i) => {
      const prev = centers[Math.max(0, i - 1)]!,
        next = centers[Math.min(count - 1, i + 1)]!
      const dx = next[0] - prev[0],
        dy = next[1] - prev[1],
        len = Math.hypot(dx, dy)
      if (!len) throw new Error('丝带中心线有重合点')
      const nx = -dy / len,
        ny = dx / len,
        weight = (i / (count - 1)) ** 2
      for (const side of [-1, 1]) {
        const px = x + side * w * nx,
          py = y + side * w * ny
        rest.push(px, py)
        uv.push(px / width, py / height)
        delta.push(nx * weight, ny * weight)
      }
    })
    indices = cells(2, count)
    if (topology) {
      // Both edges of a ribbon row receive the same displacement. Interpolate
      // that field along the nearest rest centreline segment for a drawn vertex.
      const rowDeltas = delta.slice()
      rest.length = delta.length = uv.length = 0
      for (let i = 0; i < topology.vertices.length; i += 2) {
        const x = topology.vertices[i]!, y = topology.vertices[i+1]!
        let nearest = Infinity, dx = 0, dy = 0
        for (let j = 1; j < centers.length; j++) {
          const a = centers[j-1]!, b = centers[j]!, sx = b[0]-a[0], sy = b[1]-a[1]
          const t = Math.max(0, Math.min(1, ((x-a[0])*sx + (y-a[1])*sy) / (sx*sx+sy*sy || 1)))
          const d = (x-a[0]-t*sx)**2 + (y-a[1]-t*sy)**2
          if (d >= nearest) continue
          nearest = d
          dx = (1-t)*rowDeltas[(j-1)*4]! + t*rowDeltas[j*4]!
          dy = (1-t)*rowDeltas[(j-1)*4+1]! + t*rowDeltas[j*4+1]!
        }
        rest.push(x,y)
        delta.push(dx,dy)
        uv.push(topology.uv[i]!, topology.uv[i+1]!)
      }
      indices = topology.indices
    }
  }
  return (amount: number): Geometry => {
    const displacement = def.kind === 'ribbon' ? amount * def.bend : amount
    const vertices = rest.map((v, i) => v + delta[i]! * displacement)
    if (diagnose) checkGeometry(rest, vertices, indices, def.minArea, def.minRatio)
    return { vertices, indices, uv }
  }
}
