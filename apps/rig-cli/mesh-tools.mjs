import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  GeometryError,
  createRig,
  editRig,
  emptyRig,
  meshFromAlpha,
  previewRig,
  sliceManifestSchema,
  suggestAlphaThreshold,
  workManifestSchema,
} from '@koma-rig/rig-core'
import { readPngAlpha } from './png-alpha.mjs'
import { writeJson } from './workspace.mjs'

export const CHAIN_MESH_PRESET = Object.freeze({
  detail: 28,
  concavity: 10,
  refinement: 50,
  padding: 4,
})

export const SINGLE_BONE_MESH_PRESET = Object.freeze({
  detail: 42,
  concavity: 32,
  refinement: 50,
  padding: 3,
})

async function resolveRigDir(dir) {
  const abs = resolve(dir)
  const workPath = join(abs, 'koma-work.json')
  if (existsSync(workPath)) {
    const work = workManifestSchema.parse(JSON.parse(await readFile(workPath, 'utf8')))
    return resolve(abs, work.rig)
  }
  return abs
}

async function loadRigPackage(dir) {
  const rigDir = await resolveRigDir(dir)
  const manifestPath = join(rigDir, 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`找不到切片清单：${manifestPath}`)
  }
  const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
  const rigPath = join(rigDir, 'rig.json')
  const setupPath = join(rigDir, 'setup.json')
  const rigDoc = existsSync(rigPath)
    ? JSON.parse(await readFile(rigPath, 'utf8'))
    : existsSync(setupPath)
      ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await readFile(setupPath, 'utf8')))
      : emptyRig(manifest.sourceId)
  return { rigDir, rigPath, manifest, rigDoc }
}

function parseNumberFlag(args, flag) {
  const raw = args.shift()
  if (raw === undefined || !raw.trim() || !Number.isFinite(Number(raw))) {
    throw new Error(`${flag} 需要有效数值`)
  }
  return Number(raw)
}

export function parseAutoMeshArgs(argv) {
  const opts = {
    dir: null,
    scope: 'chains', // 'chains' | 'all' | 'layers'
    layers: null,
    overwrite: false,
    dryRun: false,
    overrides: {},
  }
  const args = [...argv]
  while (args.length) {
    const token = args.shift()
    if (!token.startsWith('--')) {
      if (opts.dir) throw new Error(`多余的位置参数：${token}`)
      opts.dir = token
    } else if (token === '--chains-only') {
      opts.scope = 'chains'
    } else if (token === '--all') {
      opts.scope = 'all'
    } else if (token === '--layers') {
      const list = args.shift()
      if (!list) throw new Error('--layers 需要逗号分隔的图层 ID 或名称')
      opts.scope = 'layers'
      opts.layers = list
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    } else if (token === '--overwrite') {
      opts.overwrite = true
    } else if (token === '--dry-run') {
      opts.dryRun = true
    } else if (token === '--detail') {
      opts.overrides.detail = parseNumberFlag(args, token)
    } else if (token === '--concavity') {
      opts.overrides.concavity = parseNumberFlag(args, token)
    } else if (token === '--padding') {
      opts.overrides.padding = parseNumberFlag(args, token)
    } else if (token === '--refinement') {
      opts.overrides.refinement = parseNumberFlag(args, token)
    } else if (token === '--alpha-threshold') {
      opts.overrides.alphaThreshold = parseNumberFlag(args, token)
    } else {
      throw new Error(`未知 auto-mesh 选项：${token}`)
    }
  }
  if (!opts.dir) {
    throw new Error(
      '用法: rig auto-mesh <作品或切片目录> [--chains-only|--all|--layers id1,id2] [--overwrite] [--dry-run] [--detail N] [--concavity N] [--padding N]',
    )
  }
  return opts
}

