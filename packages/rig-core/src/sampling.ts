import { exportCapabilities, validateMotion } from './agent.js'
import type { Capabilities } from './agent.js'

type Key = { timeMs: number; value: number }
export type Values = Record<string, number>
export interface Sample {
  values: Values
  velocities: Values
}

function interior(h0: number, h1: number, d0: number, d1: number) {
  if (d0 * d1 <= 0) return 0
  const w0 = 2 * h1 + h0,
    w1 = h1 + 2 * h0
  return (w0 + w1) / (w0 / d0 + w1 / d1)
}
function endpoint(h0: number, h1: number, d0: number, d1: number) {
  const m = ((2 * h0 + h1) * d0 - h0 * d1) / (h0 + h1)
  if (Math.sign(m) !== Math.sign(d0)) return 0
  return Math.sign(d0) !== Math.sign(d1) && Math.abs(m) > 3 * Math.abs(d0) ? 3 * d0 : m
}

// Periodic tracks use the segment on the other side of the seam as a real neighbour.
function curve(input: Key[], duration: number, loop: boolean) {
  const keys = [...input]
  if (loop && keys.length > 1 && keys[0]!.timeMs === 0 && keys.at(-1)!.timeMs === duration) {
    if (keys[0]!.value !== keys.at(-1)!.value) throw new Error('循环接缝处的首尾关键帧值不同')
    keys.pop()
  }
  const n = keys.length
  if (n === 1) return (_t: number) => ({ value: keys[0]!.value, velocity: 0 })
  const widths: number[] = [],
    slopes: number[] = []
  for (let i = 0; i < (loop ? n : n - 1); i++) {
    const left = keys[i]!,
      right = keys[(i + 1) % n]!
    const h = right.timeMs - left.timeMs + (i === n - 1 ? duration : 0)
    widths.push(h)
    slopes.push((right.value - left.value) / h)
  }
  const tangents = keys.map((_, i) => {
    if (!loop && n === 2) return slopes[0]!
    if (!loop && i === 0) return endpoint(widths[0]!, widths[1]!, slopes[0]!, slopes[1]!)
    if (!loop && i === n - 1) return endpoint(widths[i - 1]!, widths[i - 2]!, slopes[i - 1]!, slopes[i - 2]!)
    const prev = (i + n - 1) % n
    return interior(widths[prev]!, widths[i]!, slopes[prev]!, slopes[i]!)
  })
  return (time: number) => {
    if (!loop && time < keys[0]!.timeMs) return { value: keys[0]!.value, velocity: 0 }
    if (!loop && time > keys[n - 1]!.timeMs) return { value: keys[n - 1]!.value, velocity: 0 }
    const t = loop && time < keys[0]!.timeMs ? time + duration : time
    let lo = 0,
      hi = n - 1
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2)
      if (keys[mid]!.timeMs <= t) lo = mid
      else hi = mid - 1
    }
    const i = loop ? lo : Math.min(lo, n - 2),
      j = (i + 1) % n
    const h = widths[i]!,
      u = (t - keys[i]!.timeMs) / h,
      v = 1 - u
    const a = keys[i]!.value,
      b = keys[j]!.value,
      m = tangents[i]!,
      k = tangents[j]!
    return {
      value: v * v * (1 + 2 * u) * a + u * u * (3 - 2 * u) * b + h * u * v * (v * m - u * k),
      velocity: (6 * u * v * (b - a)) / h + v * (1 - 3 * u) * m + u * (3 * u - 2) * k,
    }
  }
}

/** Validate a complete semantic sample without altering its values or derivatives. */
export function validateSample(caps: Capabilities, sample: Sample): Sample {
  const ids = new Set(caps.parameters.map(p=>p.id))
  for (const record of [sample.values,sample.velocities]) {
    for (const key of Object.keys(record)) if (!ids.has(key)) throw new Error('未知参数 ' + key)
    for (const id of ids) if (!Number.isFinite(record[id])) throw new Error('非有限参数或速度 ' + id)
  }
  return sample
}

// Preserve the public v1 entry point for existing hosts.
export const constrain = validateSample

export function neutral(caps: Capabilities): Sample {
  return {
    values: Object.fromEntries(caps.parameters.map((p) => [p.id, p.default])),
    velocities: Object.fromEntries(caps.parameters.map((p) => [p.id, 0])),
  }
}

export function createMotionSampler(rig: unknown, draft: unknown) {
  const caps = exportCapabilities(rig),
    motion = validateMotion(rig, draft)
  function prepare(loop: boolean) {
    return motion.tracks.map((t) => {
      try {
        return { parameter: t.parameter, at: curve(t.keys, motion.durationMs, loop) }
      } catch (error) {
        throw new Error(t.parameter + ' · ' + String(error))
      }
    })
  }
  const open = prepare(false)
  let periodic: typeof open | undefined
  function intent(timeMs: number, loop: boolean = false): Sample {
    if (!Number.isFinite(timeMs)) throw new Error('采样时间须为有限数值')
    const t = loop ? ((timeMs % motion.durationMs) + motion.durationMs) % motion.durationMs : timeMs
    const result = neutral(caps)
    for (const track of loop ? (periodic ??= prepare(true)) : open) {
      const point = track.at(t)
      result.values[track.parameter] = point.value
      result.velocities[track.parameter] = point.velocity
    }
    return result
  }
  return {
    motion,
    intent,
    sample(timeMs: number, loop: boolean = false) {
      return validateSample(caps, intent(timeMs, loop))
    },
  }
}
