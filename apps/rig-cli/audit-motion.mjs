import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import {
  createPhysicsToolkit,
  createRig,
  editRig,
  emptyRig,
  exportRigSpec,
  performanceMetaSchema,
  sliceManifestSchema,
  workManifestSchema,
} from '@koma-rig/rig-core'

const round2 = (n) => Number(n.toFixed(2))

function partWorldSample(part, layerRect) {
  const [m0, m1, m2, m3, m4, m5] = part.matrix
  const [, , w, h] = layerRect
  const verts = part.geometry?.vertices ?? [0, 0, w, 0, 0, h, w, h]
  const count = verts.length / 2
  const world = new Float64Array(verts.length)
  let minY = Infinity
  let maxY = -Infinity
  let topIdx = 0
  let botIdx = 0
  for (let i = 0; i < count; i++) {
    const lx = verts[i * 2]
    const ly = verts[i * 2 + 1]
    const wx = m0 * lx + m2 * ly + m4
    const wy = m1 * lx + m3 * ly + m5
    world[i * 2] = wx
    world[i * 2 + 1] = wy
    if (ly < minY) { minY = ly; topIdx = i }
    if (ly > maxY) { maxY = ly; botIdx = i }
  }
  return {
    world,
    top: [world[topIdx * 2], world[topIdx * 2 + 1]],
    bot: [world[botIdx * 2], world[botIdx * 2 + 1]],
    spanY: maxY - minY,
  }
}

async function resolveWorkPaths(sourceArg, scriptOverride) {
  const abs = resolve(sourceArg)
  const workPath = abs.endsWith('.json') ? abs : join(abs, 'koma-work.json')
  if (existsSync(workPath)) {
    const baseDir = abs.endsWith('.json') ? resolve(abs, '..') : abs
    const work = workManifestSchema.parse(JSON.parse(await readFile(workPath, 'utf8')))
    return {
      rigDir: resolve(baseDir, work.rig),
      scriptPath: scriptOverride ? resolve(scriptOverride) : work.performance ? resolve(baseDir, work.performance) : null,
      defaultState: work.defaultState ?? 'idle',
    }
  }
  return {
    rigDir: abs,
    scriptPath: scriptOverride ? resolve(scriptOverride) : null,
    defaultState: 'idle',
  }
}

/**
 * Pure-Node headless motion quality & physics auditor (runs in ~1s without Chromium).
 * Detects GeometryError flips, sudden frame snaps, bone clamp-wall sticking, and anti-inertia ("steel plate") hair.
 */
