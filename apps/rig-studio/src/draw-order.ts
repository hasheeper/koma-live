import type { SliceManifest } from '@koma-rig/rig-core'

function groupLookup(manifest: SliceManifest) {
  const byLayer = new Map<string, number>()
  if (manifest.format === 'koma-rig.slices.v2') {
    for (const [index, group] of (manifest.gelGroups ?? []).entries()) {
      for (const member of group.members) byLayer.set(member.layerId, index)
    }
  }
  return byLayer
}

/** Partition back-to-front layer IDs into atomic visual blocks (front-to-back order), keeping gelGroup members contiguous. */
function visualBlocks(backToFront: readonly string[], manifest: SliceManifest): string[][] {
  const groups = groupLookup(manifest)
  const blocks: string[][] = []
  let activeGroup: number | undefined
  for (const id of backToFront) {
    const group = groups.get(id)
    if (group !== undefined && group === activeGroup) {
      blocks.at(-1)!.push(id)
    } else {
      blocks.push([id])
      activeGroup = group
    }
  }
  return blocks.reverse()
}

function sameOrder(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, i) => id === b[i])
}

/** Reorder layers from the UI's front-to-back draw-order list, returning a new back-to-front drawOrder or null if unchanged. */
export function reorderDrawOrder(
  backToFront: readonly string[],
  manifest: SliceManifest,
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] | null {
  const blocks = visualBlocks(backToFront, manifest)
  const from = blocks.findIndex((block) => block.includes(draggedId))
  const to = blocks.findIndex((block) => block.includes(targetId))
  if (from < 0 || to < 0 || from === to) return null
  const targetBlock = blocks[to]!
  const [moved] = blocks.splice(from, 1)
  const anchor = blocks.indexOf(targetBlock)
  blocks.splice(position === 'before' ? anchor : anchor + 1, 0, moved!)
  const next = blocks.reverse().flat()
  return sameOrder(backToFront, next) ? null : next
}

/** Move a layer (or its gelGroup) one visual step up (toward front) or down (toward back). */
export function nudgeDrawOrder(
  backToFront: readonly string[],
  manifest: SliceManifest,
  layerId: string,
  direction: 'up' | 'down',
): string[] | null {
  const blocks = visualBlocks(backToFront, manifest)
  const index = blocks.findIndex((block) => block.includes(layerId))
  if (index < 0) return null
  const nextIndex = direction === 'up' ? index - 1 : index + 1
  if (nextIndex < 0 || nextIndex >= blocks.length) return null
  const [moved] = blocks.splice(index, 1)
  blocks.splice(nextIndex, 0, moved!)
  return blocks.reverse().flat()
}

/** Report whether a layer can visually move up (front) or down (back) in the draw-order list. */
export function canNudgeDrawOrder(backToFront: readonly string[], manifest: SliceManifest, layerId: string) {
  const blocks = visualBlocks(backToFront, manifest)
  const index = blocks.findIndex((block) => block.includes(layerId))
  return {
    up: index > 0,
    down: index >= 0 && index < blocks.length - 1,
  }
}
