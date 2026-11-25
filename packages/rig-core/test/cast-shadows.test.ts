import { describe, expect, it } from 'vitest'
import { createRig, editRig, emptyRig, type SliceManifest } from '../src/index.js'

const manifest: SliceManifest = {
  format: 'koma-rig.slices.v2',
  sourceId: 'shadow-test',
  canvas: { width: 200, height: 200 },
  reference: 'reference.png',
  blendSpace: 'srgb',
  layers: [
    { layerId: 'face', name: 'Face', groups: [], texture: 'textures/face.png', rect: [40, 40, 120, 120], visible: true, opacity: 1 },
    { layerId: 'bang_l', name: 'Bang L', groups: [], texture: 'textures/bl.png', rect: [50, 20, 60, 60], visible: true, opacity: 1 },
    { layerId: 'bang_r', name: 'Bang R', groups: [], texture: 'textures/br.png', rect: [90, 20, 60, 60], visible: true, opacity: 1 },
  ],
}

describe('castShadows schema, authoring, and runtime pose overrides', () => {
  it('supports static castShadows in rig.json and editRig set-cast-shadows', () => {
    const edited = editRig(manifest, emptyRig('shadow-test'), [
      {
        op: 'set-cast-shadows',
        castShadows: [
          {
            casters: ['bang_l', 'bang_r'],
            receivers: ['face'],
            offset: [2, 10],
            color: 0x8c5264,
            opacity: 0.22,
            blur: 4,
            blendMode: 'multiply',
          },
        ],
      },
    ])
    expect(edited.castShadows).toHaveLength(1)

    const rig = createRig(manifest, edited)
    const restPose = rig.pose()
    expect(restPose.shadows).toEqual(edited.castShadows)

    // Runtime shadows override & explicit clear
    const dynamicPose = rig.pose(undefined, undefined, undefined, 0, undefined, undefined, undefined, {
      shadows: [{ casters: ['bang_l'], receivers: ['face'], offset: [5, 12], opacity: 0.3 }],
    })
    expect(dynamicPose.shadows).toHaveLength(1)
    expect(dynamicPose.shadows?.[0]?.offset).toEqual([5, 12])

    const clearedPose = rig.pose(undefined, undefined, undefined, 0, undefined, undefined, undefined, {
      shadows: [],
    })
    expect(clearedPose.shadows).toBeUndefined()
  })

  it('rejects unknown caster or receiver layer IDs', () => {
    const badCaster = {
      ...emptyRig('shadow-test'),
      castShadows: [{ casters: ['missing'], receivers: ['face'], offset: [0, 8] }],
    }
    expect(() => createRig(manifest, badCaster)).toThrow(/未知投影投射图层/)

    const badReceiver = {
      ...emptyRig('shadow-test'),
      castShadows: [{ casters: ['bang_l'], receivers: ['missing'], offset: [0, 8] }],
    }
    expect(() => createRig(manifest, badReceiver)).toThrow(/未知投影受影图层/)
  })
})
