import type { Bone, Rig } from '@koma-rig/rig-core'

export type Endpoint = 'start' | 'end'

/** Keep the author's first pick separate from the parent-first order required by bind-chain. */
export function bindingPath(bones: ReadonlyMap<string, Bone>, first: string, last: string): string[] {
  function descend(ancestor: string, tip: string) {
    const path: string[] = []
    for (let bone = bones.get(tip); bone; bone = bone.parentBoneId ? bones.get(bone.parentBoneId) : undefined) {
      path.push(bone.boneId)
      if (bone.boneId === ancestor) return path.reverse()
    }
    return []
  }
  const forward = descend(first, last)
  return forward.length ? forward : descend(last, first)
}

/** Rest frames are already in topological order, even for unordered imported JSON. */
export function eligibleEnds(bones: ReadonlyMap<string, Bone>, orderedIds: Iterable<string>, first: string) {
  const ids = new Set([first])
  for (const id of orderedIds) {
    const parent = bones.get(id)?.parentBoneId
    if (parent && ids.has(parent)) ids.add(id)
  }
  for (let parent = bones.get(first)?.parentBoneId; parent; parent = bones.get(parent)?.parentBoneId) ids.add(parent)
  return ids
}

/** Any bone except the bone itself and its descendants may become its parent without forming a cycle. */
export function eligibleParents(bones: ReadonlyMap<string, Bone>, orderedIds: Iterable<string>, boneId: string) {
  const excluded = new Set([boneId])
  const eligible = new Set<string>()
  for (const id of orderedIds) {
    const parent = bones.get(id)?.parentBoneId
    if (excluded.has(id) || (parent && excluded.has(parent))) excluded.add(id)
    else eligible.add(id)
  }
  return eligible
}

/** Explain why a bone cannot be removed yet, or return an empty string if it can be safely removed. */
export function boneDeleteBlocker(model: Pick<Rig, 'skeleton' | 'bindings'>, boneId: string) {
  let children = 0
  for (const bone of model.skeleton.byId.values()) {
    if (bone.parentBoneId === boneId) children++
  }
  let layers = 0
  for (const binding of model.bindings) {
    if (binding.boneId === boneId || binding.boneChain?.includes(boneId)) layers++
  }
  if (!children && !layers) return ''
  const reasons: string[] = []
  if (children) reasons.push(`${children} 根子骨`)
  if (layers) reasons.push(`${layers} 个图层`)
  const action = children && layers ? '改父级或解绑' : children ? '改父级或删除子骨' : '解绑图层'
  return `正被 ${reasons.join('、')} 引用，请先${action}`
}
