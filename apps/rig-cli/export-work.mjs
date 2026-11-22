import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertStandalonePerformanceSource,
  createRig,
  sliceManifestSchema,
  workManifestSchema,
} from '@koma-rig/rig-core'
import { writeJson } from './workspace.mjs'

const RUNTIME_DIST = fileURLToPath(new URL('../../packages/rig-renderer/dist/runtime', import.meta.url))

export function parseExportWorkArgs(args) {
  const positionals = []
  let runtimeDir
  let includePoster = true
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-poster') {
      includePoster = false
    } else if (arg === '--runtime') {
      const value = args[++i]
      if (!value) throw new Error('--runtime 缺少输出目录路径')
      runtimeDir = value
    } else if (arg.startsWith('--')) {
      throw new Error('未知导出选项 ' + arg)
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length !== 2) {
    throw new Error('用法: rig export-work <作品目录或koma-work.json> <输出目录> [--runtime <运行时输出目录>] [--no-poster]')
  }
  return {
    source: positionals[0],
    outDir: positionals[1],
    runtimeDir,
    includePoster,
  }
}

function collectManifestAssets(manifest) {
  const assets = new Set(manifest.layers.map((l) => l.texture))
  if (manifest.format === 'koma-rig.slices.v2') {
    for (const group of manifest.gelGroups ?? []) {
      for (const member of group.members) assets.add(member.coverage)
    }
  }
  return [...assets].sort()
}

async function copyFileWithParents(src, dest) {
  await mkdir(dirname(dest), { recursive: true })
  await cp(src, dest)
  const info = await stat(dest)
  return info.size
}

async function resolveWorkInput(sourcePath) {
  const abs = resolve(sourcePath)
  const info = await stat(abs)
  if (info.isDirectory()) {
    return { workFile: join(abs, 'koma-work.json'), workDir: abs }
  }
  return { workFile: abs, workDir: dirname(abs) }
}

/**
 * Export a read-only, presentation-only Koma Live work bundle (like Spine/Live2D export)
 * with strictly runtime-required files and optional standalone WebGL runtime SDK.
 */
export async function runExportWork({ source, outDir, runtimeDir, includePoster = true }) {
  const { workFile, workDir } = await resolveWorkInput(source)
  const absOut = resolve(outDir)
  if (absOut === resolve(workDir) || absOut === '/') {
    throw new Error('输出目录不能与源作品目录相同或为根目录')
  }

  const rawWork = JSON.parse(await readFile(workFile, 'utf8'))
  const work = workManifestSchema.parse(rawWork)

  const rigDir = resolve(workDir, work.rig)
  const manifestRaw = JSON.parse(await readFile(join(rigDir, 'manifest.json'), 'utf8'))
  const manifest = sliceManifestSchema.parse(manifestRaw)
  const rigRaw = JSON.parse(await readFile(join(rigDir, 'rig.json'), 'utf8'))
  const model = createRig(manifest, rigRaw)
  model.pose()

  let perfCode
  let perfName
  if (work.performance) {
    const perfSrc = resolve(workDir, work.performance)
    perfCode = await readFile(perfSrc, 'utf8')
    assertStandalonePerformanceSource(perfCode)
    perfName = basename(perfSrc)
  }

  let posterSrc
  let posterName
  if (includePoster && work.poster) {
    posterSrc = resolve(workDir, work.poster)
    await stat(posterSrc)
    posterName = basename(posterSrc)
  }

  await rm(absOut, { recursive: true, force: true })
  await mkdir(join(absOut, 'slices'), { recursive: true })

  let files = 0
  let totalBytes = 0

  const assetPaths = collectManifestAssets(manifest)
  for (const relPath of assetPaths) {
    totalBytes += await copyFileWithParents(join(rigDir, relPath), join(absOut, 'slices', relPath))
    files++
  }

  // Write validated manifest.json and rig.json
  const outManifestPath = join(absOut, 'slices', 'manifest.json')
  const outRigPath = join(absOut, 'slices', 'rig.json')
  await writeJson(outManifestPath, manifestRaw)
  await writeJson(outRigPath, rigRaw)
  totalBytes += (await stat(outManifestPath)).size + (await stat(outRigPath)).size
  files += 2

  if (posterSrc && posterName) {
    totalBytes += await copyFileWithParents(posterSrc, join(absOut, 'slices', posterName))
    files++
  }

  if (perfCode !== undefined && perfName) {
    const outPerfPath = join(absOut, 'motion', perfName)
    await mkdir(dirname(outPerfPath), { recursive: true })
    await writeFile(outPerfPath, perfCode, 'utf8')
    totalBytes += (await stat(outPerfPath)).size
    files++
  }

  const exportedWork = {
    format: work.format,
    ...(work.id ? { id: work.id } : {}),
    ...(work.title ? { title: work.title } : {}),
    rig: './slices/',
    ...(perfName ? { performance: `./motion/${perfName}` } : {}),
    ...(posterName ? { poster: `./slices/${posterName}` } : {}),
    ...(work.viewport ? { viewport: work.viewport } : {}),
    ...(work.defaultState ? { defaultState: work.defaultState } : {}),
  }
  workManifestSchema.parse(exportedWork)
  const outWorkPath = join(absOut, 'koma-work.json')
  await writeJson(outWorkPath, exportedWork)
  totalBytes += (await stat(outWorkPath)).size
  files++

  let runtimeReport
  if (runtimeDir) {
    const absRuntimeOut = resolve(runtimeDir)
    if (absRuntimeOut === resolve(RUNTIME_DIST) || absRuntimeOut === '/') {
      throw new Error('运行时输出目录无效')
    }
    try {
      await stat(join(RUNTIME_DIST, 'player.js'))
    } catch {
      throw new Error('缺少独立运行时构建产物，请先运行 npm run build:runtime')
    }
    await rm(absRuntimeOut, { recursive: true, force: true })
    await mkdir(absRuntimeOut, { recursive: true })
    const entries = (await readdir(RUNTIME_DIST, { withFileTypes: true })).filter(
      (e) => e.isFile() && /\.(m?js|css|wasm)$/.test(e.name),
    )
    let rtBytes = 0
    for (const entry of entries) {
      rtBytes += await copyFileWithParents(join(RUNTIME_DIST, entry.name), join(absRuntimeOut, entry.name))
    }
    runtimeReport = {
      output: absRuntimeOut,
      files: entries.length,
      totalBytes: rtBytes,
    }
  }

  return {
    workId: work.id ?? model.caps.rigId,
    rigId: model.caps.rigId,
    output: absOut,
    files,
    totalBytes,
    posterIncluded: Boolean(posterName),
    ...(runtimeReport ? { runtime: runtimeReport } : {}),
  }
}
