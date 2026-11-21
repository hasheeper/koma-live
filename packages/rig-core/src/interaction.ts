import { createPlayer } from './player.js'
import { createMotionSampler } from './sampling.js'
import type { Rig } from './pose.js'

/** Both scene clips share the same integrator and slot clocks for the entire session. */
export function createInteractionPlayer(rig: Rig, raw: unknown, idle: unknown, response: unknown) {
  const player = createPlayer(rig, raw, idle, true)
  const duration = createMotionSampler(raw, response).motion.durationMs
  let end: number | undefined
  function beginReturn(ms: number) {
    const pose = player.advanceTo(ms)
    if (end === undefined) return pose
    end = undefined
    return player.transition(idle, { loop: true, phaseMs: ms })
  }
  function advanceTo(ms: number) {
    if (end !== undefined && end <= ms) beginReturn(end)
    return player.advanceTo(ms)
  }
  function returnToIdle(ms: number) {
    if (end !== undefined && end < ms) beginReturn(end)
    return beginReturn(ms)
  }
  function trigger(ms: number) {
    advanceTo(ms)
    end = ms + duration
    return player.transition(response, { loop: false })
  }
  return { advanceTo, trigger, returnToIdle }
}
