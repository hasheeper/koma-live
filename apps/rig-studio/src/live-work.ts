import {
  editRig,
  emptyRig,
  sliceManifestSchema,
  type SliceManifest,
  type WorkViewportInput,
} from '@koma-rig/rig-core'
import type { LiveRigSource } from '@koma-rig/rig-renderer'
import {
  createDevSource,
  createFileListSource,
  createFsSource,
  resolveRelativePath,
  resolveSourceLayout,
  snapshotSignature,
  type DirectorySource,
  type FileSnapshot,
  type ResolvedSourceLayout,
} from './local-session'
import { example, type Project } from './project'
import gbotPerformanceCode from '../../../examples/gbot/motion/gbot-live.js?raw'

export { resolveRelativePath }

export interface ScriptPayload {
  code: string
  filename?: string
}

export interface LiveWorkBundle {
  id: string
  title: string
  rig: LiveRigSource
  performanceCode?: string
  performanceFilename?: string
  poster?: Blob
  viewport?: WorkViewportInput
  defaultState?: string
  source?: DirectorySource
  layout?: ResolvedSourceLayout
  unsavedRigPreview?: boolean
  reloadScript?: () => Promise<ScriptPayload | undefined>
  reloadWork?: () => Promise<LiveWorkBundle>
  checkForUpdates?: () => Promise<boolean>
}

type AssetCache = Map<string, { sig: string; blob: Blob }>

function defaultScriptForProject(manifest: SliceManifest, rig: unknown): ScriptPayload | undefined {
  const bones = Array.isArray((rig as { bones?: unknown[] })?.bones)
    ? new Set((rig as { bones: { boneId?: string }[] }).bones.map((b) => b.boneId))
    : new Set<string>()
  if (manifest.sourceId === 'gbot' && bones.has('hip') && bones.has('head')) {
    return { code: gbotPerformanceCode, filename: 'gbot/gbot-live.js' }
  }
  return undefined
}

export async function builtinLiveWork(_which: 'gbot' = 'gbot'): Promise<LiveWorkBundle> {
  const project = await example('gbot')
  const poster = project.files.get(project.manifest.reference)
  return {
    id: 'builtin-gbot-live',
    title: 'GBot · 活体动帧',
    rig: { manifest: project.manifest, rig: project.rig, files: project.files },
    performanceCode: gbotPerformanceCode,
    performanceFilename: 'gbot/gbot-live.js',
    poster,
    viewport: { fit: 'contain', anchor: [0.5, 0.96], paddingPx: 24 },
    defaultState: 'idle',
  }
}

export async function liveWorkFromProject(
  project: Project,
  currentRig: unknown,
  options?: { preferDiskRig?: boolean },
): Promise<LiveWorkBundle> {
  if (project.source) {
    // Reuse the existing files blob map as initial cache when previewing an unsaved Studio rig
    const overrideRig = options?.preferDiskRig ? undefined : currentRig
    return liveWorkFromSource(project.source, undefined, overrideRig)
  }
  const script = defaultScriptForProject(project.manifest, currentRig)
  return {
    id: 'studio-' + project.manifest.sourceId,
    title: project.name,
    rig: { manifest: project.manifest, rig: currentRig, files: project.files },
    performanceCode: script?.code,
    performanceFilename: script?.filename,
    poster: project.files.get(project.manifest.reference),
    viewport: {
      fit: 'contain',
      anchor: project.manifest.sourceId === 'gbot' ? [0.5, 0.96] : [0.5, 0.5],
      paddingPx: 24,
    },
  }
}

function statKey(stat: FileSnapshot | null | undefined): string {
  return stat ? `${stat.mtimeMs}:${stat.size}` : ''
}

