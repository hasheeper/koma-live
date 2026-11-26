import { z } from 'zod'
import { capabilitiesSchema } from './agent.js'
import { point } from './geometry.js'
import { createRig } from './pose.js'
import { headCalibrationSchema } from './head-morph.js'
import { sliceManifestSchema, type SliceManifest } from './slices.js'

const id = z.string().min(1)
const round = (n: number) => Number(n.toFixed(3))
const roundPoint = (p: readonly [number, number]): [number, number] => [round(p[0]), round(p[1])]

export const rigSpecSchema = z.strictObject({
  format: z.literal('koma-rig.spec.v1'),
  rigId: id,
  rigVersion: z.int().positive(),
  canvas: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
  coordinates: z.strictObject({
    origin: z.literal('top-left'),
    yAxis: z.literal('down'),
    rotation: z.literal('clockwise-degrees'),
    translateSpace: z.literal('parent-local'),
    scaleDefault: z.literal(1),
  }),
  bones: z.array(
    z.strictObject({
      boneId: id,
      name: id,
      parentBoneId: id.nullable(),
      length: z.number().nonnegative(),
      restRotation: z.number(),
      restStart: point,
      restEnd: point,
    }),
  ),
  layers: z.array(
    z.strictObject({
      layerId: id,
      name: z.string(),
      visible: z.boolean(),
      boundTo: z
        .strictObject({
          boneId: id.optional(),
          boneChain: z.array(id).min(2).optional(),
        })
        .optional(),
      deformerKind: z.enum(['ffd', 'ribbon']).optional(),
      hasMesh: z.boolean(),
    }),
  ),
  slots: capabilitiesSchema.shape.slots,
  parameters: z
    .array(
      z.strictObject({
        id,
        meaning: z.string().min(1),
        unit: z.string(),
        default: z.number(),
        referenceRange: z.tuple([z.number(), z.number()]),
      }),
    )
    .optional(),
  headCalibration: headCalibrationSchema.optional(),
})
export type RigSpec = z.infer<typeof rigSpecSchema>

/** Export a concise, TRS-first puppet spec for procedural code-art animation (mountLiveRig). */
export function exportRigSpec(manifestInput: SliceManifest | unknown, raw: unknown): RigSpec {
  const manifest = sliceManifestSchema.parse(manifestInput)
  const model = createRig(manifest, raw)
  const rest = model.pose()
  const layerNames = new Map(manifest.layers.map((l) => [l.layerId, l.name]))
  const bindingById = new Map(model.bindings.map((b) => [b.layerId, b]))

  const bones: RigSpec['bones'] = []
  for (const [boneId, frame] of model.skeleton.rest) {
    const bone = model.skeleton.byId.get(boneId)!
    bones.push({
      boneId,
      name: bone.name ?? bone.boneId,
      parentBoneId: bone.parentBoneId ?? null,
      length: round(bone.length),
      restRotation: round(bone.rotation),
      restStart: roundPoint(frame.start),
      restEnd: roundPoint(frame.end),
    })
  }

  const layers: RigSpec['layers'] = rest.parts.map((part) => {
    const b = bindingById.get(part.layerId)
    const boundTo = b?.boneChain
      ? { boneChain: [...b.boneChain] }
      : b?.boneId
        ? { boneId: b.boneId }
        : undefined
    return {
      layerId: part.layerId,
      name: layerNames.get(part.layerId) ?? part.layerId,
      visible: part.visible,
      ...(boundTo ? { boundTo } : {}),
      ...(b?.deformer ? { deformerKind: b.deformer.kind } : {}),
      hasMesh: Boolean(b?.mesh),
    }
  })

  const parameters = model.caps.parameters.length
    ? model.caps.parameters.map((p) => ({
        id: p.id,
        meaning: p.meaning,
        unit: p.unit,
        default: p.default,
        referenceRange: p.referenceRange,
      }))
    : undefined

  return rigSpecSchema.parse({
    format: 'koma-rig.spec.v1',
    rigId: model.caps.rigId,
    rigVersion: model.caps.rigVersion,
    canvas: manifest.canvas,
    coordinates: {
      origin: 'top-left',
      yAxis: 'down',
      rotation: 'clockwise-degrees',
      translateSpace: 'parent-local',
      scaleDefault: 1,
    },
    bones,
    layers,
    slots: model.caps.slots,
    ...(parameters ? { parameters } : {}),
    ...(model.headCalibration ? { headCalibration: model.headCalibration } : {}),
  })
}
