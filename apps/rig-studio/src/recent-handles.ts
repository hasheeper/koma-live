const DB_NAME = 'koma-rig-studio-handles'
const DB_VERSION = 1
const STORE_NAME = 'recentDirs'
const LAST_SESSION_KEY = 'koma-rig-last-session'
const MAX_RECENT = 6

export type PermissionMode = 'read' | 'readwrite'
export type PermissionStatusValue = 'granted' | 'prompt' | 'denied'

interface PermissionCapableHandle extends FileSystemDirectoryHandle {
  queryPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionStatusValue>
  requestPermission?: (descriptor?: { mode?: PermissionMode }) => Promise<PermissionStatusValue>
}

export interface RecentDirEntry {
  id: string
  name: string
  kind: 'work' | 'slices'
  title: string
  handle: FileSystemDirectoryHandle
  lastOpenedAt: number
}

export interface LastSessionHint {
  kind: 'fs' | 'dev'
  id: string
  title: string
  name: string
  workKind: 'work' | 'slices'
}

function openDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'id' })
        }
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
}

async function withStore<T, F = T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
  fallback: F,
): Promise<T | F> {
  const db = await openDb()
  if (!db) return fallback
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE_NAME, mode)
      const store = tx.objectStore(STORE_NAME)
      const req = run(store)
      let value: T | F = fallback
      req.onsuccess = () => {
        value = req.result
      }
      tx.oncomplete = () => {
        db.close()
        resolve(value)
      }
      tx.onerror = () => {
        db.close()
        resolve(fallback)
      }
      tx.onabort = () => {
        db.close()
        resolve(fallback)
      }
    } catch {
      db.close()
      resolve(fallback)
    }
  })
}

export async function listRecentDirs(): Promise<RecentDirEntry[]> {
  const entries = await withStore<RecentDirEntry[]>('readonly', (store) => store.getAll(), [])
  return entries
    .filter((e) => e && typeof e.id === 'string' && e.handle)
    .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    .slice(0, MAX_RECENT)
}

export async function getRecentDir(id: string): Promise<RecentDirEntry | undefined> {
  const result = await withStore<RecentDirEntry | undefined>('readonly', (store) => store.get(id), undefined)
  return result?.handle ? result : undefined
}

export async function rememberRecentDir(
  handle: FileSystemDirectoryHandle,
  meta: { kind: 'work' | 'slices'; title: string },
): Promise<RecentDirEntry> {
  const existing = await listRecentDirs()
  const typedHandle = handle as PermissionCapableHandle
  let matchedId: string | undefined
  for (const item of existing) {
    try {
      if (typedHandle.isSameEntry && (await typedHandle.isSameEntry(item.handle))) {
        matchedId = item.id
        break
      }
    } catch {
      // Ignore comparison errors on stale handles
    }
  }
  const now = Date.now()
  const entry: RecentDirEntry = {
    id: matchedId ?? `fs:${handle.name}:${now.toString(36)}`,
    name: handle.name,
    kind: meta.kind,
    title: meta.title || handle.name,
    handle,
    lastOpenedAt: now,
  }
  await withStore('readwrite', (store) => store.put(entry), undefined)

  // Trim oldest entries beyond MAX_RECENT
  const all = await listRecentDirs()
  if (all.length > MAX_RECENT) {
    const db = await openDb()
    if (db) {
      await new Promise<void>((resolve) => {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const store = tx.objectStore(STORE_NAME)
        for (const stale of all.slice(MAX_RECENT)) store.delete(stale.id)
        tx.oncomplete = () => {
          db.close()
          resolve()
        }
        tx.onerror = () => {
          db.close()
          resolve()
        }
      })
    }
  }
  return entry
}

export async function removeRecentDir(id: string): Promise<void> {
  await withStore('readwrite', (store) => store.delete(id), undefined)
  const last = readLastSession()
  if (last?.kind === 'fs' && last.id === id) saveLastSession(null)
}

export async function clearRecentDirs(): Promise<void> {
  await withStore('readwrite', (store) => store.clear(), undefined)
  const last = readLastSession()
  if (last?.kind === 'fs') saveLastSession(null)
}

export function saveLastSession(hint: LastSessionHint | null): void {
  try {
    if (!hint) localStorage.removeItem(LAST_SESSION_KEY)
    else localStorage.setItem(LAST_SESSION_KEY, JSON.stringify(hint))
  } catch {
    // Ignore storage quota / privacy restrictions
  }
}

export function readLastSession(): LastSessionHint | null {
  try {
    const raw = localStorage.getItem(LAST_SESSION_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LastSessionHint>
    if (
      (parsed.kind === 'fs' || parsed.kind === 'dev') &&
      typeof parsed.id === 'string' &&
      parsed.id &&
      typeof parsed.title === 'string' &&
      typeof parsed.name === 'string'
    ) {
      return {
        kind: parsed.kind,
        id: parsed.id,
        title: parsed.title,
        name: parsed.name,
        workKind: parsed.workKind === 'work' ? 'work' : 'slices',
      }
    }
    return null
  } catch {
    return null
  }
}

export async function queryDirPermission(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode = 'read',
): Promise<PermissionStatusValue> {
  const typed = handle as PermissionCapableHandle
  if (!typed.queryPermission) return 'granted'
  try {
    return await typed.queryPermission({ mode })
  } catch {
    return 'denied'
  }
}

export async function requestDirPermission(
  handle: FileSystemDirectoryHandle,
  mode: PermissionMode = 'read',
): Promise<boolean> {
  const typed = handle as PermissionCapableHandle
  if (!typed.requestPermission) return true
  try {
    return (await typed.requestPermission({ mode })) === 'granted'
  } catch {
    return false
  }
}
