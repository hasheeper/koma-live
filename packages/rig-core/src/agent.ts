import { z } from 'zod'

const id = z.string().min(1)
const ms = z.int().nonnegative()
export const parameterSchema = z.strictObject({
  id, meaning: z.string().min(1), unit: z.string(), min: z.number(), max: z.number(), default: z.number(),
})
const ellipse = z.strictObject({ x: id, y: id, a: z.number().positive(), b: z.number().positive() })
const transition = z.strictObject({ from: id, to: id, minHoldMs: ms, exitWindowMs: z.tuple([ms, ms]) })
const slot = z.strictObject({ id, default: id, states: z.array(id).min(1), transitions: z.array(transition) })
const semantics = z.strictObject({
  parameters: z.array(parameterSchema), ellipses: z.array(ellipse), slots: z.array(slot),
})
const identity = { rigId: id, rigVersion: z.int().positive() }
const guidance=z.strictObject({
  recommendedDurationMs:z.tuple([ms.positive(),ms.positive()]),
  conditions:z.array(z.strictObject({slot:id,from:id,to:id,meaning:z.string().min(1),
    ranges:z.array(z.strictObject({parameter:id,min:z.number(),max:z.number()})).optional()}))
})
const rigHeader = z.object({ ...identity, semantics:semantics.extend({ellipses:z.array(ellipse).default([])}), guidance:guidance.optional() })
const capabilitiesV1 = z.strictObject({
  format: z.literal('koma-rig.capabilities.v1'), ...identity, ...semantics.shape,
})
const capabilitiesV2=capabilitiesV1.extend({format:z.literal('koma-rig.capabilities.v2'),guidance})
const referenceParameter = parameterSchema.omit({min:true,max:true}).extend({
  referenceRange: z.tuple([z.number(), z.number()]).describe('Recommended expressive range; finite motion values may exceed it.'),
})
export const capabilitiesSchema = z.strictObject({
  format:z.literal('koma-rig.capabilities.v3'), ...identity, parameters:z.array(referenceParameter),
  slots:semantics.shape.slots, guidance:guidance.optional(),
})
export const publishedCapabilitiesSchema=z.discriminatedUnion('format',[capabilitiesV1,capabilitiesV2,capabilitiesSchema])
export type Capabilities = z.infer<typeof capabilitiesSchema>

function unique(values: string[], name: string) {
  if (new Set(values).size !== values.length) throw new Error(`${name} 含有重复 ID`)
}

export function exportCapabilities(input: unknown): Capabilities {
  const { rigId, rigVersion, semantics: fields, guidance: advice } = rigHeader.parse(input)
  const { parameters, slots, ellipses } = fields
  unique(parameters.map(p => p.id), '参数')
  unique(slots.map(s => s.id), '差分槽')
  for (const p of parameters) {
    if (p.min > p.max) throw new Error(`${p.id} 参考区间顺序错误`)
  }
  const axes = new Map(parameters.map(p => [p.id, p]))
  for (const e of ellipses) {
    const x = axes.get(e.x), y = axes.get(e.y)
    if (!x || !y || x === y) {
      throw new Error(`椭圆轴或默认姿势无效：${e.x} / ${e.y}`)
    }
  }
  for (const s of slots) {
    unique(s.states, s.id)
    unique(s.transitions.map(t => JSON.stringify([t.from, t.to])), s.id)
    if (!s.states.includes(s.default)) throw new Error(`${s.id} 默认态缺失`)
    for (const t of s.transitions) {
      if (!s.states.includes(t.from) || !s.states.includes(t.to) || t.exitWindowMs[0] > t.exitWindowMs[1]) {
        throw new Error(`${s.id} 转换规则无效`)
      }
    }
    const canReturn = new Set([s.default])
    for (let size = 0; size < canReturn.size;) {
      size = canReturn.size
      for (const t of s.transitions) if (canReturn.has(t.to)) canReturn.add(t.from)
    }
    if (s.states.some(state => !canReturn.has(state))) throw new Error(`${s.id} 存在无法回到默认态的差分`)
  }
  if(advice){
    if(advice.recommendedDurationMs[0]>advice.recommendedDurationMs[1])throw new Error('动作时长参考范围无效')
    for(const c of advice.conditions){
      if(!slots.find(s=>s.id===c.slot)?.transitions.some(t=>t.from===c.from&&t.to===c.to))
        throw new Error('未知语义转换条件 '+c.slot)
      for(const r of c.ranges??[]){
        const p=axes.get(r.parameter)
        if(!p || r.min>r.max)throw new Error('非法语义转换条件 '+r.parameter)
      }
    }
  }
  return {
    format:'koma-rig.capabilities.v3', rigId, rigVersion,
    parameters:parameters.map(({min,max,...p})=>({...p,referenceRange:[min,max]})), slots,
    ...(advice ? {guidance:advice} : {}),
  }
}

