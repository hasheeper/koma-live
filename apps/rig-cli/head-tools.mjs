import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import {
  attachmentPoint,
  buildAutoHeadMorphs,
  createRig,
  editRig,
  emptyRig,
  neutral,
  sliceManifestSchema,
  workManifestSchema,
} from '@koma-rig/rig-core'
import { digest, workspace } from './workspace.mjs'

async function optionalFile(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

async function resolveRigDir(dir) {
  const abs = resolve(dir)
  const workPath = join(abs, 'koma-work.json')
  if (existsSync(workPath)) {
    const work = workManifestSchema.parse(JSON.parse(await readFile(workPath, 'utf8')))
    return resolve(abs, work.rig)
  }
  return abs
}

/** Validate the final skinned geometry across 25 yaw/pitch samples, including hidden expression variants. */
export function validateHeadMorphs(manifest, doc, model, { targetIds, yaw, pitch, faceId, anchor, pinNeck }) {
  const isGenerated = (m) =>
    targetIds.has(m.layerId) &&
    m.axes.length === 2 &&
    m.axes[0].parameter === yaw &&
    m.axes[1].parameter === pitch

  const values = neutral(model.caps).values
  const allVisible = createRig(
    {
      ...manifest,
      layers: manifest.layers.map((l) => (targetIds.has(l.layerId) ? { ...l, visible: true, opacity: 1 } : l)),
    },
    {
      ...doc,
      eyes: [],
      morphs: doc.morphs.map((m) => (isGenerated(m) ? { ...m, minRatio: Math.max(0.15, m.minRatio ?? 0) } : m)),
      layerSettings: doc.layerSettings?.map((s) => (targetIds.has(s.layerId) ? { ...s, visible: true } : s)),
      bindings: doc.bindings?.map((b) => (targetIds.has(b.layerId) ? { ...b, variant: undefined } : b)),
    },
  )
  const without = createRig(manifest, { ...doc, morphs: doc.morphs.filter((m) => !isGenerated(m)) })
  if (JSON.stringify(model.pose().parts) !== JSON.stringify(without.pose().parts)) {
    throw new Error('中性 Morph 改变了原始顶点')
  }

  const [left, top, width, height] = manifest.layers.find((l) => l.layerId === faceId).rect
  const local = [anchor[0] - left, anchor[1] - top]
  const checkNeck =
    Boolean(pinNeck) && targetIds.has(faceId) && local[0] >= 0 && local[0] <= width && local[1] >= 0 && local[1] <= height

  let maxNeckDriftPx = 0
  for (const py of [-1, -0.5, 0, 0.5, 1]) {
    for (const px of [-1, -0.5, 0, 0.5, 1]) {
      const parameters = { ...values, [yaw]: px, [pitch]: py }
      model.pose(parameters)
      const posed = allVisible.pose(parameters)
      if (posed.parts.some((p) => targetIds.has(p.layerId) && !p.visible)) {
        throw new Error('目标图层未通过可见性体检')
      }
      if (checkNeck) {
        const project = (p) => attachmentPoint(p.parts.find((part) => part.layerId === faceId), [width, height], local)
        const a = project(posed)
        const b = project(without.pose(parameters))
        maxNeckDriftPx = Math.max(maxNeckDriftPx, Math.hypot(a[0] - b[0], a[1] - b[1]))
      }
    }
  }
  if (maxNeckDriftPx > 0.05) {
    throw new Error(`生成后的颈部锚点偏移 ${maxNeckDriftPx.toFixed(4)} px`)
  }
  return { validatedSamples: 25, maxNeckDriftPx: checkNeck ? Number(maxNeckDriftPx.toFixed(6)) : null }
}

export async function runAutoHead(argv) {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (positionals.length !== 1) {
    throw new Error('用法: rig auto-head <作品或切片目录> [--config head-rig.json] [--dry-run]')
  }
  const source = resolve(positionals[0])
  const dir = await resolveRigDir(source)
  let configPath = values.config ? resolve(values.config) : join(source, 'head-rig.json')
  if (!values.config && dir === source && !existsSync(configPath) && (await resolveRigDir(dirname(dir))) === dir) {
    configPath = join(dirname(dir), 'head-rig.json')
  }

  const [rawConfig, rawManifest, rawRig] = await Promise.all([
    readFile(configPath),
    readFile(join(dir, 'manifest.json')),
    optionalFile(join(dir, 'rig.json')),
  ])
  const manifest = sliceManifestSchema.parse(JSON.parse(rawManifest))
  const { morphs, faceLayer, neckAnchor, pinNeck, yaw, pitch, calibration, diagnostics } = buildAutoHeadMorphs(
    manifest,
    JSON.parse(rawConfig),
  )

  const setupPath = join(dir, 'setup.json')
  const rawSetup = rawRig ? null : await optionalFile(setupPath)
  const setup = rawSetup ? JSON.parse(rawSetup) : []
  const original = rawRig ? JSON.parse(rawRig) : emptyRig(manifest.sourceId)
  const rig = setup.length ? editRig(manifest, original, setup) : original

  const edits = [...setup]
  for (const [id, meaning] of [
    [yaw, '左右转头（向右为正）'],
    [pitch, '俯仰（向下为正）'],
  ]) {
    const old = rig.semantics.parameters.find((p) => p.id === id)
    if (!old) {
      edits.push({ op: 'set-parameter', parameter: { id, meaning, unit: 'normalized', min: -1, max: 1, default: 0 } })
    } else if (old.min !== -1 || old.max !== 1 || old.default !== 0 || old.unit !== 'normalized') {
      throw new Error(id + ' 已存在，须使用归一化范围 [-1, 1] 并在 0 中立')
    }
  }

  const targetIds = new Set(morphs.map((m) => m.layerId))
  const pending = new Map(morphs.map((m) => [m.layerId, m]))
  const combined = []
  for (const old of rig.morphs ?? []) {
    const axes = old.axes.map((a) => a.parameter)
    if (targetIds.has(old.layerId) && axes.includes(yaw) && axes.includes(pitch)) {
      const replacement = pending.get(old.layerId)
      if (replacement) combined.push(replacement)
      pending.delete(old.layerId)
    } else {
      combined.push(old)
    }
  }
  combined.push(...pending.values())
  if (!isDeepStrictEqual(rig.morphs ?? [], combined)) {
    edits.push({ op: 'set-morphs', morphs: combined })
  }
  if (!isDeepStrictEqual(rig.headCalibration, calibration)) {
    edits.push({ op: 'set-head-calibration', headCalibration: calibration })
  }

  const options = { targetIds, yaw, pitch, faceId: faceLayer, anchor: neckAnchor, pinNeck }
  let checks
  const apply = !values['dry-run'] && edits.length > 0
  if (apply) {
    const base = rawRig && digest(rawRig)
    const manifestHash = digest(rawManifest)
    await workspace('edit-save', dir, edits, (m, doc, model, revision) => {
      if (revision.base !== base || revision.manifestHash !== manifestHash) {
        throw new Error('骨架或切片在生成期间已更改，请重新运行')
      }
      if (!rawRig && (rawSetup ? !rawSetup.equals(readFileSync(setupPath)) : existsSync(setupPath))) {
        throw new Error('setup.json 在生成期间已更改，请重新运行')
      }
      checks = validateHeadMorphs(m, doc, model, options)
    })
  } else {
    const doc = edits.length ? editRig(manifest, original, edits) : rig
    checks = validateHeadMorphs(manifest, doc, createRig(manifest, doc), options)
  }

  return {
    rigDir: dir,
    configPath,
    targets: morphs.length,
    changed: edits.length > 0,
    applied: apply,
    ...diagnostics,
    ...checks,
  }
}
