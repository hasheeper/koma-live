import { z } from 'zod'
import type { Point } from './geometry.js'
import type { Values } from './sampling.js'

const number = z.number()
export const affine = z.tuple([number, number, number, number, number, number])
export type Matrix = z.infer<typeof affine>
export const identity: Matrix = [1, 0, 0, 1, 0, 0]

export function transform(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}
export function compose(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    ...transform(a, b[4], b[5]),
  ]
}
export const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y]
export function inverse(m: Matrix): Matrix {
  const [a, b, c, d, x, y] = m
  const det = a * d - b * c
  if (!Number.isFinite(det) || det === 0) throw new Error('变换矩阵不可逆')
  return [d / det, -b / det, -c / det, a / det, (c * y - d * x) / det, (b * x - a * y) / det]
}
export const direction = (x: number, y: number) => (Math.atan2(y, x) * 180) / Math.PI
const id = z.string().min(1)
export const boneSchema = z.strictObject({
  boneId: id,
  name: id.optional(),
  parentBoneId: id.nullable().optional(),
  x: number,
  y: number,
  rotation: number,
  length: number.nonnegative(),
  drives: z.array(z.strictObject({ parameter: id, degrees: number })).optional(),
})
export type Bone = z.infer<typeof boneSchema>
export const boneTransformSchema = z.strictObject({
  x: number.optional(),
  y: number.optional(),
  rotation: number.optional(),
  scaleX: number.positive().optional(),
  scaleY: number.positive().optional(),
})
export type BoneTransform = z.infer<typeof boneTransformSchema>
export type BoneTransforms = Record<string, BoneTransform>
export interface BonePose {
  boneId: string
  matrix: Matrix
  start: Point
  end: Point
}

export function prepareSkeleton(bones: Bone[], defaults: Values) {
  const byId = new Map(bones.map((b) => [b.boneId, b]))
  const ordered: Bone[] = []
  const visiting = new Set<string>(),
    visited = new Set<string>()
  function visit(b: Bone) {
    if (visited.has(b.boneId)) return
    if (visiting.has(b.boneId)) throw new Error('循环骨架 ' + b.boneId)
    visiting.add(b.boneId)
    if (b.parentBoneId) {
      const parent = byId.get(b.parentBoneId)
      if (!parent) throw new Error(b.boneId + ' 缺少父骨 ' + b.parentBoneId)
      visit(parent)
    }
    for (const drive of b.drives ?? [])
      if (!Object.hasOwn(defaults, drive.parameter))
        throw new Error(b.boneId + ' 未知驱动参数 ' + drive.parameter)
    ordered.push(b)
    visiting.delete(b.boneId)
    visited.add(b.boneId)
  }
  for (const b of bones) {
    if (byId.get(b.boneId) !== b) throw new Error('重复骨骼 ' + b.boneId)
    visit(b)
  }
  function evaluate(values: Values, rotations: Values = {}, transforms: BoneTransforms = {}) {
    const frames = new Map<string, BonePose>()
    for (const [id, angle] of Object.entries(rotations))
      if (!byId.has(id) || !Number.isFinite(angle)) throw new Error('试转骨骼或角度无效 ' + id)
    for (const [id, t] of Object.entries(transforms)) {
      if (!byId.has(id)) throw new Error('未知骨骼变换 ' + id)
      const { x = 0, y = 0, rotation = 0, scaleX = 1, scaleY = 1 } = t
      if (![x, y, rotation, scaleX, scaleY].every(Number.isFinite)) throw new Error('骨骼变换包含非有限数值 ' + id)
      if (scaleX <= 0 || scaleY <= 0) throw new Error('骨骼缩放必须大于 0 · ' + id)
    }
    for (const b of ordered) {
      const parent = b.parentBoneId ? frames.get(b.parentBoneId)!.matrix : identity
      const t = Object.hasOwn(transforms, b.boneId) ? transforms[b.boneId]! : undefined
      let delta = (Object.hasOwn(rotations, b.boneId) ? rotations[b.boneId]! : 0) + (t?.rotation ?? 0)
      for (const d of b.drives ?? []) delta += (values[d.parameter]! - defaults[d.parameter]!) * d.degrees
      const tx = t?.x ?? 0,
        ty = t?.y ?? 0
      const sx = t?.scaleX ?? 1,
        sy = t?.scaleY ?? 1
      const radians = (((b.rotation % 360) + delta % 360) * Math.PI) / 180
      const c = Math.cos(radians),
        s = Math.sin(radians)
      const matrix = compose(parent, [c * sx, s * sx, -s * sy, c * sy, b.x + tx, b.y + ty])
      const end = transform(matrix, b.length, 0)
      if (![...matrix, ...end].every(Number.isFinite)) throw new Error('非有限骨骼姿势 ' + b.boneId)
      frames.set(b.boneId, { boneId: b.boneId, matrix, start: [matrix[4], matrix[5]], end })
    }
    return frames
  }
  return { byId, rest: evaluate(defaults), evaluate }
}
