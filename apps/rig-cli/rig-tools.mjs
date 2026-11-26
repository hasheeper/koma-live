import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createRig,
  diagnoseRig,
  editRig,
  emptyRig,
  sliceManifestSchema,
  syncSliceBinding,
  workManifestSchema,
} from '@koma-rig/rig-core'
import { readPngAlpha, readPngRgba, writePngRgba } from './png-alpha.mjs'
import { workspace, writeJson } from './workspace.mjs'

async function resolveRigDir(dir) {
  const abs = resolve(dir)
  const workPath = join(abs, 'koma-work.json')
  if (existsSync(workPath)) {
    const work = workManifestSchema.parse(JSON.parse(await readFile(workPath, 'utf8')))
    return resolve(abs, work.rig)
  }
  return abs
}

async function loadPackage(dir) {
  const rigDir = await resolveRigDir(dir)
  const manifestPath = join(rigDir, 'manifest.json')
  if (!existsSync(manifestPath)) throw new Error(`找不到切片清单：${manifestPath}`)
  const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const rigPath = join(rigDir, 'rig.json')
  const setupPath = join(rigDir, 'setup.json')
  const hasRigFile = existsSync(rigPath)
  const rigDoc = hasRigFile
    ? JSON.parse(await readFile(rigPath, 'utf8'))
    : existsSync(setupPath)
      ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await readFile(setupPath, 'utf8')))
      : emptyRig(manifest.sourceId)
  return { rigDir, manifestPath, rigPath, hasRigFile, manifest, rigDoc }
}

