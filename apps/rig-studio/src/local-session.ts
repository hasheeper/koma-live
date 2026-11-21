import { sliceManifestSchema, workManifestSchema, type WorkViewportInput } from '@koma-rig/rig-core'
import {
  queryDirPermission,
  rememberRecentDir,
  requestDirPermission,
  saveLastSession,
  type RecentDirEntry,
} from './recent-handles'

declare const __KOMA_DEV_WORKSPACE__: boolean
export const DEV_WORKSPACE_ENABLED = typeof __KOMA_DEV_WORKSPACE__ !== 'undefined' && __KOMA_DEV_WORKSPACE__

export interface FileSnapshot {
  mtimeMs: number
  size: number
}

export interface DevWorkSummary {
  path: string
  kind: 'work' | 'slices'
  id: string
  title: string
  hasPerformance: boolean
}

export interface DirectorySource {
  readonly sourceKind: 'fs' | 'dev' | 'files'
  readonly id: string
  readonly label: string
  readonly devPath?: string
  readonly handle?: FileSystemDirectoryHandle
  readonly allPaths?: ReadonlySet<string>
  readFile(relPath: string): Promise<Blob | undefined>
  statFiles?(relPaths: string[]): Promise<Record<string, FileSnapshot | null>>
  writeRigFile?(relPath: string, content: string): Promise<void>
}

export interface ResolvedSourceLayout {
  kind: 'work' | 'slices'
  workPath?: string
  rigDir: string
  performancePath?: string
  posterPath?: string
  id: string
  title: string
  viewport?: WorkViewportInput
  defaultState?: string
}

export function resolveRelativePath(baseDir: string, relative: string): string {
  const parts = baseDir ? baseDir.split('/').filter(Boolean) : []
  for (const segment of relative.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (!parts.length) throw new Error('路径超出所选目录范围 · ' + relative)
      parts.pop()
    } else {
      parts.push(segment)
    }
  }
  return parts.join('/')
}

export function parentDir(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

export function snapshotSignature(stats: Record<string, FileSnapshot | null>): string {
  return Object.keys(stats)
    .sort()
    .map((key) => {
      const s = stats[key]
      return s ? `${key}:${s.mtimeMs}:${s.size}` : `${key}:-`
    })
    .join('|')
}

async function getFsFileHandle(
  root: FileSystemDirectoryHandle,
  relPath: string,
  create = false,
): Promise<FileSystemFileHandle> {
  const parts = relPath.split('/').filter(Boolean)
  if (!parts.length) throw new Error('无效文件路径')
  let dir = root
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]!)
  }
  return dir.getFileHandle(parts[parts.length - 1]!, create ? { create: true } : undefined)
}

async function optionalFsFile(root: FileSystemDirectoryHandle, relPath: string): Promise<File | undefined> {
  try {
    const handle = await getFsFileHandle(root, relPath, false)
    return await handle.getFile()
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return undefined
    throw error
  }
}

export function createFsSource(handle: FileSystemDirectoryHandle, persistedId?: string): DirectorySource {
  return {
    sourceKind: 'fs',
    id: persistedId ?? `fs:${handle.name}`,
    label: handle.name,
    handle,
    readFile: (relPath) => optionalFsFile(handle, relPath),
    async statFiles(relPaths) {
      const stats: Record<string, FileSnapshot | null> = {}
      await Promise.all(
        relPaths.map(async (rel) => {
          try {
            const file = await optionalFsFile(handle, rel)
            stats[rel] = file ? { mtimeMs: Math.round(file.lastModified), size: file.size } : null
          } catch {
            stats[rel] = null
          }
        }),
      )
      return stats
    },
    async writeRigFile(relPath, content) {
      if ((await queryDirPermission(handle, 'readwrite')) !== 'granted') {
        const ok = await requestDirPermission(handle, 'readwrite')
        if (!ok) throw new Error('目录缺少写入权限，可导出 rig.json 或重新授权。')
      }
      const fileHandle = await getFsFileHandle(handle, relPath, true)
      const writer = await fileHandle.createWritable()
      try {
        await writer.write(content)
        await writer.close()
      } catch (err) {
        await writer.abort().catch(() => {})
        throw err
      }
    },
  }
}

