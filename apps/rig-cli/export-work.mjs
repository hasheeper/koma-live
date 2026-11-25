import { execFile } from 'node:child_process'
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
const PSD_DIR = fileURLToPath(new URL('../../tools/psd', import.meta.url))
const PYTHON_BIN =
  process.env.KOMA_RIG_PYTHON ||
  join(PSD_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')

const RESIZE_BATCH_PY = `
import json, os, sys
import numpy as np
from PIL import Image

tasks = json.loads(sys.stdin.read())
for item in tasks:
    src, dst, w, h = item["src"], item["dst"], int(item["w"]), int(item["h"])
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im = Image.open(src).convert("RGBA")
    if im.width == w and im.height == h:
        im.save(dst, optimize=True)
        continue
    # Premultiply alpha before Lanczos resize to prevent dark edge halos on white hair/lace
    arr = np.asarray(im, dtype=np.float32) / 255.0
    a = arr[:, :, 3:4]
    pma = np.concatenate([arr[:, :, :3] * a, a], axis=2)
    pma_u8 = np.clip(np.round(pma * 255.0), 0, 255).astype(np.uint8)
    resized = np.asarray(Image.fromarray(pma_u8, "RGBA").resize((w, h), Image.Resampling.LANCZOS), dtype=np.float32) / 255.0
    ra = resized[:, :, 3:4]
    safe = np.where(ra > 1e-6, ra, 1.0)
    rgb = np.where(ra > 1e-6, np.clip(resized[:, :, :3] / safe, 0.0, 1.0), 0.0)
    out = np.concatenate([rgb, ra], axis=2)
    out_u8 = np.clip(np.round(out * 255.0), 0, 255).astype(np.uint8)
    Image.fromarray(out_u8, "RGBA").save(dst, optimize=True)
`

async function resizeBatchPngs(tasks) {
  if (!tasks.length) return
  await new Promise((resolvePromise, reject) => {
    const child = execFile(PYTHON_BIN, ['-c', RESIZE_BATCH_PY], { maxBuffer: 16 * 1024 * 1024 }, (err, _out, stderr) => {
      if (err) {
        if (err.code === 'ENOENT') {
          reject(new Error('降采导出需要 Python + Pillow/NumPy 环境，请运行 uv sync --project tools/psd 或设置 KOMA_RIG_PYTHON'))
        } else {
          reject(new Error(stderr?.trim() || err.message))
        }
        return
      }
      resolvePromise()
    })
    child.stdin.end(JSON.stringify(tasks))
  })
}

export function parseExportWorkArgs(args) {
  const positionals = []
  let runtimeDir
  let includePoster = true
  let scale = 1
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--no-poster') {
      includePoster = false
    } else if (arg === '--runtime') {
      const value = args[++i]
      if (!value) throw new Error('--runtime 缺少输出目录路径')
      runtimeDir = value
    } else if (arg === '--scale') {
      const value = Number(args[++i])
      if (!Number.isFinite(value) || value < 0.25 || value > 1) {
        throw new Error('--scale 须为 0.25..1 之间的数值（例如 --scale 0.5）')
      }
      scale = value
    } else if (arg.startsWith('--')) {
      throw new Error('未知导出选项 ' + arg)
    } else {
      positionals.push(arg)
    }
  }
  if (positionals.length !== 2) {
    throw new Error(
      '用法: rig export-work <作品目录或koma-work.json> <输出目录> [--runtime <运行时输出目录>] [--scale <0.25..1>] [--no-poster]',
    )
  }
  return {
    source: positionals[0],
    outDir: positionals[1],
    runtimeDir,
    includePoster,
    scale,
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
export async function runExportWork({ source, outDir, runtimeDir, includePoster = true, scale = 1 }) {
  if (!Number.isFinite(scale) || scale < 0.25 || scale > 1) {
    throw new Error('--scale 须为 0.25..1 之间的数值')
  }
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
  if (scale < 1 && manifest.format !== 'koma-rig.slices.v2') {
    throw new Error('--scale 降采导出仅支持 koma-rig.slices.v2 切片清单')
  }
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

  const baseTexScale = manifest.format === 'koma-rig.slices.v2' ? (manifest.textureScale ?? 1) : 1
  const outTextureScale = scale < 1 ? Number((baseTexScale * scale).toFixed(6)) : baseTexScale
  const assetPaths = collectManifestAssets(manifest)

  if (scale < 1) {
    // Map each texture / coverage asset to its logical slice rect -> target downsampled pixels
    const assetDims = new Map()
    for (const l of manifest.layers) {
      assetDims.set(l.texture, [l.rect[2], l.rect[3]])
    }
    if (manifest.format === 'koma-rig.slices.v2') {
      const layerMap = new Map(manifest.layers.map((l) => [l.layerId, l]))
      for (const g of manifest.gelGroups ?? []) {
        for (const m of g.members) {
          const l = layerMap.get(m.layerId)
          if (l) assetDims.set(m.coverage, [l.rect[2], l.rect[3]])
        }
      }
    }
    const tasks = assetPaths.map((relPath) => {
      const dims = assetDims.get(relPath)
      const w = Math.max(1, Math.round(dims[0] * outTextureScale))
      const h = Math.max(1, Math.round(dims[1] * outTextureScale))
      return { src: join(rigDir, relPath), dst: join(absOut, 'slices', relPath), w, h }
    })
    if (posterSrc && posterName) {
      tasks.push({
        src: posterSrc,
        dst: join(absOut, 'slices', posterName),
        w: Math.max(1, Math.round(manifest.canvas.width * outTextureScale)),
        h: Math.max(1, Math.round(manifest.canvas.height * outTextureScale)),
      })
    }
    await resizeBatchPngs(tasks)
    for (const t of tasks) {
      totalBytes += (await stat(t.dst)).size
      files++
    }
  } else {
    for (const relPath of assetPaths) {
      totalBytes += await copyFileWithParents(join(rigDir, relPath), join(absOut, 'slices', relPath))
      files++
    }
    if (posterSrc && posterName) {
      totalBytes += await copyFileWithParents(posterSrc, join(absOut, 'slices', posterName))
      files++
    }
  }

  // Write validated manifest.json (with textureScale when downsampled) and untouched rig.json
  const outManifestRaw =
    outTextureScale < 1 ? { ...manifestRaw, textureScale: outTextureScale } : manifestRaw
  sliceManifestSchema.parse(outManifestRaw)
  const outManifestPath = join(absOut, 'slices', 'manifest.json')
  const outRigPath = join(absOut, 'slices', 'rig.json')
  await writeJson(outManifestPath, outManifestRaw)
  await writeJson(outRigPath, rigRaw)
  totalBytes += (await stat(outManifestPath)).size + (await stat(outRigPath)).size
  files += 2

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
    textureScale: outTextureScale,
    posterIncluded: Boolean(posterName),
    ...(runtimeReport ? { runtime: runtimeReport } : {}),
  }
}
