#!/usr/bin/env node
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { editRig, emptyRig, sliceManifestSchema, workManifestSchema } from '@koma-rig/rig-core'
import { chromium } from 'playwright-core'
import { collectCaptureGroups, parseCliArgs, validateInspectPlan } from './inspect-plan.mjs'

const cliDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(cliDir, '../..')
const runtimeDir = resolve(repoRoot, 'packages/rig-renderer/dist/runtime')
const composerPath = resolve(cliDir, 'inspect-composer.mjs')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.css': 'text/css; charset=utf-8',
}

function usage() {
  return [
    '用法:',
    '  npm run inspect:live -- --plan <review-plan.json | -> [--out <dir>]',
    '  npm run inspect:live -- <koma-work.json | 作品或切片目录> [快捷选项]',
    '  npm run inspect:live -- --rig <切片目录> [--script <performance.js>] [快捷选项]',
    '  注：若切片目录暂无 rig.json 但含 setup.json，将在内存中自动合成骨架，不改动原目录。',
    '',
    '常用快捷选项:',
    '  --state <name[@ms]>       切换状态（可重复）',
    '  --trigger <name[@ms]>     触发事件（可重复，如 --trigger jump@100）',
    '  --pointer <x,y@ms>        注入逻辑指针坐标（[-1,1] 按归一化坐标处理）',
    '  --times <t1,t2,...>       关键帧时间点（生成横胶片带）',
    '  --onion <from..to:count>  生成 Spine 式洋葱皮叠影（如 150..850:8）',
    '  --focus <t1,t2>           洋葱皮实色主帧时间戳',
    '  --arcs <bone.end,...>     绘制运动弧线与时间点阵（支持 .start/.end/.pivot）',
    '  --guides <y=867,x=285>    绘制水平/垂直参考线（可选 :标签，如 y=867:ground）',
    '  --crop <x,y,w,h>          局部逻辑坐标特写裁切',
    '  --channel <rgba|alpha>    画面通道（alpha 输出黑白通道检视图）',
    '  --bg <dark|light|checker|#hex> 画格底色',
    '  --bones / --mesh          叠加骨骼连线 / 网格三角线',
    '  --frames                  额外导出 frames/*.png 原始单帧',
    '  --no-telemetry            跳过 telemetry.json 导出',
    '  --out <dir>               输出目录（默认 .tmp/inspect-live）',
  ].join('\n')
}

async function readStdinText() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function resolveInputPath(rawPath, primaryBase) {
  if (!rawPath) return undefined
  if (isAbsolute(rawPath)) return rawPath
  const fromBase = resolve(primaryBase, rawPath)
  if (existsSync(fromBase)) return fromBase
  const fromCwd = resolve(process.cwd(), rawPath)
  if (existsSync(fromCwd)) return fromCwd
  return fromBase
}

