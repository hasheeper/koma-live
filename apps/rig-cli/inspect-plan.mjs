import { resolveViewport } from '@koma-rig/rig-core'

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function assertNonEmptyString(v, field) {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 必须是非空字符串`)
  return v
}

function assertFiniteNumber(v, field) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${field} 必须是有限数值`)
  return v
}

function assertNonNegative(v, field) {
  assertFiniteNumber(v, field)
  if (v < 0) throw new Error(`${field} 不能小于 0`)
  return v
}

function assertPositive(v, field) {
  assertFiniteNumber(v, field)
  if (v <= 0) throw new Error(`${field} 必须大于 0`)
  return v
}

function normalizeChannel(v, field) {
  if (v === undefined) return undefined
  if (v !== 'rgba' && v !== 'alpha') throw new Error(`${field} 仅支持 'rgba' 或 'alpha'`)
  return v
}

function normalizeCrop(v, field) {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length !== 4) throw new Error(`${field} 必须为 [x, y, w, h]`)
  const [x, y, w, h] = v.map((n, i) => assertFiniteNumber(n, `${field}[${i}]`))
  if (w <= 0 || h <= 0) throw new Error(`${field} 宽高必须大于 0`)
  return [x, y, w, h]
}

function normalizeContainer(v, field) {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${field} 必须为 [width, height]`)
  const w = Math.round(assertPositive(v[0], `${field}[0]`))
  const h = Math.round(assertPositive(v[1], `${field}[1]`))
  return [w, h]
}

function normalizePointer(v, field) {
  if (!isPlainObject(v)) throw new Error(`${field} 必须是对象`)
  const out = {}
  if (v.x !== undefined) out.x = assertFiniteNumber(v.x, `${field}.x`)
  if (v.y !== undefined) out.y = assertFiniteNumber(v.y, `${field}.y`)
  if (v.nx !== undefined) out.nx = assertFiniteNumber(v.nx, `${field}.nx`)
  if (v.ny !== undefined) out.ny = assertFiniteNumber(v.ny, `${field}.ny`)
  if (v.inside !== undefined) {
    if (typeof v.inside !== 'boolean') throw new Error(`${field}.inside 必须是布尔值`)
    out.inside = v.inside
  }
  if (v.down !== undefined) {
    if (typeof v.down !== 'boolean') throw new Error(`${field}.down 必须是布尔值`)
    out.down = v.down
  }
  return out
}

function normalizeOverlays(v, field) {
  if (v === undefined) return undefined
  if (!isPlainObject(v)) throw new Error(`${field} 必须是对象`)
  const out = {}
  if (v.bones !== undefined) {
    if (typeof v.bones === 'boolean') out.bones = v.bones
    else if (Array.isArray(v.bones) && v.bones.every((s) => typeof s === 'string' && s.length > 0)) out.bones = [...v.bones]
    else throw new Error(`${field}.bones 必须是布尔值或骨骼 ID 数组`)
  }
  if (v.mesh !== undefined) {
    if (typeof v.mesh === 'boolean') out.mesh = v.mesh
    else if (Array.isArray(v.mesh) && v.mesh.every((s) => typeof s === 'string' && s.length > 0)) out.mesh = [...v.mesh]
    else throw new Error(`${field}.mesh 必须是布尔值或图层 ID 数组`)
  }
  if (v.bounds !== undefined) {
    if (typeof v.bounds !== 'boolean') throw new Error(`${field}.bounds 必须是布尔值`)
    out.bounds = v.bounds
  }
  if (v.errors !== undefined) {
    if (typeof v.errors !== 'boolean') throw new Error(`${field}.errors 必须是布尔值`)
    out.errors = v.errors
  }
  if (v.arcs !== undefined) {
    if (!Array.isArray(v.arcs)) throw new Error(`${field}.arcs 必须是数组`)
    out.arcs = v.arcs.map((item, i) => {
      if (typeof item === 'string') {
        const [target, point] = item.split('.')
        assertNonEmptyString(target, `${field}.arcs[${i}]`)
        if (point && !['start', 'end', 'pivot'].includes(point)) {
          throw new Error(`${field}.arcs[${i}] 锚点仅支持 start / end / pivot`)
        }
        return { target, point: point || 'start', dots: true }
      }
      if (!isPlainObject(item)) throw new Error(`${field}.arcs[${i}] 必须是字符串或对象`)
      const target = assertNonEmptyString(item.target, `${field}.arcs[${i}].target`)
      const point = item.point ?? 'start'
      if (!['start', 'end', 'pivot'].includes(point)) {
        throw new Error(`${field}.arcs[${i}].point 仅支持 start / end / pivot`)
      }
      return {
        target,
        point,
        color: item.color !== undefined ? assertNonEmptyString(item.color, `${field}.arcs[${i}].color`) : undefined,
        dots: item.dots ?? true,
      }
    })
  }
  if (v.guides !== undefined) {
    if (!Array.isArray(v.guides)) throw new Error(`${field}.guides 必须是数组`)
    out.guides = v.guides.map((g, i) => {
      if (!isPlainObject(g)) throw new Error(`${field}.guides[${i}] 必须是对象`)
      if (g.x === undefined && g.y === undefined) throw new Error(`${field}.guides[${i}] 至少需要 x 或 y`)
      return {
        x: g.x !== undefined ? assertFiniteNumber(g.x, `${field}.guides[${i}].x`) : undefined,
        y: g.y !== undefined ? assertFiniteNumber(g.y, `${field}.guides[${i}].y`) : undefined,
        label: g.label !== undefined ? String(g.label) : undefined,
        color: g.color !== undefined ? assertNonEmptyString(g.color, `${field}.guides[${i}].color`) : undefined,
      }
    })
  }
  return out
}

export function expandTimeRange(range, field = 'range') {
  if (!isPlainObject(range)) throw new Error(`${field} 必须是对象`)
  const from = assertNonNegative(range.from, `${field}.from`)
  const to = assertNonNegative(range.to, `${field}.to`)
  if (to < from) throw new Error(`${field}.to 不能小于 from`)
  if (range.count !== undefined && range.every !== undefined) {
    throw new Error(`${field} 不能同时指定 count 与 every`)
  }
  const roundMs = (n) => Number(n.toFixed(3))
  if (range.every !== undefined) {
    const every = assertPositive(range.every, `${field}.every`)
    const out = []
    for (let t = from; t <= to + 1e-9; t += every) out.push(roundMs(Math.min(to, t)))
    if (out.length === 0 || Math.abs(out.at(-1) - to) > 1e-6) out.push(roundMs(to))
    return [...new Set(out)]
  }
  const count = range.count !== undefined ? Math.round(assertPositive(range.count, `${field}.count`)) : 6
  if (count === 1 || from === to) return [roundMs(from)]
  const out = []
  for (let i = 0; i < count; i++) {
    out.push(roundMs(from + ((to - from) * i) / (count - 1)))
  }
  return [...new Set(out)]
}

function normalizeFrameEntry(entry, field) {
  if (typeof entry === 'number') {
    return { t: assertNonNegative(entry, field) }
  }
  if (!isPlainObject(entry)) throw new Error(`${field} 必须是时间戳或对象`)
  return {
    t: assertNonNegative(entry.t, `${field}.t`),
    label: entry.label !== undefined ? String(entry.label) : undefined,
    crop: normalizeCrop(entry.crop, `${field}.crop`),
    background: entry.background !== undefined ? assertNonEmptyString(entry.background, `${field}.background`) : undefined,
    channel: normalizeChannel(entry.channel, `${field}.channel`),
    overlays: normalizeOverlays(entry.overlays, `${field}.overlays`),
  }
}

function normalizePanel(panel, field) {
  if (!isPlainObject(panel)) throw new Error(`${field} 必须是对象`)
  const kind = panel.kind
  if (!['strip', 'grid', 'onion', 'frame', 'compare'].includes(kind)) {
    throw new Error(`${field}.kind 仅支持 strip / grid / onion / frame / compare`)
  }
  const base = {
    kind,
    caption: panel.caption !== undefined ? String(panel.caption) : undefined,
    background: panel.background !== undefined ? assertNonEmptyString(panel.background, `${field}.background`) : undefined,
    channel: normalizeChannel(panel.channel, `${field}.channel`) ?? 'rgba',
    crop: normalizeCrop(panel.crop, `${field}.crop`),
    showTime: panel.showTime ?? true,
    overlays: normalizeOverlays(panel.overlays, `${field}.overlays`),
  }

  if (kind === 'strip' || kind === 'grid') {
    let frames
    if (panel.frames !== undefined) {
      if (!Array.isArray(panel.frames) || panel.frames.length === 0) throw new Error(`${field}.frames 必须为非空数组`)
      frames = panel.frames.map((f, i) => normalizeFrameEntry(f, `${field}.frames[${i}]`))
    } else if (panel.times !== undefined) {
      if (!Array.isArray(panel.times) || panel.times.length === 0) throw new Error(`${field}.times 必须为非空数组`)
      frames = panel.times.map((t, i) => ({ t: assertNonNegative(t, `${field}.times[${i}]`) }))
    } else if (panel.range !== undefined) {
      frames = expandTimeRange(panel.range, `${field}.range`).map((t) => ({ t }))
    } else {
      throw new Error(`${field} 必须提供 frames、times 或 range`)
    }
    const columns =
      panel.columns !== undefined
        ? Math.max(1, Math.round(assertPositive(panel.columns, `${field}.columns`)))
        : kind === 'strip'
          ? frames.length
          : Math.min(3, frames.length)
    return { ...base, columns, frames }
  }

  if (kind === 'onion') {
    let times
    if (panel.times !== undefined) {
      if (!Array.isArray(panel.times) || panel.times.length === 0) throw new Error(`${field}.times 必须为非空数组`)
      times = [...new Set(panel.times.map((t, i) => assertNonNegative(t, `${field}.times[${i}]`)))].sort((a, b) => a - b)
    } else if (panel.range !== undefined) {
      times = expandTimeRange(panel.range, `${field}.range`)
    } else {
      throw new Error(`${field} 必须提供 times 或 range`)
    }
    let focus
    if (panel.focus === undefined) {
      focus = [times[Math.floor(times.length / 2)]]
    } else if (typeof panel.focus === 'number') {
      focus = [assertNonNegative(panel.focus, `${field}.focus`)]
    } else if (Array.isArray(panel.focus)) {
      focus = panel.focus.map((t, i) => assertNonNegative(t, `${field}.focus[${i}]`))
    } else {
      throw new Error(`${field}.focus 必须是时间戳或数组`)
    }
    for (const f of focus) {
      if (!times.includes(f)) times.push(f)
    }
    times.sort((a, b) => a - b)
    let tint = panel.tint ?? 'spine'
    if (typeof tint === 'string') {
      if (!['spine', 'mono', 'none'].includes(tint)) throw new Error(`${field}.tint 仅支持 spine / mono / none 或 { past, future }`)
    } else if (isPlainObject(tint)) {
      tint = {
        past: assertNonEmptyString(tint.past, `${field}.tint.past`),
        future: assertNonEmptyString(tint.future, `${field}.tint.future`),
      }
    } else {
      throw new Error(`${field}.tint 格式无效`)
    }
    let alpha = [0.16, 0.55]
    if (panel.alpha !== undefined) {
      if (!Array.isArray(panel.alpha) || panel.alpha.length !== 2) throw new Error(`${field}.alpha 必须为 [min, max]`)
      const a0 = assertFiniteNumber(panel.alpha[0], `${field}.alpha[0]`)
      const a1 = assertFiniteNumber(panel.alpha[1], `${field}.alpha[1]`)
      if (a0 < 0 || a0 > 1 || a1 < 0 || a1 > 1) throw new Error(`${field}.alpha 取值必须在 [0, 1]`)
      alpha = [a0, a1]
    }
    const stepOrder = panel.stepOrder ?? 'focus-on-top'
    if (stepOrder !== 'chronological' && stepOrder !== 'focus-on-top') {
      throw new Error(`${field}.stepOrder 仅支持 chronological 或 focus-on-top`)
    }
    return { ...base, times, focus, tint, alpha, stepOrder }
  }

  if (kind === 'frame') {
    const t = assertNonNegative(panel.t, `${field}.t`)
    const label = panel.label !== undefined ? String(panel.label) : undefined
    return { ...base, t, label }
  }

  // compare
  const mode = panel.mode ?? 'side-by-side'
  if (mode !== 'side-by-side' && mode !== 'overlay') {
    throw new Error(`${field}.mode 仅支持 side-by-side 或 overlay`)
  }
  if (!Array.isArray(panel.entries) || panel.entries.length < 2) {
    throw new Error(`${field}.entries 至少需要 2 项对比条目`)
  }
  const entries = panel.entries.map((e, i) => {
    const item = normalizeFrameEntry(e, `${field}.entries[${i}]`)
    const raw = isPlainObject(e) ? e : {}
    const container = normalizeContainer(raw.container, `${field}.entries[${i}].container`)
    const viewport = raw.viewport !== undefined ? resolveViewport(raw.viewport) : undefined
    return { ...item, container, viewport }
  })
  return { ...base, mode, entries }
}

function normalizeSection(section, field) {
  if (!isPlainObject(section)) throw new Error(`${field} 必须是对象`)
  if (!Array.isArray(section.panels) || section.panels.length === 0) {
    throw new Error(`${field}.panels 必须为非空数组`)
  }
  const panels = section.panels.map((p, i) => normalizePanel(p, `${field}.panels[${i}]`))
  let columns
  if (section.columns === undefined) {
    columns = Array.from({ length: panels.length }, () => 1)
  } else if (typeof section.columns === 'number') {
    const n = Math.max(1, Math.round(assertPositive(section.columns, `${field}.columns`)))
    columns = Array.from({ length: n }, () => 1)
  } else if (Array.isArray(section.columns) && section.columns.length > 0) {
    columns = section.columns.map((w, i) => assertPositive(w, `${field}.columns[${i}]`))
  } else {
    throw new Error(`${field}.columns 必须是正整数或正权重数组`)
  }
  const gap = section.gap !== undefined ? assertNonNegative(section.gap, `${field}.gap`) : 14
  return { columns, gap, panels }
}

function normalizeBoard(board, field) {
  if (!isPlainObject(board)) throw new Error(`${field} 必须是对象`)
  const file = assertNonEmptyString(board.file, `${field}.file`)
  if (!Array.isArray(board.sections) || board.sections.length === 0) {
    throw new Error(`${field}.sections 必须为非空数组`)
  }
  return {
    file,
    title: board.title !== undefined ? String(board.title) : undefined,
    background: board.background !== undefined ? assertNonEmptyString(board.background, `${field}.background`) : '#12141a',
    width: board.width !== undefined ? Math.round(assertPositive(board.width, `${field}.width`)) : 1440,
    padding: board.padding !== undefined ? assertNonNegative(board.padding, `${field}.padding`) : 20,
    gap: board.gap !== undefined ? assertNonNegative(board.gap, `${field}.gap`) : 16,
    sections: board.sections.map((s, i) => normalizeSection(s, `${field}.sections[${i}]`)),
  }
}

function normalizeTimeline(timeline) {
  if (timeline === undefined) return []
  if (!Array.isArray(timeline)) throw new Error('timeline 必须是数组')
  return timeline
    .map((ev, i) => {
      const field = `timeline[${i}]`
      if (!isPlainObject(ev)) throw new Error(`${field} 必须是对象`)
      const at = assertNonNegative(ev.at, `${field}.at`)
      const out = { at }
      if (ev.state !== undefined) out.state = assertNonEmptyString(ev.state, `${field}.state`)
      if (ev.trigger !== undefined) out.trigger = assertNonEmptyString(ev.trigger, `${field}.trigger`)
      if (ev.payload !== undefined) out.payload = ev.payload
      if (ev.reset !== undefined) {
        if (typeof ev.reset !== 'boolean') throw new Error(`${field}.reset 必须是布尔值`)
        out.reset = ev.reset
      }
      if (ev.pointer !== undefined) out.pointer = normalizePointer(ev.pointer, `${field}.pointer`)
      if (ev.pointerTrack !== undefined) {
        const to = assertNonNegative(ev.to, `${field}.to`)
        if (to < at) throw new Error(`${field}.to 不能小于 at`)
        if (!Array.isArray(ev.pointerTrack) || ev.pointerTrack.length < 2) {
          throw new Error(`${field}.pointerTrack 至少需要 2 个点`)
        }
        out.to = to
        out.pointerTrack = ev.pointerTrack.map((p, j) => normalizePointer(p, `${field}.pointerTrack[${j}]`))
      }
      if (ev.container !== undefined) out.container = normalizeContainer(ev.container, `${field}.container`)
      if (ev.viewport !== undefined) out.viewport = resolveViewport(ev.viewport)
      return out
    })
    .sort((a, b) => a.at - b.at)
}

/** Validate and normalize a koma-rig.inspect.v1 plan without adding dependencies to rig-core. */
export function validateInspectPlan(raw) {
  if (!isPlainObject(raw)) throw new Error('审片计划必须是 JSON 对象')
  if (raw.format !== 'koma-rig.inspect.v1') {
    throw new Error(`审片计划 format 必须为 'koma-rig.inspect.v1'`)
  }
  if (!isPlainObject(raw.source)) throw new Error('source 必须是对象')
  const source = {
    work: raw.source.work !== undefined ? assertNonEmptyString(raw.source.work, 'source.work') : undefined,
    rig: raw.source.rig !== undefined ? assertNonEmptyString(raw.source.rig, 'source.rig') : undefined,
    performance:
      raw.source.performance !== undefined ? assertNonEmptyString(raw.source.performance, 'source.performance') : undefined,
    poster: raw.source.poster !== undefined ? assertNonEmptyString(raw.source.poster, 'source.poster') : undefined,
    viewport: raw.source.viewport !== undefined ? resolveViewport(raw.source.viewport) : undefined,
  }
  if (!source.work && !source.rig) throw new Error('source 必须至少提供 work 或 rig')

  const stepMs = raw.stepMs !== undefined ? assertPositive(raw.stepMs, 'stepMs') : 10
  const maxDpr = raw.maxDpr !== undefined ? assertPositive(raw.maxDpr, 'maxDpr') : 2
  const outDir = raw.outDir !== undefined ? assertNonEmptyString(raw.outDir, 'outDir') : '.tmp/inspect-live'
  const exportTelemetry = raw.exportTelemetry ?? true
  const exportFrames = raw.exportFrames ?? false
  const timeline = normalizeTimeline(raw.timeline)
  const boards = raw.boards !== undefined ? raw.boards.map((b, i) => normalizeBoard(b, `boards[${i}]`)) : []
  const extraTimes =
    raw.extraTimes !== undefined
      ? [...new Set(raw.extraTimes.map((t, i) => assertNonNegative(t, `extraTimes[${i}]`)))].sort((a, b) => a - b)
      : []

  if (!boards.length && !exportTelemetry && !exportFrames) {
    throw new Error('审片计划至少需输出 boards、exportTelemetry 或 exportFrames 之一')
  }

  return {
    format: 'koma-rig.inspect.v1',
    source,
    stepMs,
    maxDpr,
    outDir,
    exportTelemetry,
    exportFrames,
    timeline,
    boards,
    extraTimes,
  }
}

export function viewportContextKey(container, viewport) {
  if (!container && !viewport) return 'logical'
  const vp = resolveViewport(viewport)
  const cw = container ? container[0] : 0
  const ch = container ? container[1] : 0
  return `viewport:${cw}x${ch}:${vp.fit}:${vp.anchor[0]},${vp.anchor[1]}:${vp.paddingPx}`
}

/**
 * Group all timestamps referenced across boards into minimal deterministic capture runs.
 * Logical canvas panels share a single pass; compare entries with distinct container/viewport
 * get isolated capture passes so the same timestamp t can be compared across sizes without clobbering.
 */
export function collectCaptureGroups(plan) {
  const groups = new Map()
  function ensureGroup(key, meta) {
    let g = groups.get(key)
    if (!g) {
      g = { key, ...meta, times: new Set() }
      groups.set(key, g)
    }
    return g
  }

  const logical = ensureGroup('logical', { kind: 'logical', container: null, viewport: plan.source.viewport ?? null })
  for (const t of plan.extraTimes ?? []) logical.times.add(t)

  for (const board of plan.boards) {
    for (const section of board.sections) {
      for (const panel of section.panels) {
        if (panel.kind === 'strip' || panel.kind === 'grid') {
          for (const f of panel.frames) logical.times.add(f.t)
        } else if (panel.kind === 'onion') {
          for (const t of panel.times) logical.times.add(t)
        } else if (panel.kind === 'frame') {
          logical.times.add(panel.t)
        } else if (panel.kind === 'compare') {
          for (const entry of panel.entries) {
            if (panel.mode === 'side-by-side' && (entry.container || entry.viewport)) {
              const vp = entry.viewport ?? plan.source.viewport ?? resolveViewport()
              const container = entry.container ?? [800, 600]
              const key = viewportContextKey(container, vp)
              const grp = ensureGroup(key, { kind: 'viewport', container, viewport: vp })
              grp.times.add(entry.t)
            } else {
              logical.times.add(entry.t)
            }
          }
        }
      }
    }
  }

  if (logical.times.size === 0 && plan.exportTelemetry) {
    logical.times.add(0)
  }

  return [...groups.values()]
    .filter((g) => g.times.size > 0)
    .map((g) => ({
      ...g,
      times: [...g.times].sort((a, b) => a - b),
    }))
}

function parseAtSpec(raw, defaultAt = 0) {
  const i = raw.lastIndexOf('@')
  if (i < 0) return { value: raw, at: defaultAt }
  const at = Number(raw.slice(i + 1))
  if (!Number.isFinite(at) || at < 0) throw new Error(`无效时间戳语法: ${raw}`)
  return { value: raw.slice(0, i), at }
}

function parseRangeSpec(raw) {
  const match = /^(\d+(?:\.\d+)?)\.\.(\d+(?:\.\d+)?)(?::(\d+))?$/.exec(raw)
  if (!match) throw new Error(`无效范围格式: ${raw}，期望 from..to[:count]，例如 120..620:8`)
  return {
    from: Number(match[1]),
    to: Number(match[2]),
    count: match[3] ? Number(match[3]) : 7,
  }
}

function parseGuideSpec(raw) {
  return raw
    .split(',')
    .filter(Boolean)
    .map((part) => {
      const m = /^([xy])=(-?\d+(?:\.\d+)?)(?::(.*))?$/i.exec(part.trim())
      if (!m) throw new Error(`无效参考线格式: ${part}，期望 y=867 或 x=285:center`)
      const axis = m[1].toLowerCase()
      return {
        [axis]: Number(m[2]),
        label: m[3] || `${axis}=${m[2]}`,
      }
    })
}

/**
 * Parse CLI arguments: returns either { mode: 'plan', planPath, outDirOverride }
 * or { mode: 'shortcut', plan } translated cleanly into koma-rig.inspect.v1.
 */
export function parseCliArgs(argv) {
  let planPath
  let work
  let rig
  let performance
  let poster
  let outDir
  let stepMs
  let maxDpr
  let width
  let background = 'dark'
  let channel = 'rgba'
  let crop
  let bones = false
  let mesh = false
  let exportFrames = false
  let exportTelemetry = true
  const timeline = []
  let times
  let onionRange
  let focus
  let arcs
  let guides

  const nextVal = (i, flag) => {
    if (i + 1 >= argv.length) throw new Error(`${flag} 缺少参数值`)
    return argv[i + 1]
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { mode: 'help' }
    else if (arg === '--plan') { planPath = nextVal(i++, arg) }
    else if (arg === '--work') { work = nextVal(i++, arg) }
    else if (arg === '--rig') { rig = nextVal(i++, arg) }
    else if (arg === '--script' || arg === '--performance') { performance = nextVal(i++, arg) }
    else if (arg === '--poster') { poster = nextVal(i++, arg) }
    else if (arg === '--out' || arg === '-o') { outDir = nextVal(i++, arg) }
    else if (arg === '--step') { stepMs = Number(nextVal(i++, arg)) }
    else if (arg === '--dpr') { maxDpr = Number(nextVal(i++, arg)) }
    else if (arg === '--width') { width = Number(nextVal(i++, arg)) }
    else if (arg === '--bg' || arg === '--background') { background = nextVal(i++, arg) }
    else if (arg === '--channel') { channel = nextVal(i++, arg) }
    else if (arg === '--bones') { bones = true }
    else if (arg === '--mesh') { mesh = true }
    else if (arg === '--frames') { exportFrames = true }
    else if (arg === '--no-telemetry') { exportTelemetry = false }
    else if (arg === '--state') {
      const { value, at } = parseAtSpec(nextVal(i++, arg), 0)
      timeline.push({ at, state: value })
    } else if (arg === '--trigger') {
      const { value, at } = parseAtSpec(nextVal(i++, arg), 0)
      timeline.push({ at, trigger: value })
    } else if (arg === '--pointer') {
      const { value, at } = parseAtSpec(nextVal(i++, arg), 0)
      const [px, py] = value.split(',').map(Number)
      if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error(`无效指针参数: ${value}`)
      const isNorm = Math.abs(px) <= 1 && Math.abs(py) <= 1
      timeline.push({ at, pointer: isNorm ? { nx: px, ny: py, inside: true } : { x: px, y: py, inside: true } })
    } else if (arg === '--times') {
      times = nextVal(i++, arg)
        .split(',')
        .filter(Boolean)
        .map((n) => Number(n.trim()))
    } else if (arg === '--onion') {
      onionRange = parseRangeSpec(nextVal(i++, arg))
    } else if (arg === '--focus') {
      focus = nextVal(i++, arg)
        .split(',')
        .filter(Boolean)
        .map((n) => Number(n.trim()))
    } else if (arg === '--arcs') {
      arcs = nextVal(i++, arg)
        .split(',')
        .filter(Boolean)
        .map((s) => s.trim())
    } else if (arg === '--guides') {
      guides = parseGuideSpec(nextVal(i++, arg))
    } else if (arg === '--crop') {
      crop = nextVal(i++, arg)
        .split(',')
        .map((n) => Number(n.trim()))
    } else if (!arg.startsWith('-') && !work) {
      work = arg
    } else {
      throw new Error(`未知参数: ${arg}`)
    }
  }

  if (planPath !== undefined) {
    return { mode: 'plan', planPath, outDirOverride: outDir }
  }

  const overlays = {
    ...(bones ? { bones: true } : {}),
    ...(mesh ? { mesh: true } : {}),
    ...(arcs ? { arcs } : {}),
    ...(guides ? { guides } : {}),
  }
  const hasOverlays = Object.keys(overlays).length > 0

  const sections = []
  const stripTimes = times ?? (onionRange ? undefined : [0, 200, 400, 600, 800, 1000])
  if (stripTimes) {
    sections.push({
      columns: 1,
      panels: [
        {
          kind: 'strip',
          caption: '关键帧序列',
          columns: Math.min(6, stripTimes.length),
          times: stripTimes,
          background,
          channel,
          ...(crop ? { crop } : {}),
          ...(hasOverlays ? { overlays } : {}),
        },
      ],
    })
  }
  if (onionRange) {
    sections.push({
      columns: 1,
      panels: [
        {
          kind: 'onion',
          caption: `洋葱皮叠影 (${onionRange.from}ms → ${onionRange.to}ms)`,
          range: onionRange,
          ...(focus ? { focus } : {}),
          background,
          channel,
          ...(crop ? { crop } : {}),
          ...(hasOverlays ? { overlays } : {}),
        },
      ],
    })
  }

  const plan = validateInspectPlan({
    format: 'koma-rig.inspect.v1',
    source: { work, rig, performance, poster },
    ...(stepMs !== undefined ? { stepMs } : {}),
    ...(maxDpr !== undefined ? { maxDpr } : {}),
    outDir: outDir ?? '.tmp/inspect-live',
    exportTelemetry,
    exportFrames,
    timeline,
    boards: [
      {
        file: 'review-board.png',
        title: 'Koma Live Visual Inspection',
        ...(width !== undefined ? { width } : {}),
        sections,
      },
    ],
  })

  return { mode: 'shortcut', plan }
}
