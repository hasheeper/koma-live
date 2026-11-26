import { describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAuditMotion } from '../apps/rig-cli/audit-motion.mjs'
import { encodePngRgba, readPngRgba } from '../apps/rig-cli/png-alpha.mjs'
import { parseCliArgs } from '../apps/rig-cli/inspect-plan.mjs'
import { runBakeReference, runDoctor, runPadSlice, runReorder, runRepivot } from '../apps/rig-cli/rig-tools.mjs'
import { workspace } from '../apps/rig-cli/workspace.mjs'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const cliPath = join(root, 'apps/rig-cli/rig.mjs')

async function cli(...args) {
  const { stdout } = await run(process.execPath, [cliPath, ...args])
  return JSON.parse(stdout)
}

function solidRgba(w, h, r, g, b, a = 255) {
  const buf = new Uint8Array(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    buf[i * 4] = r
    buf[i * 4 + 1] = g
    buf[i * 4 + 2] = b
    buf[i * 4 + 3] = a
  }
  return buf
}

async function createTempRig() {
  const dir = await mkdtemp(join(tmpdir(), 'koma-rig-tools-'))
  await mkdir(join(dir, 'textures'), { recursive: true })
  await writeFile(join(dir, 'textures/0.png'), encodePngRgba(120, 160, solidRgba(120, 160, 210, 220, 240, 255)))
  await writeFile(join(dir, 'textures/1.png'), encodePngRgba(100, 120, solidRgba(100, 120, 180, 120, 130, 255)))
  await writeFile(join(dir, 'textures/2.png'), encodePngRgba(40, 160, solidRgba(40, 160, 235, 235, 245, 255)))

  const manifest = {
    format: 'koma-rig.slices.v2',
    blendSpace: 'srgb',
    sourceId: 'synthetic-char',
    canvas: { width: 400, height: 400 },
    reference: 'reference.png',
    layers: [
      { layerId: 'back_hair', name: 'Back Hair', groups: ['body'], texture: 'textures/0.png', sourceIndex: 0, rect: [140, 80, 120, 160], visible: true, opacity: 1 },
      { layerId: 'torso', name: 'Torso', groups: ['body'], texture: 'textures/1.png', sourceIndex: 1, rect: [150, 140, 100, 120], visible: true, opacity: 1 },
      { layerId: 'strand_r', name: 'Right Strand', groups: ['body'], texture: 'textures/2.png', sourceIndex: 2, rect: [240, 120, 40, 160], visible: true, opacity: 1 },
    ],
  }
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(
    join(dir, 'setup.json'),
    JSON.stringify([
      { op: 'set-parameter', parameter: { id: 'headYaw', meaning: 'yaw', unit: 'normalized', min: -1, max: 1, default: 0 } },
      { op: 'add-bone', boneId: 'root', start: [200, 360], end: [200, 260] },
      { op: 'add-bone', boneId: 'chest', parentBoneId: 'root', end: [200, 150] },
      { op: 'add-bone', boneId: 'strand_bone', parentBoneId: 'chest', start: [120, 280], end: [260, 280], snap: false },
      { op: 'bind', layerId: 'back_hair', boneId: 'chest' },
      { op: 'bind', layerId: 'torso', boneId: 'chest' },
      { op: 'bind', layerId: 'strand_r', boneId: 'strand_bone' },
      {
        op: 'set-mesh',
        layerId: 'torso',
        mesh: { points: [[0, 0], [100, 0], [100, 120], [0, 120]], indices: [0, 1, 2, 0, 2, 3] },
      },
      {
        op: 'set-cast-shadows',
        castShadows: [{ casters: ['strand_r'], receivers: ['torso'], offset: [3, 5] }],
      },
    ]),
  )
  await workspace('edit', dir, join(dir, 'setup.json'))
  await workspace('save', dir)
  await runBakeReference([dir])
  return dir
}

