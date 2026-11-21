import { validateSample, createMotionSampler } from './sampling.js'
import type { Sample, Values } from './sampling.js'
import { attachmentPoint } from './pose.js'
import type { Rig } from './pose.js'

export const stepMs = 10
const smooth = (t: number) => t * t * (3 - 2 * t)
type Clip = ReturnType<typeof createMotionSampler>
type Active = { clip: Clip; start: number; loop: boolean }
type Fade = { source: (ms: number) => Sample; start: number; duration: number }
type SlotState = {
  state: string
  entered: number
  queue: string[]
  returning: boolean
  requested: number
  contact: Values
}

function firstEdge(from: string, to: string, edges: { from: string; to: string }[]) {
  const queue = [{ at: from, first: '' }],
    seen = new Set([from])
  for (let i = 0; i < queue.length; i++)
    for (const e of edges) {
      const node = queue[i]!
      if (e.from !== node.at || seen.has(e.to)) continue
      const first = node.first || e.to
      if (e.to === to) return first
      seen.add(e.to)
      queue.push({ at: e.to, first })
    }
  throw new Error('差分路径不存在 ' + from + ' → ' + to)
}
function read(active: Active, time: number) {
  return active.clip.intent(time - active.start, active.loop)
}

export function createPlayer(rig: Rig, raw: unknown, draft: unknown, loop: boolean = false) {
  let active: Active = { clip: createMotionSampler(raw, draft), start: 0, loop },
    fade: Fade | undefined
  let tick = 0,
    now = 0,
    previousClipTime = -1
  const slots = new Map<string, SlotState>(
    rig.caps.slots.map((s) => [
      s.id,
      {
        state: s.default,
        entered: 0,
        queue: [],
        returning: false,
        requested: 0,
        contact: Object.create(null),
      },
    ]),
  )
  const secondary = new Map(
    rig.bindings
      .filter((b) => b.spring)
      .map((b) => [b.layerId, { offset: 0, speed: 0, phase: b.spring!.phase }]),
  )
  const nextSecondary = new Map(secondary)
  function continuous(t: number) {
    const target = read(active, t)
    if (!fade || t >= fade.start + fade.duration) return target
    const source = fade.source(t),
      u = Math.max(0, (t - fade.start) / fade.duration)
    const w = smooth(u),
      dw = (6 * u * (1 - u)) / fade.duration
    for (const p of rig.caps.parameters) {
      const a = source.values[p.id]!,
        b = target.values[p.id]!
      target.values[p.id] = a + (b - a) * w
      target.velocities[p.id] =
        source.velocities[p.id]! * (1 - w) + target.velocities[p.id]! * w + (b - a) * dw
    }
    return target
  }
  function requestReturn(t: number, sample: Sample) {
    for (const def of rig.caps.slots) {
      const s = slots.get(def.id)!
      s.queue = []
      if (s.returning || s.state === def.default) continue
      s.returning = true
      s.requested = (Math.floor(t / stepMs) + 1) * stepMs
      for (const b of rig.bindings)
        if (b.variant?.slot === def.id && b.variant.state === s.state)
          for (const p of b.variant.contact ?? [])
            if (!Object.hasOwn(s.contact, p)) s.contact[p] = sample.values[p]!
    }
  }
  function requests(t: number) {
    const elapsed = t - active.start,
      m = active.clip.motion
    const firstCycle = active.loop
      ? Math.max(0, Math.floor(Math.max(0, previousClipTime) / m.durationMs) - 1)
      : 0
    const lastCycle = active.loop ? Math.floor(elapsed / m.durationMs) : 0
    for (let cycle = firstCycle; cycle <= lastCycle; cycle++)
      for (const r of m.requests) {
        const at = r.timeMs + cycle * m.durationMs
        if (at <= previousClipTime || at > elapsed) continue
        if (!rig.bindings.some((b) => b.variant?.slot === r.slot && b.variant.state === r.to))
          throw new Error('差分缺少已绑定切片 ' + r.slot + ' / ' + r.to)
        const s = slots.get(r.slot)!
        if (!s.queue.length && !s.returning) s.requested = t
        s.queue.push(r.to)
      }
    previousClipTime = elapsed
  }
  function slotStep(t: number, base: Sample) {
    requests(t)
    if (!active.loop && t - active.start > active.clip.motion.durationMs) requestReturn(t, base)
    for (const def of rig.caps.slots) {
      const s = slots.get(def.id)!
      const next = s.returning ? firstEdge(s.state, def.default, def.transitions) : s.queue[0]
      if (!next) continue
      if (next === s.state) {
        s.queue.shift()
        continue
      }
      const edge = def.transitions.find((e) => e.from === s.state && e.to === next)
      if (!edge) throw new Error('非法差分边 ' + def.id + ' ' + s.state + ' → ' + next)
      const start = Math.ceil(Math.max(s.requested, s.entered + edge.minHoldMs) / stepMs) * stepMs,
        [a, b] = edge.exitWindowMs
      const open = Math.ceil((start + a) / stepMs) * stepMs,
        close = Math.floor((start + b) / stepMs) * stepMs
      if (open > close) throw new Error(def.id + ' @ ' + t + ' ms · 退场窗口内没有模拟步')
      const gates = rig.gates.filter((g) => g.slot === def.id && g.from === s.state && g.to === next)
      if (t < open || (s.returning && (!gates.length || Object.keys(s.contact).length) && t < close)) continue
      if (t > close) throw new Error(def.id + ' @ ' + t + ' ms · 已错过转换窗口')
      if (gates.length) {
        const sample = displayedSample(t)
        const offsets = Object.fromEntries([...secondary].map(([id, st]) => [id, st.offset]))
        const displayed = Object.fromEntries([...slots].map(([id, st]) => [id, st.state]))
        const parts = new Map(rig.pose(sample.values, displayed, offsets, t).parts.map((p) => [p.layerId, p]))
        let failure = ''
        for (const g of gates) {
          for (const r of g.ranges ?? [])
            if (sample.values[r.parameter]! < r.min || sample.values[r.parameter]! > r.max)
              failure = r.parameter
          for (const pair of g.anchors ?? []) {
            const a = attachmentPoint(parts.get(pair.from.layerId)!,rig.layerSize(pair.from.layerId),pair.from.local)
            const b = attachmentPoint(parts.get(pair.to.layerId)!,rig.layerSize(pair.to.layerId),pair.to.local)
            if (Math.hypot(a[0] - b[0], a[1] - b[1]) > pair.tolerancePx)
              failure = pair.from.layerId + ' / ' + pair.to.layerId
          }
        }
        if (failure) {
          if (t >= close)
            throw new Error(
              def.id + ' ' + s.state + ' → ' + next + ' @ ' + t + ' ms · 窗口内未对齐 ' + failure,
            )
          continue
        }
      }
      if (s.returning && a === b)
        for (const [id, held] of Object.entries(s.contact)) {
          if (Math.abs(base.values[id]! - held) > 1e-9 || Math.abs(base.velocities[id]!) > 1e-9)
            throw new Error(def.id + ' @ ' + t + ' ms · 接触参数 ' + id + ' 需要非零退场窗口')
        }
      s.state = next
      s.entered = t
      s.requested = t + stepMs
      s.contact = Object.create(null)
      for (const b of rig.bindings)
        if (b.variant?.slot === def.id && b.variant.state === next)
          for (const p of b.variant.contact ?? []) s.contact[p] = base.values[p]!
      if (!s.returning) s.queue.shift()
      if (s.state === def.default) {
        s.returning = false
        s.contact = Object.create(null)
      }
    }
  }
  function displayedSample(t: number) {
    const sample = continuous(t)
    for (const def of rig.caps.slots) {
      const s = slots.get(def.id)!
      if (!s.returning) {
        for (const [id, value] of Object.entries(s.contact)) {
          sample.values[id] = value
          sample.velocities[id] = 0
        }
        continue
      }
      const next = firstEdge(s.state, def.default, def.transitions)
      const edge = def.transitions.find((e) => e.from === s.state && e.to === next)!
      const start = Math.ceil(Math.max(s.requested, s.entered + edge.minHoldMs) / stepMs) * stepMs
      const [a, b] = edge.exitWindowMs
      const u = b > a ? Math.max(0, Math.min(1, (t - start - a) / (b - a))) : 0
      for (const [id, value] of Object.entries(s.contact)) {
        if (u === 0) {
          sample.values[id] = value
          sample.velocities[id] = 0
          continue
        }
        const target = sample.values[id]!
        sample.values[id] = value + (target - value) * smooth(u)
        sample.velocities[id] =
          sample.velocities[id]! * smooth(u) + (b > a ? ((target - value) * 6 * u * (1 - u)) / (b - a) : 0)
      }
    }
    return validateSample(rig.caps, sample)
  }
  function planPhysicsStep(t: number) {
    const sample = displayedSample(t),
      dt = stepMs / 1000
    for (const b of rig.bindings) {
      if (!b.spring) continue
      const p = b.spring,
        s = secondary.get(b.layerId)!
      const driver = rig.caps.parameters.find((v) => v.id === p.parameter)!
      const phase = s.phase + dt * 2 * Math.PI * p.hz
      const target = sample.values[p.parameter]! - driver.default + p.amplitude * Math.sin(phase)
      // Implicit Euler for a damped spring remains bounded for stiff calibrated rigs.
      const speed =
        (s.speed + dt * p.stiffness * (target - s.offset)) / (1 + dt * p.damping + dt * dt * p.stiffness)
      const offset = s.offset + dt * speed
      if (![speed,offset,phase].every(Number.isFinite)) throw new Error(b.layerId + ' @ ' + t + ' ms · 非有限次级运动')
      nextSecondary.set(b.layerId, { offset, speed, phase })
    }
  }
  function frame(t: number) {
    const sample = displayedSample(t)
    const displayed = Object.fromEntries([...slots].map(([id, s]) => [id, s.state]))
    // Draw between fixed simulation steps without committing any render-time state.
    const fraction = (t - tick) / stepMs
    const dynamics = Object.fromEntries(
      [...secondary].map(([id, s]) => {
        const next = nextSecondary.get(id)!
        return [
          id,
          {
            offset: s.offset + (next.offset - s.offset) * fraction,
            speed: s.speed + (next.speed - s.speed) * fraction,
            phase: s.phase + (next.phase - s.phase) * fraction,
          },
        ] as const
      }),
    )
    const offsets = Object.fromEntries(Object.entries(dynamics).map(([id, s]) => [id, s.offset]))
    return {
      timeMs: t,
      ...rig.pose(sample.values, displayed, offsets, t),
      velocities: sample.velocities,
      secondary: dynamics,
    }
  }
  slotStep(0, continuous(0))
  planPhysicsStep(0)
  return {
    advanceTo(timeMs: number) {
      if (!Number.isFinite(timeMs) || timeMs < now) throw new Error('播放器时间无效或倒退')
      if (
        !secondary.size &&
        !active.clip.motion.requests.length &&
        rig.caps.slots.every(
          (def) => slots.get(def.id)!.state === def.default && !slots.get(def.id)!.queue.length,
        )
      )
        tick = Math.floor(timeMs / stepMs) * stepMs
      while (tick + stepMs <= timeMs) {
        tick += stepMs
        for (const [id, s] of nextSecondary) secondary.set(id, s)
        slotStep(tick, continuous(tick))
        planPhysicsStep(tick)
      }
      now = timeMs
      return frame(now)
    },
    transition(next: unknown, options: { loop?: boolean; durationMs?: number; phaseMs?: number } = {}) {
      const duration = options.durationMs ?? 180,
        phase = options.phaseMs ?? 0
      if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(phase) || phase < 0)
        throw new Error('过渡时长或相位无效')
      const clip = createMotionSampler(raw, next),
        cycle = options.loop ?? false
      clip.intent(phase, cycle)
      const old = active,
        initial = continuous(now),
        start = now
      const interrupted = fade && now < fade.start + fade.duration
      const source = interrupted
        ? (t: number): Sample => ({
            values: Object.fromEntries(
              rig.caps.parameters.map((p) => [
                p.id,
                initial.values[p.id]! + (t - start) * initial.velocities[p.id]!,
              ]),
            ),
            velocities: initial.velocities,
          })
        : (t: number) => read(old, t)
      requestReturn(now, initial)
      fade = { start: now, duration, source }
      active = { clip, loop: cycle, start: now - phase }
      previousClipTime = phase - Number.EPSILON * Math.max(1, phase)
      return frame(now)
    },
  }
}
