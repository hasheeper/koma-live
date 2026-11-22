import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { chromium } from 'playwright-core'
import { createServer as createViteServer, preview } from 'vite'
import { editRig, emptyRig, sliceManifestSchema } from '@koma-rig/rig-core'
import { runInspectLive } from '../apps/rig-cli/inspect-live.mjs'

const execFileAsync = promisify(execFile)

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.css': 'text/css; charset=utf-8',
}

async function startStaticServer(rootDir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/host.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html><body style="margin:0;background:#111"><div id="host" style="width:800px;height:600px"></div></body></html>`)
        return
      }
      const fullPath = resolve(rootDir, '.' + decodeURIComponent(url.pathname))
      if (!fullPath.startsWith(rootDir)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }
      const data = await readFile(fullPath)
      res.writeHead(200, { 'content-type': mimeTypes[extname(fullPath)] || 'application/octet-stream' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('Not Found')
    }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return server
}

test('Koma Live switches cleanly from Studio, renders coaxial DPR layers and drives meta controls without drift', async (t) => {
  const studioRoot = fileURLToPath(new URL('../apps/rig-studio', import.meta.url))
  const server = await preview({ root: studioRoot, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })

  await page.goto('http://127.0.0.1:' + server.httpServer.address().port)
  await page.getByRole('button', { name: '切换到动帧 Live' }).waitFor()
  await page.getByRole('button', { name: '切换到动帧 Live' }).click()

  // URL synced to ?view=live and brand subtitle updates to LIVE
  await page.waitForFunction(() => new URLSearchParams(location.search).get('view') === 'live')
  await page.locator('.koma-canvas-stack canvas').nth(2).waitFor()
  assert.equal(await page.locator('.brand-subtitle').textContent(), 'LIVE')

  // Coaxial 3-layer stack alignment + DPR 2D backing pixel scale
  const chainAlignment = await page.evaluate(() => {
    const stack = document.querySelector('.koma-canvas-stack')
    const canvases = [...stack.querySelectorAll('canvas')]
    const rects = canvases.map((c) => {
      const r = c.getBoundingClientRect()
      return { left: r.left, top: r.top, width: r.width, height: r.height }
    })
    return {
      count: canvases.length,
      rects,
      backBackingWidth: canvases[0].width,
      puppetLogicalWidth: canvases[1].width,
      frontBackingWidth: canvases[2].width,
    }
  })
  assert.equal(chainAlignment.count, 3, 'back + puppet + front coaxial canvases must mount')
  for (let i = 1; i < chainAlignment.rects.length; i++) {
    for (const k of ['left', 'top', 'width', 'height']) {
      assert.ok(Math.abs(chainAlignment.rects[i][k] - chainAlignment.rects[0][k]) < 0.15, `layer ${i} ${k} drift`)
    }
  }
  assert.ok(chainAlignment.backBackingWidth > chainAlignment.puppetLogicalWidth, '2D back layer applies Retina DPR scaling')
  assert.equal(chainAlignment.backBackingWidth, chainAlignment.frontBackingWidth)

  // Switch to built-in GBot live work and verify dynamic meta-driven controls
  await page.getByRole('button', { name: '作品菜单' }).click()
  await page.getByRole('button', { name: 'GBot · 活体动帧' }).click()
  await page.getByRole('button', { name: 'happy', exact: true }).waitFor()
  const poster = page.locator('.koma-canvas-stack img')
  assert.deepEqual(await poster.evaluate(async img => {
    await img.decode()
    return [img.naturalWidth, img.naturalHeight]
  }), [625, 995])
  await page.getByRole('button', { name: 'wave', exact: true }).waitFor()
  await page.getByRole('button', { name: 'happy', exact: true }).click()
  await page.getByRole('button', { name: 'tap', exact: true }).click()
  await page.getByRole('button', { name: 'wave', exact: true }).click()
  await page.getByRole('button', { name: 'jump', exact: true }).click()
  await page.waitForTimeout(120)
  assert.equal(await page.locator('.live-diagnostic').count(), 0, 'built-in GBot performance must run with zero errors')

  // Switch viewport preset to 360x540 portrait card and verify coaxial zero-drift inside card
  const presetBtn = page.getByRole('button', { name: '视口框实测' })
  await presetBtn.click() // full-bottom
  await presetBtn.click() // card-portrait
  await page.locator('.live-frame.preset-card-portrait').waitFor()
  await page.waitForTimeout(80)
  const cardCheck = await page.evaluate(() => {
    const frame = document.querySelector('.live-frame.preset-card-portrait').getBoundingClientRect()
    const canvases = [...document.querySelectorAll('.koma-canvas-stack canvas')].map((c) => c.getBoundingClientRect())
    return { frame, canvases }
  })
  assert.ok(Math.abs(cardCheck.frame.width - 360) < 1)
  assert.ok(Math.abs(cardCheck.frame.height - 540) < 1)
  for (const r of cardCheck.canvases) {
    assert.ok(r.left >= cardCheck.frame.left - 0.5 && r.right <= cardCheck.frame.right + 0.5)
    assert.ok(r.top >= cardCheck.frame.top - 0.5 && r.bottom <= cardCheck.frame.bottom + 0.5)
    assert.ok(Math.abs(r.left - cardCheck.canvases[0].left) < 0.15)
    assert.ok(Math.abs(r.top - cardCheck.canvases[0].top) < 0.15)
  }

  // Toggle pointer tracking off and confirm live UI button toggles state cleanly
  const pointerBtn = page.getByRole('button', { name: '鼠标跟随' })
  assert.equal(await pointerBtn.getAttribute('aria-pressed'), 'true')
  await pointerBtn.click()
  assert.equal(await pointerBtn.getAttribute('aria-pressed'), 'false')
  await pointerBtn.click()
  assert.equal(await pointerBtn.getAttribute('aria-pressed'), 'true')

  // Toggle inspection overlay and switch back to Studio cleanly
  await page.getByRole('button', { name: '审查叠加层' }).click()
  await page.waitForTimeout(60)
  const overlayHasPixels = await page.evaluate(() => {
    const c = document.querySelector('.live-overlay')
    const data = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) return true
    return false
  })
  assert.equal(overlayHasPixels, true, 'inspection overlay renders live bones/bounds')

  await page.getByRole('button', { name: '切回绑骨 Studio' }).click()
  await page.waitForFunction(() => !new URLSearchParams(location.search).has('view'))
  await page.getByRole('complementary', { name: '属性检查器' }).waitFor()
})

test('standalone player.js mountPerformance enforces all 4 contract guardrails across arbitrary directories', async (t) => {
  const server = await startStaticServer(repoRoot)
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({
    viewport: { width: 900, height: 700 },
    deviceScaleFactor: 2,
  })
  await page.goto(`${baseUrl}/host.html`)

  const result = await page.evaluate(async (origin) => {
    const { mountPerformance } = await import(`${origin}/packages/rig-renderer/dist/runtime/player.js`)
    const host = document.getElementById('host')

    // Load portable koma-work.json with decoupled slices/ and motion/ subdirectories
    const live = await mountPerformance(host, {
      work: `${origin}/tests/fixtures/live-demo/koma-work.json`,
      autoplay: false,
      stepMs: 10,
      maxDpr: 2,
    })

    // Guardrail 2: deterministic stepTo(640) produces identical bone poses even after perturbations
    live.stepTo(640)
    const poseA = structuredClone(live.puppet.pose.bones)
    live.trigger('flick')
    live.stepTo(200)
    live.stepTo(640)
    const poseB = structuredClone(live.puppet.pose.bones)

    // Guardrail 3: 2D DPR scaling active while logical canvas dimensions stay at 160x128
    const canvases = [...live.stackElement.querySelectorAll('canvas')]
    const backCanvas = canvases[0]
    const backTransformA = backCanvas.getContext('2d').getTransform().a
    const layoutBefore = live.getLayout()

    // Resize host container and verify zero-drift rescaling + pointer inverse mapping
    host.style.width = '320px'
    host.style.height = '240px'
    await new Promise((r) => setTimeout(r, 60))
    const layoutAfter = live.getLayout()
    const stackRect = live.stackElement.getBoundingClientRect()
    live.element.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: stackRect.left + stackRect.width / 2,
        clientY: stackRect.top + stackRect.height / 2,
        bubbles: true,
      }),
    )
    const centerPointer = live.pointer
    live.setPointerTracking(false)
    live.element.dispatchEvent(
      new PointerEvent('pointermove', {
        clientX: stackRect.left + 10,
        clientY: stackRect.top + 10,
        bubbles: true,
      }),
    )
    const pointerWhenDisabled = live.pointer
    live.destroy()

    // Guardrail 1: external relative import is rejected before execution
    let guardrail1Message = ''
    try {
      await mountPerformance(host, {
        rig: `${origin}/tests/fixtures/live-demo/slices/`,
        performance: { code: `import { x } from './helper.js'\nexport default () => ({ update() {} })` },
      })
    } catch (e) {
      guardrail1Message = e.message
    }

    // Guardrail 4a: errorPolicy 'pause' stops immediately and invokes onError exactly once (no 60fps storm)
    let pauseErrorCount = 0
    const badPause = await mountPerformance(host, {
      rig: `${origin}/tests/fixtures/live-demo/slices/`,
      performance: {
        code: `export default function (ctx) {
          return { update() { ctx.puppet.setPose({ bones: { tip: { rotation: 179 } } }) } }
        }`,
      },
      errorPolicy: 'pause',
      onError: () => { pauseErrorCount++ },
    })
    await new Promise((r) => setTimeout(r, 180))
    const pausedAfterError = !badPause.playing
    badPause.destroy()

    // Guardrail 4b: errorPolicy 'throttle' deduplicates repeating errors within throttle window
    let throttleErrorCount = 0
    const badThrottle = await mountPerformance(host, {
      rig: `${origin}/tests/fixtures/live-demo/slices/`,
      performance: {
        code: `export default function (ctx) {
          return { update() { ctx.puppet.setPose({ bones: { tip: { rotation: 179 } } }) } }
        }`,
      },
      errorPolicy: 'throttle',
      errorThrottleMs: 1000,
      onError: () => { throttleErrorCount++ },
    })
    await new Promise((r) => setTimeout(r, 180))
    badThrottle.destroy()

    return {
      poseA,
      poseB,
      backWidth: backCanvas.width,
      backTransformA,
      layoutBefore,
      layoutAfter,
      centerPointer,
      pointerWhenDisabled,
      guardrail1Message,
      pauseErrorCount,
      pausedAfterError,
      throttleErrorCount,
    }
  }, baseUrl)

  assert.deepEqual(result.poseA, result.poseB, 'stepTo(640) must be 100% deterministic')
  assert.equal(result.layoutBefore.canvasWidth, 160)
  assert.equal(result.layoutBefore.canvasHeight, 128)
  assert.equal(result.backWidth, 320, '2D back canvas scales to 2x maxDpr physical pixels')
  assert.equal(result.backTransformA, 2, '2D context transform pre-scaled to keep logical coordinates at 160x128')
  assert.ok(result.layoutAfter.scale < result.layoutBefore.scale, 'ResizeObserver rescales box to fit 320x240')
  assert.equal(result.centerPointer.inside, true)
  assert.ok(Math.abs(result.centerPointer.x - 80) < 0.5, 'pointer maps to logical center x=80')
  assert.ok(Math.abs(result.centerPointer.y - 64) < 0.5, 'pointer maps to logical center y=64')
  assert.ok(Math.abs(result.centerPointer.nx) < 0.01 && Math.abs(result.centerPointer.ny) < 0.01)
  assert.equal(result.pointerWhenDisabled.inside, false, 'disabling pointerTracking resets and ignores DOM pointer events')
  assert.equal(result.pointerWhenDisabled.nx, 0)
  assert.equal(result.pointerWhenDisabled.ny, 0)
  assert.match(result.guardrail1Message, /单文件自包含/)
  assert.equal(result.pauseErrorCount, 1, 'errorPolicy pause fires onError once with zero storm')
  assert.equal(result.pausedAfterError, true, 'errorPolicy pause freezes playback')
  assert.equal(result.throttleErrorCount, 1, 'errorPolicy throttle deduplicates repeating 60fps errors')
})

test('inspect:live renders flexible composite boards, alpha channel, cross-viewport compare and telemetry rotationDeg', async (t) => {
  const outDir = await mkdtemp(join(tmpdir(), 'koma-inspect-live-'))
  t.after(() => rm(outDir, { recursive: true, force: true }))

  const summary = await runInspectLive(
    {
      format: 'koma-rig.inspect.v1',
      source: { work: join(repoRoot, 'tests/fixtures/live-demo/koma-work.json') },
      outDir,
      exportTelemetry: true,
      exportFrames: true,
      timeline: [
        { at: 0, state: 'gust' },
        { at: 120, trigger: 'flick' },
        { at: 140, to: 320, pointerTrack: [{ nx: -0.6, ny: -0.4 }, { nx: 0.6, ny: 0.5 }] },
      ],
      boards: [
        {
          file: 'composite-review.png',
          title: 'Chain Strip Live Inspection',
          width: 1280,
          sections: [
            {
              columns: 1,
              panels: [
                {
                  kind: 'strip',
                  caption: 'Timeline Strip',
                  columns: 4,
                  frames: [
                    { t: 0, label: 'start' },
                    { t: 120, label: 'flick' },
                    { t: 260, label: 'peak' },
                    { t: 420, label: 'settle' },
                  ],
                  overlays: { guides: [{ y: 64, label: 'mid' }] },
                },
              ],
            },
            {
              columns: [1.2, 0.9, 1.1],
              panels: [
                {
                  kind: 'onion',
                  caption: 'Spine Onion + Motion Arc',
                  range: { from: 120, to: 360, count: 5 },
                  focus: 240,
                  tint: 'spine',
                  background: 'checker',
                  overlays: {
                    arcs: [{ target: 'tip', point: 'end', color: '#3df2ff', dots: true }],
                    bones: true,
                  },
                },
                {
                  kind: 'frame',
                  caption: 'Alpha Channel Inspection',
                  t: 260,
                  channel: 'alpha',
                  crop: [0, 20, 160, 88],
                },
                {
                  kind: 'compare',
                  caption: 'Cross-Viewport Same-t Compare',
                  mode: 'side-by-side',
                  entries: [
                    { t: 260, label: 'full', container: [800, 600], viewport: { fit: 'contain', anchor: [0.5, 0.5] } },
                    { t: 260, label: 'card', container: [360, 540], viewport: { fit: 'contain', anchor: [0.5, 1] } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    repoRoot,
  )

  // Every capture group (logical + 2 distinct cross-viewport containers at same t=260ms) produced non-empty WebGL frames
  assert.equal(summary.captureChecks.length, 3)
  for (const check of summary.captureChecks) {
    assert.equal(check.allNonEmpty, true, `capture group ${check.key} must not produce blank WebGL frames`)
    assert.equal(check.errorCount, 0)
  }

  // Board PNG & raw frames written cleanly
  assert.equal(summary.boards.length, 1)
  assert.equal(summary.boards[0].width, 1280)
  const pngBytes = await readFile(summary.boards[0].file)
  assert.deepEqual([...pngBytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'valid PNG signature')
  assert.ok(summary.frames.length >= 6, 'raw transparent frames exported')

  // Telemetry includes rotationDeg and effectiveScale, reflecting real motion after flick@120
  const telemetry = JSON.parse(await readFile(summary.telemetry, 'utf8'))
  assert.equal(telemetry.format, 'koma-rig.telemetry.v1')
  const sample0 = telemetry.samples.find((s) => s.timeMs === 0)
  const sample260 = telemetry.samples.find((s) => s.timeMs === 260)
  assert.ok(sample0 && sample260)
  assert.equal(typeof sample0.bones.tip.rotationDeg, 'number')
  assert.equal(typeof sample260.bones.tip.rotationDeg, 'number')
  assert.notEqual(sample0.bones.tip.rotationDeg, sample260.bones.tip.rotationDeg)
  assert.deepEqual(sample0.bones.base.effectiveScale, [1, 1])

  // Verify shortcut CLI entrypoint executes cleanly from repo root
  const cliOut = join(outDir, 'cli-shortcut')
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      join(repoRoot, 'apps/rig-cli/inspect-live.mjs'),
      join(repoRoot, 'tests/fixtures/live-demo/koma-work.json'),
      '--trigger',
      'flick@120',
      '--times',
      '0,120,260',
      '--onion',
      '120..360:4',
      '--channel',
      'alpha',
      '--out',
      cliOut,
    ],
    { cwd: repoRoot },
  )
  const cliSummary = JSON.parse(stdout)
  assert.equal(cliSummary.boards.length, 1)
  assert.equal(cliSummary.captureChecks[0].allNonEmpty, true)

  // Verify directory shorthand + GBot rigid-body invariants
  // + same-timestamp state+pointer ordering + overlay compare + crop-safe X/Y guides & multi-arc legend
  const gbotOut = join(outDir, 'gbot-rigid-check')
  const gbotSummary = await runInspectLive(
    {
      format: 'koma-rig.inspect.v1',
      source: {
        // Directory shorthand: auto-detects koma-work.json inside examples/gbot
        work: join(repoRoot, 'examples/gbot'),
      },
      outDir: gbotOut,
      exportTelemetry: true,
      timeline: [
        { at: 0, state: 'idle' },
        { at: 0, pointer: { nx: 0.75, ny: -0.25, inside: true } },
        { at: 100, pointer: { inside: false } },
        { at: 100, trigger: 'jump' },
      ],
      boards: [
        {
          file: 'gbot-check.png',
          sections: [
            {
              columns: 1,
              panels: [
                {
                  kind: 'strip',
                  times: [0, 100, 280, 580, 880, 1360],
                  overlays: {
                    guides: [
                      { y: 867, label: 'ground' },
                      { x: 280, label: 'center', color: '#38bdf8' },
                    ],
                  },
                },
              ],
            },
            {
              columns: [1, 1],
              panels: [
                {
                  kind: 'onion',
                  range: { from: 280, to: 880, count: 5 },
                  focus: 580,
                  overlays: {
                    arcs: [
                      { target: 'hip', point: 'start', dots: true },
                      { target: 'foot_r', point: 'start', dots: true },
                    ],
                    guides: [
                      { y: 867, label: 'ground' },
                      { x: 280, label: 'axis', color: '#38bdf8' },
                    ],
                  },
                },
                {
                  kind: 'compare',
                  mode: 'overlay',
                  crop: [150, 740, 300, 210],
                  entries: [
                    { t: 100, label: 'rest' },
                    { t: 280, label: 'squat' },
                  ],
                  overlays: {
                    bones: ['shin_r', 'foot_r'],
                    guides: [
                      { y: 867, label: 'ground' },
                      { x: 207, label: 'foot_r', color: '#fbbf24' },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    },
    repoRoot,
  )
  assert.equal(gbotSummary.captureChecks[0].allNonEmpty, true)
  assert.equal(gbotSummary.captureChecks[0].errorCount, 0)
  const gbotTelemetry = JSON.parse(await readFile(gbotSummary.telemetry, 'utf8'))
  const gbotAt0 = gbotTelemetry.samples.find((item) => item.timeMs === 0)
  assert.equal(gbotAt0.pointer.inside, true, 'same-timestamp pointer after state must take effect on frame 0')
  assert.ok(Math.abs(gbotAt0.pointer.nx - 0.75) < 1e-3)
  assert.ok(Math.abs(gbotAt0.pointer.ny - -0.25) < 1e-3)
  for (const sample of gbotTelemetry.samples) {
    assert.deepEqual(sample.errors, [])
    for (const [boneId, b] of Object.entries(sample.bones)) {
      assert.deepEqual(b.effectiveScale, [1, 1], `${boneId} @ ${sample.timeMs}ms must stay strictly rigid`)
    }
  }
  const groundedTimes = [100, 280, 880, 1360]
  for (const tMs of groundedTimes) {
    const s = gbotTelemetry.samples.find((item) => item.timeMs === tMs)
    assert.ok(Math.abs(s.bones.foot_r.start[0] - 207) < 0.2, `foot_r.x grounded @ ${tMs}ms`)
    assert.ok(Math.abs(s.bones.foot_r.start[1] - 867) < 0.2, `foot_r.y grounded @ ${tMs}ms`)
    assert.ok(Math.abs(s.bones.foot_l.start[0] - 307) < 0.2, `foot_l.x grounded @ ${tMs}ms`)
    assert.ok(Math.abs(s.bones.foot_l.start[1] - 853) < 0.2, `foot_l.y grounded @ ${tMs}ms`)
  }
  const apex = gbotTelemetry.samples.find((item) => item.timeMs === 580)
  assert.ok(apex.bones.foot_r.start[1] < 800, 'GBot right boot lifts cleanly off ground at jump apex')

  // Verify broken setup.json fails fast with explicit error instead of silent HTTP 404
  const badRigDir = join(outDir, 'bad-setup-dir')
  await cp(join(repoRoot, 'tests/fixtures/chain-strip'), badRigDir, { recursive: true })
  await writeFile(join(badRigDir, 'setup.json'), JSON.stringify([{ op: 'bind', layerId: 'nonexistent', boneId: 'base' }]))
  await assert.rejects(
    runInspectLive(
      {
        format: 'koma-rig.inspect.v1',
        source: { rig: badRigDir },
        outDir: join(outDir, 'bad-out'),
        boards: [{ file: 'x.png', sections: [{ panels: [{ kind: 'frame', t: 0 }] }] }],
      },
      repoRoot,
    ),
    /nonexistent|缺少|骨骼|图层/,
  )
})

test('inspect:live reports missing and unreadable slice textures to the caller', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'koma-texture-errors-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const rig = join(temp, 'rig')
  await cp(join(repoRoot, 'tests/fixtures/chain-strip'), rig, { recursive: true })
  const plan = {
    format: 'koma-rig.inspect.v1',
    source: { rig },
    outDir: join(temp, 'out'),
    boards: [{ file: 'frame.png', sections: [{ panels: [{ kind: 'frame', t: 0 }] }] }],
  }
  const texture = join(rig, 'textures/strip.png')
  await rm(texture)
  await assert.rejects(runInspectLive(plan), /strip\.png · HTTP 404/)
  await mkdir(texture)
  await assert.rejects(runInspectLive(plan), /strip\.png · HTTP 500/)
})

test('P0-1 dev workspace auto-loads ?work=, preserves context across Studio↔Live, and restores last session on reload', async t => {
  const studioRoot = fileURLToPath(new URL('../apps/rig-studio', import.meta.url))
  const devServer = await createViteServer({
    root: studioRoot,
    mode: 'development',
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 },
  })
  await devServer.listen()
  t.after(() => devServer.close())
  const baseUrl = devServer.resolvedUrls.local[0].replace(/\/$/, '')

  // Dev workspace endpoint discovers portable examples
  const listRes = await fetch(`${baseUrl}/__koma-workspace/list`)
  assert.equal(listRes.status, 200)
  const { works } = await listRes.json()
  assert.ok(works.some(w => w.path === 'examples/gbot' && w.kind === 'work'))

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })

  // 1. Direct URL ?view=live&work=examples/gbot loads immediately with auto-reload toggle active
  await page.goto(`${baseUrl}/?view=live&work=examples/gbot`)
  await page.locator('.koma-canvas-stack canvas').nth(2).waitFor()
  const titleInLive = await page.locator('.file-name').textContent()
  assert.match(titleInLive ?? '', /GBot/, `unexpected live title: ${titleInLive}`)
  await page.getByRole('button', { name: 'happy', exact: true }).waitFor()
  const autoWatchBtn = page.getByRole('button', { name: '自动热重载' })
  await autoWatchBtn.waitFor()
  assert.equal(await autoWatchBtn.getAttribute('aria-pressed'), 'true')
  await page.getByRole('button', { name: 'happy', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'happy', exact: true }).getAttribute('aria-pressed'), 'true')

  // 2. Switching to Studio automatically opens the same work's slices/ rig without manual folder picking
  await page.getByRole('button', { name: '切回绑骨 Studio' }).click()
  await page.locator('.pixi-surface canvas').waitFor()
  await page.waitForFunction(() => document.querySelector('.file-name')?.textContent?.includes('GBot'))

  // 3. Switching back to Live preserves the active work & state ('happy')
  await page.getByRole('button', { name: '切换到动帧 Live' }).click()
  await page.locator('.koma-canvas-stack canvas').nth(2).waitFor()
  const happyAfterReturn = page.getByRole('button', { name: 'happy', exact: true })
  await happyAfterReturn.waitFor()
  assert.equal(await happyAfterReturn.getAttribute('aria-pressed'), 'true')

  // 4. Reloading plain root URL (without ?work=) restores the last opened dev session automatically
  await page.goto(`${baseUrl}/`)
  await page.locator('.pixi-surface canvas').waitFor()
  await page.waitForFunction(() => document.querySelector('.file-name')?.textContent?.includes('GBot'))
  assert.equal(await page.locator('.notice.problem').count(), 0)
})

test('M4 Mesh Field deforms normal + gelGroups layers in WebGL and cleanly restores exact rest pixels when omitted', async t => {
  const server = await startStaticServer(repoRoot)
  t.after(() => server.close())
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } })
  await page.goto(`${baseUrl}/host.html`)

  const manifest = sliceManifestSchema.parse({
    format: 'koma-rig.slices.v2',
    sourceId: 'm4-gel-demo',
    blendSpace: 'srgb',
    canvas: { width: 200, height: 220 },
    reference: 'reference.png',
    layers: [
      { layerId: 'bell_back', name: '伞盖后', groups: [], texture: 'textures/bell_back.png', rect: [30, 20, 120, 80], visible: true, opacity: 1 },
      { layerId: 'bell_front', name: '伞盖前', groups: [], texture: 'textures/bell_front.png', rect: [50, 30, 100, 70], visible: true, opacity: 1 },
      { layerId: 'ribbon', name: '丝带', groups: [], texture: 'textures/ribbon.png', rect: [84, 100, 32, 100], visible: true, opacity: 1 },
    ],
    gelGroups: [
      {
        opacity: 0.65,
        members: [
          { layerId: 'bell_back', coverage: 'textures/cov_back.png' },
          { layerId: 'bell_front', coverage: 'textures/cov_front.png' },
        ],
      },
    ],
  })
  const rig = editRig(manifest, emptyRig('m4-gel-demo'), [
    { op: 'add-bone', boneId: 'root', name: '根', start: [100, 60], end: [100, 120] },
    { op: 'bind', layerId: 'bell_back', boneId: 'root' },
    { op: 'bind', layerId: 'bell_front', boneId: 'root' },
    { op: 'bind', layerId: 'ribbon', boneId: 'root' },
  ])

  const result = await page.evaluate(async ({ origin, manifest, rig }) => {
    const { mountLiveRig, mountPerformance } = await import(`${origin}/packages/rig-renderer/dist/runtime/player.js`)
    const host = document.getElementById('host')

    async function makePngBlob(w, h, draw) {
      const c = new OffscreenCanvas(w, h)
      const g = c.getContext('2d')
      draw(g, w, h)
      return c.convertToBlob({ type: 'image/png' })
    }

    // Create a translucent gelGroup (two overlapping bell layers with coverage masks) + one standalone ribbon layer
    const bellBackTex = await makePngBlob(120, 80, (g, w, h) => {
      g.fillStyle = 'rgba(80, 170, 255, 1)'
      g.fillRect(10, 10, w - 20, h - 20)
    })
    const bellFrontTex = await makePngBlob(100, 70, (g, w, h) => {
      g.fillStyle = 'rgba(255, 110, 190, 1)'
      g.fillRect(8, 8, w - 16, h - 16)
    })
    const bellBackCov = await makePngBlob(120, 80, (g, w, h) => {
      g.fillStyle = '#ffffff'
      g.fillRect(10, 10, w - 20, h - 20)
    })
    const bellFrontCov = await makePngBlob(100, 70, (g, w, h) => {
      g.fillStyle = '#ffffff'
      g.fillRect(8, 8, w - 16, h - 16)
    })
    const ribbonTex = await makePngBlob(32, 100, (g, w, h) => {
      g.fillStyle = 'rgba(255, 220, 90, 1)'
      g.fillRect(6, 0, w - 12, h)
    })
    const refTex = await makePngBlob(200, 220, () => {})

    const files = new Map([
      ['reference.png', refTex],
      ['textures/bell_back.png', bellBackTex],
      ['textures/bell_front.png', bellFrontTex],
      ['textures/cov_back.png', bellBackCov],
      ['textures/cov_front.png', bellFrontCov],
      ['textures/ribbon.png', ribbonTex],
    ])

    function snapshotCanvas(canvas) {
      const c = new OffscreenCanvas(canvas.width, canvas.height)
      const g = c.getContext('2d')
      g.drawImage(canvas, 0, 0)
      return g.getImageData(0, 0, canvas.width, canvas.height).data
    }

    function diffPixels(a, b) {
      let diffs = 0
      for (let i = 0; i < a.length; i += 4) {
        if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) diffs++
      }
      return diffs
    }

    // 1. Test mountLiveRig direct deform -> dynamic disable pixel-exact restoration (including gelGroups coverage!)
    const puppet = await mountLiveRig(host, { manifest, rig, files })
    const pxRest = snapshotCanvas(puppet.canvas)

    puppet.setPose({
      deform: {
        bell_back: { grid: [6, 6], field: (_u, v, x) => [Math.sin(x * 0.06) * 8 * v, Math.cos(x * 0.05) * 6 * v] },
        bell_front: { grid: [6, 6], field: (_u, v, x) => [Math.sin(x * 0.06) * 8 * v, Math.cos(x * 0.05) * 6 * v] },
        ribbon: { grid: [3, 8], field: (_u, v) => [Math.sin(v * 5) * v * v * 14, 0] },
      },
    })
    const pxDeformed = snapshotCanvas(puppet.canvas)

    // Subsequent frame omits deform -> must cleanly restore exact rest pixels with 0 residue
    puppet.setPose({})
    const pxRestored = snapshotCanvas(puppet.canvas)
    puppet.destroy()

    // 2. Test mountPerformance deterministic stepTo(t) with Mesh Field inside single-file script
    const live = await mountPerformance(host, {
      rig: { manifest, rig, files },
      autoplay: false,
      stepMs: 10,
      performance: {
        code: `
          export const meta = { format: 'koma-rig.performance.v1', title: 'M4 Jellyfish Field', states: ['float'] }
          export default function ({ puppet }) {
            return {
              reset() { puppet.reset() },
              update({ timeMs }) {
                const t = timeMs / 1000
                const bellField = (_u, v, x) => [Math.sin(x * 0.05 - t * 3) * 6 * v, Math.cos(x * 0.04 - t * 2) * 4 * v]
                puppet.setPose({
                  timeMs,
                  deform: {
                    bell_back: { grid: [6, 6], field: bellField },
                    bell_front: { grid: [6, 6], field: bellField },
                    ribbon: { grid: [3, 8], field: (_u, v) => [Math.sin(v * 5 - t * 4) * v * v * 12, 0] },
                  },
                })
              },
            }
          }
        `,
      },
    })
    live.stepTo(400)
    const vertsA = live.puppet.pose.parts.find((p) => p.layerId === 'ribbon').geometry.vertices.slice()
    live.stepTo(100)
    live.stepTo(400)
    const vertsB = live.puppet.pose.parts.find((p) => p.layerId === 'ribbon').geometry.vertices.slice()
    live.destroy()

    return {
      deformedDiffCount: diffPixels(pxRest, pxDeformed),
      restoredDiffCount: diffPixels(pxRest, pxRestored),
      deterministicMatch: JSON.stringify(vertsA) === JSON.stringify(vertsB),
      ribbonVertexCount: vertsA.length / 2,
    }
  }, { origin: baseUrl, manifest, rig })

  assert.ok(result.deformedDiffCount > 500, 'Mesh Field must visibly deform normal + gelGroups WebGL pixels')
  assert.equal(result.restoredDiffCount, 0, 'Omitting deform on next frame must restore exact rest pixels (0 mismatch)')
  assert.equal(result.deterministicMatch, true, 'Mesh Field under mountPerformance stepTo(t) must be 100% deterministic')
  assert.equal(result.ribbonVertexCount, 36, '3x8 grid produces (3+1)*(8+1) = 36 vertices')
})