export function createDevSource(relPath: string): DirectorySource {
  const cleanRoot = relPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  const joinRoot = (sub: string) => (sub ? `${cleanRoot}/${sub}` : cleanRoot)
  return {
    sourceKind: 'dev',
    id: `dev:${cleanRoot}`,
    label: cleanRoot,
    devPath: cleanRoot,
    async readFile(subPath) {
      const full = joinRoot(subPath)
      const res = await fetch(`/__koma-workspace/file?path=${encodeURIComponent(full)}`, { cache: 'no-store' })
      if (res.status === 404) return undefined
      if (!res.ok) throw new Error(`读取工作区文件失败 (${res.status}) · ${full}`)
      return res.blob()
    },
    async statFiles(subPaths) {
      const params = new URLSearchParams()
      const mapping = subPaths.map((sub) => ({ sub, full: joinRoot(sub) }))
      for (const item of mapping) params.append('path', item.full)
      const res = await fetch(`/__koma-workspace/stat?${params.toString()}`, { cache: 'no-store' })
      if (!res.ok) return Object.fromEntries(subPaths.map((p) => [p, null]))
      const body = (await res.json()) as { stats?: Record<string, FileSnapshot | null> }
      const raw = body.stats ?? {}
      const out: Record<string, FileSnapshot | null> = {}
      for (const item of mapping) out[item.sub] = raw[item.full] ?? null
      return out
    },
    async writeRigFile(subPath, content) {
      const full = joinRoot(subPath)
      const res = await fetch(`/__koma-workspace/rig?path=${encodeURIComponent(full)}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: content,
      })
      if (!res.ok) {
        let message = `写入失败 (${res.status})`
        try {
          const parsed = (await res.json()) as { error?: string }
          if (parsed.error) message = parsed.error
        } catch {
          // ignore
        }
        throw new Error(message)
      }
    },
  }
}

export function createFileListSource(list: File[]): DirectorySource {
  const byPath = new Map<string, File>()
  let rootName = 'local'
  for (const file of list) {
    if (file.webkitRelativePath) {
      const segments = file.webkitRelativePath.split('/')
      if (segments[0]) rootName = segments[0]
      byPath.set(segments.slice(1).join('/'), file)
    } else {
      byPath.set(file.name, file)
    }
  }
  return {
    sourceKind: 'files',
    id: `files:${rootName}:${Date.now().toString(36)}`,
    label: rootName,
    allPaths: new Set(byPath.keys()),
    async readFile(relPath) {
      return byPath.get(relPath)
    },
  }
}

export async function listDevWorks(): Promise<DevWorkSummary[]> {
  if (!DEV_WORKSPACE_ENABLED) return []
  try {
    const res = await fetch('/__koma-workspace/list', { cache: 'no-store' })
    if (!res.ok) return []
    const data = (await res.json()) as { works?: DevWorkSummary[] }
    return Array.isArray(data.works) ? data.works : []
  } catch {
    return []
  }
}

export async function resolveSourceLayout(source: DirectorySource): Promise<ResolvedSourceLayout> {
  let workPath: string | undefined
  if (await source.readFile('koma-work.json')) {
    workPath = 'koma-work.json'
  } else if (source.allPaths) {
    workPath = [...source.allPaths].find((k) => k.endsWith('/koma-work.json'))
  }

  if (workPath) {
    const workBlob = await source.readFile(workPath)
    if (!workBlob) throw new Error('未能读取作品清单 · ' + workPath)
    const workDir = parentDir(workPath)
    const work = workManifestSchema.parse(JSON.parse(await workBlob.text()))
    const rigDir = resolveRelativePath(workDir, work.rig)
    const performancePath = work.performance ? resolveRelativePath(workDir, work.performance) : undefined
    const posterPath = work.poster ? resolveRelativePath(workDir, work.poster) : undefined
    return {
      kind: 'work',
      workPath,
      rigDir,
      performancePath,
      posterPath,
      id: work.id,
      title: work.title ?? work.id,
      viewport: work.viewport,
      defaultState: work.defaultState,
    }
  }

  const manifestBlob = await source.readFile('manifest.json')
  if (!manifestBlob) {
    throw new Error('请选择包含 koma-work.json 或直接包含 manifest.json 的作品/切片目录。')
  }
  const manifest = sliceManifestSchema.parse(JSON.parse(await manifestBlob.text()))
  const perfBlob = await source.readFile('performance.js')
  return {
    kind: 'slices',
    rigDir: '',
    performancePath: perfBlob ? 'performance.js' : undefined,
    id: manifest.sourceId,
    title: manifest.sourceId,
  }
}

export async function rememberOpenedSource(
  source: DirectorySource,
  layout: ResolvedSourceLayout,
): Promise<RecentDirEntry | undefined> {
  if (source.sourceKind === 'fs' && source.handle) {
    const entry = await rememberRecentDir(source.handle, { kind: layout.kind, title: layout.title })
    saveLastSession({
      kind: 'fs',
      id: entry.id,
      title: entry.title,
      name: entry.name,
      workKind: layout.kind,
    })
    return entry
  }
  if (source.sourceKind === 'dev' && source.devPath) {
    saveLastSession({
      kind: 'dev',
      id: source.devPath,
      title: layout.title,
      name: source.devPath,
      workKind: layout.kind,
    })
  }
  return undefined
}

export type DroppedPayload =
  | { kind: 'directory'; handle: FileSystemDirectoryHandle }
  | { kind: 'file'; file: File; handle?: FileSystemFileHandle }

export async function extractDroppedPayload(dataTransfer: DataTransfer | null): Promise<DroppedPayload | null> {
  if (!dataTransfer) return null
  const items = Array.from(dataTransfer.items ?? [])
  for (const item of items) {
    if (item.kind !== 'file') continue
    const withHandle = item as DataTransferItem & {
      getAsFileSystemHandle?: () => Promise<FileSystemHandle | null>
    }
    if (withHandle.getAsFileSystemHandle) {
      try {
        const handle = await withHandle.getAsFileSystemHandle()
        if (handle?.kind === 'directory') {
          return { kind: 'directory', handle: handle as FileSystemDirectoryHandle }
        }
        if (handle?.kind === 'file') {
          const fh = handle as FileSystemFileHandle
          return { kind: 'file', file: await fh.getFile(), handle: fh }
        }
      } catch {
        // Fall back to getAsFile
      }
    }
    const file = item.getAsFile()
    if (file) return { kind: 'file', file }
  }
  const fallbackFile = dataTransfer.files?.[0]
  return fallbackFile ? { kind: 'file', file: fallbackFile } : null
}
