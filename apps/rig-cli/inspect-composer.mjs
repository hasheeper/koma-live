// Browser-side deterministic timeline sampler and flexible Canvas 2D board composer.
// Runs inside headless Chromium alongside packages/rig-renderer/dist/runtime/player.js.

const ARC_PALETTE = ['#fbbf24', '#fb7185', '#a78bfa', '#34d399', '#38bdf8', '#fb923c']

function round3(n) {
  return Number(n.toFixed(3))
}

function cloneCanvas(source) {
  const c = document.createElement('canvas')
  c.width = source.width
  c.height = source.height
  c.getContext('2d').drawImage(source, 0, 0)
  return c
}

function hasNonZeroAlpha(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) return true
  }
  return false
}

function toAlphaCanvas(source) {
  const c = document.createElement('canvas')
  c.width = source.width
  c.height = source.height
  const srcCtx = source.getContext('2d', { willReadFrequently: true })
  const dstCtx = c.getContext('2d')
  const img = srcCtx.getImageData(0, 0, source.width, source.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    d[i] = a
    d[i + 1] = a
    d[i + 2] = a
    d[i + 3] = 255
  }
  dstCtx.putImageData(img, 0, 0)
  return c
}

function toAlphaSilhouetteCanvas(source) {
  const c = document.createElement('canvas')
  c.width = source.width
  c.height = source.height
  const srcCtx = source.getContext('2d', { willReadFrequently: true })
  const dstCtx = c.getContext('2d')
  const img = srcCtx.getImageData(0, 0, source.width, source.height)
  const d = img.data
  for (let i = 0; i < d.length; i += 4) {
    d[i] = 255
    d[i + 1] = 255
    d[i + 2] = 255
  }
  dstCtx.putImageData(img, 0, 0)
  return c
}

function toTintedCanvas(source, color, mode) {
  const c = document.createElement('canvas')
  c.width = source.width
  c.height = source.height
  const ctx = c.getContext('2d')
  if (mode === 'mono') {
    const sCtx = source.getContext('2d', { willReadFrequently: true })
    const img = sCtx.getImageData(0, 0, source.width, source.height)
    const d = img.data
    for (let i = 0; i < d.length; i += 4) {
      const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2])
      d[i] = lum
      d[i + 1] = lum
      d[i + 2] = lum
    }
    ctx.putImageData(img, 0, 0)
    return c
  }
  ctx.drawImage(source, 0, 0)
  ctx.globalCompositeOperation = 'source-atop'
  ctx.fillStyle = color
  ctx.globalAlpha = 0.72
  ctx.fillRect(0, 0, c.width, c.height)
  ctx.globalCompositeOperation = 'source-over'
  ctx.globalAlpha = 1
  return c
}

function extractTelemetry(live, timeMs, errorsForStep) {
  const pose = live.puppet.pose
  const bones = {}
  for (const b of pose.bones ?? []) {
    const [a, m1, c, d] = b.matrix
    const rotationDeg = round3((Math.atan2(m1, a) * 180) / Math.PI)
    const sx = round3(Math.hypot(a, m1))
    const sy = round3(Math.hypot(c, d))
    bones[b.boneId] = {
      start: [round3(b.start[0]), round3(b.start[1])],
      end: [round3(b.end[0]), round3(b.end[1])],
      rotationDeg,
      effectiveScale: [sx, sy],
    }
  }
  const parts = {}
  for (const p of pose.parts ?? []) {
    parts[p.layerId] = {
      pivot: [round3(p.pivot[0]), round3(p.pivot[1])],
      visible: Boolean(p.visible),
    }
  }
  return {
    timeMs: round3(timeMs),
    state: live.state,
    pointer: {
      inside: live.pointer.inside,
      down: live.pointer.down,
      x: round3(live.pointer.x),
      y: round3(live.pointer.y),
      nx: round3(live.pointer.nx),
      ny: round3(live.pointer.ny),
    },
    bones,
    parts,
    errors: errorsForStep.map((e) => ({
      name: e.name,
      message: e.message,
      ...(e.polygons?.length ? { polygons: e.polygons } : {}),
    })),
  }
}

function interpolateTrack(trackEvent, t) {
  const pts = trackEvent.pointerTrack
  const span = trackEvent.to - trackEvent.at
  const u = span <= 0 ? 1 : Math.max(0, Math.min(1, (t - trackEvent.at) / span))
  const scaled = u * (pts.length - 1)
  const idx = Math.min(pts.length - 2, Math.floor(scaled))
  const frac = scaled - idx
  const a = pts[idx]
  const b = pts[idx + 1]
  const out = {}
  if (a.x !== undefined || b.x !== undefined) {
    out.x = (a.x ?? 0) + ((b.x ?? a.x ?? 0) - (a.x ?? 0)) * frac
    out.y = (a.y ?? 0) + ((b.y ?? a.y ?? 0) - (a.y ?? 0)) * frac
  } else {
    out.nx = (a.nx ?? 0) + ((b.nx ?? a.nx ?? 0) - (a.nx ?? 0)) * frac
    out.ny = (a.ny ?? 0) + ((b.ny ?? a.ny ?? 0) - (a.ny ?? 0)) * frac
  }
  if (a.inside !== undefined || b.inside !== undefined) out.inside = frac < 1 ? (a.inside ?? true) : (b.inside ?? true)
  if (a.down !== undefined || b.down !== undefined) out.down = frac < 1 ? Boolean(a.down) : Boolean(b.down)
  return out
}