async function resolveAssetMounts(source, baseDir) {
  let rigDir
  let perfFile
  let posterFile
  let initialState
  let viewport = source.viewport

  if (source.work) {
    const workCandidate = resolveInputPath(source.work, baseDir)
    if (!existsSync(workCandidate)) throw new Error(`找不到作品清单或目录: ${workCandidate}`)
    const workStat = await stat(workCandidate)
    if (workStat.isDirectory()) {
      const nestedWork = resolve(workCandidate, 'koma-work.json')
      if (existsSync(nestedWork)) {
        const work = workManifestSchema.parse(JSON.parse(await readFile(nestedWork, 'utf8')))
        rigDir = resolve(workCandidate, work.rig)
        if (work.performance) perfFile = resolve(workCandidate, work.performance)
        if (work.poster) posterFile = resolve(workCandidate, work.poster)
        if (work.defaultState) initialState = work.defaultState
        if (!viewport && work.viewport) viewport = work.viewport
      } else if (existsSync(resolve(workCandidate, 'manifest.json'))) {
        rigDir = workCandidate
        const fallbackPerf = resolve(workCandidate, 'performance.js')
        if (!source.performance && existsSync(fallbackPerf)) perfFile = fallbackPerf
      } else {
        throw new Error(`目录中缺少 koma-work.json 或 manifest.json: ${workCandidate}`)
      }
    } else {
      const workDir = dirname(workCandidate)
      const work = workManifestSchema.parse(JSON.parse(await readFile(workCandidate, 'utf8')))
      rigDir = resolve(workDir, work.rig)
      if (work.performance) perfFile = resolve(workDir, work.performance)
      if (work.poster) posterFile = resolve(workDir, work.poster)
      if (work.defaultState) initialState = work.defaultState
      if (!viewport && work.viewport) viewport = work.viewport
    }
  }

  if (source.rig) rigDir = resolveInputPath(source.rig, baseDir)
  if (source.performance) perfFile = resolveInputPath(source.performance, baseDir)
  if (source.poster) posterFile = resolveInputPath(source.poster, baseDir)

  if (!rigDir || !existsSync(rigDir)) throw new Error(`找不到切片目录: ${rigDir ?? '(未指定)'}`)
  const rigStats = await stat(rigDir)
  if (!rigStats.isDirectory()) throw new Error(`rig 路径必须是目录: ${rigDir}`)
  if (perfFile && !existsSync(perfFile)) throw new Error(`找不到演出脚本: ${perfFile}`)
  if (posterFile && !existsSync(posterFile)) throw new Error(`找不到兜底图: ${posterFile}`)

  // Pre-synthesize rig.json in memory when source folder only has manifest.json (+ optional setup.json),
  // failing fast with exact schema/editRig diagnostics before launching Chromium.
  let synthesizedRigJson
  const rigJsonPath = resolve(rigDir, 'rig.json')
  if (!existsSync(rigJsonPath)) {
    const manifestPath = resolve(rigDir, 'manifest.json')
    if (!existsSync(manifestPath)) throw new Error(`切片目录缺少 manifest.json: ${rigDir}`)
    const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const setupPath = resolve(rigDir, 'setup.json')
    const rigDoc = existsSync(setupPath)
      ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await readFile(setupPath, 'utf8')))
      : emptyRig(manifest.sourceId)
    synthesizedRigJson = JSON.stringify(rigDoc)
  }

  return { rigDir, perfFile, posterFile, initialState, viewport, synthesizedRigJson }
}

async function sendFile(res, path, type = MIME[extname(path)] || 'application/octet-stream') {
  const body = await readFile(path)
  res.writeHead(200, { 'content-type': type })
  res.end(body)
}

async function startInspectServer(mounts) {
  if (!existsSync(resolve(runtimeDir, 'player.js'))) {
    throw new Error('缺少已构建的独立运行时 packages/rig-renderer/dist/runtime/player.js，请先运行 npm run build:runtime')
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      const pathname = decodeURIComponent(url.pathname)

      if (pathname === '/__koma/host.html') {
        res.writeHead(200, { 'content-type': MIME['.html'] })
        res.end('<!doctype html><html><body style="margin:0;background:transparent"><div id="host"></div></body></html>')
        return
      }
      if (pathname === '/__koma/inspect-composer.mjs') {
        await sendFile(res, composerPath)
        return
      }
      if (pathname.startsWith('/__koma/runtime/')) {
        const rel = pathname.slice('/__koma/runtime/'.length)
        const target = resolve(runtimeDir, rel)
        if (!target.startsWith(runtimeDir)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        await sendFile(res, target)
        return
      }
      if (pathname.startsWith('/__rig/')) {
        const rel = pathname.slice('/__rig/'.length)
        const target = resolve(mounts.rigDir, rel)
        if (!target.startsWith(mounts.rigDir)) {
          res.writeHead(403)
          res.end('Forbidden')
          return
        }
        // Serve pre-synthesized rig.json (from setup.json or emptyRig) when source folder has no saved rig.json
        if (rel === 'rig.json' && !existsSync(target) && mounts.synthesizedRigJson !== undefined) {
          res.writeHead(200, { 'content-type': MIME['.json'] })
          res.end(mounts.synthesizedRigJson)
          return
        }
        await sendFile(res, target)
        return
      }
      if (pathname.startsWith('/__perf/') && mounts.perfFile) {
        await sendFile(res, mounts.perfFile, MIME['.js'])
        return
      }
      if (pathname.startsWith('/__poster/') && mounts.posterFile) {
        await sendFile(res, mounts.posterFile)
        return
      }
      res.writeHead(404)
      res.end('Not Found')
    } catch (err) {
      if (err && typeof err === 'object' && err.code === 'ENOENT') {
        res.writeHead(404)
        res.end('Not Found')
      } else {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(err instanceof Error ? err.message : String(err))
      }
    }
  })

  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