function srgbToLinear(c) {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

function linearToSrgb(c) {
  const v = c < 0 ? 0 : c
  return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055
}

/**
 * Pure-Node PMA reference.png baker matching tools/psd/proof.py (supports slices v1 linear & v2 sRGB + gelGroups).
 */
export async function bakeReferencePng(rigDir, manifestInput) {
  const manifest = manifestInput ?? sliceManifestSchema.parse(JSON.parse(await readFile(join(rigDir, 'manifest.json'), 'utf8')))
  const { width, height } = manifest.canvas
  const linear = manifest.format === 'koma-rig.slices.v1'
  const total = width * height
  const dstR = new Float64Array(total)
  const dstG = new Float64Array(total)
  const dstB = new Float64Array(total)
  const dstA = new Float64Array(total)

  const memberships = new Map()
  for (const g of manifest.gelGroups ?? []) {
    for (let idx = 0; idx < g.members.length; idx++) {
      memberships.set(g.members[idx].layerId, { group: g, member: g.members[idx], isFirst: idx === 0, isLast: idx === g.members.length - 1 })
    }
  }

  let gR = null
  let gG = null
  let gB = null
  let gA = null

  for (const layer of manifest.layers) {
    const mem = memberships.get(layer.layerId)
    if (mem?.isFirst) {
      gR = new Float64Array(total)
      gG = new Float64Array(total)
      gB = new Float64Array(total)
      gA = new Float64Array(total)
    }

    if (layer.visible && layer.opacity > 0) {
      const [rx, ry, rw, rh] = layer.rect
      const tex = await readPngRgba(join(rigDir, layer.texture))
      if (tex.width !== rw || tex.height !== rh) {
        throw new Error(`切片 ${layer.layerId} 贴图尺寸 ${tex.width}×${tex.height} 与 rect ${rw}×${rh} 不符`)
      }
      const cov = mem ? await readPngAlpha(join(rigDir, mem.member.coverage)) : null
      const tR = mem ? gR : dstR
      const tG = mem ? gG : dstG
      const tB = mem ? gB : dstB
      const tA = mem ? gA : dstA

      const x0 = Math.max(0, rx)
      const y0 = Math.max(0, ry)
      const x1 = Math.min(width, rx + rw)
      const y1 = Math.min(height, ry + rh)
      const op = layer.opacity

      for (let cy = y0; cy < y1; cy++) {
        const sy = cy - ry
        const srcRow = sy * rw
        const dstRow = cy * width
        for (let cx = x0; cx < x1; cx++) {
          const sx = cx - rx
          const si = (srcRow + sx) * 4
          const rawA = tex.rgba[si + 3] / 255
          const sa = rawA * op
          const k = cov ? (cov.alpha[srcRow + sx] / 255) : sa
          if (sa === 0 && k === 0) continue

          let r = tex.rgba[si] / 255
          let g = tex.rgba[si + 1] / 255
          let b = tex.rgba[si + 2] / 255
          if (linear) {
            r = srgbToLinear(r)
            g = srgbToLinear(g)
            b = srgbToLinear(b)
          }
          const di = dstRow + cx
          const inv = 1 - k
          tR[di] = r * sa + inv * tR[di]
          tG[di] = g * sa + inv * tG[di]
          tB[di] = b * sa + inv * tB[di]
          tA[di] = sa + inv * tA[di]
        }
      }
    }

    if (mem?.isLast && gR && gG && gB && gA) {
      const gop = mem.group.opacity
      for (let i = 0; i < total; i++) {
        const sa = gA[i] * gop
        if (sa === 0) continue
        const inv = 1 - sa
        dstR[i] = gR[i] * gop + inv * dstR[i]
        dstG[i] = gG[i] * gop + inv * dstG[i]
        dstB[i] = gB[i] * gop + inv * dstB[i]
        dstA[i] = sa + inv * dstA[i]
      }
      gR = gG = gB = gA = null
    }
  }

  const out = new Uint8Array(total * 4)
  for (let i = 0; i < total; i++) {
    const a = dstA[i] < 0 ? 0 : dstA[i] > 1 ? 1 : dstA[i]
    let r = a > 1e-12 ? dstR[i] / a : 0
    let g = a > 1e-12 ? dstG[i] / a : 0
    let b = a > 1e-12 ? dstB[i] / a : 0
    if (linear && a > 1e-12) {
      r = linearToSrgb(r)
      g = linearToSrgb(g)
      b = linearToSrgb(b)
    }
    const o = i * 4
    out[o] = Math.round(Math.max(0, Math.min(1, r)) * 255)
    out[o + 1] = Math.round(Math.max(0, Math.min(1, g)) * 255)
    out[o + 2] = Math.round(Math.max(0, Math.min(1, b)) * 255)
    out[o + 3] = Math.round(a * 255)
  }

  const outPath = join(rigDir, manifest.reference)
  await writePngRgba(outPath, width, height, out)
  return { output: outPath, width, height, layers: manifest.layers.length }
}

async function scanLayerPixelMetrics(rigDir, manifest) {
  const metrics = {}
  await Promise.all(
    manifest.layers.map(async (layer) => {
      const file = join(rigDir, layer.texture)
      if (!existsSync(file)) return
      const { width, height, alpha } = await readPngAlpha(file)
      let minX = width
      let minY = height
      let maxX = -1
      let maxY = -1
      for (let y = 0; y < height; y++) {
        const row = y * width
        for (let x = 0; x < width; x++) {
          if (alpha[row + x] > 24) {
            if (x < minX) minX = x
            if (x > maxX) maxX = x
            if (y < minY) minY = y
            if (y > maxY) maxY = y
          }
        }
      }
      if (maxX < minX || maxY < minY) return
      const topXs = []
      const bandEnd = Math.min(height - 1, minY + 12)
      for (let y = minY; y <= bandEnd; y++) {
        const row = y * width
        for (let x = minX; x <= maxX; x++) {
          if (alpha[row + x] > 24) topXs.push(x)
        }
      }
      topXs.sort((a, b) => a - b)
      const medianX = topXs.length ? topXs[(topXs.length / 2) | 0] : (minX + maxX) / 2
      const [rx, ry] = layer.rect
      metrics[layer.layerId] = {
        alphaRect: [rx + minX, ry + minY, maxX - minX + 1, maxY - minY + 1],
        topRoot: [rx + medianX, ry + minY],
      }
    }),
  )
  return metrics
}

export async function runDoctor(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'no-pixels': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 1) {
    throw new Error('用法: rig doctor <作品或切片目录> [--no-pixels]')
  }
  const { rigDir, manifest, rigDoc } = await loadPackage(positionals[0])
  const pixelMetrics = values['no-pixels'] ? undefined : await scanLayerPixelMetrics(rigDir, manifest)
  const report = diagnoseRig(manifest, rigDoc, { pixelMetrics })
  return { rigDir, ...report }
}

export async function runBakeReference(argv) {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true })
  if (positionals.length !== 1) {
    throw new Error('用法: rig bake-reference <作品或切片目录>')
  }
  const rigDir = await resolveRigDir(positionals[0])
  return bakeReferencePng(rigDir)
}