function findActiveTrack(tracks, t) {
  for (let i = tracks.length - 1; i >= 0; i--) {
    const tr = tracks[i]
    if (t >= tr.at && t <= tr.to) return tr
  }
  return null
}

/**
 * Synchronously composite back -> puppet -> front in the exact same JS turn
 * immediately after setPose/render so WebGL preserveDrawingBuffer:false never drops frames.
 */
function captureSyncCanvas(live, group) {
  live.puppet.render()
  const stack = live.stackElement
  const canvases = [...stack.querySelectorAll('canvas')]
  const size = live.puppet.spec.canvas

  if (group.kind === 'viewport') {
    const [cw, ch] = group.container
    const layout = live.getLayout()
    const out = document.createElement('canvas')
    out.width = cw
    out.height = ch
    const ctx = out.getContext('2d')
    ctx.clearRect(0, 0, cw, ch)
    for (const c of canvases) {
      if (c.style.display === 'none' || c.width === 0 || c.height === 0) continue
      ctx.drawImage(c, 0, 0, c.width, c.height, layout.offsetX, layout.offsetY, layout.width, layout.height)
    }
    return { canvas: out, layout }
  }

  const out = document.createElement('canvas')
  out.width = size.width
  out.height = size.height
  const ctx = out.getContext('2d')
  ctx.clearRect(0, 0, size.width, size.height)
  for (const c of canvases) {
    if (c.style.display === 'none' || c.width === 0 || c.height === 0) continue
    ctx.drawImage(c, 0, 0, c.width, c.height, 0, 0, size.width, size.height)
  }
  return { canvas: out, layout: null }
}

async function runCaptureGroup(mountPerformance, host, sourceOpts, plan, group) {
  const defaultW = group.kind === 'viewport' ? group.container[0] : 800
  const defaultH = group.kind === 'viewport' ? group.container[1] : 600
  host.style.width = `${defaultW}px`
  host.style.height = `${defaultH}px`

  let stepErrors = []
  const live = await mountPerformance(host, {
    ...sourceOpts,
    ...(group.viewport ? { viewport: group.viewport } : {}),
    autoplay: false,
    stepMs: plan.stepMs,
    maxDpr: plan.maxDpr,
    validateGeometry: true,
    errorPolicy: 'throttle',
    errorThrottleMs: 0,
    onError(err) {
      stepErrors.push({
        name: err instanceof Error ? err.name : 'Error',
        message: err instanceof Error ? err.message : String(err),
        polygons: err?.polygons,
      })
    },
  })

  try {
    const tracks = plan.timeline.filter((e) => e.pointerTrack)
    const discreteEvents = plan.timeline.filter((e) => !e.pointerTrack)

    const targetSet = new Set(group.times)
    const milestoneSet = new Set(group.times)
    for (const ev of discreteEvents) milestoneSet.add(ev.at)
    for (const tr of tracks) {
      milestoneSet.add(tr.at)
      milestoneSet.add(tr.to)
    }
    const maxTarget = group.times.length ? Math.max(...group.times) : 0
    const milestones = [...milestoneSet].filter((t) => t <= maxTarget + 1e-9).sort((a, b) => a - b)

    let cursor = 0
    let eventIdx = 0
    const frames = new Map()
    const canvasSize = { ...live.puppet.spec.canvas }

    const applyEventsAt = (t) => {
      let dirty = false
      while (eventIdx < discreteEvents.length && discreteEvents[eventIdx].at <= t + 1e-9) {
        const ev = discreteEvents[eventIdx++]
        if (ev.reset) {
          live.reset()
          dirty = false
        }
        if (ev.container && group.kind === 'logical') {
          host.style.width = `${ev.container[0]}px`
          host.style.height = `${ev.container[1]}px`
          live.setViewport(ev.viewport ?? group.viewport ?? undefined)
          dirty = true
        } else if (ev.viewport && group.kind === 'logical') {
          live.setViewport(ev.viewport)
          dirty = true
        }
        if (ev.pointer !== undefined) {
          live.setPointer(ev.pointer)
          dirty = true
        }
        if (ev.state !== undefined) {
          live.setState(ev.state)
          dirty = false
        }
        if (ev.trigger !== undefined) {
          live.trigger(ev.trigger, ev.payload)
          dirty = false
        }
      }
      const activeTrack = findActiveTrack(tracks, t)
      if (activeTrack) {
        live.setPointer(interpolateTrack(activeTrack, t))
        dirty = true
      }
      return dirty
    }

    const advanceWithTracks = (fromT, toT) => {
      const delta = toT - fromT
      if (delta <= 1e-9) return
      const hasTrack = tracks.some((tr) => tr.at < toT && tr.to > fromT)
      if (!hasTrack) {
        live.advanceBy(delta)
        return
      }
      let cur = fromT
      while (cur < toT - 1e-9) {
        const sub = Math.min(plan.stepMs, toT - cur)
        const nextT = cur + sub
        const tr = findActiveTrack(tracks, nextT)
        if (tr) live.setPointer(interpolateTrack(tr, nextT))
        live.advanceBy(sub)
        cur = nextT
      }
    }

    for (const targetT of milestones) {
      stepErrors = []
      if (targetT > cursor + 1e-9) {
        advanceWithTracks(cursor, targetT)
        cursor = targetT
      }
      const needsRender = applyEventsAt(targetT)
      if (needsRender) {
        live.advanceBy(0)
      }
      if (targetSet.has(targetT)) {
        const { canvas, layout } = captureSyncCanvas(live, group)
        const poseSnapshot = structuredClone(live.puppet.pose)
        const telemetry = extractTelemetry(live, targetT, stepErrors)
        frames.set(targetT, {
          timeMs: targetT,
          canvas,
          nonEmpty: hasNonZeroAlpha(canvas),
          pose: poseSnapshot,
          telemetry,
          layout,
          errors: stepErrors.slice(),
        })
      }
    }

    return { key: group.key, kind: group.kind, container: group.container, canvasSize, frames }
  } finally {
    live.destroy()
  }
}

