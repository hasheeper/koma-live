import type { Geometry } from './geometry.js'

/**
 * Real-time procedural vertex displacement callback evaluated in rest space
 * before single-bone world transforms or boneChain skinning.
 *
 * - `(u, v)` are slice-local normalized coordinates in `[0, 1]`.
 * - `(x, y)` are original canvas rest pixel coordinates (`rect.x + u * rect.w`, `rect.y + v * rect.h`).
 * - Returned `[dx, dy]` are rest-space pixel offsets applied prior to skeleton transforms.
 */
export type MeshFieldFn = (u: number, v: number, x: number, y: number) => readonly [number, number]

export interface MeshFieldSpec {
  field: MeshFieldFn
  /** Subdivision grid `[cols, rows]`, integer values in `1..16` (default `[6, 6]`). */
  grid?: readonly [number, number]
  /** Optional minimum triangle area ratio floor for GeometryError checks (default `0.01`). */
  minRatio?: number
}

export type MeshFieldInput = MeshFieldFn | MeshFieldSpec
export type MeshFields = Record<string, MeshFieldInput>

export interface NormalizedMeshField {
  field: MeshFieldFn
  cols: number
  rows: number
  minRatio?: number
}

export const DEFAULT_FIELD_GRID: readonly [number, number] = [6, 6]
export const MAX_FIELD_GRID = 16

export function normalizeMeshField(input: MeshFieldInput, layerId: string): NormalizedMeshField {
  const spec = typeof input === 'function' ? { field: input } : input
  if (!spec || typeof spec.field !== 'function') {
    throw new Error(`Mesh Field 缺少有效位移函数 · ${layerId}`)
  }
  const [cols, rows] = spec.grid ?? DEFAULT_FIELD_GRID
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > MAX_FIELD_GRID ||
    rows > MAX_FIELD_GRID
  ) {
    throw new Error(`Mesh Field 细分密度 grid 须为 1..${MAX_FIELD_GRID} 的整数 · ${layerId}`)
  }
  if (spec.minRatio !== undefined && (!Number.isFinite(spec.minRatio) || spec.minRatio <= 0)) {
    throw new Error(`Mesh Field minRatio 须为正有限数 · ${layerId}`)
  }
  return { field: spec.field, cols, rows, minRatio: spec.minRatio }
}

/** Build a clean regular `[cols, rows]` triangulated grid covering `[0..width] × [0..height]`. */
export function buildRegularGrid(width: number, height: number, cols: number, rows: number): Geometry {
  const stride = cols + 1
  const count = stride * (rows + 1)
  const vertices = new Array<number>(count * 2)
  const uv = new Array<number>(count * 2)
  let offset = 0
  for (let iy = 0; iy <= rows; iy++) {
    const v = iy / rows
    const py = v * height
    for (let ix = 0; ix <= cols; ix++) {
      const u = ix / cols
      vertices[offset] = u * width
      vertices[offset + 1] = py
      uv[offset] = u
      uv[offset + 1] = v
      offset += 2
    }
  }
  const indices: number[] = []
  for (let iy = 0; iy < rows; iy++) {
    for (let ix = 0; ix < cols; ix++) {
      const i = iy * stride + ix
      indices.push(i, i + 1, i + stride, i + 1, i + stride + 1, i + stride)
    }
  }
  return { vertices, uv, indices }
}

function orient2(vertices: number[], a: number, b: number, c: number) {
  const ax = vertices[2 * a]!,
    ay = vertices[2 * a + 1]!
  const bx = vertices[2 * b]!,
    by = vertices[2 * b + 1]!
  const cx = vertices[2 * c]!,
    cy = vertices[2 * c + 1]!
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
}

function pushUnique(ring: number[], idx: number) {
  if (!ring.length || ring[ring.length - 1] !== idx) ring.push(idx)
}

function finalizeRing(ring: number[]): number[] {
  if (ring.length > 1 && ring[0] === ring[ring.length - 1]) ring.pop()
  return ring
}

function polygonArea(vertices: number[], face: number[]): number {
  let twice = 0
  for (let i = 0; i < face.length; i++) {
    const a = face[i]!,
      b = face[(i + 1) % face.length]!
    twice += vertices[2 * a]! * vertices[2 * b + 1]! - vertices[2 * b]! * vertices[2 * a + 1]!
  }
  return twice * 0.5
}

/**
 * Plane-cut an existing triangulated contour/chain mesh along regular `[cols, rows]`
 * vertical and horizontal lines in rest-local slice coordinates.
 *
 * - Never moves any existing contour boundary vertex.
 * - Snaps near-miss cut classifications (`|d| <= snapEps`) onto existing vertices
 *   so cuts pass through them instead of creating hair-thin sliver triangles.
 * - Filters degenerate zero-area sub-faces during watertight fan triangulation.
 */
