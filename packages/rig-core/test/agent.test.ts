import { describe, expect, it } from 'vitest'
import { capabilitiesJsonSchema, exportCapabilities, validateMotion } from '../src/agent'
import rig from '../../../examples/rig.json'
import motion from '../../../examples/paper/motions/tilt.json'

describe('external motion drafts', () => {
  it('projects only AI fields and emits a closed JSON Schema', () => {
    const caps = exportCapabilities({ ...rig, vertices: [3], textures: ['private.png'] })
    expect(Object.keys(caps).sort()).toEqual(['format','rigId','rigVersion','parameters','slots'].sort())
    expect(caps.parameters[0]!.referenceRange).toEqual([rig.semantics.parameters[0]!.min, rig.semantics.parameters[0]!.max])
    expect(capabilitiesJsonSchema().additionalProperties).toBe(false)
    expect(JSON.stringify(caps)).not.toContain('private.png')
    expect(validateMotion(rig, motion)).toEqual(motion)
  })
  it('checks coupled axes, default ranges and state references', () => {
    const bad = structuredClone(rig)
    bad.semantics.ellipses[0]!.y = 'missing'
    expect(() => exportCapabilities(bad)).toThrow()
    const slots = structuredClone(rig)
    slots.semantics.slots[0]!.transitions[0]!.to = 'missing'
    expect(() => exportCapabilities(slots)).toThrow()
  })
  it('requires a finite path back to the default slot state', () => {
    const bad = structuredClone(rig)
    bad.semantics.slots[0]!.transitions.pop()
    expect(() => exportCapabilities(bad)).toThrow('默认态')
  })
  it.each([
    { ...motion, rigVersion: 9 },
    { ...motion, geometry: [] },
    { ...motion, tracks: [{ parameter: 'hairVertices', keys: [{ timeMs: 0, value: 0 }] }] },
    { ...motion, tracks: [{ parameter: 'tiltX', keys: [{ timeMs: 0, value: Infinity }] }] },
    { ...motion, requests: [{ slot: 'fold', to: 'unknown', timeMs: 0 }] },
  ])('rejects an invalid draft', draft => expect(() => validateMotion(rig, draft)).toThrow())
})