// ── Board 2D Composition ──

function fillBackground(ctx, x, y, w, h, bg, channel) {
  const effective = bg ?? (channel === 'alpha' ? '#000000' : 'dark')
  if (effective === 'checker') {
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, y, w, h)
    ctx.clip()
    const cell = 12
    ctx.fillStyle = '#242730'
    ctx.fillRect(x, y, w, h)
    ctx.fillStyle = '#313543'
    for (let gy = Math.floor(y); gy < y + h; gy += cell) {
      for (let gx = Math.floor(x); gx < x + w; gx += cell) {
        if ((Math.floor((gx - x) / cell) + Math.floor((gy - y) / cell)) % 2 === 0) {
          ctx.fillRect(gx, gy, cell, cell)
        }
      }
    }
    ctx.restore()
    return
  }
  ctx.fillStyle = effective === 'dark' ? '#171920' : effective === 'light' ? '#e7ebf2' : effective
  ctx.fillRect(x, y, w, h)
}

function drawRoundedRectPath(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}

function drawBadge(ctx, x, y, text, tone = 'neutral') {
  if (!text) return
  ctx.save()
  ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  const padX = 7
  const tw = ctx.measureText(text).width
  const bw = tw + padX * 2
  const bh = 20
  ctx.fillStyle = tone === 'error' ? 'rgba(185, 28, 28, 0.92)' : 'rgba(12, 14, 20, 0.78)'
  drawRoundedRectPath(ctx, x, y, bw, bh, 5)
  ctx.fill()
  ctx.strokeStyle = tone === 'error' ? 'rgba(248, 113, 113, 0.9)' : 'rgba(255, 255, 255, 0.14)'
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.fillStyle = '#f8fafc'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + padX, y + bh / 2 + 0.5)
  ctx.restore()
}

function fitRect(boxX, boxY, boxW, boxH, srcW, srcH, pad = 6) {
  const aw = Math.max(1, boxW - pad * 2)
  const ah = Math.max(1, boxH - pad * 2)
  const s = Math.min(aw / srcW, ah / srcH)
  const dw = srcW * s
  const dh = srcH * s
  return {
    dx: boxX + (boxW - dw) / 2,
    dy: boxY + (boxH - dh) / 2,
    dw,
    dh,
    scale: s,
  }
}

function drawGuideLabel(ctx, x, y, text, color) {
  ctx.save()
  ctx.setLineDash([])
  ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  const tw = ctx.measureText(text).width
  const bw = tw + 8
  const bh = 14
  ctx.fillStyle = 'rgba(12, 14, 20, 0.78)'
  drawRoundedRectPath(ctx, x, y, bw, bh, 3)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.lineWidth = 0.75
  ctx.stroke()
  ctx.fillStyle = color
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + 4, y + bh / 2 + 0.5)
  ctx.restore()
}

