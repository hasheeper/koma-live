import { describe, expect, it } from 'vitest'
import {
  exportCapabilities,
  capabilitiesJsonSchema,
  publishedCapabilitiesSchema,
  createMotionSampler,
  createRig,
  sliceManifestSchema,
  constrain,
  neutral,
  checkGeometry,
  prepareGeometry,
  createPlayer,
  createInteractionPlayer,
  auditMotions,
} from '../src/index'
import paper from '../../../examples/paper/rig.json'
import paperManifest from '../../../examples/paper/manifest.json'
import tilt from '../../../examples/paper/motions/tilt.json'
import sway from '../../../examples/paper/motions/sway.json'
import partsRig from '../../../tests/fixtures/layered-parts/rig.json'
import fixtureManifest from '../../../tests/fixtures/layered-parts/manifest.json'
import idle from '../../../tests/fixtures/layered-parts/motions/idle.json'
import response from '../../../tests/fixtures/layered-parts/motions/activate.json'

const manifest = sliceManifestSchema.parse(paperManifest)
const partsManifest = sliceManifestSchema.parse(fixtureManifest)
const model = createRig(manifest, paper),
  partsModel = createRig(partsManifest, partsRig)

describe('PCHIP and the explicit scene loop option', () => {
  it('uses the analytical periodic harmonic mean on both sides of a nonzero seam', () => {
    const s = createMotionSampler(paper, sway)
    const periodic = 2 / (1 / (2 / 160) + 1 / (3 / 160))
    expect(s.sample(0, true).velocities.tiltX).toBeCloseTo(periodic, 12)
    expect(s.sample(800, true)).toEqual(s.sample(0, true))
    expect(s.sample(-1, true)).toEqual(s.sample(799, true))
    expect(s.sample(0.0001, true).velocities.tiltX).toBeCloseTo(s.sample(799.9999, true).velocities.tiltX!, 7)
    expect(s.sample(0)).toEqual(s.sample(0, false))
    expect(s.sample(0).velocities.tiltX).not.toBeCloseTo(periodic, 5)
    expect(s.sample(801, false).velocities.tiltX).toBe(0)
    expect(() => createMotionSampler(paper, { ...sway, loop: true })).toThrow()
  })
  it('periodically interpolates sparse keys across time zero and rejects conflicting seam endpoints', () => {
    const curve = (keys: { timeMs: number; value: number }[]) =>
      createMotionSampler(paper, { ...tilt, tracks: [{ parameter: 'tiltX', keys }] })
    const sparse = curve([
      { timeMs: 200, value: 2 },
      { timeMs: 600, value: -2 },
    ])
    expect(sparse.sample(0, true).values.tiltX).toBeCloseTo(0)
    expect(sparse.sample(0, false).values.tiltX).toBe(2)
    const mismatch = curve([
      { timeMs: 0, value: 0 },
      { timeMs: 800, value: 1 },
    ])
    expect(() => mismatch.sample(80, true)).toThrow('接缝')
    expect(mismatch.sample(400).values.tiltX).toBe(0.5)
    expect(curve([{ timeMs: 50, value: 3 }]).sample(799, true).values.tiltX).toBe(3)
  })
  it('stays monotone between nonuniform keys, including a plateau and reversal', () => {
    const keys = [
      { timeMs: 1, value: -4 },
      { timeMs: 31, value: 3 },
      { timeMs: 218, value: 3 },
      { timeMs: 799, value: -1 },
    ]
    const s = createMotionSampler(paper, { ...tilt, tracks: [{ parameter: 'tiltX', keys }] })
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!,
        b = keys[i]!
      for (let t = a.timeMs; t <= b.timeMs; t += 0.75) {
        const v = s.sample(t).values.tiltX!
        expect(v).toBeGreaterThanOrEqual(Math.min(a.value, b.value) - 1e-12)
        expect(v).toBeLessThanOrEqual(Math.max(a.value, b.value) + 1e-12)
      }
    }
  })
})

