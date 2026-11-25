import { z } from 'zod'

const texturePath = z.string().regex(/^textures\/[A-Za-z0-9_-]+\.png$/)
const legacy = z.strictObject({
  format: z.literal('koma-rig.slices.v1'),
  sourceId: z.string().min(1),
  canvas: z.strictObject({ width: z.int().positive(), height: z.int().positive() }),
  reference: z.literal('reference.png'),
  groupTree: z.array(z.strictObject({
    groupId: z.string().min(1), parentGroupId: z.string().min(1).nullable(), name: z.string(),
    index: z.int().nonnegative(), visible: z.boolean(), idSource: z.enum(['native','mapped','index']),
  })).optional(),
  // Source-over in back-to-front order. Opacity is unbaked and normalized.
  layers: z.array(z.strictObject({
    layerId: z.string().min(1), name: z.string(), groups: z.array(z.string()),
    groupId: z.string().min(1).optional(), sourceIndex: z.int().nonnegative().optional(),
    texture: texturePath,
    rect: z.tuple([z.int(), z.int(), z.int().positive(), z.int().positive()]),
    visible: z.boolean(), opacity: z.number().min(0).max(1),
  })),
})
const direct = legacy.extend({
  format:z.literal('koma-rig.slices.v2'),blendSpace:z.literal('srgb'),
  /** Optional uniform texture downsample ratio in `(0, 1]` (e.g. `0.5` for half-res mobile export); logical canvas & rects stay 1×. */
  textureScale:z.number().positive().max(1).optional(),
  gelGroups:z.array(z.strictObject({opacity:z.number().min(0).max(1),
    members:z.array(z.strictObject({layerId:z.string(),coverage:texturePath})).min(1)})).optional(),
})
export const sliceManifestSchema=z.discriminatedUnion('format',[legacy,direct]).superRefine((m,ctx)=>{
  const groups = new Map((m.groupTree ?? []).map(g => [g.groupId, g]))
  if (groups.size !== m.groupTree?.length && m.groupTree)
    ctx.addIssue({code:'custom',message:'重复图层组 ID'})
  const done = new Set<string>()
  for (const g of groups.values()) {
    const path = new Set<string>()
    let id: string | null = g.groupId
    while (id && !done.has(id)) {
      const group = groups.get(id)
      if (!group || path.has(id)) {
        ctx.addIssue({code:'custom',message:'缺少父图层组或图层组循环 ' + id})
        break
      }
      path.add(id)
      id = group.parentGroupId
    }
    for (const id of path) done.add(id)
  }
  for (const l of m.layers)
    if (l.groupId && !groups.has(l.groupId)) ctx.addIssue({code:'custom',message:l.layerId + ' 缺少图层组 ' + l.groupId})
  if(m.format==='koma-rig.slices.v1') return
  const seen=new Set<string>()
  for(const g of m.gelGroups??[]) {
    let previous=-1
    for(const {layerId} of g.members) {
      const i=m.layers.findIndex(l=>l.layerId===layerId)
      if(i<0 || seen.has(layerId) || (previous>=0 && previous+1!==i))
        ctx.addIssue({code:'custom',message:'同深度合成组成员须唯一且按连续层序排列 '+layerId})
      previous=i;seen.add(layerId)
    }
  }
}).refine(m => new Set(m.layers.map(l => l.layerId)).size === m.layers.length, '重复 layerId')

export type SliceManifest = z.infer<typeof sliceManifestSchema>
export type CanvasSize = SliceManifest['canvas']
export type PixelRect = SliceManifest['layers'][number]['rect']