export async function liveWorkFromSource(
  source: DirectorySource,
  prevCache?: AssetCache,
  overrideRig?: unknown,
): Promise<LiveWorkBundle> {
  const layout = await resolveSourceLayout(source)
  const rigDir = layout.rigDir
  const manifestPath = resolveRelativePath(rigDir, 'manifest.json')
  const rigPath = resolveRelativePath(rigDir, 'rig.json')
  const setupPath = resolveRelativePath(rigDir, 'setup.json')

  const manifestBlob = await source.readFile(manifestPath)
  if (!manifestBlob) throw new Error('缺少切片清单 · ' + manifestPath)
  const manifest = sliceManifestSchema.parse(JSON.parse(await manifestBlob.text()))

  let rigDoc: unknown
  if (overrideRig !== undefined) {
    rigDoc = overrideRig
  } else {
    const rigBlob = await source.readFile(rigPath)
    const setupBlob = rigBlob ? undefined : await source.readFile(setupPath)
    rigDoc = rigBlob
      ? JSON.parse(await rigBlob.text())
      : setupBlob
        ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await setupBlob.text()))
        : emptyRig(manifest.sourceId)
  }

  const assetRelPaths = new Set<string>(manifest.layers.map((l) => l.texture))
  if (manifest.format === 'koma-rig.slices.v2') {
    for (const g of manifest.gelGroups ?? []) {
      for (const m of g.members) assetRelPaths.add(m.coverage)
    }
  }
  const fullByRel = new Map<string, string>()
  for (const rel of assetRelPaths) fullByRel.set(rel, resolveRelativePath(rigDir, rel))
  const fallbackPosterFull = resolveRelativePath(rigDir, manifest.reference)
  const explicitPosterFull = layout.posterPath

  const allAssetFullPaths = new Set<string>([...fullByRel.values(), fallbackPosterFull])
  if (explicitPosterFull) allAssetFullPaths.add(explicitPosterFull)

  const watchedPaths = [layout.workPath, manifestPath, layout.performancePath].filter(
    (p): p is string => Boolean(p),
  )
  if (overrideRig === undefined) {
    watchedPaths.push(rigPath, setupPath)
  }

  let assetStats: Record<string, FileSnapshot | null> = {}
  let watchedSig = ''
  if (source.statFiles) {
    const statList = Array.from(new Set([...watchedPaths, ...allAssetFullPaths]))
    const allStats = await source.statFiles(statList)
    assetStats = allStats
    const watchedSubset: Record<string, FileSnapshot | null> = {}
    for (const p of watchedPaths) watchedSubset[p] = allStats[p] ?? null
    watchedSig = snapshotSignature(watchedSubset)
  }

  const nextCache: AssetCache = new Map()
  const loadCachedAsset = async (fullPath: string): Promise<Blob | undefined> => {
    const sig = statKey(assetStats[fullPath])
    if (sig && prevCache) {
      const cached = prevCache.get(fullPath)
      if (cached && cached.sig === sig) {
        nextCache.set(fullPath, cached)
        return cached.blob
      }
    }
    const blob = await source.readFile(fullPath)
    if (blob && sig) nextCache.set(fullPath, { sig, blob })
    return blob
  }

  const files = new Map<string, Blob>()
  await Promise.all(
    [...fullByRel.entries()].map(async ([rel, full]) => {
      const blob = await loadCachedAsset(full)
      if (!blob) throw new Error('缺少贴图 · ' + full)
      files.set(rel, blob)
    }),
  )

  const fallbackPoster = await loadCachedAsset(fallbackPosterFull)
  const poster = explicitPosterFull
    ? ((await loadCachedAsset(explicitPosterFull)) ?? fallbackPoster)
    : fallbackPoster

  let performanceCode: string | undefined
  let performanceFilename: string | undefined
  let reloadScript: (() => Promise<ScriptPayload | undefined>) | undefined
  if (layout.performancePath) {
    const perfPath = layout.performancePath
    const perfBlob = await source.readFile(perfPath)
    if (!perfBlob) throw new Error('缺少演出脚本 · ' + perfPath)
    performanceCode = await perfBlob.text()
    performanceFilename = perfPath
    if (source.sourceKind !== 'files') {
      reloadScript = async () => {
        const fresh = await source.readFile(perfPath)
        if (!fresh) return undefined
        return { code: await fresh.text(), filename: perfPath }
      }
    }
  }

  const canReload = source.sourceKind !== 'files'
  return {
    id: layout.id,
    title: layout.title,
    rig: { manifest, rig: rigDoc, files },
    performanceCode,
    performanceFilename,
    poster,
    viewport: layout.viewport,
    defaultState: layout.defaultState,
    source,
    layout,
    unsavedRigPreview: overrideRig !== undefined,
    reloadScript,
    reloadWork: canReload ? () => liveWorkFromSource(source, nextCache, overrideRig) : undefined,
    checkForUpdates:
      canReload && source.statFiles
        ? async () => {
            const current = await source.statFiles!(watchedPaths)
            return snapshotSignature(current) !== watchedSig
          }
        : undefined,
  }
}

/** Load either a koma-work.json folder (arbitrary layout) or a plain slice folder via FileSystemDirectoryHandle. */
export async function loadLocalWorkDirectory(
  root: FileSystemDirectoryHandle,
  persistedId?: string,
): Promise<LiveWorkBundle> {
  return liveWorkFromSource(createFsSource(root, persistedId))
}

/** Load a workspace work/slice directory from the Vite dev server (dev mode only). */
export async function loadDevWorkDirectory(relPath: string): Promise<LiveWorkBundle> {
  return liveWorkFromSource(createDevSource(relPath))
}

/** Load either a koma-work.json folder or a plain slice folder from <input webkitdirectory>. */
export async function loadLocalWorkFiles(list: File[]): Promise<LiveWorkBundle> {
  return liveWorkFromSource(createFileListSource(list))
}
