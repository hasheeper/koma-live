import { z } from 'zod'
import type { Geometry } from './geometry.js'
import { buildRegularGrid, MAX_FIELD_GRID, subdivideContourGrid } from './mesh-field.js'
import type { Values } from './sampling.js'

export const morphAxisSchema = z.strictObject({
  parameter: z.string().min(1),
  samples: z.array(z.number().finite()).min(2).refine(
    values => values.every((v, i) => i === 0 || v > values[i - 1]!),
    'Morph 轴采样值须严格递增',
  ),
})
const divisions = z.int().min(1).max(MAX_FIELD_GRID)
export const layerMorphGridSchema = z.strictObject({
  layerId: z.string().min(1),
  grid: z.tuple([divisions, divisions]),
  axes: z.union([z.tuple([morphAxisSchema]), z.tuple([morphAxisSchema, morphAxisSchema])]),
  deltas: z.array(z.array(z.number().finite()).nullable()),
  minRatio: z.number().positive().optional(),
}).superRefine(({ layerId, grid, axes, deltas }, ctx) => {
  const [x, y] = axes
  if (x.parameter === y?.parameter)
    ctx.addIssue({ code: 'custom', path: ['axes'], message: layerId + ' Morph 两个轴必须不同' })
  if (deltas.length !== x.samples.length * (y?.samples.length ?? 1))
    ctx.addIssue({ code: 'custom', path: ['deltas'], message: layerId + ' Morph 姿态样本数量不符' })
  const size = 2 * (grid[0] + 1) * (grid[1] + 1)
  deltas.forEach((delta, i) => {
    if (delta && delta.length !== size)
      ctx.addIssue({ code: 'custom', path: ['deltas', i], message: layerId + ' Morph 晶格位移数量不符' })
  })
})

export type MorphAxis = z.infer<typeof morphAxisSchema>
export type LayerMorphGrid = z.infer<typeof layerMorphGridSchema>
type Lattice = ArrayLike<number>

function bracket(samples: number[], value: number): [number, number] {
  const last = samples.length - 1
  if (value <= samples[0]!) return [0, 0]
  if (value >= samples[last]!) return [last, 0]
  let lo = 0, hi = last
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    if (value < samples[mid]!) hi = mid
    else lo = mid
  }
  return [lo, (value - samples[lo]!) / (samples[hi]! - samples[lo]!)]
}

/** Blend up to four parameter samples. A null corner contributes zero at its own weight. */
export function interpolateMorph(grid: LayerMorphGrid, parameters: Values): Lattice | null {
  const [x, y] = grid.axes
  const [ix, tx] = bracket(x.samples, parameters[x.parameter]!)
  const [iy, ty] = y ? bracket(y.samples, parameters[y.parameter]!) : [0, 0]
  const index = iy * x.samples.length + ix
  if (!tx && !ty) return grid.deltas[index]!
  let mixed: Float64Array | null = null
  function add(slot: number, weight: number) {
    const delta = grid.deltas[slot]
    if (!weight || !delta) return
    mixed ??= new Float64Array(delta.length)
    for (let k = 0; k < delta.length; k++) mixed[k] = mixed[k]! + weight * delta[k]!
  }
  add(index, (1 - tx) * (1 - ty))
  add(index + 1, tx * (1 - ty))
  add(index + x.samples.length, (1 - tx) * ty)
  add(index + x.samples.length + 1, tx * ty)
  return mixed
}

/** Add one slice-local UV lattice into a packed array of rest-space pixel offsets. */
export function accumulateMorph(uv: Geometry['uv'], [cols, rows]: LayerMorphGrid['grid'], lattice: Lattice, offsets: number[]) {
  const stride = (cols + 1) * 2
  for (let k = 0; k < uv.length; k += 2) {
    const x = Math.max(0, Math.min(1, uv[k]!)) * cols
    const y = Math.max(0, Math.min(1, uv[k + 1]!)) * rows
    const ix = Math.min(Math.floor(x), cols - 1), iy = Math.min(Math.floor(y), rows - 1)
    const tx = x - ix, ty = y - iy
    const top = iy * stride + ix * 2, bottom = top + stride
    for (let axis = 0; axis < 2; axis++) {
      const a = top + axis, b = bottom + axis
      offsets[k + axis] = offsets[k + axis]! +
        (1 - ty) * ((1 - tx) * lattice[a]! + tx * lattice[a + 2]!) +
        ty * ((1 - tx) * lattice[b]! + tx * lattice[b + 2]!)
    }
  }
}

/** Subdivision must preserve the already-rendered shape, even halfway through a bone bend.
 * Replay each rest-space edge split on the posed triangle, then apply the skinned Morph vector.
 */
export function prepareMorphSurface(source: Geometry | undefined, width: number, height: number, cols: number, rows: number) {
  const splits: Array<[number, number, number]> = []
  const geometry = !source ? buildRegularGrid(width, height, cols, rows)
    : cols === 1 && rows === 1 ? source : subdivideContourGrid(source, width, height, cols, rows, splits)
  function posedVertices(posed?: Geometry) {
    if (!posed) return geometry.vertices.slice()
    const vertices = posed.vertices.slice()
    for (const [a, b, t] of splits) {
      const x = vertices[a * 2]!, y = vertices[a * 2 + 1]!
      vertices.push(x + t * (vertices[b * 2]! - x), y + t * (vertices[b * 2 + 1]! - y))
    }
    return vertices
  }
  return { geometry, posedVertices }
}