export function capabilitiesJsonSchema(format:z.infer<typeof publishedCapabilitiesSchema>['format']='koma-rig.capabilities.v3') {
  return z.toJSONSchema(format==='koma-rig.capabilities.v1'?capabilitiesV1:format==='koma-rig.capabilities.v2'?capabilitiesV2:capabilitiesSchema)
}

/** Compare older reviewed packages against the projection actually stored in their hashes. */
export function matchesPublishedCapabilities(raw: unknown, input: unknown) {
  const stored = publishedCapabilitiesSchema.parse(input)
  const {rigId,rigVersion,semantics,guidance} = rigHeader.parse(raw)
  const expected = stored.format === 'koma-rig.capabilities.v3' ? exportCapabilities(raw)
    : { format: guidance ? 'koma-rig.capabilities.v2' : 'koma-rig.capabilities.v1', rigId,rigVersion,...semantics,...(guidance?{guidance}:{}) }
  return JSON.stringify(stored)===JSON.stringify(publishedCapabilitiesSchema.parse(expected))
}

const key = z.strictObject({ timeMs: ms, value: z.number() })
const motionSchema = z.strictObject({
  format: z.literal('koma-rig.motion.v1'), ...identity, durationMs: ms.positive(),
  tracks: z.array(z.strictObject({ parameter: id, keys: z.array(key).min(1) })),
  requests: z.array(z.strictObject({ timeMs: ms, slot: id, to: id })),
})

/** Validate draft inputs. Pose evaluation and geometric acceptance are separate stages. */
export function validateMotion(rig: unknown, input: unknown) {
  const caps = exportCapabilities(rig)
  const motion = motionSchema.parse(input)
  if (motion.rigId !== caps.rigId || motion.rigVersion !== caps.rigVersion) throw new Error('动作的 Rig 版本不匹配')
  unique(motion.tracks.map(t => t.parameter), '轨道')
  for (const track of motion.tracks) {
    const p = caps.parameters.find(value => value.id === track.parameter)
    if (!p) throw new Error(`未知参数 ${track.parameter}`)
    let previous = -1
    for (const k of track.keys) {
      if (k.timeMs <= previous || k.timeMs > motion.durationMs) {
        throw new Error(`${p.id} 关键帧时间无效`)
      }
      previous = k.timeMs
    }
  }
  const states = new Map(caps.slots.map(s => [s.id, { state: s.default, entered: 0 }]))
  let lastTime = -1
  for (const request of motion.requests) {
    const s = caps.slots.find(s => s.id === request.slot)
    const current = states.get(request.slot)
    const rule = s?.transitions.find(t => t.from === current?.state && t.to === request.to)
    if (!current || !rule || request.timeMs < lastTime || request.timeMs < current.entered || request.timeMs > motion.durationMs) {
      throw new Error(`非法差分请求 ${request.slot} → ${request.to}`)
    }
    const entered = Math.max(current.entered + rule.minHoldMs, request.timeMs) + rule.exitWindowMs[0]
    states.set(request.slot, { state: request.to, entered })
    lastTime = request.timeMs
  }
  return motion
}
