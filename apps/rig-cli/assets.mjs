import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access, cp, link, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  auditMotions,
  capabilitiesJsonSchema,
  createRig,
  emptyRig,
  exportCapabilities,
  releaseSchema,
  sliceManifestSchema,
} from '@koma-rig/rig-core'
import { digest, jsonBytes, workspace, writeJson } from './workspace.mjs'

const run = promisify(execFile)
const psd = fileURLToPath(new URL('../../tools/psd', import.meta.url))
const python =
  process.env.KOMA_RIG_PYTHON ||
  join(psd, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const readJson = async (path) => JSON.parse(await readFile(path))
const readManifest = async (dir) => sliceManifestSchema.parse(await readJson(join(dir, 'manifest.json')))
function textures(manifest) {
  return new Set([
    ...manifest.layers.map((l) => l.texture),
    ...(manifest.gelGroups ?? []).flatMap((g) => g.members.map((m) => m.coverage)),
  ])
}
async function temporary(parent, task) {
  const dir = await mkdtemp(join(parent, '.koma-rig-'))
  try {
    return await task(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function proof(dir, args) {
  try {
    const { stdout } = await run(python, ['-m', 'layer_rig_psd.proof', dir, ...args])
    return stdout ? JSON.parse(stdout) : undefined
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('请用 uv sync --project tools/psd 安装离线像素工具，或指定 KOMA_RIG_PYTHON')
    throw new Error(error.stdout?.trim() || error.stderr?.trim() || error.message)
  }
}
async function runDefringe(args) {
  try {
    const { stdout } = await run(python, ['-m', 'layer_rig_psd.defringe', ...args], {
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout ? JSON.parse(stdout) : undefined
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error('请用 uv sync --project tools/psd 安装离线像素工具，或指定 KOMA_RIG_PYTHON')
    throw new Error(error.stdout?.trim() || error.stderr?.trim() || error.message)
  }
}
async function copySlices(source, dest, manifest) {
  await mkdir(join(dest, 'textures'))
  for (const file of [...textures(manifest), manifest.reference]) await cp(join(source, file), join(dest, file))
  await writeJson(join(dest, 'manifest.json'), manifest)
  return proof(dest, [])
}
export async function assetCommand(command, args) {
  const [dir, target, option] = args
  if (!dir) throw new Error(command + ' 需要企划目录')
  if (command === 'import') {
    if (!target || args.length !== 2) throw new Error('用法: rig import <切片目录> <新企划目录>')
    const manifest = await readManifest(dir)
    let pixels
    await newDirectory(target, async (dest) => {
      pixels = await copySlices(dir, dest, manifest)
      await writeJson(join(dest, 'rig.json'), emptyRig(manifest.sourceId))
    })
    return { output: target, pixels }
  }
  if (command === 'render') {
    if (!target || args.length > 3) throw new Error('用法: rig render <目录> <输出.png> [试动.json]')
    const pose = await workspace('preview', dir, option)
    await temporary(tmpdir(), async (temp) => {
      const frame = join(temp, 'pose.json')
      await writeJson(frame, pose)
      await proof(dir, ['--pose', frame, '--output', target])
    })
    return { output: target }
  }
  if (command === 'verify-slices') {
    if (args.length > 2) throw new Error('用法: rig verify-slices <目录> [差异图.png]')
    await readManifest(dir)
    return proof(dir, target ? ['--heatmap', target] : [])
  }
  if (command === 'defringe') {
    return runDefringe(args)
  }
  if (command === 'reimport') return reimportProject(args)
  return releaseProject(command, args)
}

async function reimportProject([oldDir, nextDir, ...args]) {
  if (!nextDir) throw new Error('用法: rig reimport <原企划> <新切片目录> [--map 映射.json] [--out 新企划]')
  let mapping = {},
    out,
    drawOrder
  while (args.length) {
    const flag = args.shift(),
      value = args.shift()
    if (!value) throw new Error('缺少选项值 ' + flag)
    if (flag === '--map') {
      const input = await readJson(value)
      mapping = input.layers ?? {}
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping))
        throw new Error('layers 须为旧 ID 到新 ID 的映射')
      drawOrder = input.drawOrder
    } else if (flag === '--out') out = value
    else throw new Error('未知选项 ' + flag)
  }
  const old = await readManifest(oldDir),
    next = await readManifest(nextDir)
  if (old.sourceId !== next.sourceId) throw new Error('跨源稿重导 ' + old.sourceId + ' / ' + next.sourceId)
  const oldIds = new Set(old.layers.map((l) => l.layerId)),
    newIds = new Set(next.layers.map((l) => l.layerId))
  const remap = new Map()
  for (const [from, to] of Object.entries(mapping)) {
    if (!oldIds.has(from) || !newIds.has(to) || remap.has(to))
      throw new Error('无效或重复的显式映射 ' + from + ' → ' + to)
    remap.set(to, from)
  }
  for (const l of next.layers) l.layerId = remap.get(l.layerId) ?? l.layerId
  for (const group of next.gelGroups ?? [])
    for (const m of group.members) m.layerId = remap.get(m.layerId) ?? m.layerId
  sliceManifestSchema.parse(next)
  const rig = await readJson(join(oldDir, 'rig.json'))
  if (drawOrder !== undefined) rig.drawOrder = drawOrder
  const fresh = new Map(next.layers.map((l) => [l.layerId, l]))
  const removed = [...oldIds].filter((id) => !fresh.has(id))
  const changed = []
  async function coverage(dir, manifest) {
    const result = new Map()
    for (const g of manifest.gelGroups ?? []) {
      const ids = g.members.map((m) => m.layerId)
      for (const m of g.members)
        result.set(m.layerId, JSON.stringify([ids, g.opacity, digest(await readFile(join(dir, m.coverage)))]))
    }
    return result
  }
  const oldCoverage = await coverage(oldDir, old),
    nextCoverage = await coverage(nextDir, next)
  for (const [i, l] of old.layers.entries()) {
    const n = fresh.get(l.layerId)
    if (!n) continue
    const fields = ['rect', 'groups', 'groupId', 'visible', 'opacity'].filter(
      (k) => JSON.stringify(l[k]) !== JSON.stringify(n[k]),
    )
    if (next.layers[i]?.layerId !== l.layerId) fields.push('order')
    if (digest(await readFile(join(oldDir, l.texture))) !== digest(await readFile(join(nextDir, n.texture))))
      fields.push('texture')
    if (oldCoverage.get(l.layerId) !== nextCoverage.get(l.layerId)) fields.push('coverage')
    if (fields.length) changed.push({ layerId: l.layerId, fields })
  }
  const canvasChanged = old.canvas.width !== next.canvas.width || old.canvas.height !== next.canvas.height
  const affected = new Set([...removed, ...changed.map((c) => c.layerId)])
  const bindings = rig.bindings ?? []
  // Legacy layer hierarchies propagate alignment changes to descendants.
  for (let before = -1; before !== affected.size;) {
    before = affected.size
    for (const b of bindings) if (canvasChanged || affected.has(b.parentId)) affected.add(b.layerId)
  }
  const report = {
    sourceId: old.sourceId,
    canvasChanged,
    added: [...fresh.keys()].filter((id) => !oldIds.has(id)),
    removed,
    changed,
    reviewBindings: bindings.filter((b) => affected.has(b.layerId)).map((b) => b.layerId),
  }
  let invalid
  try {
    createRig(next, rig).pose()
  } catch (error) {
    invalid = error.message
  }
  if (!out) return { ...report, valid: !invalid, error: invalid }
  if (invalid) throw new Error(JSON.stringify({ ...report, error: invalid }))
  await newDirectory(out, async (dest) => {
    await copySlices(nextDir, dest, next)
    await writeJson(join(dest, 'rig.json'), rig)
    for (const file of await motionNames(oldDir)) {
      await mkdir(join(dest, 'motions'), { recursive: true })
      await cp(join(oldDir, file), join(dest, file))
    }
  })
  return { ...report, output: out }
}
async function newDirectory(out, populate) {
  try {
    await access(out)
    throw new Error('输出目录已存在 ' + out)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  await mkdir(dirname(resolve(out)), { recursive: true })
  await temporary(dirname(resolve(out)), async (tmp) => {
    const dest = join(tmp, 'project')
    await mkdir(dest)
    await populate(dest)
    await rename(dest, out)
  })
}
async function motionNames(dir) {
  try {
    return (await readdir(join(dir, 'motions')))
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => 'motions/' + f)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}
async function releaseProject(command, [dir, idleName, responseName, out, reviewFile, ...extra]) {
  const publish = command === 'publish'
  if (!dir || !idleName || !responseName || (publish ? !out || !reviewFile : out !== undefined) || extra.length)
    throw new Error(
      '用法: rig review <目录> <待机.json> <响应.json> | publish <目录> <待机.json> <响应.json> <新包.zip> <人工验收.json>',
    )
  const idle = 'motions/' + idleName,
    response = 'motions/' + responseName
  const manifest = await readManifest(dir)
  if (manifest.format !== 'koma-rig.slices.v2') throw new Error('运行时发布需要 v2 切片')
  const raw = await readJson(join(dir, 'rig.json')),
    caps = exportCapabilities(raw)
  const staged = new Map()
  function json(name, value) {
    staged.set(name, Buffer.from(jsonBytes(value)))
  }
  json('manifest.json', manifest)
  json('rig.json', raw)
  json('rig-capabilities.json', caps)
  json('rig-capabilities.schema.json', capabilitiesJsonSchema(caps.format))
  const motions = {}
  for (const name of await motionNames(dir)) {
    motions[name] = await readJson(join(dir, name))
    json(name, motions[name])
  }
  for (const name of [manifest.reference, ...textures(manifest)])
    staged.set(name, await readFile(join(dir, name)))
  const files = Object.fromEntries([...staged].map(([name, data]) => [name, digest(data)]))
  const release = releaseSchema.parse({
    format: 'koma-rig.release.v1',
    rigId: caps.rigId,
    rigVersion: caps.rigVersion,
    idle,
    response,
    files,
  })
  const reviewId = digest(jsonBytes(release))
  const audit = auditMotions(manifest, raw, motions, idle, response)
  return temporary(tmpdir(), async (temp) => {
    const folder = join(temp, 'project')
    await mkdir(join(folder, 'textures'), { recursive: true })
    await mkdir(join(folder, 'motions'))
    for (const [name, data] of staged) await writeFile(join(folder, name), data)
    const slices = await proof(folder, [])
    const pose = join(temp, 'rest.json')
    await writeJson(pose, createRig(manifest, raw).pose())
    const rest = await proof(folder, ['--pose', pose])
    if (!publish) return { reviewId, audit, slices, rest }
    const signoff = await readJson(reviewFile)
    if (
      signoff.reviewId !== reviewId ||
      signoff.approved !== true ||
      typeof signoff.reviewer !== 'string' ||
      !signoff.reviewer.trim()
    )
      throw new Error('需要与本次 reviewId 一致的人工看片记录及署名')
    const acceptance = { reviewId, reviewer: signoff.reviewer, approved: true, audit, slices, rest }
    json('acceptance.json', acceptance)
    await writeJson(join(folder, 'acceptance.json'), acceptance)
    release.files['acceptance.json'] = digest(staged.get('acceptance.json'))
    await writeJson(join(folder, 'release.json'), release)
    await mkdir(dirname(resolve(out)), { recursive: true })
    await temporary(dirname(resolve(out)), async (dest) => {
      const archive = join(dest, 'package.zip')
      const script = `
from pathlib import Path
from sys import argv
from zipfile import ZIP_DEFLATED, ZipFile

root = Path(argv[1])
with ZipFile(argv[2], "x", ZIP_DEFLATED) as archive:
    for file in sorted(root.rglob("*")):
        if file.is_file():
            archive.write(file, file.relative_to(root))
`
      await run(python, ['-c', script, folder, archive])
      await link(archive, out)
    })
    return { output: out, reviewId, reviewer: signoff.reviewer }
  })
}