it('retains the rest canvas pivot, applies the parent once and preserves painter order', () => {
  const pose = createPlayer(model, paper, tilt).advanceTo(400)
  expect(pose.parts.map((p) => p.layerId)).toEqual(manifest.layers.map((l) => l.layerId))
  expect(pose.parts[1]!.pivot).toEqual([100, 80])
  expect(pose.parts[3]!.pivot[0]).toBeCloseTo(124.939, 3)
  expect(pose.parts[3]!.pivot[1]).toBeCloseTo(81.744, 3)
  for (const patch of [
    { parentId: 'missing' },
    { parentId: 'psd-4' },
    { layerId: 'psd-4' },
    { layerId: 'missing' },
  ]) {
    const rig = structuredClone(paper)
    Object.assign(rig.bindings[0]!, patch)
    expect(() => createRig(manifest, rig)).toThrow()
  }
})

it('preserves diagonal gaze inputs and retains a shared aperture for unequal eyes at every blink', () => {
  for (const x of [-1, 0, 1])
    for (const y of [-1, 0, 1])
      for (const blink of [0, 0.5, 1])
        for (const tilt of [-8, 8]) {
          const sample = neutral(partsModel.caps)
          Object.assign(sample.values, { gazeX: x, gazeY: y, blink, tilt })
          const values = constrain(partsModel.caps, sample).values
          expect([values.gazeX,values.gazeY]).toEqual([x,y])
          const parts = partsModel.pose(values).parts
          for (const side of ['left', 'right']) {
            const part = (suffix: string) => parts.find((p) => p.layerId === side + suffix)!
            expect(part('I').mask).toEqual(part('W').mask)
            expect(part('I').visible).toBe(blink !== 1)
            expect(part('W').visible).toBe(blink !== 1)
            expect(part('C').visible).toBe(blink === 1)
          }
        }
  const bad = structuredClone(partsRig)
  bad.eyes[0]!.travel = [40, 2]
  const wide=createRig(partsManifest, bad).pose({ ...neutral(partsModel.caps).values, gazeX: 1 })
  expect(wide.parts.find(p=>p.layerId===bad.eyes[0]!.iris)?.mask?.length).toBe(48)
})

it('identifies flipped, nearly flat, and individually valid overlapping triangles', () => {
  const tri = [0, 0, 4, 0, 0, 4],
    indices = [0, 1, 2]
  expect(() => checkGeometry(tri, [0, 0, 0, 4, 4, 0], indices, 0.001, 0.05)).toThrow('翻面')
  expect(() => checkGeometry(tri, [0, 0, 4, 0, 0, 0.01], indices, 0.001, 0.05)).toThrow('退化')
  const disjoint = [...tri, 8, 0, 12, 0, 8, 4]
  expect(() => checkGeometry(disjoint, [...tri, 1, 1, 2, 1, 1, 2], [0, 1, 2, 3, 4, 5], 0.001, 0.01)).toThrow(
    '自交',
  )
  expect(() => checkGeometry(disjoint, [...tri, 2, 0, 6, 0, 2, 4], [0, 1, 2, 3, 4, 5], 0.001, 0.01)).toThrow(
    '自交',
  )
  const quad = [0, 0, 4, 0, 0, 4, 4, 4]
  expect(() => checkGeometry(quad, quad, [0, 1, 2, 1, 3, 2], 0.001, 0.05)).not.toThrow()
  const geom = prepareGeometry(
    {
      kind: 'ribbon',
      parameter: 'tilt',
      line: [
        [2, 0, 2],
        [2, 12, 2],
        [2, 24, 2],
      ],
      bend: 1,
      maxBend: 2,
      minArea: 0.01,
      minRatio: 0.1,
    },
    4,
    24,
  )
  expect(geom(0).vertices.slice(0, 4)).toEqual(geom(2).vertices.slice(0, 4))
  expect(geom(0).vertices.at(-2)).not.toEqual(geom(2).vertices.at(-2))
})