export async function runAuditMotion(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      script: { type: 'string' },
      'idle-ms': { type: 'string', default: '3000' },
      'step': { type: 'string', default: '16.6667' },
      'idle-snap-px': { type: 'string', default: '12' },
      'turn-snap-px': { type: 'string', default: '32' },
    },
  })
  if (positionals.length !== 1) {
    throw new Error('用法: rig audit-motion <作品或切片目录> [--script perf.js] [--idle-ms 3000] [--step 16.67]')
  }

  const idleMs = Number(values['idle-ms'])
  const stepMs = Number(values.step)
  const idleSnapThreshold = Number(values['idle-snap-px'])
  const turnSnapThreshold = Number(values['turn-snap-px'])
  if (!(idleMs > 0) || !(stepMs > 0)) throw new Error('--idle-ms 与 --step 须为正数')

  const { rigDir, scriptPath, defaultState } = await resolveWorkPaths(positionals[0], values.script)
  if (!scriptPath || !existsSync(scriptPath)) {
    throw new Error('缺少演出脚本：请在 koma-work.json 中配置 performance 或使用 --script 指定')
  }

  const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(join(rigDir, 'manifest.json'), 'utf8')))
  const rigPath = join(rigDir, 'rig.json')
  const setupPath = join(rigDir, 'setup.json')
  const rigDoc = existsSync(rigPath)
    ? JSON.parse(await readFile(rigPath, 'utf8'))
    : existsSync(setupPath)
      ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await readFile(setupPath, 'utf8')))
      : emptyRig(manifest.sourceId)

  const rig = createRig(manifest, rigDoc)
  const spec = exportRigSpec(manifest, rigDoc)
  const layerRectById = new Map(manifest.layers.map((l) => [l.layerId, l.rect]))

  // Import performance ES module cleanly (cache-busted URL in case called multiple times in one process)
  const modUrl = `${pathToFileURL(scriptPath).href}?audit=${Date.now()}`
  const mod = await import(modUrl)
  if (typeof mod.default !== 'function') {
    throw new Error(`演出脚本 ${basename(scriptPath)} 缺少 default export createPerformance(ctx)`)
  }
  const meta = mod.meta ? performanceMetaSchema.parse(mod.meta) : { format: 'koma-rig.performance.v1' }

  let lastInput = null
  let lastPose = null
  const puppet = {
    spec,
    reset() {
      lastInput = null
      lastPose = rig.pose()
    },
    setPose(input = {}) {
      lastInput = input
      lastPose = rig.pose(
        input.parameters ?? {},
        input.slots ?? rig.defaultSlots,
        {},
        input.timeMs ?? 0,
        {},
        input.bones ?? {},
        input.deform,
        {
          opacity: input.opacity,
          tint: input.tint,
          clipTo: input.clipTo,
          shadows: input.shadows,
          validateGeometry: true,
        },
      )
      return {
        ...lastPose,
        bones: (lastPose.bones ?? []).map((b) => ({ boneId: b.boneId, start: b.start, end: b.end })),
      }
    },
  }

  const perf = await mod.default({
    puppet,
    size: manifest.canvas,
    back: null,
    front: null,
    physics: createPhysicsToolkit(),
  })
  perf.setState?.(defaultState)

  const geometryErrors = []
  const idleMaxStepByLayer = new Map()
  const turnMaxStepByLayer = new Map()
  const prevWorldByLayer = new Map()

  function recordFrameSteps(targetMap) {
    if (!lastPose) return
    for (const part of lastPose.parts) {
      if (!part.visible) continue
      const rect = layerRectById.get(part.layerId)
      if (!rect) continue
      const sample = partWorldSample(part, rect)
      const prev = prevWorldByLayer.get(part.layerId)
      if (prev && prev.length === sample.world.length) {
        let maxD = 0
        for (let i = 0; i < sample.world.length; i += 2) {
          const d = Math.hypot(sample.world[i] - prev[i], sample.world[i + 1] - prev[i + 1])
          if (d > maxD) maxD = d
        }
        if (maxD > (targetMap.get(part.layerId) ?? 0)) targetMap.set(part.layerId, maxD)
      }
      prevWorldByLayer.set(part.layerId, sample.world)
    }
  }

  function stepSafe(timeMs, dtMs, pointer, stateLabel) {
    try {
      perf.update({ timeMs, dtMs, pointer, state: stateLabel })
      return true
    } catch (err) {
      geometryErrors.push({ timeMs: round2(timeMs), state: stateLabel, message: err instanceof Error ? err.message : String(err) })
      return false
    }
  }

  // Phase 1: Pure idle smoothness audit
  const idleFrames = Math.ceil(idleMs / stepMs)
  let tMs = 0
  for (let i = 0; i <= idleFrames; i++) {
    tMs = i * stepMs
    if (stepSafe(tMs, i === 0 ? 0 : stepMs, { inside: false, nx: 0, ny: 0, x: 0, y: 0, down: false }, defaultState)) {
      if (i > 0) recordFrameSteps(idleMaxStepByLayer)
    }
  }

  // Phase 2: Brisk turn sweep RIGHT (+0.9) -> LEFT (-0.9) — audit frame snaps, bone clamp-wall snaps, and inertia direction!
  const boneById = new Map(spec.bones.map((b) => [b.boneId, b]))
  const bindingById = new Map(rig.bindings.map((b) => [b.layerId, b]))
  const isHeadOrHairLayer = (layerId) => {
    if (/hair|bang|sideburn|ahoge|strand|tail|ponytail|ribbon/i.test(layerId)) return true
    const b = bindingById.get(layerId)
    let cur = b?.boneId ?? b?.boneChain?.[0]
    while (cur) {
      if (/head|neck/i.test(cur)) return true
      cur = boneById.get(cur)?.parentBoneId ?? null
    }
    return false
  }

  function measureDeformBend(deformObj) {
    const out = new Map()
    if (!deformObj) return out
    for (const [layerId, fieldSpec] of Object.entries(deformObj)) {
      if (!isHeadOrHairLayer(layerId)) continue
      const fn = typeof fieldSpec === 'function' ? fieldSpec : fieldSpec?.field
      const rect = layerRectById.get(layerId)
      if (!fn || !rect || rect[3] < 120) continue
      const [rx, ry, rw, rh] = rect
      const [topDx] = fn(0.5, 0.05, rx + rw * 0.5, ry + rh * 0.05)
      const [botDx] = fn(0.5, 0.95, rx + rw * 0.5, ry + rh * 0.95)
      out.set(layerId, botDx - topDx)
    }
    return out
  }

  const boneHistory = new Map()
  const turnWindows = [
    { dir: 1, onsetMs: 0, sampleFrom: 50, sampleTo: 480, baseline: measureDeformBend(lastInput?.deform), peakLag: new Map(), peakLead: new Map() },
    { dir: -1, onsetMs: 1100, sampleFrom: 1150, sampleTo: 1580, baseline: null, peakLag: new Map(), peakLead: new Map() },
  ]

  const sweepFrames = Math.ceil(2600 / stepMs)
  for (let k = 1; k <= sweepFrames; k++) {
    tMs += stepMs
    const elapsed = k * stepMs
    // Capture pre-reversal baseline on the frame immediately BEFORE the reversal starts!
    if (elapsed >= 1100 && turnWindows[1].baseline === null) {
      turnWindows[1].baseline = measureDeformBend(lastInput?.deform)
    }
    const nx = elapsed < 1100 ? 0.9 : -0.9
    const ok = stepSafe(tMs, stepMs, { inside: true, nx, ny: 0, x: 0, y: 0, down: false }, defaultState)
    if (!ok || !lastPose) continue
    recordFrameSteps(turnMaxStepByLayer)

    // Track bone rotation plateau -> sudden jump (clamp-wall snap detector)
    for (const [boneId, tr] of Object.entries(lastInput?.bones ?? {})) {
      if (typeof tr?.rotation !== 'number') continue
      let h = boneHistory.get(boneId)
      if (!h) {
        h = { prev: tr.rotation, flatRun: 0, maxPostFlatJump: 0 }
        boneHistory.set(boneId, h)
      } else {
        const delta = Math.abs(tr.rotation - h.prev)
        if (delta < 0.005 && Math.abs(tr.rotation) > 0.5) {
          h.flatRun++
        } else {
          if (h.flatRun >= 5 && delta > h.maxPostFlatJump) h.maxPostFlatJump = delta
          h.flatRun = 0
        }
        h.prev = tr.rotation
      }
    }

    // Measure peak response delta relative to each turn's pre-onset baseline (eliminates reversal transient noise!)
    const bends = measureDeformBend(lastInput?.deform)
    for (const win of turnWindows) {
      if (!win.baseline) continue
      if (elapsed >= win.sampleFrom && elapsed <= win.sampleTo) {
        for (const [id, v] of bends) {
          const delta = v - (win.baseline.get(id) ?? 0)
          // True Newtonian inertia: turning right (dir=+1) -> delta < 0 (lag = -dir * delta > 0)
          const lag = -win.dir * delta
          const lead = win.dir * delta
          if (lag > (win.peakLag.get(id) ?? 0)) win.peakLag.set(id, lag)
          if (lead > (win.peakLead.get(id) ?? 0)) win.peakLead.set(id, lead)
        }
      }
    }
  }

  // Phase 3: Extreme corner stress check across all declared states
  const states = meta.states?.length ? meta.states : [defaultState]
  const corners = [[0, 0], [1, 0], [-1, 0], [0, -1], [0, 1], [1, -1], [-1, 1]]
  for (const st of states) {
    perf.setState?.(st)
    for (const [nx, ny] of corners) {
      for (let s = 0; s < 8; s++) {
        tMs += 30
        stepSafe(tMs, 30, { inside: true, nx, ny, x: 0, y: 0, down: false }, st)
      }
    }
  }

  const topSteps = (map, limit = 8) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([layerId, maxStepPx]) => ({ layerId, maxStepPx: round2(maxStepPx) }))

  const idleSnapAlerts = [...idleMaxStepByLayer.entries()]
    .filter(([, px]) => px > idleSnapThreshold)
    .map(([layerId, px]) => ({ layerId, maxStepPx: round2(px) }))

  const turnSnapAlerts = [...turnMaxStepByLayer.entries()]
    .filter(([, px]) => px > turnSnapThreshold)
    .map(([layerId, px]) => ({ layerId, maxStepPx: round2(px) }))

  const clampFreezeAlerts = [...boneHistory.entries()]
    .filter(([, h]) => h.maxPostFlatJump > 1.2)
    .map(([boneId, h]) => ({ boneId, postFlatJumpDeg: round2(h.maxPostFlatJump) }))

  const layerIdsChecked = new Set([
    ...turnWindows[0].peakLag.keys(),
    ...turnWindows[0].peakLead.keys(),
    ...turnWindows[1].peakLag.keys(),
    ...turnWindows[1].peakLead.keys(),
  ])
  const antiInertiaAlerts = []
  for (const layerId of layerIdsChecked) {
    const lag0 = turnWindows[0].peakLag.get(layerId) ?? 0
    const lead0 = turnWindows[0].peakLead.get(layerId) ?? 0
    const lag1 = turnWindows[1].peakLag.get(layerId) ?? 0
    const lead1 = turnWindows[1].peakLead.get(layerId) ?? 0
    const totalLag = lag0 + lag1
    const totalLead = lead0 + lead1
    if (totalLead > 10 && totalLead > totalLag * 1.6) {
      antiInertiaAlerts.push({
        layerId,
        peakLagPx: round2(Math.max(lag0, lag1)),
        peakLeadPx: round2(Math.max(lead0, lead1)),
        message: `${layerId} 转头响应期发梢顺着头部方向前冲（反惯性/钢板感），请检查 yawVel 惯性符号`,
      })
    }
  }

  const ok = geometryErrors.length === 0 && idleSnapAlerts.length === 0 && clampFreezeAlerts.length === 0

  return {
    ok,
    rigDir,
    script: scriptPath,
    statesTested: states,
    summary: {
      geometryErrors: geometryErrors.length,
      idleSnapAlerts: idleSnapAlerts.length,
      turnSnapAlerts: turnSnapAlerts.length,
      clampFreezeAlerts: clampFreezeAlerts.length,
      antiInertiaAlerts: antiInertiaAlerts.length,
    },
    idleTopSteps: topSteps(idleMaxStepByLayer, 6),
    turnTopSteps: topSteps(turnMaxStepByLayer, 6),
    ...(geometryErrors.length ? { geometryErrors: geometryErrors.slice(0, 10) } : {}),
    ...(idleSnapAlerts.length ? { idleSnapAlerts } : {}),
    ...(turnSnapAlerts.length ? { turnSnapAlerts } : {}),
    ...(clampFreezeAlerts.length ? { clampFreezeAlerts } : {}),
    ...(antiInertiaAlerts.length ? { antiInertiaAlerts } : {}),
  }
}