describe('rig-cli platform tools', () => {
  it('supports doctor, repivot, pad-slice with bleed row, reorder with shadow cleanup, and bake-reference', async () => {
    const dir = await createTempRig()
    try {
      // 1. doctor catches distant off-root pivot on strand_bone (120,280 vs [240,120]) — verify CLI dispatch end-to-end
      const doc1 = await cli('doctor', dir)
      expect(doc1.ok).toBe(true)
      expect(doc1.summary.maxRestDriftPx).toBe(0)
      expect(doc1.issues.some((i) => i.code === 'pivot_far_from_layer' && i.boneId === 'strand_bone')).toBe(true)

      // 2. repivot moves strand_bone to (260, 120) with 0.000 px rest drift!
      const rep = await runRepivot([dir, 'strand_bone', '260', '120'])
      expect(rep.applied).toBe(true)
      expect(rep.maxRestDriftPx).toBe(0)
      expect(rep.restStart).toEqual([260, 120])

      const doc2 = await runDoctor([dir])
      expect(doc2.issues.some((i) => i.code === 'pivot_far_from_layer' && i.boneId === 'strand_bone')).toBe(false)

      // 3. pad-slice expands torso upward by 30px, bleeds row 2, updates mesh + restOffset + reference.png with 0 drift!
      const pad = await runPadSlice([dir, 'torso', '--top', '30', '--bleed-top-row', '2'])
      expect(pad.applied).toBe(true)
      expect(pad.newRect).toEqual([150, 110, 100, 150])
      expect(pad.maxRestDriftPx).toBe(0)
      expect(pad.bakedReference).toBe(true)

      const paddedPng = await readPngRgba(join(dir, 'textures/1.png'))
      expect(paddedPng.width).toBe(100)
      expect(paddedPng.height).toBe(150)
      // Top bled pixel (0,0) carries the interior torso color (180,120,130,255)
      expect([paddedPng.rgba[0], paddedPng.rgba[1], paddedPng.rgba[2], paddedPng.rgba[3]]).toEqual([180, 120, 130, 255])

      // 4. reorder moves strand_r BEFORE torso in draw-order mode AND auto-cleans conflicting castShadow!
      const reord = await runReorder([dir, 'strand_r', '--before', 'torso'])
      expect(reord.applied).toBe(true)
      expect(reord.cleanedShadowCasters.length).toBe(1)

      const doc3 = await runDoctor([dir])
      expect(doc3.ok).toBe(true)
      expect(doc3.summary.warnings).toBe(0)
      expect(doc3.summary.errors).toBe(0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('audit-motion verifies healthy physics (using ctx.physics) and flags anti-inertia steel-plate scripts', async () => {
    const dir = await createTempRig()
    try {
      const goodScript = join(dir, 'good.js')
      await writeFile(
        goodScript,
        `
export const meta = { format: 'koma-rig.performance.v1', states: ['idle'] }
export default function createPerformance({ puppet, physics }) {
  const strand = physics.createHairStrand({ stiffness: 44, damping: 4.4, maxPx: 18, inertiaGain: 4.5 })
  const velFilter = physics.createLowPass(18, 0)
  let yaw = 0, prevYaw = 0
  return {
    update({ timeMs, dtMs, pointer }) {
      const dt = Math.min(dtMs, 50) / 1000
      const targetYaw = pointer?.inside ? pointer.nx : Math.sin(timeMs / 1000) * 0.25
      yaw += (targetYaw - yaw) * (dt > 0 ? 1 - Math.exp(-6.5 * dt) : 0)
      const yawVel = velFilter.step(dt > 1e-4 ? (yaw - prevYaw) / dt : 0, dt)
      prevYaw = yaw
      const { dx } = strand.step({ headYawVel: yawVel, dtSec: dt })
      puppet.setPose({
        timeMs,
        parameters: { headYaw: yaw },
        deform: { strand_r: { grid: [3, 6], field: (_u, v) => [dx * v * v, 0] } },
      })
    },
  }
}
`,
      )

      const goodAudit = await runAuditMotion([dir, '--script', goodScript, '--idle-ms', '800'])
      expect(goodAudit.ok).toBe(true)
      expect(goodAudit.summary.geometryErrors).toBe(0)
      expect(goodAudit.summary.antiInertiaAlerts).toBe(0)
      expect(goodAudit.summary.clampFreezeAlerts).toBe(0)

      // Anti-inertia steel-plate script: tip shoots FORWARD (+yawVel) in turn direction!
      const badScript = join(dir, 'bad.js')
      await writeFile(
        badScript,
        `
export const meta = { format: 'koma-rig.performance.v1', states: ['idle'] }
export default function createPerformance({ puppet }) {
  let yaw = 0, prevYaw = 0
  return {
    update({ timeMs, dtMs, pointer }) {
      const dt = Math.min(dtMs, 50) / 1000
      const targetYaw = pointer?.inside ? pointer.nx : 0
      yaw += (targetYaw - yaw) * (dt > 0 ? 1 - Math.exp(-6.5 * dt) : 0)
      const yawVel = dt > 1e-4 ? (yaw - prevYaw) / dt : 0
      prevYaw = yaw
      puppet.setPose({
        timeMs,
        parameters: { headYaw: yaw },
        deform: { strand_r: { grid: [3, 6], field: (_u, v) => [yawVel * 5 * v * v, 0] } },
      })
    },
  }
}
`,
      )

      const badAudit = await runAuditMotion([dir, '--script', badScript, '--idle-ms', '500'])
      expect(badAudit.summary.antiInertiaAlerts).toBeGreaterThanOrEqual(1)
      expect(badAudit.antiInertiaAlerts[0].layerId).toBe('strand_r')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('inspect-plan CLI parses --dpr and --step shortcut options', () => {
    const parsed = parseCliArgs(['examples/gbot', '--dpr', '1', '--step', '33.33', '--times', '0,500'])
    expect(parsed.mode).toBe('shortcut')
    expect(parsed.plan.maxDpr).toBe(1)
    expect(parsed.plan.stepMs).toBe(33.33)
  })
})