it('preserves contact at interrupt time and retracts a nondefault hand on its independent clock', () => {
  const scene = createInteractionPlayer(partsModel, partsRig, idle, response)
  scene.trigger(93)
  const before = scene.advanceTo(222)
  expect(before.slots.arm).toBe('touch')
  const after = scene.returnToIdle(222)
  expect(after.parts.find((p) => p.layerId === 'touch')).toEqual(
    before.parts.find((p) => p.layerId === 'touch'),
  )
  expect(after.secondary).toEqual(before.secondary)
  const states: string[] = []
  for (let t = 222; t <= 582; t += 2) {
    const pose = scene.advanceTo(t)
    if (states.at(-1) !== pose.slots.arm) states.push(pose.slots.arm!)
    expect(
      pose.parts.filter((p) => ['down', 'touch', 'retract'].includes(p.layerId) && p.visible),
    ).toHaveLength(1)
  }
  expect(states).toEqual(['touch', 'retract', 'down'])
})

it('keeps contact until its exit step, including interruptions one step either side of the hold boundary', () => {
  for (const exit of [200, 210, 220]) {
    const scene = createInteractionPlayer(partsModel, partsRig, idle, response)
    scene.trigger(0)
    expect(scene.advanceTo(110).slots.arm).toBe('touch')
    const before = scene.advanceTo(exit),
      at = scene.returnToIdle(exit)
    expect(at.parameters).toEqual(before.parameters)
    expect(at.velocities).toEqual(before.velocities)
    const end = Math.max(exit + 10, 210) + 60
    expect(scene.advanceTo(end - 10).slots.arm).toBe('touch')
    expect(scene.advanceTo(end).slots.arm).toBe('retract')
    expect(scene.advanceTo(end + 10).slots.arm).toBe('retract')
  }
  const bad = structuredClone(partsRig)
  bad.gates[0]!.anchors[0]!.to.local = [1000, 1000]
  const scene = createInteractionPlayer(createRig(partsManifest, bad), bad, idle, response)
  scene.trigger(0)
  expect(() => scene.advanceTo(140)).toThrow(/arm.*140 ms.*未对齐/)
})

it('publishes semantic hints and evaluates complete motions with legacy input exclusion metadata', () => {
  const c = exportCapabilities(partsRig)
  expect(c.format).toBe('koma-rig.capabilities.v3')
  expect(exportCapabilities(paper).format).toBe('koma-rig.capabilities.v3')
  expect(publishedCapabilitiesSchema.parse(c)).toEqual(c)
  expect(capabilitiesJsonSchema(c.format).additionalProperties).toBe(false)
  expect(() => publishedCapabilitiesSchema.parse({ ...c, bindings: [] })).toThrow()
  expect(JSON.stringify(c)).not.toMatch(/"bindings"|"anchors"|"tolerancePx"|"texture"|"vertices"|"geometry"/)
  const rule = { when: [{ parameter: 'tiltX', min: 7, max: 10 }], reason: '仅允许较小歪头' }
  const good = { ...paper, semantics: { ...paper.semantics, slots: [] }, forbidden: [rule] }
  const tracks = [{ ...tilt.tracks[0]!, keys: [{ timeMs: 0, value: 8 }] }]
  expect(() => auditMotions(manifest, good, { idle: sway, response: tilt }, 'idle', 'response')).not.toThrow()
  expect(() =>
    auditMotions(manifest, good, { idle: sway, response: { ...tilt, tracks } }, 'idle', 'response'),
  ).not.toThrow()
})

it('replays seeded interruptions identically on different render schedules', () => {
  let seed = 2751
  const events = Array.from({ length: 5 }, (_, i) => {
    seed = (1664525 * seed + 1013904223) >>> 0
    return 80 + i * 160 + (seed % 60)
  })
  function run(cadence: number) {
    const scene = createInteractionPlayer(partsModel, partsRig, idle, response)
    let last = 0
    events.forEach((t, i) => {
      for (let at = last + cadence; at < t; at += cadence) scene.advanceTo(at)
      if (i % 2) scene.returnToIdle(t)
      else scene.trigger(t)
      last = t
    })
    for (let t = last + cadence; t < 1800; t += cadence) scene.advanceTo(t)
    return scene.advanceTo(1800)
  }
  expect(run(7)).toEqual(run(41))
  const result = auditMotions(partsManifest, partsRig, { idle, response }, 'idle', 'response')
  expect(result.poses).toBeGreaterThan(600)
})
