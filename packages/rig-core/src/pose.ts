import { z } from 'zod'
import { sliceManifestSchema, type SliceManifest } from './slices.js'
import { exportCapabilities } from './agent.js'
import { attachmentMesh, deformer, checkGeometry, GeometryError, point, prepareGeometry, restMesh } from './geometry.js'
import { prepareChain, quadGeometry } from './chain.js'
import { accumulateMorph, interpolateMorph, layerMorphGridSchema, prepareMorphSurface, type LayerMorphGrid } from './morph.js'
import { headCalibrationSchema } from './head-morph.js'
import {
  applyMeshField,
  buildRegularGrid,
  normalizeMeshField,
  subdivideContourGrid,
  type MeshFields,
} from './mesh-field.js'
import type { Geometry, Point } from './geometry.js'
import { neutral } from './sampling.js'
import type { Values } from './sampling.js'

import {
  affine,
  boneSchema,
  compose,
  inverse,
  identity,
  prepareSkeleton,
  transform,
  translate,
} from './skeleton.js'
import type { Matrix, BonePose, BoneTransforms } from './skeleton.js'
export { transform, type Matrix } from './skeleton.js'

const id = z.string().min(1)
const drive = z.strictObject({
  parameter: id,
  degrees: z.number().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  opacity: z.number().optional(),
})
const spring = z.strictObject({
  parameter: id,
  stiffness: z.number().positive(),
  damping: z.number().positive(),
  amplitude: z.number(),
  hz: z.number().nonnegative(),
  phase: z.number(),
  limit: z.number().positive().optional(),
})
export const bindingSchema = z.strictObject({
  layerId: id,
  pivot: point,
  parentId: id.nullable().optional(),
  boneId: id.optional(),
  boneChain: z.array(id).min(2).optional(),
  jointSoftnessPx: z.number().positive().optional(),
  restOffset: affine.optional(),
  bindOrigin: point.optional(),
  restDegrees: z.number().optional(),
  drives: z.array(drive).optional(),
  deformer: deformer.optional(),
  mesh: attachmentMesh.optional(),
  spring: spring.optional(),
  variant: z.strictObject({ slot: id, state: id, contact: z.array(id).optional() }).optional(),
})
export type Binding = z.infer<typeof bindingSchema>
const eye = z.strictObject({
  iris: id,
  white: id,
  closed: id,
  head: id,
  center: point,
  radius: point,
  travel: point,
  units: z.tuple([z.number().positive(),z.number().positive()]).optional(),
  inner: point.optional(),
  outer: point.optional(),
  pupil: point.optional(),
  x: id,
  y: id,
  blink: id,
  threshold: z.number().positive().max(1),
  corners: z.tuple([point, point, point, point]),
})
export type Eye = z.infer<typeof eye>
const range = z.strictObject({ parameter: id, min: z.number(), max: z.number() })
const attachment = z.strictObject({ layerId: id, local: point })
const gate = z.strictObject({
  slot: id,
  from: id,
  to: id,
  ranges: z.array(range).optional(),
  anchors: z
    .array(z.strictObject({ from: attachment, to: attachment, tolerancePx: z.number().nonnegative() }))
    .optional(),
})
export const layerSetting = z.strictObject({
  layerId: id,
  locked: z.boolean().optional(),
  visible: z.boolean().optional(),
  peekOpacity: z.number().min(0).max(1).optional(),
  peekAfter: id.optional(),
  /** Clip this layer's rendered output to another layer's live deformed Alpha silhouette. */
  clipTo: id.optional(),
})
export const castShadowSchema = z.strictObject({
  /** Layer IDs casting the shadow (live deformed geometry + transform). */
  casters: z.array(id).min(1),
  /** Receiver layer IDs onto whose union Alpha silhouette the shadow is clipped. */
  receivers: z.array(id).min(1),
  /** Shadow projection offset `[dx, dy]` in logical canvas pixels. */
  offset: point,
  /** Optional 24-bit RGB shadow tint (`0x000000..0xffffff`, default `0x6b5870`). */
  color: z.number().int().min(0).max(0xffffff).optional(),
  /** Peak shadow opacity in `[0, 1]` (default `0.2`). */
  opacity: z.number().min(0).max(1).optional(),
  /** Soft Gaussian blur radius in logical pixels (default `0` = crisp 2D cel anime shadow). */
  blur: z.number().min(0).max(64).optional(),
  /** Blending mode onto receiver surface (`'multiply'` default or `'normal'`). */
  blendMode: z.enum(['multiply', 'normal']).optional(),
})
export type CastShadow = z.infer<typeof castShadowSchema>
const rigData = z.object({
  morphs: z.array(layerMorphGridSchema).default([]),
  headCalibration: headCalibrationSchema.optional(),
  layerSettings: z.array(layerSetting).default([]),
  castShadows: z.array(castShadowSchema).default([]),
  bindings: z.array(bindingSchema).default([]),
  bones: z.array(boneSchema).default([]),
  drawOrder: z.array(id).optional(),
  eyes: z.array(eye).default([]),
  gates: z.array(gate).default([]),
  semantics: z.object({ellipses:z.array(z.object({x:id,y:id,a:z.number().positive(),b:z.number().positive()})).default([])}),
})
export interface Part {
  layerId: string
  matrix: Matrix
  pivot: Point
  visible: boolean
  opacity?: number
  tint?: number
  peekOpacity?: number
  peekAfter?: string
  clipTo?: string
  geometry?: Geometry
  mask?: Point[]
}
export interface PoseOptions {
  /** Per-layer runtime opacity multipliers in `[0, 1]` (multiplied with any drive opacity). */
  opacity?: Record<string, number>
  /** Per-layer runtime RGB tint integers in `0x000000..0xffffff` (defaults to `0xffffff`). */
  tint?: Record<string, number>
  /** Per-layer runtime Alpha clipping mask target `layerId` (pass `null` to clear a static `layerSettings.clipTo`). */
  clipTo?: Record<string, string | null>
  /** Runtime cast-shadow overrides (replaces static `rig.json` `castShadows` for this frame; `[]` clears). */
  shadows?: CastShadow[]
  /** Run full triangle flip/self-intersection checkGeometry() pass (defaults to `true`). */
  validateGeometry?: boolean
}
/** Locate a material-space contact on the same piecewise-linear surface as the renderer. */
export function attachmentPoint(part:Part, size:Point, local:Point):Point {
  const g=part.geometry
  if (g) for (let i=0;i<g.indices.length;i+=3) {
    const [a,b,c]=[g.indices[i]!*2,g.indices[i+1]!*2,g.indices[i+2]!*2]
    const dx=local[0]/size[0]-g.uv[a]!,dy=local[1]/size[1]-g.uv[a+1]!
    const ux=g.uv[b]!-g.uv[a]!,uy=g.uv[b+1]!-g.uv[a+1]!,vx=g.uv[c]!-g.uv[a]!,vy=g.uv[c+1]!-g.uv[a+1]!
    const det=ux*vy-uy*vx, u=(dx*vy-dy*vx)/det, v=(ux*dy-uy*dx)/det
    if (!(u>=-1e-9 && v>=-1e-9 && u+v<=1+1e-9)) continue
    const p=g.vertices
    return transform(part.matrix,(1-u-v)*p[a]!+u*p[b]!+v*p[c]!, (1-u-v)*p[a+1]!+u*p[b+1]!+v*p[c+1]!)
  }
  return transform(part.matrix,...local)
}
export interface Pose {
  bones?: BonePose[]
  parts: Part[]
  shadows?: CastShadow[]
  parameters: Values
  slots: Record<string, string>
}
export function createRig(manifest: SliceManifest, raw: unknown) {
  const caps = exportCapabilities(raw),
    { bones, bindings, drawOrder, layerSettings, castShadows, eyes, gates, semantics, morphs, headCalibration } = rigData.parse(raw)
  if (caps.guidance)
    for (const c of caps.guidance.conditions)
      if (c.ranges?.length) gates.push({ slot: c.slot, from: c.from, to: c.to, ranges: c.ranges })
  const byId = new Map(bindings.map((b) => [b.layerId, b]))
  if (byId.size !== bindings.length) throw new Error('重复图层绑定')
  const layers = new Map(manifest.layers.map((l) => [l.layerId, l]))
  const settings = new Map(layerSettings.map((s) => [s.layerId, s]))
  for (const s of layerSettings) {
    if (!layers.has(s.layerId) || settings.get(s.layerId) !== s)
      throw new Error('未知或重复的图层设置 ' + s.layerId)
    if (s.peekAfter && !layers.has(s.peekAfter))
      throw new Error('未知透发锚点图层 ' + s.peekAfter)
    if (s.clipTo) {
      if (!layers.has(s.clipTo)) throw new Error('未知裁切目标图层 ' + s.clipTo)
      if (s.clipTo === s.layerId) throw new Error('图层不能自裁切 ' + s.layerId)
    }
  }
  const validateCastShadows = (list: CastShadow[]) => {
    for (const sh of list) {
      if (!sh.casters.length || !sh.receivers.length) throw new Error('投影配置须同时指定投射与受影图层')
      for (const cid of sh.casters) {
        if (!layers.has(cid)) throw new Error('未知投影投射图层 ' + cid)
      }
      for (const rid of sh.receivers) {
        if (!layers.has(rid)) throw new Error('未知投影受影图层 ' + rid)
      }
      if (!Number.isFinite(sh.offset[0]) || !Number.isFinite(sh.offset[1])) {
        throw new Error('投影偏移须为有限数值')
      }
      if (sh.opacity !== undefined && (!Number.isFinite(sh.opacity) || sh.opacity < 0 || sh.opacity > 1)) {
        throw new Error('投影不透明度须在 [0, 1] 内')
      }
      if (sh.blur !== undefined && (!Number.isFinite(sh.blur) || sh.blur < 0 || sh.blur > 64)) {
        throw new Error('投影模糊半径须在 [0, 64] 内')
      }
      if (sh.color !== undefined && (!Number.isInteger(sh.color) || sh.color < 0 || sh.color > 0xffffff)) {
        throw new Error('投影颜色须为 0x000000..0xffffff 整数')
      }
    }
  }
  validateCastShadows(castShadows)
  let orderedLayers = manifest.layers
  if (drawOrder) {
    if (
      drawOrder.length !== layers.size ||
      new Set(drawOrder).size !== layers.size ||
      drawOrder.some((id) => !layers.has(id))
    )
      throw new Error('绘制顺序必须恰好包含每个图层')
    orderedLayers = drawOrder.map((id) => layers.get(id)!)
    sliceManifestSchema.parse({ ...manifest, layers: orderedLayers })
  }
  const defs = neutral(caps).values
  const skeleton = prepareSkeleton(bones, defs)
  const params = new Map(caps.parameters.map((p) => [p.id, p]))
  const surfaces = new Map<string, {restGeometry:Geometry; restWorld:number[]; at:(amount:number)=>Geometry; chain?:ReturnType<typeof prepareChain>}>()
  const morphGroups = new Map<string, { grids: LayerMorphGrid[]; cols: number; rows: number }>()
  for (const morph of morphs) {
    if (!layers.has(morph.layerId)) throw new Error('Morph 未知图层 ' + morph.layerId)
    for (const axis of morph.axes) {
      if (!params.has(axis.parameter)) throw new Error(morph.layerId + ' Morph 未知参数 ' + axis.parameter)
    }
    morph.deltas = morph.deltas.map(delta => delta?.some(v => v !== 0) ? delta : null)
    if (!morph.deltas.some(Boolean)) continue
    const group = morphGroups.get(morph.layerId) ?? { grids: [], cols: 1, rows: 1 }
    group.grids.push(morph)
    group.cols = Math.max(group.cols, morph.grid[0])
    group.rows = Math.max(group.rows, morph.grid[1])
    morphGroups.set(morph.layerId, group)
  }
  const ordered: Binding[] = [],
    visited = new Set<string>(),
    visiting = new Set<string>()
  function visit(b: Binding) {
    if (visited.has(b.layerId)) return
    if (visiting.has(b.layerId)) throw new Error('循环挂载 ' + b.layerId)
    visiting.add(b.layerId)
    if (b.parentId) {
      const parent = byId.get(b.parentId)
      if (!parent) throw new Error(b.layerId + ' 缺少父绑定 ' + b.parentId)
      visit(parent)
    }
    visiting.delete(b.layerId)
    visited.add(b.layerId)
    ordered.push(b)
  }
  for (const b of bindings) {
    const layer = layers.get(b.layerId)
    if (!layer) throw new Error('绑定缺少图层 ' + b.layerId)
    if (
      ([b.parentId,b.boneId,b.boneChain].filter(Boolean).length>1) ||
      (b.jointSoftnessPx!==undefined && !b.boneChain) ||
      (b.boneId && !skeleton.byId.has(b.boneId)) ||
      (b.parentId && b.restOffset) ||
      !!b.restOffset !== !!b.bindOrigin ||
      (b.boneId && !b.restOffset)
    )
      throw new Error(b.layerId + ' 骨骼绑定或静止偏移无效 ' + (b.boneId ?? ''))
    if (b.restOffset) {
      const [a, basisY, c, d] = b.restOffset
      const det = a * d - basisY * c
      if (!Number.isFinite(det) || det === 0) throw new Error(b.layerId + ' 静止偏移不可逆')
    }
    const inputs = [
      ...(b.drives ?? []).map((d) => d.parameter),
      b.deformer?.parameter,
      b.spring?.parameter,
      ...(b.variant?.contact ?? []),
    ]
    for (const p of inputs) if (p !== undefined && !params.has(p)) throw new Error(b.layerId + ' 未知参数 ' + p)
    if (b.spring && !b.deformer) throw new Error(b.layerId + ' 次级运动缺少变形器')
    if (b.variant && !caps.slots.find((s) => s.id === b.variant!.slot)?.states.includes(b.variant.state)) {
      throw new Error('未知差分 ' + b.layerId)
    }
    visit(b)
  }
  const defaultSlots = Object.fromEntries(caps.slots.map((s) => [s.id, s.default]))
  const eyeLayers = new Set<string>()
  for (const e of eyes) {
    for (const part of [e.iris, e.white, e.closed]) {
      if (eyeLayers.has(part) || part === e.head) throw new Error('重复眼部绑定 ' + part)
      eyeLayers.add(part)
    }
    if (
      Boolean(e.inner) !== Boolean(e.outer) ||
      (e.inner && e.outer && e.inner[0] === e.outer[0] && e.inner[1] === e.outer[1])
    )
      throw new Error('眼角锚点无效 ' + e.iris)
    for (const id of [e.iris, e.white, e.closed, e.head])
      if (!layers.has(id)) throw new Error('眼部图层缺失 ' + id)
    const [x, y, w, h] = layers.get(e.iris)!.rect
    if (e.pupil && (e.pupil[0] < x || e.pupil[1] < y || e.pupil[0] > x + w || e.pupil[1] > y + h))
      throw new Error('瞳孔中心超出虹膜切片 ' + e.iris)
    for (const id of [e.x, e.y, e.blink]) if (!params.has(id)) throw new Error('眼部参数缺失 ' + id)
    if (
      !byId.has(e.head) ||
      [e.iris, e.white, e.closed].some((id) => byId.get(id)?.parentId !== e.head) ||
      Math.min(...e.radius) <= 0 ||
      Math.min(...e.travel) < 0
    ) {
      throw new Error('遮罩挂载或半径无效 ' + e.iris)
    }
  }
  for (const g of gates) {
    if (!caps.slots.find((s) => s.id === g.slot)?.transitions.some((t) => t.from === g.from && t.to === g.to))
      throw new Error('未知转换条件 ' + g.slot)
    for (const pair of g.anchors ?? [])
      for (const a of [pair.from, pair.to])
        if (!layers.has(a.layerId)) throw new Error('缺少接触部件 ' + a.layerId)
  }
  for (const r of gates.flatMap((g) => g.ranges ?? []))
    if (!params.has(r.parameter) || r.min > r.max) throw new Error('无效的条件范围 ' + r.parameter)
  // Map original canvas coordinates to the rest canvas. Keeping the bind-time crop
  // origin makes expanding a texture on reimport independent of its bone pivot.
  function mountMatrix(b: Binding, frames: Map<string, BonePose>, world: Map<string, Matrix>): Matrix {
    const root = b.boneId ?? b.boneChain?.[0]
    if (root && !frames.has(root)) throw new Error('未知目标骨骼 '+root)
    if (!b.restOffset) {
      if (root) return compose(frames.get(root)!.matrix,inverse(skeleton.rest.get(root)!.matrix))
      return b.parentId ? world.get(b.parentId)! : identity
    }
    const bone = root ? frames.get(root)!.matrix : identity
    const [x, y] = b.bindOrigin!
    return compose(compose(bone, b.restOffset), translate(-x, -y))
  }
  const restWorld = new Map<string, Matrix>()
  for (const b of ordered) restWorld.set(b.layerId, mountMatrix(b, skeleton.rest, restWorld))
  function layerSize(id: string): Point {
    const l = layers.get(id)
    if (!l) throw new Error('未知图层 ' + id)
    return [l.rect[2], l.rect[3]]
  }
  function restLayerMatrix(layerId: string) {
    const layer = layers.get(layerId)
    if (!layer) throw new Error('未知图层 ' + layerId)
    return compose(restWorld.get(layerId) ?? identity, translate(layer.rect[0], layer.rect[1]))
  }
  function worldVertices(vertices:number[], matrix:Matrix) {
    const result:number[]=[]
    for (let i=0;i<vertices.length;i+=2) result.push(...transform(matrix,vertices[i]!,vertices[i+1]!))
    return result
  }
  for (const b of bindings) {
    if (!b.mesh && !b.deformer && !b.boneChain) continue
    const [w,h]=layerSize(b.layerId), rest=restLayerMatrix(b.layerId)
    let base=b.mesh ? restMesh(b.mesh,w,h) : b.deformer ? prepareGeometry(b.deformer,w,h)(0) : quadGeometry(w,h)
    let chain:ReturnType<typeof prepareChain>|undefined
    if (b.boneChain) {
      try { chain=prepareChain(b.boneChain,b.jointSoftnessPx,skeleton.byId,skeleton.rest,rest,base) }
      catch (error) { throw new Error(b.layerId+' · '+String(error)) }
      base=chain.geometry
    }
    const at=b.deformer ? prepareGeometry(b.deformer,w,h,b.mesh||chain?base:undefined,false) : ()=>base
    surfaces.set(b.layerId,{at,chain,restGeometry:base,restWorld:worldVertices(base.vertices,rest)})
  }
  interface CachedFieldSurface {
    key: string
    restGeometry: Geometry
    restWorld: number[]
    skin?: (frames: Map<string, BonePose>, local: Geometry) => Geometry
  }
  const fieldCache = new Map<string, CachedFieldSurface>()
  function getFieldSurface(layerId: string, cols: number, rows: number): CachedFieldSurface {
    const key = `${cols}x${rows}`
    const existing = fieldCache.get(layerId)
    if (existing && existing.key === key) return existing
    const [w, h] = layerSize(layerId)
    const rest = restLayerMatrix(layerId)
    const surface = surfaces.get(layerId)
    const b = byId.get(layerId)
    let restGeometry: Geometry
    let skin: CachedFieldSurface['skin']
    if (surface?.chain) {
      restGeometry = subdivideContourGrid(surface.chain.geometry, w, h, cols, rows)
      skin = surface.chain.skinFor(restGeometry)
    } else if (surface && (b?.mesh || b?.deformer)) {
      restGeometry = subdivideContourGrid(surface.at(0), w, h, cols, rows)
    } else {
      restGeometry = buildRegularGrid(w, h, cols, rows)
    }
    const entry: CachedFieldSurface = {
      key,
      restGeometry,
      restWorld: worldVertices(restGeometry.vertices, rest),
      skin,
    }
    fieldCache.set(layerId, entry)
    return entry
  }
  type MorphSurface = ReturnType<typeof prepareMorphSurface> & {
    source?: Geometry; cols: number; rows: number; restWorld: number[]; skinVectors?: CachedFieldSurface['skin']
  }
  const morphSurfaces = new Map<string, MorphSurface>()
  function getMorphSurface(layerId: string, source: Geometry | undefined, cols: number, rows: number) {
    const cached = morphSurfaces.get(layerId)
    if (cached && cached.source === source && cached.cols === cols && cached.rows === rows) return cached
    const [w, h] = layerSize(layerId)
    const prepared = prepareMorphSurface(source, w, h, cols, rows)
    const entry: MorphSurface = {
      ...prepared, source, cols, rows,
      restWorld: worldVertices(prepared.geometry.vertices, restLayerMatrix(layerId)),
      skinVectors: surfaces.get(layerId)?.chain?.skinFor(prepared.geometry, true),
    }
    morphSurfaces.set(layerId, entry)
    return entry
  }
  function pose(
    parameters: Values = defs,
    slots = defaultSlots,
    secondary: Values = {},
    timeMs = 0,
    rotations: Values = {},
    transforms: BoneTransforms = {},
    deform?: MeshFields,
    options?: PoseOptions,
  ): Pose {
    for (const key of Object.keys(parameters)) if (!params.has(key)) throw new Error('未知参数 '+key)
    for (const p of caps.parameters) if (!Number.isFinite(parameters[p.id]))
      throw new Error(p.id+' @ '+timeMs+' ms · 非有限或缺失参数')
    if (deform) {
      for (const key of Object.keys(deform)) {
        if (!layers.has(key)) throw new Error('未知变形图层 ' + key)
      }
    }
    const runtimeOpacity = options?.opacity
    if (runtimeOpacity) {
      for (const [key, val] of Object.entries(runtimeOpacity)) {
        if (!layers.has(key)) throw new Error('未知透明度图层 ' + key)
        if (!Number.isFinite(val) || val < 0 || val > 1)
          throw new Error(key + ' @ ' + timeMs + ' ms · 透明度须在 [0, 1] 范围内')
      }
    }
    const runtimeTint = options?.tint
    if (runtimeTint) {
      for (const [key, val] of Object.entries(runtimeTint)) {
        if (!layers.has(key)) throw new Error('未知着色图层 ' + key)
        if (!Number.isInteger(val) || val < 0 || val > 0xffffff)
          throw new Error(key + ' @ ' + timeMs + ' ms · 着色 tint 须为 0x000000..0xffffff 整数')
      }
    }
    const runtimeClipTo = options?.clipTo
    if (runtimeClipTo) {
      for (const [key, target] of Object.entries(runtimeClipTo)) {
        if (!layers.has(key)) throw new Error('未知裁切图层 ' + key)
        if (target !== null) {
          if (!layers.has(target)) throw new Error('未知裁切目标图层 ' + target)
          if (target === key) throw new Error('图层不能自裁切 ' + key)
        }
      }
    }
    const validateGeometry = options?.validateGeometry !== false
    const activeFieldChecks = new Map<string, { restWorld: number[]; minRatio?: number }>()
    const frames = skeleton.evaluate(parameters, rotations, transforms)
    const world = new Map<string, Matrix>(),
      opacities = new Map<string, number>()
    for (const b of ordered) {
      const [x, y] = b.pivot
      let dx = 0,
        dy = 0,
        angle = 0,
        opacity = 1
      for (const d of b.drives ?? []) {
        const value = parameters[d.parameter]! - defs[d.parameter]!
        dx += value * (d.x ?? 0)
        dy += value * (d.y ?? 0)
        angle += value * (d.degrees ?? 0)
        opacity += value * (d.opacity ?? 0)
      }
      if (opacity !== 1) opacities.set(b.layerId, Math.max(0, Math.min(1, opacity)))
      if (b.restDegrees) {
        const a = (b.restDegrees * Math.PI) / 180,
          localX = dx
        dx = localX * Math.cos(a) - dy * Math.sin(a)
        dy = localX * Math.sin(a) + dy * Math.cos(a)
      }
      const parent = mountMatrix(b, frames, world)
      const radians = ((angle % 360) * Math.PI) / 180
      const c = Math.cos(radians),
        s = Math.sin(radians)
      world.set(b.layerId, compose(parent, [c, s, -s, c, x + dx - c * x + s * y, y + dy - s * x - c * y]))
    }
    const parts = orderedLayers.map((l): Part => {
      const w = world.get(l.layerId) ?? identity,
        b = byId.get(l.layerId),
        surface = surfaces.get(l.layerId)
      const [x, y, width, height] = l.rect
      const pivot = b?.pivot ?? [x + width / 2, y + height / 2]
      const setting = settings.get(l.layerId)
      const result: Part = {
        layerId: l.layerId,
        pivot: transform(w, ...pivot),
        matrix: compose(w, [1, 0, 0, 1, x, y]),
        visible: b?.variant
          ? slots[b.variant.slot] === b.variant.state
          : (setting?.visible ?? l.visible),
      }
      const driveOpacity = opacities.get(l.layerId)
      const overrideOpacity = runtimeOpacity?.[l.layerId]
      if (driveOpacity !== undefined || overrideOpacity !== undefined) {
        result.opacity = (driveOpacity ?? 1) * (overrideOpacity ?? 1)
      }
      const overrideTint = runtimeTint?.[l.layerId]
      if (overrideTint !== undefined) result.tint = overrideTint
      if (setting?.peekOpacity && setting.peekOpacity > 0) {
        result.peekOpacity = setting.peekOpacity
        if (setting.peekAfter) result.peekAfter = setting.peekAfter
      }
      const resolvedClipTo =
        runtimeClipTo && Object.hasOwn(runtimeClipTo, l.layerId)
          ? (runtimeClipTo[l.layerId] ?? undefined)
          : setting?.clipTo
      if (resolvedClipTo) result.clipTo = resolvedClipTo
      if (!result.matrix.every(Number.isFinite) || !result.pivot.every(Number.isFinite))
        throw new Error(l.layerId + ' @ ' + timeMs + ' ms · 非有限世界变换')
      const fieldInput = deform?.[l.layerId]
      let fieldSurface: CachedFieldSurface | undefined
      let fieldCols = 0, fieldRows = 0
      if (fieldInput !== undefined) {
        const { field, cols, rows, minRatio } = normalizeMeshField(fieldInput, l.layerId)
        const cached = getFieldSurface(l.layerId, cols, rows)
        fieldSurface = cached
        fieldCols = cols
        fieldRows = rows
        const displaced = applyMeshField(cached.restGeometry, l.rect, field, l.layerId, timeMs)
        result.geometry = cached.skin ? cached.skin(frames, displaced) : displaced
        activeFieldChecks.set(l.layerId, { restWorld: cached.restWorld, minRatio })
      } else if (surface) {
        const amount=b?.deformer ? parameters[b.deformer.parameter]! - defs[b.deformer.parameter]! + (secondary[l.layerId] ?? 0) : 0
        const local=surface.at(amount)
        result.geometry=surface.chain ? surface.chain.posed(frames).geometry(local) : local
      }
      const group = morphGroups.get(l.layerId)
      if (group) {
        let refined: MorphSurface | undefined
        let offsets: number[] | undefined
        let minRatio = Math.max(fieldSurface ? activeFieldChecks.get(l.layerId)?.minRatio ?? .01 : 0,
          b?.deformer?.minRatio ?? 0)
        for (const morph of group.grids) {
          const lattice = interpolateMorph(morph, parameters)
          if (!lattice) continue
          refined ??= getMorphSurface(l.layerId, fieldSurface?.restGeometry ?? surface?.restGeometry,
            fieldCols >= group.cols ? 1 : group.cols, fieldRows >= group.rows ? 1 : group.rows)
          offsets ??= new Array<number>(refined.geometry.uv.length).fill(0)
          accumulateMorph(refined.geometry.uv, morph.grid, lattice, offsets)
          minRatio = Math.max(minRatio, morph.minRatio ?? .01)
        }
        if (refined && offsets && offsets.some(v => v !== 0)) {
          const mesh = refined.geometry
          const vertices = refined.posedVertices(result.geometry)
          // For linear blend skinning, skin(p + delta) = skin(p) + linearSkin(delta).
          const vectors = refined.skinVectors?.(frames, { ...mesh, vertices: offsets }).vertices ?? offsets
          for (let i = 0; i < vertices.length; i++) vertices[i] = vertices[i]! + vectors[i]!
          result.geometry = { ...mesh, vertices }
          activeFieldChecks.set(l.layerId, { restWorld: refined.restWorld, minRatio: minRatio || undefined })
        }
      }
      return result
    })
    const byPart = new Map(parts.map((p) => [p.layerId, p]))
    for (const e of eyes) {
      const head = world.get(e.head)!,
        iris = byPart.get(e.iris)!,
        white = byPart.get(e.white)!,
        closed = byPart.get(e.closed)!
      const legacy = semantics.ellipses.find(v => v.x===e.x && v.y===e.y)
      const x = parameters[e.x]! / (e.units?.[0] ?? legacy?.a ?? 1),
        y = parameters[e.y]! / (e.units?.[1] ?? legacy?.b ?? 1)
      const blink = Math.min(1, Math.max(0, parameters[e.blink]!))
      const correction = e.corners[(x < 0 ? 0 : 1) + (y < 0 ? 0 : 2)]!,
        w = Math.abs(x * y)
      const center: Point =
        e.inner && e.outer ? [(e.inner[0] + e.outer[0]) / 2, (e.inner[1] + e.outer[1]) / 2] : e.center
      const axis: Point = e.inner && e.outer ? [e.outer[0] - e.inner[0], e.outer[1] - e.inner[1]] : [1, 0]
      const length = Math.hypot(...axis),
        ux = (axis[0] / length) * (axis[0] < 0 ? -1 : 1),
        uy = (axis[1] / length) * (axis[0] < 0 ? -1 : 1)
      const rx = e.inner ? length / 2 : e.radius[0]
      const horizontal = x * e.travel[0] + correction[0] * w,
        vertical = (y * e.travel[1] + correction[1] * w) * (1 - blink)
      const dx = horizontal * ux - vertical * uy,
        dy = horizontal * uy + vertical * ux
      const wx = head[0] * dx + head[2] * dy,
        wy = head[1] * dx + head[3] * dy
      iris.matrix[4] += wx
      iris.matrix[5] += wy
      iris.pivot = [iris.pivot[0] + wx, iris.pivot[1] + wy]
      closed.visible = blink >= e.threshold
      iris.visible &&= !closed.visible
      white.visible &&= !closed.visible
      const contour = Array.from({ length: 48 }, (_, i) => {
        const t = (i * Math.PI) / 24
        const u = rx * Math.cos(t),
          v = e.radius[1] * (1 - blink) * Math.sin(t)
        return transform(head, center[0] + ux * u - uy * v, center[1] + uy * u + ux * v)
      })
      iris.mask = contour
      white.mask = contour
    }
    for (const setting of layerSettings)
      if (setting.visible === false) byPart.get(setting.layerId)!.visible = false
    if (validateGeometry) {
      for (const part of parts) {
        const g = part.geometry
        if (!g || !part.visible || part.opacity === 0 || layers.get(part.layerId)!.opacity === 0) continue
        const fieldCheck = activeFieldChecks.get(part.layerId)
        const surface = surfaces.get(part.layerId)
        const restWorldRef = fieldCheck?.restWorld ?? surface?.restWorld
        if (!restWorldRef) continue
        const d = byId.get(part.layerId)?.deformer
        const isChain = Boolean(surface?.chain)
        const matrixDet = part.matrix[0] * part.matrix[3] - part.matrix[1] * part.matrix[2]
        const baseRatio = fieldCheck?.minRatio ?? d?.minRatio ?? 0.01
        const baseMinArea = d?.minArea ?? 1e-8
        const scaleFactor = !isChain && matrixDet > 0 ? matrixDet : 1
        try {
          checkGeometry(
            restWorldRef,
            worldVertices(g.vertices, part.matrix),
            g.indices,
            baseMinArea * Math.min(1, scaleFactor),
            baseRatio * scaleFactor,
          )
        } catch (error) {
          if (error instanceof GeometryError)
            throw new GeometryError(part.layerId + ' @ ' + timeMs + ' ms · ' + error.message, error.polygons)
          throw error
        }
      }
    }
    const activeShadows = options?.shadows !== undefined ? options.shadows : castShadows
    if (options?.shadows !== undefined && options.shadows.length) validateCastShadows(options.shadows)
    return {
      ...(bones.length ? { bones: [...frames.values()] } : {}),
      parts,
      ...(activeShadows.length ? { shadows: activeShadows } : {}),
      parameters,
      slots: { ...slots },
    }
  }
  return {
    caps,
    skeleton,
    settings,
    layerSize,
    controlMapper(layerId:string,pose:Pose) {
      const part=pose.parts.find(p=>p.layerId===layerId)!
      const chain=surfaces.get(layerId)?.chain?.posed(new Map(pose.bones?.map(b=>[b.boneId,b])))
      return (rest:Point,local:Point) => transform(part.matrix,...(chain?.point(rest,local) ?? local))
    },
    restLayerMatrix,
    bindings,
    eyes,
    gates,
    defaultSlots,
    headCalibration,
    pose,
  }
}
export type Rig = ReturnType<typeof createRig>
