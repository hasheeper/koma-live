import { expect, it } from 'vitest'
import { sliceManifestSchema } from '@koma-rig/rig-core'
import { canNudgeDrawOrder, nudgeDrawOrder, reorderDrawOrder } from '../apps/rig-studio/src/draw-order'

const layer = (layerId: string) => ({
  layerId,
  name: layerId,
  groups: [],
  texture: `textures/${layerId}.png`,
  rect: [0, 0, 10, 10] as [number, number, number, number],
  visible: true,
  opacity: 1,
})

const plainManifest = sliceManifestSchema.parse({
  format: 'koma-rig.slices.v2',
  blendSpace: 'srgb',
  sourceId: 'demo',
  canvas: { width: 20, height: 20 },
  reference: 'reference.png',
  layers: [layer('back'), layer('mid'), layer('front')],
})

const gelManifest = sliceManifestSchema.parse({
  format: 'koma-rig.slices.v2',
  blendSpace: 'srgb',
  sourceId: 'gel-demo',
  canvas: { width: 20, height: 20 },
  reference: 'reference.png',
  layers: [layer('bg'), layer('g1'), layer('g2'), layer('fg')],
  gelGroups: [
    {
      opacity: 1,
      members: [
        { layerId: 'g1', coverage: 'textures/g1_cov.png' },
        { layerId: 'g2', coverage: 'textures/g2_cov.png' },
      ],
    },
  ],
})

it('reorders plain layers from the front-to-back UI view and returns back-to-front order', () => {
  const order = ['back', 'mid', 'front']
  // Visually moving 'back' before 'front' brings it to the frontmost slot.
  expect(reorderDrawOrder(order, plainManifest, 'back', 'front', 'before')).toEqual(['mid', 'front', 'back'])
  // Visually moving 'front' after 'mid' puts it between 'back' and 'mid'.
  expect(reorderDrawOrder(order, plainManifest, 'front', 'mid', 'after')).toEqual(['back', 'front', 'mid'])
  // Dropping in the same effective slot is a no-op.
  expect(reorderDrawOrder(order, plainManifest, 'front', 'mid', 'before')).toBeNull()
  expect(reorderDrawOrder(order, plainManifest, 'mid', 'mid', 'after')).toBeNull()
})

it('nudges layers up toward the front and down toward the back', () => {
  const order = ['back', 'mid', 'front']
  expect(canNudgeDrawOrder(order, plainManifest, 'front')).toEqual({ up: false, down: true })
  expect(canNudgeDrawOrder(order, plainManifest, 'mid')).toEqual({ up: true, down: true })
  expect(canNudgeDrawOrder(order, plainManifest, 'back')).toEqual({ up: true, down: false })
  expect(nudgeDrawOrder(order, plainManifest, 'back', 'up')).toEqual(['mid', 'back', 'front'])
  expect(nudgeDrawOrder(order, plainManifest, 'front', 'down')).toEqual(['back', 'front', 'mid'])
  expect(nudgeDrawOrder(order, plainManifest, 'front', 'up')).toBeNull()
})

it('keeps gelGroup members contiguous and in calibrated order when reordering or nudging', () => {
  const order = ['bg', 'g1', 'g2', 'fg']
  // Dragging within the same gelGroup is ignored.
  expect(reorderDrawOrder(order, gelManifest, 'g1', 'g2', 'before')).toBeNull()
  // Moving fg below any gelGroup member moves it behind the whole group.
  const movedFg = reorderDrawOrder(order, gelManifest, 'fg', 'g1', 'after')
  expect(movedFg).toEqual(['bg', 'fg', 'g1', 'g2'])
  // Resulting order still passes strict manifest gelGroups validation.
  const byId = new Map(gelManifest.layers.map((l) => [l.layerId, l]))
  expect(() => sliceManifestSchema.parse({ ...gelManifest, layers: movedFg!.map((id) => byId.get(id)!) })).not.toThrow()
  // Nudging g2 up moves the whole [g1, g2] group above fg.
  expect(nudgeDrawOrder(order, gelManifest, 'g2', 'up')).toEqual(['bg', 'fg', 'g1', 'g2'])
})