export async function runAutoMesh(options) {
  const { rigDir, rigPath, manifest, rigDoc } = await loadRigPackage(options.dir)
  const model = createRig(manifest, rigDoc)
  const bindingByLayer = new Map(model.bindings.map((b) => [b.layerId, b]))
  const layerById = new Map(manifest.layers.map((l) => [l.layerId, l]))

  const coverageByLayer = new Map()
  if (manifest.format === 'koma-rig.slices.v2') {
    for (const g of manifest.gelGroups ?? []) {
      for (const m of g.members) coverageByLayer.set(m.layerId, m.coverage)
    }
  }

  let targetLayerIds
  if (options.scope === 'layers') {
    targetLayerIds = []
    for (const key of options.layers) {
      const matched = layerById.get(key) ?? manifest.layers.find((l) => l.name === key)
      if (!matched) throw new Error(`找不到图层：${key}`)
      if (!targetLayerIds.includes(matched.layerId)) targetLayerIds.push(matched.layerId)
    }
  } else if (options.scope === 'all') {
    targetLayerIds = model.bindings
      .filter((b) => Boolean(b.boneId) || (b.boneChain && b.boneChain.length > 0))
      .map((b) => b.layerId)
  } else {
    targetLayerIds = model.bindings
      .filter((b) => Array.isArray(b.boneChain) && b.boneChain.length > 1)
      .map((b) => b.layerId)
  }

  const edits = []
  const reportLayers = []
  let skippedCount = 0

  for (const layerId of targetLayerIds) {
    const layer = layerById.get(layerId)
    if (!layer) continue
    const binding = bindingByLayer.get(layerId)
    const isChain = Boolean(binding?.boneChain && binding.boneChain.length > 1)
    const bindingKind = isChain ? 'boneChain' : binding?.boneId ? 'boneId' : 'unbound'

    if (binding?.mesh && !options.overwrite) {
      skippedCount++
      reportLayers.push({
        layerId,
        name: layer.name,
        bindingKind,
        status: 'skipped',
        reason: 'already-has-mesh',
        vertices: binding.mesh.points.length,
        triangles: binding.mesh.indices.length / 3,
      })
      continue
    }

    const alphaRelPath = coverageByLayer.get(layerId) ?? layer.texture
    const { width, height, alpha } = await readPngAlpha(join(rigDir, alphaRelPath))
    if (width !== layer.rect[2] || height !== layer.rect[3]) {
      throw new Error(`贴图尺寸与 manifest 不符：${layerId} (${width}x${height} vs ${layer.rect[2]}x${layer.rect[3]})`)
    }

    const basePreset = isChain ? CHAIN_MESH_PRESET : SINGLE_BONE_MESH_PRESET
    const traceOpts = {
      ...basePreset,
      alphaThreshold: suggestAlphaThreshold(alpha),
      ...options.overrides,
    }
    const mesh = meshFromAlpha(alpha, width, height, traceOpts)
    edits.push({ op: 'set-mesh', layerId, mesh })
    reportLayers.push({
      layerId,
      name: layer.name,
      bindingKind,
      status: 'generated',
      vertices: mesh.points.length,
      triangles: mesh.indices.length / 3,
      options: traceOpts,
    })
  }

  if (edits.length) {
    const nextRig = editRig(manifest, rigDoc, edits)
    createRig(manifest, nextRig).pose()
    if (!options.dryRun) {
      await writeJson(rigPath, nextRig)
    }
  }

  return {
    dir: rigDir,
    rigPath,
    dryRun: options.dryRun,
    updatedCount: edits.length,
    skippedCount,
    layers: reportLayers,
  }
}

export function parseCheckBendArgs(argv) {
  const opts = {
    dir: null,
    maxAngleDeg: 75,
    warnBelowDeg: 18,
    layerFilter: null,
  }
  const args = [...argv]
  while (args.length) {
    const token = args.shift()
    if (!token.startsWith('--')) {
      if (opts.dir) throw new Error(`多余的位置参数：${token}`)
      opts.dir = token
    } else if (token === '--max-angle') {
      opts.maxAngleDeg = Math.max(1, Math.min(180, parseNumberFlag(args, token)))
    } else if (token === '--warn-below') {
      opts.warnBelowDeg = Math.max(0, Math.min(180, parseNumberFlag(args, token)))
    } else if (token === '--layer') {
      const value = args.shift()
      if (!value) throw new Error('--layer 需要图层 ID 或名称')
      opts.layerFilter = value
    } else {
      throw new Error(`未知 check-bend 选项：${token}`)
    }
  }
  if (!opts.dir) {
    throw new Error('用法: rig check-bend <作品或切片目录> [--max-angle 75] [--warn-below 18] [--layer id]')
  }
  return opts
}

