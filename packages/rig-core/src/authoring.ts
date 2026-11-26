import { z } from 'zod'
import { parameterSchema } from './agent.js'
import { headCalibrationSchema } from './head-morph.js'
import { layerMorphGridSchema } from './morph.js'
import { attachmentMesh, deformer, point, prepareGeometry, type Point } from './geometry.js'
import { bindingSchema, castShadowSchema, createRig, layerSetting, type Binding, type Rig } from './pose.js'
import { neutral, type Values } from './sampling.js'
import { boneSchema, boneTransformSchema, prepareSkeleton, compose, direction, identity, inverse, transform, translate } from './skeleton.js'
import type { PixelRect, SliceManifest } from './slices.js'

const id = z.string().min(1)
const layer = { layerId: id }
const documentSchema = z.looseObject({
  semantics: z.looseObject({ parameters: z.array(parameterSchema) }),
  bones: z.array(boneSchema).default([]),
  bindings: z.array(bindingSchema).default([]),
  drawOrder: z.array(id).optional(),
  layerSettings: z.array(layerSetting).optional(),
  castShadows: z.array(castShadowSchema).optional(),
  morphs: z.array(layerMorphGridSchema).optional(),
  headCalibration: headCalibrationSchema.optional(),
})
export const editSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('set-parameter'), parameter: parameterSchema }),
  z.strictObject({ op: z.literal('remove-parameter'), parameterId: id }),
  z.strictObject({
    op: z.literal('add-bone'),
    boneId: id,
    name: id.optional(),
    parentBoneId: id.optional(),
    start: point.optional(),
    end: point,
    snap: z.boolean().optional(),
  }),
  z.strictObject({
    op: z.literal('edit-bone'),
    boneId: id,
    changes: boneSchema.omit({ boneId: true, parentBoneId: true }).partial(),
  }),
  z.strictObject({ op: z.literal('place-bone'), boneId:id, start:point, end:point }),
  z.strictObject({ op: z.literal('repivot-bone'), boneId: id, pivot: point, keepEnd: z.boolean().optional() }),
  z.strictObject({ op: z.literal('reparent'), boneId: id, parentBoneId: id.nullable() }),
  z.strictObject({ op: z.literal('remove-bone'), boneId: id }),
  z.strictObject({ op: z.literal('bind'), ...layer, boneId: id }),
  z.strictObject({ op: z.literal('bind-chain'), ...layer, boneChain:z.array(id).min(2), jointSoftnessPx:z.number().positive().optional() }),
  z.strictObject({ op: z.literal('unbind'), ...layer }),
  layerSetting.extend({ op: z.literal('set-layer') }),
  z.strictObject({ op: z.literal('draw-order'), layers: z.array(id) }),
  z.strictObject({
    op: z.literal('create-ffd'),
    ...layer,
    parameter: id,
    size: z.union([z.literal(3), z.literal(4)]),
    locked: z.array(z.int().nonnegative()).optional(),
    maxDisplacementPx: z.number().nonnegative().optional(),
    minArea: z.number().positive(),
    minRatio: z.number().positive(),
  }),
  z.strictObject({ op: z.literal('ffd-point'), ...layer, index: z.int().nonnegative(), offset: point }),
  z.strictObject({ op: z.literal('set-mesh'), ...layer, mesh: attachmentMesh.nullable() }),
  z.strictObject({ op: z.literal('set-deformer'), ...layer, deformer: deformer.nullable() }),
  z.strictObject({ op: z.literal('set-cast-shadows'), castShadows: z.array(castShadowSchema) }),
  z.strictObject({ op: z.literal('set-morphs'), morphs: z.array(layerMorphGridSchema) }),
  z.strictObject({ op: z.literal('set-head-calibration'), headCalibration: headCalibrationSchema.nullable() }),
])
export type RigEdit = z.infer<typeof editSchema>

/**
 * Recalibrate a layer binding when its slice rect changes (e.g. padding/bleeding or cropping a texture)
 * so original painted pixels remain locked to their exact 0.0000 px rest canvas position.
 */
