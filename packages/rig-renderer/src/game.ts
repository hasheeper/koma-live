import {
  createInteractionPlayer,
  createRig,
  exportCapabilities,
  exportRigSpec,
  matchesPublishedCapabilities,
  neutral,
  releaseSchema,
  sliceManifestSchema,
  type BoneTransforms,
  type MeshFields,
  type Pose,
  type RigSpec,
  type SliceManifest,
} from '@koma-rig/rig-core'
import { mountCharacter } from './character.js'

export interface LiveRigSource {
  manifest: SliceManifest | unknown
  rig: unknown
  files: ReadonlyMap<string, Blob>
}

export interface LivePoseInput {
  bones?: BoneTransforms
  rotations?: Record<string, number>
  parameters?: Record<string, number>
  slots?: Record<string, string>
  deform?: MeshFields
  timeMs?: number
}

export interface LiveRigPlayer {
  canvas: HTMLCanvasElement
  spec: RigSpec
  readonly pose: Pose
  setPose(input?: LivePoseInput): Pose
  render(): void
  reset(): Pose
  destroy(): void
}

async function fetchRelative(dir: URL, path: string) {
  const url = new URL(path.split('/').map(encodeURIComponent).join('/'), dir)
  const response = await fetch(url)
  if (!response.ok) throw new Error(path + ' · HTTP ' + response.status)
  return response.blob()
}

/** Mount a live procedural rig from a static slice directory or in-memory assets. */
export async function mountLiveRig(
  host: HTMLElement,
  source: string | URL | LiveRigSource,
): Promise<LiveRigPlayer> {
  let manifest: SliceManifest
  let raw: unknown
  let files: ReadonlyMap<string, Blob>

  if (typeof source === 'string' || source instanceof URL) {
    const dir = new URL(String(source).replace(/\/?$/, '/'), document.baseURI)
    const [manifestBlob, rigBlob] = await Promise.all([
      fetchRelative(dir, 'manifest.json'),
      fetchRelative(dir, 'rig.json'),
    ])
    manifest = sliceManifestSchema.parse(JSON.parse(await manifestBlob.text()))
    raw = JSON.parse(await rigBlob.text())
    const paths = new Set(manifest.layers.map((l) => l.texture))
    if (manifest.format === 'koma-rig.slices.v2') {
      for (const group of manifest.gelGroups ?? []) {
        for (const member of group.members) paths.add(member.coverage)
      }
    }
    const loaded = new Map<string, Blob>()
    await Promise.all([...paths].map(async (path) => loaded.set(path, await fetchRelative(dir, path))))
    files = loaded
  } else {
    manifest = sliceManifestSchema.parse(source.manifest)
    raw = source.rig
    files = source.files
  }

  const rig = createRig(manifest, raw)
  const spec = exportRigSpec(manifest, raw)
  const defaults = neutral(rig.caps).values
  const view = await mountCharacter(host, manifest, files)
  let current: Pose

  function setPose(input: LivePoseInput = {}): Pose {
    const parameters = input.parameters ? { ...defaults, ...input.parameters } : defaults
    const slots = input.slots ? { ...rig.defaultSlots, ...input.slots } : rig.defaultSlots
    const next = rig.pose(
      parameters,
      slots,
      {},
      input.timeMs ?? 0,
      input.rotations ?? {},
      input.bones ?? {},
      input.deform,
    )
    view.update(next)
    current = next
    return next
  }

  try {
    current = setPose()
  } catch (e) {
    view.destroy()
    throw e
  }

  return {
    canvas: view.canvas,
    spec,
    get pose() {
      return current
    },
    setPose,
    render: () => view.update(current),
    reset: () => setPose(),
    destroy: view.destroy,
  }
}

/** Mount a reviewed static release. The host owns scene time and its fallback image. */
export async function mountPublished(host: HTMLElement, root: string | URL) {
  const dir = new URL(String(root).replace(/\/?$/, '/'), document.baseURI)
  const read = (path: string) => fetchRelative(dir, path)
  const release = releaseSchema.parse(JSON.parse(await (await read('release.json')).text()))
  const files = new Map<string, Blob>()
  await Promise.all(
    Object.entries(release.files).map(async ([path, expected]) => {
      const blob = await read(path)
      const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
      const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
      if (hash !== expected) throw new Error('发布文件校验不符 ' + path)
      files.set(path, blob)
    }),
  )
  async function json(path: string): Promise<unknown> {
    const file = files.get(path)
    if (!file) throw new Error('发布包缺少 ' + path)
    return JSON.parse(await file.text())
  }
  const raw = await json('rig.json'),
    caps = exportCapabilities(raw)
  const stored = await json('rig-capabilities.json')
  if (
    caps.rigId !== release.rigId ||
    caps.rigVersion !== release.rigVersion ||
    !matchesPublishedCapabilities(raw, stored)
  )
    throw new Error('发布版本或能力清单不符')
  const manifest = sliceManifestSchema.parse(await json('manifest.json'))
  const rig = createRig(manifest, raw)
  const player = createInteractionPlayer(rig, raw, await json(release.idle), await json(release.response))
  const view = await mountCharacter(host, manifest, files)
  function advanceTo(timeMs: number) {
    const frame = player.advanceTo(timeMs)
    view.update(frame)
    return frame
  }
  try {
    advanceTo(0)
  } catch (e) {
    view.destroy()
    throw e
  }
  return {
    canvas: view.canvas,
    advanceTo,
    trigger: player.trigger,
    returnToIdle: player.returnToIdle,
    destroy: view.destroy,
  }
}