export async function runRepivot(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      translate: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 4) {
    throw new Error('用法: rig repivot <作品或切片目录> <boneId> <x> <y> [--translate] [--dry-run]')
  }
  const [dirArg, boneId, xRaw, yRaw] = positionals
  const px = Number(xRaw)
  const py = Number(yRaw)
  if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('枢轴坐标 x y 须为有限数值')

  const { rigDir, manifest, rigDoc } = await loadPackage(dirArg)
  const edit = { op: 'repivot-bone', boneId, pivot: [px, py], keepEnd: !values.translate }
  const nextDoc = editRig(manifest, rigDoc, [edit])
  const diag = diagnoseRig(manifest, nextDoc)
  if (!values['dry-run']) {
    await workspace('edit-save', rigDir, [edit])
  }
  const nextModel = createRig(manifest, nextDoc)
  const restBone = nextModel.skeleton.rest.get(boneId)
  return {
    rigDir,
    boneId,
    applied: !values['dry-run'],
    restStart: restBone.start.map((n) => Number(n.toFixed(3))),
    restEnd: restBone.end.map((n) => Number(n.toFixed(3))),
    maxRestDriftPx: diag.summary.maxRestDriftPx,
  }
}

export async function runPadSlice(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      top: { type: 'string', default: '0' },
      bottom: { type: 'string', default: '0' },
      left: { type: 'string', default: '0' },
      right: { type: 'string', default: '0' },
      'bleed-top-row': { type: 'string' },
      'no-bake': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 2) {
    throw new Error('用法: rig pad-slice <作品或切片目录> <layerId> [--top N] [--bottom N] [--left N] [--right N] [--bleed-top-row Y] [--dry-run]')
  }
  const [dirArg, layerId] = positionals
  const padTop = Number(values.top)
  const padBottom = Number(values.bottom)
  const padLeft = Number(values.left)
  const padRight = Number(values.right)
  for (const [k, v] of [['top', padTop], ['bottom', padBottom], ['left', padLeft], ['right', padRight]]) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`--${k} 须为非负整数`)
  }
  if (padTop === 0 && padBottom === 0 && padLeft === 0 && padRight === 0) {
    throw new Error('至少指定一个大于 0 的扩边参数（--top / --bottom / --left / --right）')
  }
  const bleedTopRow = values['bleed-top-row'] !== undefined ? Number(values['bleed-top-row']) : null
  if (bleedTopRow !== null && (!Number.isInteger(bleedTopRow) || bleedTopRow < 0)) {
    throw new Error('--bleed-top-row 须为原贴图内的非负整数行号')
  }

  const { rigDir, manifestPath, rigPath, hasRigFile, manifest, rigDoc } = await loadPackage(dirArg)
  const layer = manifest.layers.find((l) => l.layerId === layerId)
  if (!layer) throw new Error(`未知图层：${layerId}`)

  const oldRect = [...layer.rect]
  const [ox, oy, ow, oh] = oldRect
  const newRect = [ox - padLeft, oy - padTop, ow + padLeft + padRight, oh + padTop + padBottom]
  const texPath = join(rigDir, layer.texture)
  const tex = await readPngRgba(texPath)
  if (tex.width !== ow || tex.height !== oh) {
    throw new Error(`切片 ${layerId} 贴图尺寸 ${tex.width}×${tex.height} 与 rect ${ow}×${oh} 不符`)
  }
  if (bleedTopRow !== null && bleedTopRow >= oh) {
    throw new Error(`--bleed-top-row=${bleedTopRow} 超出原贴图高度 ${oh}`)
  }

  const nw = newRect[2]
  const nh = newRect[3]
  const outRgba = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < oh; y++) {
    const srcStart = y * ow * 4
    const dstStart = ((y + padTop) * nw + padLeft) * 4
    outRgba.set(tex.rgba.subarray(srcStart, srcStart + ow * 4), dstStart)
  }
  if (bleedTopRow !== null && padTop > 0) {
    // Extrude a clean interior row upward to eliminate top outline notches when bleeding neck/joints!
    const srcRowStart = bleedTopRow * ow * 4
    const rowSlice = tex.rgba.subarray(srcRowStart, srcRowStart + ow * 4)
    for (let y = 0; y < padTop + bleedTopRow; y++) {
      outRgba.set(rowSlice, (y * nw + padLeft) * 4)
    }
  }

  const nextManifest = {
    ...manifest,
    layers: manifest.layers.map((l) => (l.layerId === layerId ? { ...l, rect: newRect } : l)),
  }
  sliceManifestSchema.parse(nextManifest)

  const nextRig = structuredClone(rigDoc)
  const bindingIdx = (nextRig.bindings ?? []).findIndex((b) => b.layerId === layerId)
  let bindingUpdated = false
  if (bindingIdx >= 0) {
    nextRig.bindings[bindingIdx] = syncSliceBinding(nextRig.bindings[bindingIdx], oldRect, newRect)
    bindingUpdated = true
  }

  const hasMorphs = (nextRig.morphs ?? []).some((m) => m.layerId === layerId)
  const diag = diagnoseRig(nextManifest, nextRig)
  if (diag.summary.maxRestDriftPx > 0.05) {
    throw new Error(`同步切片后静止对齐偏差过高：${diag.summary.maxRestDriftPx} px`)
  }

  let baked = false
  if (!values['dry-run']) {
    await writePngRgba(texPath, nw, nh, outRgba)
    await writeJson(manifestPath, nextManifest)
    if (hasRigFile && bindingUpdated) {
      await writeJson(rigPath, nextRig)
    }
    if (!values['no-bake']) {
      await bakeReferencePng(rigDir, nextManifest)
      baked = true
    }
  }

  return {
    rigDir,
    layerId,
    applied: !values['dry-run'],
    oldRect,
    newRect,
    bindingUpdated,
    bakedReference: baked,
    maxRestDriftPx: diag.summary.maxRestDriftPx,
    ...(hasMorphs ? { note: `图层 ${layerId} 存在 morphs，若其 UV 范围改变请重新执行 rig auto-head` } : {}),
  }
}