export function syncSliceBinding(binding: Binding, oldRect: PixelRect, newRect: PixelRect): Binding {
  const [x0, y0] = oldRect
  const [x1, y1] = newRect
  const dx = x0 - x1
  const dy = y0 - y1
  const next: Binding = { ...binding }

  if (binding.restOffset && binding.bindOrigin) {
    const [bx0, by0] = binding.bindOrigin
    next.restOffset = compose(binding.restOffset, translate(x1 - bx0, y1 - by0))
    next.bindOrigin = [x1, y1]
  }
  if (binding.mesh && (dx !== 0 || dy !== 0)) {
    next.mesh = {
      ...binding.mesh,
      points: binding.mesh.points.map(([px, py]): Point => [px + dx, py + dy]),
    }
  }
  return next
}

export function emptyRig(rigId: string) {
  return { rigId: id.parse(rigId), rigVersion: 1, semantics: { parameters: [], slots: [] } }
}

/** Apply one undoable transaction to a fresh document. Authoring always reads rest transforms. */
export function editRig(manifest: SliceManifest, input: unknown, commands: unknown) {
  const edits = z.array(editSchema).min(1).parse(commands)
  const doc = documentSchema.parse(input)
  let model = createRig(manifest, doc)
  for (const e of edits) {
    if (e.op === 'set-parameter') {
      const i = doc.semantics.parameters.findIndex((p) => p.id === e.parameter.id)
      if (i < 0) doc.semantics.parameters.push(e.parameter)
      else doc.semantics.parameters[i] = e.parameter
    } else if (e.op === 'remove-parameter') {
      const i = doc.semantics.parameters.findIndex((p) => p.id === e.parameterId)
      if (i < 0) throw new Error('未知参数 ' + e.parameterId)
      doc.semantics.parameters.splice(i, 1)
    } else if (e.op === 'add-bone') {
      const parent = e.parentBoneId ? model.skeleton.rest.get(e.parentBoneId) : undefined
      if (e.parentBoneId && !parent) throw new Error('未知父骨 ' + e.parentBoneId)
      const snap = parent && e.snap !== false
      const from = snap ? parent.end : e.start
      if (!from) throw new Error(e.boneId + ' 需要画布起点')
      const local = inverse(parent?.matrix ?? identity)
      const [x, y] = snap ? [model.skeleton.byId.get(e.parentBoneId!)!.length, 0] : transform(local, ...from)
      const dx = e.end[0] - from[0],
        dy = e.end[1] - from[1]
      const length = Math.hypot(dx, dy)
      const rotation =
        length === 0 ? 0 : direction(local[0] * dx + local[2] * dy, local[1] * dx + local[3] * dy)
      doc.bones.push({ boneId: e.boneId, name: e.name, parentBoneId: e.parentBoneId, x, y, rotation, length })
    } else if (e.op === 'place-bone' || e.op === 'repivot-bone') {
      const bone = doc.bones.find((b) => b.boneId === e.boneId)
      if (!bone) throw new Error('未知骨骼 ' + e.boneId)
      const prevPose = model.skeleton.rest.get(e.boneId)!
      const nextStart: Point = e.op === 'place-bone' ? e.start : e.pivot
      let nextEnd: Point
      if (e.op === 'place-bone') {
        nextEnd = e.end
      } else if (e.keepEnd === false) {
        nextEnd = [
          e.pivot[0] + (prevPose.end[0] - prevPose.start[0]),
          e.pivot[1] + (prevPose.end[1] - prevPose.start[1]),
        ]
      } else {
        const dist = Math.hypot(prevPose.end[0] - e.pivot[0], prevPose.end[1] - e.pivot[1])
        nextEnd =
          dist > 1e-6
            ? prevPose.end
            : [
                e.pivot[0] + (prevPose.end[0] - prevPose.start[0]),
                e.pivot[1] + (prevPose.end[1] - prevPose.start[1]),
              ]
      }
      const parent = bone.parentBoneId ? model.skeleton.rest.get(bone.parentBoneId)!.matrix : identity
      const local = inverse(parent)
      const [x, y] = transform(local, ...nextStart)
      const [tx, ty] = transform(local, ...nextEnd)
      Object.assign(bone, { x, y, length: Math.hypot(tx - x, ty - y), rotation: direction(tx - x, ty - y) })
      if (e.op === 'repivot-bone') {
        // Keep direct child bones at their exact original rest world transforms.
        const movedSkeleton = prepareSkeleton(doc.bones, neutral(model.caps).values)
        const nextParentWorld = movedSkeleton.rest.get(e.boneId)!.matrix
        for (const child of doc.bones) {
          if (child.parentBoneId !== e.boneId) continue
          const prevChildWorld = model.skeleton.rest.get(child.boneId)!.matrix
          const childLocal = compose(inverse(nextParentWorld), prevChildWorld)
          Object.assign(child, {
            x: childLocal[4],
            y: childLocal[5],
            rotation: direction(childLocal[0], childLocal[1]),
          })
        }
      }
      // Recalibrate attachments against their original rest pixels, including children of the edited bone.
      const nextSkeleton = prepareSkeleton(doc.bones, neutral(model.caps).values)
      for (const binding of doc.bindings) {
        const root = binding.boneId ?? binding.boneChain?.[0]
        if (!root) continue
        const layer = manifest.layers.find((l) => l.layerId === binding.layerId)!
        binding.restOffset = compose(inverse(nextSkeleton.rest.get(root)!.matrix), model.restLayerMatrix(binding.layerId))
        binding.bindOrigin = [layer.rect[0], layer.rect[1]]
      }
    } else if (e.op === 'reparent' || e.op === 'edit-bone' || e.op === 'remove-bone') {
      const bone = doc.bones.find((b) => b.boneId === e.boneId)
      if (!bone) throw new Error('未知骨骼 ' + e.boneId)
      if (e.op === 'edit-bone') Object.assign(bone, e.changes)
      else if (e.op === 'remove-bone') doc.bones.splice(doc.bones.indexOf(bone), 1)
      else {
        const parent = e.parentBoneId ? model.skeleton.rest.get(e.parentBoneId) : undefined
        if (e.parentBoneId && !parent) throw new Error('未知父骨 ' + e.parentBoneId)
        const local = compose(inverse(parent?.matrix ?? identity), model.skeleton.rest.get(e.boneId)!.matrix)
        Object.assign(bone, {
          parentBoneId: e.parentBoneId,
          x: local[4],
          y: local[5],
          rotation: direction(local[0], local[1]),
        })
      }
    } else if (e.op === 'set-layer') {
      const { op, ...setting } = e
      doc.layerSettings ??= []
      const old = doc.layerSettings.find((s) => s.layerId === e.layerId)
      if (old) Object.assign(old, setting)
      else doc.layerSettings.push(setting)
    } else if (e.op === 'draw-order') {
      doc.drawOrder = e.layers
    } else if (e.op === 'set-morphs') {
      if (e.morphs.length) doc.morphs = e.morphs
      else delete doc.morphs
    } else if (e.op === 'set-head-calibration') {
      if (e.headCalibration) doc.headCalibration = e.headCalibration
      else delete doc.headCalibration
    } else if (e.op === 'set-cast-shadows') {
      if (e.castShadows.length) doc.castShadows = e.castShadows
      else delete doc.castShadows
    } else {
      const l = manifest.layers.find((l) => l.layerId === e.layerId)
      if (!l) throw new Error('未知图层 ' + e.layerId)
      if (model.settings.get(l.layerId)?.locked) throw new Error('图层已锁定 ' + l.layerId)
      let b = doc.bindings.find((b) => b.layerId === e.layerId)
      const [x, y, w, h] = l.rect
      if (!b) {
        b = { layerId: l.layerId, pivot: [x + w / 2, y + h / 2] }
        doc.bindings.push(b)
      }
      if (e.op === 'bind' || e.op === 'bind-chain' || e.op === 'unbind') {
        const root = e.op==='bind' ? e.boneId : e.op==='bind-chain' ? e.boneChain[0] : undefined
        const target = root ? model.skeleton.rest.get(root) : undefined
        if (root && !target) throw new Error('未知目标骨骼 ' + root)
        b.restOffset = compose(inverse(target?.matrix ?? identity), model.restLayerMatrix(l.layerId))
        b.bindOrigin = [x, y]
        if (e.op === 'bind') b.boneId = e.boneId
        else delete b.boneId
        delete b.boneChain
        delete b.jointSoftnessPx
        if (e.op==='bind-chain') { b.boneChain=e.boneChain; b.jointSoftnessPx=e.jointSoftnessPx }
        delete b.parentId
      } else if (e.op === 'create-ffd') {
        b.deformer = {
          kind: 'ffd',
          size: e.size,
          parameter: e.parameter,
          locked: e.locked,
          maxDisplacementPx: e.maxDisplacementPx,
          minArea: e.minArea,
          minRatio: e.minRatio,
          offsets: Array.from({ length: e.size ** 2 }, (): Point => [0, 0]),
        }
      } else if (e.op === 'ffd-point') {
        if (b.deformer?.kind !== 'ffd' || !b.deformer.offsets[e.index])
          throw new Error(e.layerId + ' 未知晶格点 ' + e.index)
        b.deformer.offsets[e.index] = e.offset
      } else if (e.op === 'set-mesh') {
        if (e.mesh) b.mesh = e.mesh
        else delete b.mesh
      } else if (e.op === 'set-deformer') {
        if (e.deformer) b.deformer = e.deformer
        else delete b.deformer
      }
    }
    model = createRig(manifest, doc)
  }
  model.pose()
  return doc
}

