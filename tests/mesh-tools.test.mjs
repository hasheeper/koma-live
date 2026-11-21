import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createRig, sliceManifestSchema } from '@koma-rig/rig-core'
import { readPngAlpha } from '../apps/rig-cli/png-alpha.mjs'
import { parseAutoMeshArgs, parseCheckBendArgs, runAutoMesh, runCheckBend } from '../apps/rig-cli/mesh-tools.mjs'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('rig-cli P0-2 mesh-tools (zero-dep PNG alpha, auto-mesh, check-bend)', () => {
  it('decodes real 8-bit RGBA slice PNG alpha channels accurately', async () => {
    const strip = await readPngAlpha(join(repoRoot, 'examples/chain-strip/textures/strip.png'))
    expect(strip.width).toBe(112)
    expect(strip.height).toBe(16)
    expect(strip.alpha.length).toBe(112 * 16)
    let opaqueCount = 0
    for (const a of strip.alpha) if (a > 0) opaqueCount++
    expect(opaqueCount).toBeGreaterThan(1000)

    const dkhTex = await readPngAlpha(join(repoRoot, 'examples/dkh/slices/textures/0.png'))
    expect(dkhTex.width).toBeGreaterThan(0)
    expect(dkhTex.height).toBeGreaterThan(0)
    expect(dkhTex.alpha.length).toBe(dkhTex.width * dkhTex.height)
  })

  it('runs auto-mesh in dry-run and write modes on boneChain layers without breaking rig validation', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'koma-automesh-'))
    try {
      await cp(join(repoRoot, 'examples/chain-strip'), temp, { recursive: true })

      const dry = await runAutoMesh(parseAutoMeshArgs([temp, '--dry-run']))
      expect(dry.dryRun).toBe(true)
      expect(dry.updatedCount).toBe(1)
      expect(dry.layers[0].status).toBe('generated')
      expect(dry.layers[0].vertices).toBeGreaterThanOrEqual(4)

      const written = await runAutoMesh(parseAutoMeshArgs([temp]))
      expect(written.dryRun).toBe(false)
      expect(written.updatedCount).toBe(1)

      const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(join(temp, 'manifest.json'), 'utf8')))
      const rigDoc = JSON.parse(await readFile(join(temp, 'rig.json'), 'utf8'))
      const model = createRig(manifest, rigDoc)
      const stripBinding = model.bindings.find((b) => b.layerId === 'strip')
      expect(stripBinding?.mesh?.points.length).toBeGreaterThanOrEqual(4)
      expect(model.pose().parts[0].geometry).toBeTruthy()

      // Second run without --overwrite skips layers that already have a mesh
      const second = await runAutoMesh(parseAutoMeshArgs([temp]))
      expect(second.updatedCount).toBe(0)
      expect(second.skippedCount).toBe(1)
    } finally {
      await rm(temp, { recursive: true, force: true })
    }
  })

  it('runs check-bend across both slice dirs and koma-work.json root dirs', async () => {
    const stripReport = await runCheckBend(parseCheckBendArgs([join(repoRoot, 'examples/chain-strip')]))
    expect(stripReport.totalChains).toBe(1)
    expect(stripReport.chains[0].layerId).toBe('strip')
    expect(stripReport.chains[0].joints.length).toBe(1)

    const liveDemoReport = await runCheckBend(parseCheckBendArgs([join(repoRoot, 'examples/live-demo')]))
    expect(liveDemoReport.totalChains).toBe(1)
    expect(liveDemoReport.chains[0].layerId).toBe('strip')

    const dkhTwintail = await runCheckBend(
      parseCheckBendArgs([join(repoRoot, 'examples/dkh'), '--layer', 'twintail_l', '--max-angle', '60']),
    )
    expect(dkhTwintail.totalChains).toBe(1)
    expect(dkhTwintail.maxAngleDeg).toBe(60)
    expect(dkhTwintail.chains[0].joints.length).toBe(2)
    expect(dkhTwintail.chains[0].simultaneous).toBeTruthy()
    for (const j of dkhTwintail.chains[0].joints) {
      expect(j.minSafeDeg).toBeLessThanOrEqual(0)
      expect(j.maxSafeDeg).toBeGreaterThanOrEqual(0)
    }
  }, 15000)
})
