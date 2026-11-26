import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { runAutoHead } from '../apps/rig-cli/head-tools.mjs'
import { workspace } from '../apps/rig-cli/workspace.mjs'

const fixture = fileURLToPath(new URL('./fixtures/chain-strip/', import.meta.url))
const config = {
  format: 'koma-rig.auto-head.v1',
  geometry: { faceLayer: 'strip' },
  layers: { strip: { role: 'face', grid: [6, 6] } },
}
const save = (path, obj) => writeFile(path, JSON.stringify(obj, null, 2))
const load = async (path) => JSON.parse(await readFile(path, 'utf8'))

let root, slices, rigPath, configPath

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'koma-auto-head-'))
  slices = join(root, 'slices')
  rigPath = join(slices, 'rig.json')
  configPath = join(root, 'head-rig.json')
  await cp(fixture, slices, { recursive: true })
  await cp(new URL('./fixtures/live-demo/koma-work.json', import.meta.url), join(root, 'koma-work.json'))
  await save(configPath, config)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('supports dry-run preview, atomic apply with 25-sample check, pinNeck mode, and idempotent reruns', async () => {
  const beforeFiles = await readdir(slices)
  const preview = await runAutoHead([root, '--dry-run'])
  expect(preview).toMatchObject({
    changed: true,
    applied: false,
    targets: 1,
    validatedSamples: 25,
    maxNeckDriftPx: null,
  })
  expect(await readdir(slices)).toEqual(beforeFiles)

  const applied = await runAutoHead([slices])
  expect(applied).toMatchObject({ applied: true, configPath, targets: 1, validatedSamples: 25, maxNeckDriftPx: null })
  const doc = await load(rigPath)
  expect(doc.bones.map((b) => b.boneId)).toEqual(['base', 'tip'])
  expect(doc.morphs[0].deltas[4]).toBeNull()

  const journal = join(slices, '.rig-draft.json')
  const firstJournal = await readFile(journal)
  const rerun = await runAutoHead([slices, '--config', configPath])
  expect(rerun).toMatchObject({ changed: false, applied: false })
  expect(await readFile(journal)).toEqual(firstJournal)

  // Verify explicit pinNeck mode zeroes neckAnchor drift
  await save(configPath, { ...config, geometry: { ...config.geometry, pinNeck: true } })
  const pinned = await runAutoHead([root, '--dry-run'])
  expect(pinned).toMatchObject({ changed: true, applied: false, validatedSamples: 25, maxNeckDriftPx: 0 })
})

it('preserves unrelated morphs/axes and rejects dirty drafts or invalid geometry', async () => {
  await runAutoHead([root])
  const old = await load(rigPath)
  const customMorph = {
    layerId: 'strip',
    grid: [1, 1],
    axes: [{ parameter: 'bend', samples: [-15, 0, 15] }],
    deltas: [Array(8).fill(1), null, Array(8).fill(-1)],
  }
  await workspace('edit-save', slices, [{ op: 'set-morphs', morphs: [old.morphs[0], customMorph] }])

  await save(configPath, {
    ...config,
    parameters: { yaw: { id: 'headYaw', deg: 11 }, pitch: { id: 'headPitch', upDeg: 4.5, downDeg: 10 } },
  })
  const updated = await runAutoHead([root])
  expect(updated).toMatchObject({ changed: true, applied: true })
  const next = await load(rigPath)
  expect(next.morphs).toHaveLength(2)
  expect(next.morphs[1]).toEqual(customMorph)

  // Dirty draft guard
  await workspace('edit', slices, [{ op: 'set-layer', layerId: 'strip', visible: false }])
  await save(configPath, { ...config, parameters: { yaw: { id: 'headYaw', deg: 14 }, pitch: { id: 'headPitch', upDeg: 5, downDeg: 11 } } })
  await expect(runAutoHead([root])).rejects.toThrow(/未保存草稿/)
})