export async function runReorder(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      before: { type: 'string' },
      after: { type: 'string' },
      mode: { type: 'string', default: 'draw-order' },
      'keep-shadows': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 2 || Boolean(values.before) === Boolean(values.after)) {
    throw new Error('用法: rig reorder <作品或切片目录> <layerId[,layerId2]> (--before <anchor> | --after <anchor>) [--mode draw-order|manifest] [--keep-shadows] [--dry-run]')
  }
  if (!['draw-order', 'manifest'].includes(values.mode)) {
    throw new Error('--mode 仅支持 draw-order 或 manifest')
  }
  const [dirArg, rawTargets] = positionals
  const targets = rawTargets.split(',').map((s) => s.trim()).filter(Boolean)
  const anchor = values.before ?? values.after
  const after = Boolean(values.after)
  if (targets.includes(anchor)) throw new Error('目标图层不能与锚点图层相同')

  const { rigDir, manifestPath, manifest, rigDoc } = await loadPackage(dirArg)
  const allIds = manifest.layers.map((l) => l.layerId)
  for (const id of [...targets, anchor]) {
    if (!allIds.includes(id)) throw new Error(`未知图层：${id}`)
  }

  const baseOrder = values.mode === 'draw-order' && Array.isArray(rigDoc.drawOrder) ? [...rigDoc.drawOrder] : [...allIds]
  const targetSet = new Set(targets)
  const remaining = baseOrder.filter((id) => !targetSet.has(id))
  const anchorIdx = remaining.indexOf(anchor)
  const nextOrder = [
    ...remaining.slice(0, anchorIdx + (after ? 1 : 0)),
    ...targets,
    ...remaining.slice(anchorIdx + (after ? 1 : 0)),
  ]

  const orderIndex = new Map(nextOrder.map((id, i) => [id, i]))
  const removedShadows = []
  let nextShadows = rigDoc.castShadows ? structuredClone(rigDoc.castShadows) : []
  if (!values['keep-shadows'] && nextShadows.length) {
    const cleaned = []
    for (const s of nextShadows) {
      const keptCasters = s.casters.filter((c) => {
        const ci = orderIndex.get(c)
        const conflicts = s.receivers.every((r) => ci < orderIndex.get(r))
        if (conflicts) removedShadows.push({ caster: c, receivers: s.receivers })
        return !conflicts
      })
      if (keptCasters.length) cleaned.push({ ...s, casters: keptCasters })
    }
    nextShadows = cleaned
  }

  if (!values['dry-run']) {
    if (values.mode === 'draw-order') {
      const edits = [{ op: 'draw-order', layers: nextOrder }]
      if (!values['keep-shadows'] && rigDoc.castShadows) {
        edits.push({ op: 'set-cast-shadows', castShadows: nextShadows })
      }
      await workspace('edit-save', rigDir, edits)
    } else {
      const byId = new Map(manifest.layers.map((l) => [l.layerId, l]))
      const nextManifest = { ...manifest, layers: nextOrder.map((id) => byId.get(id)) }
      await writeJson(manifestPath, nextManifest)
      if (!values['keep-shadows'] && rigDoc.castShadows) {
        await workspace('edit-save', rigDir, [{ op: 'set-cast-shadows', castShadows: nextShadows }])
      }
      await bakeReferencePng(rigDir, nextManifest)
    }
  }

  return {
    rigDir,
    mode: values.mode,
    applied: !values['dry-run'],
    moved: targets,
    anchor,
    position: after ? 'after' : 'before',
    cleanedShadowCasters: removedShadows,
  }
}
