import { expect, it } from 'vitest'
import { prepareSkeleton, type Bone } from '@koma-rig/rig-core'
import { bindingPath, boneDeleteBlocker, eligibleEnds, eligibleParents } from '../apps/rig-studio/src/binding-selection'

const bone = (boneId: string, parentBoneId?: string): Bone =>
  ({boneId, parentBoneId, x: 1, y: 0, rotation: 0, length: 1})
const skeleton = prepareSkeleton([
  bone('tip', 'wrist'), bone('other-finger', 'wrist'), bone('wrist', 'arm'),
  bone('other-arm', 'root'), bone('arm', 'root'), bone('root'), bone('detached'),
], {})

it('retains a distal first pick when moving the other endpoint, always emitting parent-first order', () => {
  expect(bindingPath(skeleton.byId, 'tip', 'root')).toEqual(['root', 'arm', 'wrist', 'tip'])
  expect(bindingPath(skeleton.byId, 'tip', 'arm')).toEqual(['arm', 'wrist', 'tip'])
  expect(bindingPath(skeleton.byId, 'arm', 'tip')).toEqual(['arm', 'wrist', 'tip'])
  expect(bindingPath(skeleton.byId, 'tip', 'tip')).toEqual(['tip'])
})

it('admits ancestors and descendants but excludes cousins, siblings and detached roots', () => {
  const eligible = eligibleEnds(skeleton.byId, skeleton.rest.keys(), 'arm')
  expect(eligible).toEqual(new Set(['root', 'arm', 'wrist', 'tip', 'other-finger']))
  expect(bindingPath(skeleton.byId, 'tip', 'other-finger')).toEqual([])
  expect(bindingPath(skeleton.byId, 'arm', 'detached')).toEqual([])
})

it('excludes the bone itself and all descendants from eligible reparent targets', () => {
  expect(eligibleParents(skeleton.byId, skeleton.rest.keys(), 'arm')).toEqual(new Set(['root', 'other-arm', 'detached']))
  expect(eligibleParents(skeleton.byId, skeleton.rest.keys(), 'root')).toEqual(new Set(['detached']))
  expect(eligibleParents(skeleton.byId, skeleton.rest.keys(), 'detached')).toEqual(
    new Set(['root', 'arm', 'other-arm', 'wrist', 'tip', 'other-finger']),
  )
})

it('reports child-bone and layer-binding references blocking bone deletion', () => {
  const mock = {
    skeleton,
    bindings: [
      { layerId: 'layer-a', pivot: [0, 0] as [number, number], boneId: 'tip' },
      { layerId: 'layer-b', pivot: [0, 0] as [number, number], boneChain: ['arm', 'wrist'] },
    ],
  }
  expect(boneDeleteBlocker(mock, 'detached')).toBe('')
  expect(boneDeleteBlocker(mock, 'other-arm')).toBe('')
  expect(boneDeleteBlocker(mock, 'tip')).toContain('1 个图层')
  expect(boneDeleteBlocker(mock, 'root')).toContain('2 根子骨')
  expect(boneDeleteBlocker(mock, 'arm')).toContain('1 根子骨、1 个图层')
})