export function subdivideContourGrid(
  source: Geometry,
  width: number,
  height: number,
  cols: number,
  rows: number,
): Geometry {
  const vertices = source.vertices.slice()
  const uv = source.uv.slice()
  let faces: number[][] = []
  for (let i = 0; i < source.indices.length; i += 3) {
    faces.push([source.indices[i]!, source.indices[i + 1]!, source.indices[i + 2]!])
  }

  const cuts: Array<{ axis: 0 | 1; coord: number }> = []
  for (let ix = 1; ix < cols; ix++) cuts.push({ axis: 0, coord: (width * ix) / cols })
  for (let iy = 1; iy < rows; iy++) cuts.push({ axis: 1, coord: (height * iy) / rows })

  const snapEps = Math.min(0.4, (width / cols) * 0.05, (height / rows) * 0.05)

  for (const { axis, coord } of cuts) {
    const vertexCount = vertices.length / 2
    const distances = new Array<number>(vertexCount)
    for (let i = 0; i < vertexCount; i++) {
      const d = vertices[2 * i + axis]! - coord
      distances[i] = Math.abs(d) <= snapEps ? 0 : d
    }

    const intersections = new Map<string, number>()
    const nextFaces: number[][] = []

    for (const face of faces) {
      let hasNeg = false
      let hasPos = false
      for (const idx of face) {
        const d = distances[idx]!
        if (d < 0) hasNeg = true
        else if (d > 0) hasPos = true
      }
      if (!hasNeg || !hasPos) {
        nextFaces.push(face)
        continue
      }

      const left: number[] = []
      const right: number[] = []
      for (let j = 0; j < face.length; j++) {
        const a = face[j]!
        const b = face[(j + 1) % face.length]!
        const da = distances[a]!
        const db = distances[b]!
        if (da <= 0) pushUnique(left, a)
        if (da >= 0) pushUnique(right, a)
        if (da * db >= 0) continue

        const key = a < b ? `${a},${b}` : `${b},${a}`
        let k = intersections.get(key)
        if (k === undefined) {
          k = vertices.length / 2
          intersections.set(key, k)
          const t = da / (da - db)
          vertices.push(
            vertices[2 * a]! + t * (vertices[2 * b]! - vertices[2 * a]!),
            vertices[2 * a + 1]! + t * (vertices[2 * b + 1]! - vertices[2 * a + 1]!),
          )
          uv.push(
            uv[2 * a]! + t * (uv[2 * b]! - uv[2 * a]!),
            uv[2 * a + 1]! + t * (uv[2 * b + 1]! - uv[2 * a + 1]!),
          )
        }
        pushUnique(left, k)
        pushUnique(right, k)
      }

      finalizeRing(left)
      finalizeRing(right)
      if (left.length >= 3) nextFaces.push(left)
      if (right.length >= 3) nextFaces.push(right)
    }

    faces = nextFaces
  }

  const indices: number[] = []
  const minFaceArea = 1e-4
  for (const face of faces) {
    if (face.length < 3) continue
    const area = polygonArea(vertices, face)
    if (Math.abs(area) <= minFaceArea) continue

    // Choose the sharpest corner as fan anchor so collinear edges never emit degenerate triangles.
    let anchor = 0
    let bestCorner = -1
    for (let i = 0; i < face.length; i++) {
      const prev = face[(i + face.length - 1) % face.length]!
      const curr = face[i]!
      const next = face[(i + 1) % face.length]!
      const corner = Math.abs(orient2(vertices, prev, curr, next))
      if (corner > bestCorner) {
        bestCorner = corner
        anchor = i
      }
    }
    const base = face[anchor]!
    for (let step = 1; step + 1 < face.length; step++) {
      const b = face[(anchor + step) % face.length]!
      const c = face[(anchor + step + 1) % face.length]!
      const triSigned = orient2(vertices, base, b, c) * 0.5
      if (Math.abs(triSigned) <= minFaceArea) continue
      if (triSigned > 0) indices.push(base, b, c)
      else indices.push(base, c, b)
    }
  }

  return { vertices, uv, indices }
}

/**
 * Evaluate a user displacement field in rest space across all vertices of a cached geometry,
 * returning the exact same `uv` and `indices` references for zero-reallocation WebGL updates.
 */
export function applyMeshField(
  restGeometry: Geometry,
  rect: readonly [number, number, number, number],
  field: MeshFieldFn,
  layerId: string,
  timeMs: number,
): Geometry {
  const [rx, ry, rw, rh] = rect
  const src = restGeometry.vertices
  const uv = restGeometry.uv
  const out = new Array<number>(src.length)

  for (let i = 0; i < src.length; i += 2) {
    const u = uv[i]!
    const v = uv[i + 1]!
    const canvasX = rx + u * rw
    const canvasY = ry + v * rh
    const delta = field(u, v, canvasX, canvasY)
    if (!delta || !Number.isFinite(delta[0]) || !Number.isFinite(delta[1])) {
      throw new Error(`${layerId} @ ${timeMs} ms · Mesh Field 返回了非有限位移`)
    }
    out[i] = src[i]! + delta[0]
    out[i + 1] = src[i + 1]! + delta[1]
  }

  return { vertices: out, uv, indices: restGeometry.indices }
}