export function previewRig(model: Rig, input: unknown = {}) {
  const options = z
    .strictObject({
      parameters: z.record(id, z.number()).optional(),
      rotations: z.record(id, z.number()).optional(),
      bones: z.record(id, boneTransformSchema).optional(),
    })
    .parse(input)
  const sample = neutral(model.caps)
  for (const [id, value] of Object.entries(options.parameters ?? {})) {
    if (!Object.hasOwn(sample.values, id)) throw new Error('未知试动参数 ' + id)
    sample.values[id] = value
  }
  const values: Values = sample.values
  const pose = model.pose(values, model.defaultSlots, {}, 0, options.rotations, options.bones)
  const parts = new Map(pose.parts.map((p) => [p.layerId, p]))
  const defaults = neutral(model.caps).values
  const controls = model.bindings.flatMap((b) => {
    const d = b.deformer
    if (!d) return []
    const part = parts.get(b.layerId)!
    let points: Point[], rest:Point[]
    if (d.kind === 'ffd') {
      const amount = values[d.parameter]! - defaults[d.parameter]!
      const [w, h] = model.layerSize(b.layerId)
      rest=d.offsets.map((_,i)=>[((i%d.size)*w)/(d.size-1),(Math.floor(i/d.size)*h)/(d.size-1)])
      points = d.offsets.map(([dx, dy], i) => [
        ((i % d.size) * w) / (d.size - 1) + dx * amount,
        (Math.floor(i / d.size) * h) / (d.size - 1) + dy * amount,
      ])
    } else {
      rest=d.line.map(([x,y])=>[x,y])
      const vertices = b.mesh || b.boneChain
        ? prepareGeometry(d, ...model.layerSize(b.layerId))(values[d.parameter]! - defaults[d.parameter]!).vertices
        : part.geometry!.vertices
      points = d.line.map((_, i) => {
        const k = i * 4 * 4 // four spline segments per span, two vertices per row
        return [(vertices[k]! + vertices[k + 2]!) / 2, (vertices[k + 1]! + vertices[k + 3]!) / 2]
      })
    }
    const mapPoint=model.controlMapper(b.layerId,pose)
    return [
      {
        layerId: b.layerId,
        kind: d.kind,
        locked: d.kind === 'ffd' ? (d.locked ?? []) : [0],
        points: points.map((p,i) => mapPoint(rest[i]!,p)),
      },
    ]
  })
  return controls.length ? { ...pose, controls } : pose
}