function decodeDataUrlPng(dataUrl) {
  const prefix = 'data:image/png;base64,'
  if (!dataUrl.startsWith(prefix)) throw new Error('无效 PNG dataUrl')
  return Buffer.from(dataUrl.slice(prefix.length), 'base64')
}

export async function runInspectLive(planInput, baseDir = process.cwd()) {
  const plan = validateInspectPlan(planInput)
  const mounts = await resolveAssetMounts(plan.source, baseDir)
  const groups = collectCaptureGroups(plan)
  const outRoot = resolveInputPath(plan.outDir, baseDir)
  await mkdir(outRoot, { recursive: true })

  const server = await startInspectServer(mounts)
  const origin = `http://127.0.0.1:${server.address().port}`
  const sourceOpts = {
    rig: `${origin}/__rig/`,
    ...(mounts.perfFile ? { performance: `${origin}/__perf/${encodeURIComponent(basename(mounts.perfFile))}` } : {}),
    ...(mounts.posterFile ? { poster: `${origin}/__poster/${encodeURIComponent(basename(mounts.posterFile))}` } : {}),
    ...(mounts.initialState ? { initialState: mounts.initialState } : {}),
    ...(mounts.viewport ? { viewport: mounts.viewport } : {}),
  }

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  try {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 960 },
      deviceScaleFactor: Math.min(2, plan.maxDpr),
    })
    await page.goto(`${origin}/__koma/host.html`)

    const result = await page.evaluate(
      async ({ originUrl, sourceOpts: srcOpts, planData, captureGroups }) => {
        const { mountPerformance } = await import(`${originUrl}/__koma/runtime/player.js`)
        const { executeInspectPlan } = await import(`${originUrl}/__koma/inspect-composer.mjs`)
        const host = document.getElementById('host')
        return executeInspectPlan({
          mountPerformance,
          host,
          sourceOpts: srcOpts,
          plan: planData,
          groups: captureGroups,
        })
      },
      { originUrl: origin, sourceOpts, planData: plan, captureGroups: groups },
    )

    const writtenBoards = []
    for (const board of result.boards) {
      const target = resolve(outRoot, board.file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeDataUrlPng(board.dataUrl))
      writtenBoards.push({ file: target, width: board.width, height: board.height })
    }

    let telemetryPath
    if (plan.exportTelemetry) {
      telemetryPath = resolve(outRoot, 'telemetry.json')
      await writeFile(telemetryPath, JSON.stringify(result.telemetry, null, 2) + '\n', 'utf8')
    }

    const writtenFrames = []
    for (const frame of result.exportedFrames) {
      const target = resolve(outRoot, frame.file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, decodeDataUrlPng(frame.dataUrl))
      writtenFrames.push({ timeMs: frame.timeMs, file: target })
    }

    return {
      outDir: outRoot,
      boards: writtenBoards,
      telemetry: telemetryPath,
      frames: writtenFrames,
      captureChecks: result.captureChecks,
    }
  } finally {
    await browser.close()
    server.close()
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2))
  if (parsed.mode === 'help') {
    console.log(usage())
    return
  }

  let plan
  let baseDir = process.cwd()
  if (parsed.mode === 'plan') {
    let rawText
    if (parsed.planPath === '-') {
      rawText = await readStdinText()
    } else {
      const fullPlanPath = resolve(process.cwd(), parsed.planPath)
      rawText = await readFile(fullPlanPath, 'utf8')
      baseDir = dirname(fullPlanPath)
    }
    plan = JSON.parse(rawText)
    if (parsed.outDirOverride) plan.outDir = parsed.outDirOverride
  } else {
    plan = parsed.plan
  }

  const summary = await runInspectLive(plan, baseDir)
  console.log(JSON.stringify(summary, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[inspect:live]', err instanceof Error ? err.message : String(err))
    process.exitCode = 1
  })
}