function drawArcLegend(ctx, items, clipRect) {
  if (!items.length || !clipRect || clipRect.w < 180) return
  ctx.save()
  ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
  const padX = 7
  const itemGap = 10
  const dotR = 3
  const dotTextGap = 5
  const widths = items.map((it) => dotR * 2 + dotTextGap + ctx.measureText(it.label).width)
  const totalW = padX * 2 + widths.reduce((s, w) => s + w, 0) + itemGap * Math.max(0, items.length - 1)
  if (totalW > clipRect.w - 16) {
    ctx.restore()
    return
  }
  const bh = 18
  const bx = clipRect.x + clipRect.w - totalW - 8
  const by = clipRect.y + clipRect.h - bh - 8
  ctx.fillStyle = 'rgba(12, 14, 20, 0.8)'
  drawRoundedRectPath(ctx, bx, by, totalW, bh, 5)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.lineWidth = 1
  ctx.stroke()

  let cx = bx + padX
  const cy = by + bh / 2
  ctx.textBaseline = 'middle'
  items.forEach((it, idx) => {
    ctx.fillStyle = it.color
    ctx.beginPath()
    ctx.arc(cx + dotR, cy, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f1f5f9'
    ctx.fillText(it.label, cx + dotR * 2 + dotTextGap, cy + 0.5)
    cx += widths[idx] + itemGap
  })
  ctx.restore()
}

function drawSwatchBadge(ctx, x, y, items) {
  if (!items.length) return
  ctx.save()
  ctx.font = '500 11px ui-monospace, SFMono-Regular, Menlo, monospace'
  const padX = 8
  const sep = ' vs '
  const sepW = ctx.measureText(sep).width
  const dotR = 3.5
  const dotGap = 5
  const itemWidths = items.map((it) => dotR * 2 + dotGap + ctx.measureText(it.label).width)
  const bw = padX * 2 + itemWidths.reduce((s, w) => s + w, 0) + sepW * Math.max(0, items.length - 1)
  const bh = 20
  ctx.fillStyle = 'rgba(12, 14, 20, 0.82)'
  drawRoundedRectPath(ctx, x, y, bw, bh, 5)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)'
  ctx.lineWidth = 1
  ctx.stroke()
  let cx = x + padX
  const cy = y + bh / 2
  ctx.textBaseline = 'middle'
  items.forEach((it, idx) => {
    if (idx > 0) {
      ctx.fillStyle = '#94a3b8'
      ctx.fillText(sep, cx, cy + 0.5)
      cx += sepW
    }
    ctx.fillStyle = it.color
    ctx.beginPath()
    ctx.arc(cx + dotR, cy, dotR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#f8fafc'
    ctx.fillText(it.label, cx + dotR * 2 + dotGap, cy + 0.5)
    cx += itemWidths[idx]
  })
  ctx.restore()
}

function drawOverlays(ctx, mapper, overlays, sample, allSamples, canvasSize, clipRect) {
  if (!overlays && !sample?.errors?.length) return
  const ov = overlays ?? {}
  ctx.save()

  if (ov.bounds) {
    const a = mapper(0, 0)
    const b = mapper(canvasSize.width, canvasSize.height)
    ctx.strokeStyle = 'rgba(61, 242, 255, 0.45)'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.strokeRect(a[0] + 0.5, a[1] + 0.5, b[0] - a[0], b[1] - a[1])
    ctx.setLineDash([])
  }

  // Reference guides (ground line, center axis, etc.) — crop-safe backed labels for both X & Y
  for (const g of ov.guides ?? []) {
    const strokeColor = g.color ?? 'rgba(239, 68, 68, 0.85)'
    const labelColor = g.color ?? '#f87171'
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 1.25
    ctx.setLineDash([5, 4])
    ctx.beginPath()
    if (g.y !== undefined) {
      const p0 = mapper(0, g.y)
      const p1 = mapper(canvasSize.width, g.y)
      ctx.moveTo(p0[0], p0[1])
      ctx.lineTo(p1[0], p1[1])
      ctx.stroke()
      if (g.label) {
        ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
        const tw = ctx.measureText(g.label).width
        const minX = clipRect ? clipRect.x + 6 : p0[0] + 4
        const maxX = clipRect ? Math.max(minX, clipRect.x + clipRect.w - tw - 14) : p0[0] + 4
        const lx = Math.max(minX, Math.min(maxX, p0[0] + 4))
        const preferredY = p0[1] - 16
        const minY = clipRect ? clipRect.y + 32 : preferredY
        const maxY = clipRect ? clipRect.y + clipRect.h - 18 : preferredY
        const ly = preferredY < minY ? Math.min(maxY, p0[1] + 4) : Math.min(maxY, preferredY)
        drawGuideLabel(ctx, lx, ly, g.label, labelColor)
      }
    }
    if (g.x !== undefined) {
      const p0 = mapper(g.x, 0)
      const p1 = mapper(g.x, canvasSize.height)
      ctx.moveTo(p0[0], p0[1])
      ctx.lineTo(p1[0], p1[1])
      ctx.stroke()
      if (g.label) {
        ctx.font = '500 10px ui-monospace, SFMono-Regular, Menlo, monospace'
        const tw = ctx.measureText(g.label).width
        const bw = tw + 8
        const minX = clipRect ? clipRect.x + 6 : p0[0] + 5
        const maxX = clipRect ? Math.max(minX, clipRect.x + clipRect.w - bw - 6) : p0[0] + 5
        const rawX = clipRect && p0[0] + 5 + bw > clipRect.x + clipRect.w - 6 ? p0[0] - bw - 5 : p0[0] + 5
        const lx = Math.max(minX, Math.min(maxX, rawX))
        const ly = clipRect ? clipRect.y + clipRect.h - 22 : p0[1] + 4
        drawGuideLabel(ctx, lx, ly, g.label, labelColor)
      }
    }
    ctx.setLineDash([])
  }

  // Skinned mesh wireframes
  if (ov.mesh && sample?.pose?.parts) {
    const filter = Array.isArray(ov.mesh) ? new Set(ov.mesh) : null
    ctx.strokeStyle = 'rgba(61, 242, 255, 0.32)'
    ctx.lineWidth = 1
    for (const part of sample.pose.parts) {
      if (!part.visible || !part.geometry) continue
      if (filter && !filter.has(part.layerId)) continue
      const { vertices, indices } = part.geometry
      const m = part.matrix
      ctx.beginPath()
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i] * 2
        const b = indices[i + 1] * 2
        const c = indices[i + 2] * 2
        const pa = mapper(m[0] * vertices[a] + m[2] * vertices[a + 1] + m[4], m[1] * vertices[a] + m[3] * vertices[a + 1] + m[5])
        const pb = mapper(m[0] * vertices[b] + m[2] * vertices[b + 1] + m[4], m[1] * vertices[b] + m[3] * vertices[b + 1] + m[5])
        const pc = mapper(m[0] * vertices[c] + m[2] * vertices[c + 1] + m[4], m[1] * vertices[c] + m[3] * vertices[c + 1] + m[5])
        ctx.moveTo(pa[0], pa[1])
        ctx.lineTo(pb[0], pb[1])
        ctx.lineTo(pc[0], pc[1])
        ctx.closePath()
      }
      ctx.stroke()
    }
  }

  // Bones
  if (ov.bones && sample?.pose?.bones) {
    const filter = Array.isArray(ov.bones) ? new Set(ov.bones) : null
    for (const bone of sample.pose.bones) {
      if (filter && !filter.has(bone.boneId)) continue
      const a = mapper(bone.start[0], bone.start[1])
      const b = mapper(bone.end[0], bone.end[1])
      ctx.strokeStyle = 'rgba(61, 242, 255, 0.9)'
      ctx.lineWidth = 1.6
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
      ctx.fillStyle = '#0e1117'
      ctx.beginPath()
      ctx.arc(a[0], a[1], 3.2, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
  }

  // Motion arcs with start/end direction markers, spacing dots & compact legend
  if (ov.arcs?.length && allSamples?.length) {
    const legendItems = []
    ov.arcs.forEach((arc, arcIdx) => {
      const color = arc.color ?? ARC_PALETTE[arcIdx % ARC_PALETTE.length]
      const pts = []
      for (const s of allSamples) {
        if (arc.point === 'pivot') {
          const part = s.telemetry.parts[arc.target]
          if (part) pts.push(mapper(part.pivot[0], part.pivot[1]))
        } else {
          const bone = s.telemetry.bones[arc.target]
          if (bone) {
            const p = arc.point === 'end' ? bone.end : bone.start
            pts.push(mapper(p[0], p[1]))
          }
        }
      }
      if (!pts.length) return
      legendItems.push({ label: `${arc.target}.${arc.point}`, color })
      if (pts.length > 1) {
        ctx.strokeStyle = color
        ctx.lineWidth = 1.8
        ctx.beginPath()
        ctx.moveTo(pts[0][0], pts[0][1])
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1])
        ctx.stroke()
      }
      if (arc.dots !== false) {
        for (let i = 0; i < pts.length; i++) {
          const [px, py] = pts[i]
          if (i === 0) {
            ctx.fillStyle = '#0e1117'
            ctx.strokeStyle = color
            ctx.lineWidth = 2
            ctx.beginPath()
            ctx.arc(px, py, 3.6, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
          } else if (i === pts.length - 1) {
            ctx.fillStyle = color
            ctx.strokeStyle = '#f8fafc'
            ctx.lineWidth = 1.25
            ctx.beginPath()
            ctx.arc(px, py, 3.8, 0, Math.PI * 2)
            ctx.fill()
            ctx.stroke()
          } else {
            ctx.fillStyle = color
            ctx.beginPath()
            ctx.arc(px, py, 2.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      }
    })
    if (allSamples.length >= 2) drawArcLegend(ctx, legendItems, clipRect)
  }

  // GeometryError offending polygons
  if (ov.errors !== false && sample?.errors?.length) {
    ctx.fillStyle = 'rgba(239, 68, 68, 0.38)'
    ctx.strokeStyle = 'rgba(248, 113, 113, 0.98)'
    ctx.lineWidth = 1.8
    for (const err of sample.errors) {
      for (const poly of err.polygons ?? []) {
        if (poly.length < 3) continue
        const p0 = mapper(poly[0][0], poly[0][1])
        ctx.beginPath()
        ctx.moveTo(p0[0], p0[1])
        for (let i = 1; i < poly.length; i++) {
          const pi = mapper(poly[i][0], poly[i][1])
          ctx.lineTo(pi[0], pi[1])
        }
        ctx.closePath()
        ctx.fill()
        ctx.stroke()
      }
    }
  }

  ctx.restore()
}

function drawLogicalCell(ctx, x, y, w, h, sample, opts, canvasSize, allSamples) {
  const channel = opts.channel ?? 'rgba'
  fillBackground(ctx, x, y, w, h, opts.background, channel)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  const crop = opts.crop ?? [0, 0, canvasSize.width, canvasSize.height]
  const [sx, sy, sw, sh] = crop
  const fit = fitRect(x, y, w, h, sw, sh, 4)
  const srcCanvas = channel === 'alpha' ? toAlphaCanvas(sample.canvas) : sample.canvas
  ctx.drawImage(srcCanvas, sx, sy, sw, sh, fit.dx, fit.dy, fit.dw, fit.dh)

  const mapper = (lx, ly) => [fit.dx + (lx - sx) * fit.scale, fit.dy + (ly - sy) * fit.scale]
  drawOverlays(ctx, mapper, opts.overlays, sample, allSamples ?? [sample], canvasSize, { x, y, w, h })
  ctx.restore()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  const timeTag = opts.showTime !== false ? `${Math.round(sample.timeMs)}ms` : ''
  const label = [timeTag, opts.label].filter(Boolean).join(' · ')
  if (label) drawBadge(ctx, x + 8, y + 8, label)
  if (sample.errors?.length) drawBadge(ctx, x + 8, y + h - 28, sample.errors[0].message, 'error')
}

function drawViewportCell(ctx, x, y, w, h, sample, opts, canvasSize) {
  const channel = opts.channel ?? 'rgba'
  fillBackground(ctx, x, y, w, h, opts.background ?? '#0f1117', channel)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  const containerW = sample.canvas.width
  const containerH = sample.canvas.height
  const fit = fitRect(x, y, w, h, containerW, containerH, 12)

  // Draw explicit simulated host container box frame
  ctx.fillStyle = channel === 'alpha' ? '#000000' : 'rgba(255, 255, 255, 0.03)'
  ctx.fillRect(fit.dx, fit.dy, fit.dw, fit.dh)
  const srcCanvas = channel === 'alpha' ? toAlphaCanvas(sample.canvas) : sample.canvas
  ctx.drawImage(srcCanvas, 0, 0, containerW, containerH, fit.dx, fit.dy, fit.dw, fit.dh)

  ctx.strokeStyle = 'rgba(148, 163, 184, 0.55)'
  ctx.lineWidth = 1.25
  ctx.strokeRect(fit.dx + 0.5, fit.dy + 0.5, fit.dw - 1, fit.dh - 1)

  if (sample.layout) {
    const mapper = (lx, ly) => [
      fit.dx + (sample.layout.offsetX + lx * sample.layout.scale) * fit.scale,
      fit.dy + (sample.layout.offsetY + ly * sample.layout.scale) * fit.scale,
    ]
    drawOverlays(ctx, mapper, opts.overlays, sample, [sample], canvasSize, { x, y, w, h })
  }
  ctx.restore()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  const sizeTag = `${containerW}×${containerH}`
  const timeTag = opts.showTime !== false ? `${Math.round(sample.timeMs)}ms` : ''
  const label = [opts.label, sizeTag, timeTag].filter(Boolean).join(' · ')
  drawBadge(ctx, x + 8, y + 8, label)
  if (sample.errors?.length) drawBadge(ctx, x + 8, y + h - 28, sample.errors[0].message, 'error')
}

function drawOnionPanel(ctx, x, y, w, h, panel, logicalGroup, canvasSize) {
  const channel = panel.channel ?? 'rgba'
  fillBackground(ctx, x, y, w, h, panel.background, channel)
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()

  const crop = panel.crop ?? [0, 0, canvasSize.width, canvasSize.height]
  const [sx, sy, sw, sh] = crop
  const fit = fitRect(x, y, w, h, sw, sh, 8)
  const focusSet = new Set(panel.focus)
  const samples = panel.times.map((t) => logicalGroup.frames.get(t)).filter(Boolean)
  const focusAnchor = panel.focus[Math.floor(panel.focus.length / 2)] ?? panel.times[Math.floor(panel.times.length / 2)]
  const [minA, maxA] = panel.alpha

  const pastColor = typeof panel.tint === 'object' ? panel.tint.past : '#38bdf8'
  const futureColor = typeof panel.tint === 'object' ? panel.tint.future : '#34d399'

  const drawOrder =
    panel.stepOrder === 'chronological'
      ? samples
      : [...samples.filter((s) => !focusSet.has(s.timeMs)), ...samples.filter((s) => focusSet.has(s.timeMs))]

  const maxSpan = Math.max(1, ...samples.map((s) => Math.abs(s.timeMs - focusAnchor)))

  for (const sample of drawOrder) {
    const isFocus = focusSet.has(sample.timeMs)
    let src = channel === 'alpha' ? toAlphaSilhouetteCanvas(sample.canvas) : sample.canvas
    if (!isFocus) {
      const dist = Math.abs(sample.timeMs - focusAnchor) / maxSpan
      const opacity = minA + (maxA - minA) * (1 - dist)
      if (panel.tint === 'spine' || typeof panel.tint === 'object') {
        const tintColor = sample.timeMs < focusAnchor ? pastColor : futureColor
        src = toTintedCanvas(src, tintColor, 'tint')
      } else if (panel.tint === 'mono') {
        src = toTintedCanvas(src, '', 'mono')
      }
      ctx.globalAlpha = opacity
    } else {
      ctx.globalAlpha = 1
    }
    ctx.drawImage(src, sx, sy, sw, sh, fit.dx, fit.dy, fit.dw, fit.dh)
  }
  ctx.globalAlpha = 1

  const focusSample = logicalGroup.frames.get(focusAnchor) ?? samples.at(-1)
  const mapper = (lx, ly) => [fit.dx + (lx - sx) * fit.scale, fit.dy + (ly - sy) * fit.scale]
  drawOverlays(ctx, mapper, panel.overlays, focusSample, samples, canvasSize, { x, y, w, h })
  ctx.restore()

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)

  if (panel.showTime !== false && samples.length) {
    const summary = `${Math.round(samples[0].timeMs)}→${Math.round(samples.at(-1).timeMs)}ms · ${samples.length}f`
    drawBadge(ctx, x + 8, y + 8, summary)
  }
}

function estimatePanelBodyHeight(panel, panelWidth, canvasSize) {
  const aspect = (crop) => {
    const sw = crop ? crop[2] : canvasSize.width
    const sh = crop ? crop[3] : canvasSize.height
    return sh / Math.max(1, sw)
  }
  if (panel.kind === 'strip' || panel.kind === 'grid') {
    const cols = Math.max(1, panel.columns)
    const rows = Math.ceil(panel.frames.length / cols)
    const gap = 8
    const cellW = Math.max(60, (panelWidth - gap * (cols - 1)) / cols)
    const cellH = Math.max(110, Math.min(340, Math.round(cellW * aspect(panel.crop))))
    return rows * cellH + gap * Math.max(0, rows - 1)
  }
  if (panel.kind === 'compare') {
    if (panel.mode === 'overlay') {
      return Math.max(220, Math.min(480, Math.round(panelWidth * aspect(panel.crop))))
    }
    const cols = panel.entries.length
    const gap = 8
    const cellW = Math.max(80, (panelWidth - gap * (cols - 1)) / cols)
    const first = panel.entries[0]
    const ratio = first?.container ? first.container[1] / first.container[0] : aspect(panel.crop)
    return Math.max(180, Math.min(440, Math.round(cellW * ratio)))
  }
  return Math.max(220, Math.min(520, Math.round(panelWidth * aspect(panel.crop))))
}

function renderPanel(ctx, x, y, w, h, panel, groupMap, plan, canvasSize, viewportContextKeyFn) {
  const headerH = panel.caption ? 26 : 0
  if (panel.caption) {
    ctx.save()
    ctx.font = '600 12px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    ctx.fillStyle = '#e2e8f0'
    ctx.textBaseline = 'middle'
    ctx.fillText(panel.caption, x + 2, y + headerH / 2)
    ctx.restore()
  }
  const by = y + headerH
  const bh = Math.max(40, h - headerH)
  const logicalGroup = groupMap.get('logical')

  if (panel.kind === 'strip' || panel.kind === 'grid') {
    const cols = Math.max(1, panel.columns)
    const rows = Math.ceil(panel.frames.length / cols)
    const gap = 8
    const cellW = (w - gap * (cols - 1)) / cols
    const cellH = (bh - gap * Math.max(0, rows - 1)) / rows
    const allSamples = panel.frames.map((f) => logicalGroup.frames.get(f.t)).filter(Boolean)
    panel.frames.forEach((entry, idx) => {
      const col = idx % cols
      const row = Math.floor(idx / cols)
      const sample = logicalGroup.frames.get(entry.t)
      if (!sample) return
      drawLogicalCell(
        ctx,
        x + col * (cellW + gap),
        by + row * (cellH + gap),
        cellW,
        cellH,
        sample,
        {
          label: entry.label,
          crop: entry.crop ?? panel.crop,
          background: entry.background ?? panel.background,
          channel: entry.channel ?? panel.channel,
          showTime: panel.showTime,
          overlays: entry.overlays ?? panel.overlays,
        },
        canvasSize,
        allSamples,
      )
    })
    return
  }

  if (panel.kind === 'onion') {
    drawOnionPanel(ctx, x, by, w, bh, panel, logicalGroup, canvasSize)
    return
  }

  if (panel.kind === 'frame') {
    const sample = logicalGroup.frames.get(panel.t)
    if (!sample) return
    drawLogicalCell(
      ctx,
      x,
      by,
      w,
      bh,
      sample,
      {
        label: panel.label,
        crop: panel.crop,
        background: panel.background,
        channel: panel.channel,
        showTime: panel.showTime,
        overlays: panel.overlays,
      },
      canvasSize,
      [sample],
    )
    return
  }

  // compare
  if (panel.mode === 'overlay') {
    const channel = panel.channel ?? 'rgba'
    fillBackground(ctx, x, by, w, bh, panel.background, channel)
    ctx.save()
    ctx.beginPath()
    ctx.rect(x, by, w, bh)
    ctx.clip()
    const crop = panel.crop ?? [0, 0, canvasSize.width, canvasSize.height]
    const [sx, sy, sw, sh] = crop
    const fit = fitRect(x, by, w, bh, sw, sh, 8)
    const tintPalette = ['#e2e8f0', '#fb923c', '#34d399', '#f472b6', '#38bdf8']
    const overlaySamples = []
    const badgeItems = []
    panel.entries.forEach((entry, idx) => {
      const sample = logicalGroup.frames.get(entry.t)
      if (!sample) return
      overlaySamples.push(sample)
      const tint = tintPalette[idx % tintPalette.length]
      badgeItems.push({ label: entry.label || `${Math.round(entry.t)}ms`, color: tint })
      let src = (entry.channel ?? channel) === 'alpha' ? toAlphaSilhouetteCanvas(sample.canvas) : sample.canvas
      if (idx > 0) src = toTintedCanvas(src, tint, 'tint')
      ctx.globalAlpha = idx === 0 ? 0.9 : 0.55
      ctx.drawImage(src, sx, sy, sw, sh, fit.dx, fit.dy, fit.dw, fit.dh)
    })
    ctx.globalAlpha = 1
    if (overlaySamples.length) {
      const mapper = (lx, ly) => [fit.dx + (lx - sx) * fit.scale, fit.dy + (ly - sy) * fit.scale]
      drawOverlays(ctx, mapper, panel.overlays, overlaySamples[0], overlaySamples, canvasSize, { x, y: by, w, h: bh })
    }
    ctx.restore()
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
    ctx.lineWidth = 1
    ctx.strokeRect(x + 0.5, by + 0.5, w - 1, bh - 1)
    drawSwatchBadge(ctx, x + 8, by + 8, badgeItems)
    const firstErr = overlaySamples.find((s) => s.errors?.length)?.errors?.[0]
    if (firstErr) drawBadge(ctx, x + 8, by + bh - 28, firstErr.message, 'error')
    return
  }

  // side-by-side compare (supports both logical and distinct viewport containers at same t!)
  const gap = 8
  const cols = panel.entries.length
  const cellW = (w - gap * (cols - 1)) / cols
  panel.entries.forEach((entry, idx) => {
    const cx = x + idx * (cellW + gap)
    if (entry.container || entry.viewport) {
      const vp = entry.viewport ?? plan.source.viewport ?? { fit: 'contain', anchor: [0.5, 0.5], paddingPx: 0 }
      const container = entry.container ?? [800, 600]
      const key = viewportContextKeyFn(container, vp)
      const grp = groupMap.get(key)
      const sample = grp?.frames.get(entry.t)
      if (!sample) return
      drawViewportCell(
        ctx,
        cx,
        by,
        cellW,
        bh,
        sample,
        {
          label: entry.label,
          background: entry.background ?? panel.background,
          channel: entry.channel ?? panel.channel,
          showTime: panel.showTime,
          overlays: entry.overlays ?? panel.overlays,
        },
        canvasSize,
      )
    } else {
      const sample = logicalGroup?.frames.get(entry.t)
      if (!sample) return
      drawLogicalCell(
        ctx,
        cx,
        by,
        cellW,
        bh,
        sample,
        {
          label: entry.label,
          crop: entry.crop ?? panel.crop,
          background: entry.background ?? panel.background,
          channel: entry.channel ?? panel.channel,
          showTime: panel.showTime,
          overlays: entry.overlays ?? panel.overlays,
        },
        canvasSize,
        [sample],
      )
    }
  })
}

function viewportKeyLocal(container, vp) {
  const fit = vp?.fit ?? 'contain'
  const anchor = vp?.anchor ?? [0.5, 0.5]
  const paddingPx = vp?.paddingPx ?? 0
  return `viewport:${container[0]}x${container[1]}:${fit}:${anchor[0]},${anchor[1]}:${paddingPx}`
}

function composeBoard(board, groupMap, plan, canvasSize) {
  const width = board.width
  const pad = board.padding
  const sectionGap = board.gap
  const innerW = width - pad * 2
  const titleH = board.title ? 34 : 0

  const sectionMetrics = board.sections.map((section) => {
    const colCount = section.columns.length
    const totalWeight = section.columns.reduce((s, w) => s + w, 0)
    const gap = section.gap
    const availW = innerW - gap * Math.max(0, colCount - 1)
    const colWidths = section.columns.map((w) => (availW * w) / totalWeight)
    const rows = []
    for (let i = 0; i < section.panels.length; i += colCount) {
      const slice = section.panels.slice(i, i + colCount)
      const rowHeight = Math.max(
        ...slice.map((p, cIdx) => (p.caption ? 26 : 0) + estimatePanelBodyHeight(p, colWidths[cIdx], canvasSize)),
      )
      rows.push({ panels: slice, height: rowHeight })
    }
    const height = rows.reduce((s, r) => s + r.height, 0) + gap * Math.max(0, rows.length - 1)
    return { colWidths, rows, height }
  })

  const totalHeight =
    pad * 2 +
    titleH +
    sectionMetrics.reduce((sum, m) => sum + m.height, 0) +
    sectionGap * Math.max(0, sectionMetrics.length - 1)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = Math.ceil(totalHeight)
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = board.background
  ctx.fillRect(0, 0, canvas.width, canvas.height)

  let y = pad
  if (board.title) {
    ctx.save()
    ctx.font = '700 16px -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    ctx.fillStyle = '#f8fafc'
    ctx.textBaseline = 'middle'
    ctx.fillText(board.title, pad, y + 12)
    ctx.restore()
    y += titleH
  }

  board.sections.forEach((section, sIdx) => {
    const { colWidths, rows } = sectionMetrics[sIdx]
    rows.forEach((row, rIdx) => {
      let x = pad
      row.panels.forEach((panel, cIdx) => {
        const cw = colWidths[cIdx]
        renderPanel(ctx, x, y, cw, row.height, panel, groupMap, plan, canvasSize, viewportKeyLocal)
        x += cw + section.gap
      })
      y += row.height + (rIdx < rows.length - 1 ? section.gap : 0)
    })
    y += sectionGap
  })

  return {
    file: board.file,
    width: canvas.width,
    height: canvas.height,
    dataUrl: canvas.toDataURL('image/png'),
  }
}

export async function executeInspectPlan({ mountPerformance, host, sourceOpts, plan, groups }) {
  const groupMap = new Map()
  let canvasSize = null
  for (const group of groups) {
    const captured = await runCaptureGroup(mountPerformance, host, sourceOpts, plan, group)
    groupMap.set(group.key, captured)
    if (!canvasSize) canvasSize = captured.canvasSize
  }

  const boards = plan.boards.map((board) => composeBoard(board, groupMap, plan, canvasSize))

  const logicalGroup = groupMap.get('logical') ?? [...groupMap.values()][0]
  const samples = logicalGroup ? [...logicalGroup.frames.values()].map((f) => f.telemetry) : []
  const telemetry = {
    format: 'koma-rig.telemetry.v1',
    canvas: canvasSize,
    stepMs: plan.stepMs,
    samples,
  }

  const exportedFrames = []
  if (plan.exportFrames && logicalGroup) {
    for (const [t, frame] of logicalGroup.frames) {
      exportedFrames.push({
        timeMs: t,
        file: `frames/t-${String(Math.round(t)).padStart(5, '0')}ms.png`,
        dataUrl: frame.canvas.toDataURL('image/png'),
      })
    }
  }

  const captureChecks = [...groupMap.values()].map((g) => ({
    key: g.key,
    kind: g.kind,
    frameCount: g.frames.size,
    allNonEmpty: [...g.frames.values()].every((f) => f.nonEmpty),
    errorCount: [...g.frames.values()].reduce((sum, f) => sum + f.errors.length, 0),
  }))

  return { boards, telemetry, exportedFrames, captureChecks }
}
