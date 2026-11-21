import { z } from 'zod'
import { createRig } from './pose.js'
import { createMotionSampler } from './sampling.js'
import { createPlayer, stepMs } from './player.js'
import { createInteractionPlayer } from './interaction.js'
import type { SliceManifest } from './slices.js'

const motionPath = z.string().regex(/^motions\/[^/\\:]+\.json$/)
export const releaseSchema = z.strictObject({
  format: z.literal('koma-rig.release.v1'),
  rigId: z.string().min(1),
  rigVersion: z.int().positive(),
  idle: motionPath,
  response: motionPath,
  files: z.record(
    z
      .string()
      .regex(
        /^(?:(?:rig|manifest|acceptance|rig-capabilities(?:\.schema)?)\.json|reference\.png|textures\/[A-Za-z0-9_-]+\.png|motions\/[^/\\:]+\.json)$/,
      ),
    z.string().regex(/^[a-f0-9]{64}$/),
  ),
})
export type Release = z.infer<typeof releaseSchema>

export function auditMotions(
  manifest: SliceManifest,
  raw: unknown,
  motions: Record<string, unknown>,
  idle: string,
  response: string,
) {
  const rig = createRig(manifest, raw)
  rig.pose()
  for (const slot of rig.caps.slots)
    for (const state of slot.states) {
      if (!rig.bindings.some((b) => b.variant?.slot === slot.id && b.variant.state === state))
        throw new Error('差分状态缺少部件 ' + slot.id + ' / ' + state)
    }
  const tail = rig.caps.slots.reduce(
    (max, s) =>
      Math.max(
        max,
        s.transitions.reduce((n, e) => n + e.minHoldMs + e.exitWindowMs[1] + 2 * stepMs, 0),
      ),
    stepMs,
  )
  if (!Object.hasOwn(motions, idle) || !Object.hasOwn(motions, response))
    throw new Error('待机或交互动作缺失')
  let checked = 0
  for (const [name, motion] of Object.entries(motions)) {
    try {
      const sampler = createMotionSampler(raw, motion),
        loop = name === idle
      const player = createPlayer(rig, raw, motion, loop)
      const duration = sampler.motion.durationMs
      const end = loop ? duration * 2 : duration + tail
      const times = new Set([0, end, ...sampler.motion.tracks.flatMap((t) => t.keys.map((k) => k.timeMs))])
      for (let t = 0; t < end; t += stepMs) times.add(t)
      for (const t of [...times].sort((a, b) => a - b)) {
        player.advanceTo(t)
        checked++
      }
      const last = player.advanceTo(end)
      if (!loop && rig.caps.slots.some((s) => last.slots[s.id] !== s.default))
        throw new Error('退场未回默认态')
    } catch (e) {
      throw new Error(name + ' · ' + String(e))
    }
  }
  const idleDuration = createMotionSampler(raw, motions[idle]).motion.durationMs
  const responseDuration = createMotionSampler(raw, motions[response]).motion.durationMs
  // Replay at fixed, reproducible phases including the two sides of a tick boundary.
  const interruptions: { enterMs: number; returnMs: number }[] = []
  for (const fraction of [0, 0.173, 0.5, 0.937]) {
    const scene = createInteractionPlayer(rig, raw, motions[idle], motions[response])
    const enter = Math.floor(idleDuration * fraction),
      exit = enter + Math.floor(responseDuration * (1 - fraction))
    interruptions.push({ enterMs: enter, returnMs: exit })
    scene.trigger(enter)
    for (let t = enter + stepMs; t < exit; t += stepMs) {
      scene.advanceTo(t)
      checked++
    }
    const before = scene.advanceTo(exit),
      after = scene.returnToIdle(exit)
    for (const p of rig.caps.parameters)
      if (Math.abs(before.parameters[p.id]! - after.parameters[p.id]!) > 1e-9)
        throw new Error(p.id + ' 打断时姿势跳变')
    for (const s of rig.caps.slots)
      if (before.slots[s.id] !== after.slots[s.id]) throw new Error(s.id + ' 打断时槽态跳变')
    for (let t = exit + stepMs; t <= exit + tail + 200; t += stepMs) {
      scene.advanceTo(t)
      checked++
    }
    const settled = scene.advanceTo(exit + tail + 200)
    for (const s of rig.caps.slots)
      if (settled.slots[s.id] !== s.default) throw new Error(s.id + ' 打断后未回默认态')
  }
  return { rigId: rig.caps.rigId, rigVersion: rig.caps.rigVersion, poses: checked, stepMs, interruptions }
}