function testBoneAngles(model, bones) {
  try {
    previewRig(model, { bones })
    return { ok: true, error: null }
  } catch (err) {
    if (err instanceof GeometryError) {
      return { ok: false, error: err.message }
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

function findMaxSafeMagnitude(model, buildBones, maxDeg) {
  const full = testBoneAngles(model, buildBones(maxDeg))
  if (full.ok) return { safeDeg: maxDeg, failureReason: null }

  const rest = testBoneAngles(model, buildBones(0))
  if (!rest.ok) return { safeDeg: 0, failureReason: rest.error }

  let lo = 0
  let hi = maxDeg
  let lastError = full.error
  for (let iter = 0; iter < 11; iter++) {
    const mid = (lo + hi) * 0.5
    const check = testBoneAngles(model, buildBones(mid))
    if (check.ok) {
      lo = mid
    } else {
      hi = mid
      lastError = check.error
    }
    if (hi - lo <= 0.25) break
  }
  const safeDeg = Math.floor(lo * 4) / 4
  return { safeDeg, failureReason: lastError }
}

export async function runCheckBend(options) {
  const { rigDir, rigPath, manifest, rigDoc } = await loadRigPackage(options.dir)
  const model = createRig(manifest, rigDoc)
  const layerById = new Map(manifest.layers.map((l) => [l.layerId, l]))

  let chainBindings = model.bindings.filter((b) => Array.isArray(b.boneChain) && b.boneChain.length > 1)
  if (options.layerFilter) {
    chainBindings = chainBindings.filter((b) => {
      const layer = layerById.get(b.layerId)
      return b.layerId === options.layerFilter || layer?.name === options.layerFilter
    })
  }

  const chains = []
  let warnCount = 0

  for (const binding of chainBindings) {
    const layer = layerById.get(binding.layerId)
    const movableBones = binding.boneChain.slice(1)
    const joints = []
    let chainWarn = false

    for (const boneId of movableBones) {
      const bone = model.skeleton.byId.get(boneId)
      const pos = findMaxSafeMagnitude(model, (deg) => ({ [boneId]: { rotation: deg } }), options.maxAngleDeg)
      const neg = findMaxSafeMagnitude(model, (deg) => ({ [boneId]: { rotation: -deg } }), options.maxAngleDeg)
      const warn = pos.safeDeg < options.warnBelowDeg || neg.safeDeg < options.warnBelowDeg
      if (warn) chainWarn = true
      joints.push({
        boneId,
        name: bone?.name ?? boneId,
        minSafeDeg: -neg.safeDeg,
        maxSafeDeg: pos.safeDeg,
        warn,
        ...(pos.failureReason && pos.safeDeg < options.maxAngleDeg ? { posLimitReason: pos.failureReason } : {}),
        ...(neg.failureReason && neg.safeDeg < options.maxAngleDeg ? { negLimitReason: neg.failureReason } : {}),
      })
    }

    let simultaneous = null
    if (movableBones.length > 1) {
      const posAll = findMaxSafeMagnitude(
        model,
        (deg) => Object.fromEntries(movableBones.map((id) => [id, { rotation: deg }])),
        options.maxAngleDeg,
      )
      const negAll = findMaxSafeMagnitude(
        model,
        (deg) => Object.fromEntries(movableBones.map((id) => [id, { rotation: -deg }])),
        options.maxAngleDeg,
      )
      const simWarn = posAll.safeDeg < options.warnBelowDeg || negAll.safeDeg < options.warnBelowDeg
      if (simWarn) chainWarn = true
      simultaneous = {
        minSafeDeg: -negAll.safeDeg,
        maxSafeDeg: posAll.safeDeg,
        warn: simWarn,
      }
    }

    if (chainWarn) warnCount++
    chains.push({
      layerId: binding.layerId,
      name: layer?.name ?? binding.layerId,
      hasMesh: Boolean(binding.mesh),
      boneChain: binding.boneChain,
      jointSoftnessPx: binding.jointSoftnessPx ?? null,
      status: chainWarn ? 'warn' : 'ok',
      joints,
      ...(simultaneous ? { simultaneous } : {}),
    })
  }

  return {
    dir: rigDir,
    rigPath,
    totalChains: chains.length,
    warnCount,
    warnBelowDeg: options.warnBelowDeg,
    maxAngleDeg: options.maxAngleDeg,
    chains,
  }
}
