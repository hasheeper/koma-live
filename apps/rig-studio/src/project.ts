import {
  createRig,
  editRig,
  emptyRig,
  sliceManifestSchema,
  type SliceManifest,
  type AttachmentMesh,
} from '@koma-rig/rig-core'
import {
  createDevSource,
  createFileListSource,
  createFsSource,
  resolveRelativePath,
  resolveSourceLayout,
  snapshotSignature,
  type DirectorySource,
  type ResolvedSourceLayout,
} from './local-session'
import character from '../../../examples/gbot/slices/manifest.json'
import characterRig from '../../../examples/gbot/slices/rig.json'

const sampleImages = import.meta.glob<string>(
  ['../../../examples/gbot/slices/{reference.png,textures/*.png}'],
  { eager: true, query: '?url', import: 'default' },
)

export type Selection = { type: 'bone' | 'layer' | 'attachment'; id: string } | null
export type Mode = 'setup' | 'pose'
export type Tool = 'select' | 'bone' | 'pan'

export interface MeshDraft extends AttachmentMesh {
  layerId: string
  drawing: boolean
}

export interface Project {
  name: string
  manifest: SliceManifest
  files: Map<string, Blob>
  alpha: Map<string, Uint8Array>
  coverageAlpha: Map<string, Uint8Array>
  rig: unknown
  source?: DirectorySource
  layout?: ResolvedSourceLayout
  writeRig?: (text: string) => Promise<void>
  reloadRig?: () => Promise<unknown>
  checkRigChanged?: () => Promise<boolean>
}

type Proof = Pick<Project, 'alpha' | 'coverageAlpha'> | { error: string }

async function prepare(
  name: string,
  manifest: SliceManifest,
  files: Map<string, Blob>,
  rig: unknown,
  verify: boolean,
): Promise<Project> {
  if (manifest.format !== 'koma-rig.slices.v2') throw new Error('工作台需要离线导出的 v2 切片包。')
  createRig(manifest, rig).pose()
  const worker = new Worker(new URL('./proof.worker.ts', import.meta.url), { type: 'module' })
  try {
    const masks = await new Promise<Pick<Project, 'alpha' | 'coverageAlpha'>>((resolve, reject) => {
      worker.onmessage = ({ data }: MessageEvent<Proof>) =>
        'error' in data ? reject(new Error(data.error)) : resolve(data)
      worker.onerror = (event) => reject(new Error(event.message))
      worker.postMessage({ manifest, files, verify })
    })
    return { name, manifest, files, ...masks, rig }
  } finally {
    worker.terminate()
  }
}

function texturePaths(manifest: SliceManifest) {
  const paths = new Set(manifest.layers.map((layer) => layer.texture))
  if (manifest.format === 'koma-rig.slices.v2') {
    for (const group of manifest.gelGroups ?? []) {
      for (const member of group.members) paths.add(member.coverage)
    }
  }
  return paths
}

export async function example(_which: 'gbot' = 'gbot') {
  const manifest = sliceManifestSchema.parse(character)
  const prefix = '../../../examples/gbot/slices/'
  const files = new Map<string, Blob>()
  await Promise.all(
    [manifest.reference, ...texturePaths(manifest)].map(async (path) => {
      const url = sampleImages[prefix + path]
      if (!url) throw new Error('缺少 ' + path)
      const response = await fetch(url)
      if (!response.ok) throw new Error('未能读取 ' + path)
      files.set(path, await response.blob())
    }),
  )
  return prepare('GBot · 角色骨架', manifest, files, structuredClone(characterRig), false)
}

export async function projectFromSource(source: DirectorySource): Promise<Project> {
  const layout = await resolveSourceLayout(source)
  const rigDir = layout.rigDir
  const manifestPath = resolveRelativePath(rigDir, 'manifest.json')
  const manifestBlob = await source.readFile(manifestPath)
  if (!manifestBlob) throw new Error('缺少切片清单 · ' + manifestPath)
  const manifest = sliceManifestSchema.parse(JSON.parse(await manifestBlob.text()))

  const rigPath = resolveRelativePath(rigDir, 'rig.json')
  const setupPath = resolveRelativePath(rigDir, 'setup.json')

  const readRigState = async () => {
    const rigBlob = await source.readFile(rigPath)
    const rigText = rigBlob ? await rigBlob.text() : undefined
    const setupBlob = rigText === undefined ? await source.readFile(setupPath) : undefined
    const rigDoc =
      rigText !== undefined
        ? JSON.parse(rigText)
        : setupBlob
          ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await setupBlob.text()))
          : emptyRig(manifest.sourceId)
    const statSig = source.statFiles ? snapshotSignature(await source.statFiles([rigPath, setupPath])) : ''
    return { rigDoc, rigText, statSig }
  }

  const initial = await readRigState()
  const assets = new Map<string, Blob>()
  const assetList = [manifest.reference, ...texturePaths(manifest)]
  await Promise.all(
    assetList.map(async (rel) => {
      const full = resolveRelativePath(rigDir, rel)
      const blob = await source.readFile(full)
      if (!blob) throw new Error('缺少 ' + rel)
      assets.set(rel, blob)
    }),
  )

  const project = await prepare(layout.title || manifest.sourceId, manifest, assets, initial.rigDoc, true)
  project.source = source
  project.layout = layout

  let baseline = initial.rigText
  let rigStatSig = initial.statSig

  if (source.writeRigFile) {
    project.writeRig = async (content: string) => {
      const current = await source.readFile(rigPath)
      const currentText = current ? await current.text() : undefined
      if (currentText !== baseline) {
        throw new Error('目录中的 rig.json 已在外部变更，可在企划菜单重新载入目录版本或导出当前副本。')
      }
      await source.writeRigFile!(rigPath, content)
      baseline = content
      if (source.statFiles) {
        rigStatSig = snapshotSignature(await source.statFiles([rigPath, setupPath]))
      }
    }
  }

  if (source.sourceKind !== 'files') {
    project.reloadRig = async () => {
      const fresh = await readRigState()
      createRig(manifest, fresh.rigDoc).pose()
      baseline = fresh.rigText
      rigStatSig = fresh.statSig
      return fresh.rigDoc
    }
  }

  if (source.statFiles) {
    project.checkRigChanged = async () => {
      const nextSig = snapshotSignature(await source.statFiles!([rigPath, setupPath]))
      if (nextSig === rigStatSig) return false
      // Confirm actual file text differs from our baseline so metadata-only touches don't spam reloads
      const current = await source.readFile(rigPath)
      const currentText = current ? await current.text() : undefined
      if (currentText === baseline) {
        rigStatSig = nextSig
        return false
      }
      return true
    }
  }

  return project
}

export async function directory(list: File[]) {
  return projectFromSource(createFileListSource(list))
}

export async function mountedDirectory(root: FileSystemDirectoryHandle, persistedId?: string): Promise<Project> {
  return projectFromSource(createFsSource(root, persistedId))
}

export async function devWorkspaceProject(relPath: string): Promise<Project> {
  return projectFromSource(createDevSource(relPath))
}
