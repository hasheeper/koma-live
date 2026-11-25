import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRig, editRig, emptyRig, previewRig, sliceManifestSchema } from '@koma-rig/rig-core'

export const jsonBytes = (value) => JSON.stringify(value, null, 2) + '\n'
export const digest = (data) => createHash('sha256').update(data).digest('hex')
export async function writeJson(path, value, beforeReplace) {
  const temp = path + '.' + randomUUID() + '.tmp'
  try {
    await writeFile(temp, jsonBytes(value), { flag: 'wx' })
    if (beforeReplace) await beforeReplace()
    await rename(temp, path)
  } finally {
    await rm(temp, { force: true })
  }
}
async function optionalFile(path) {
  try {
    return await readFile(path)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}
async function fileHash(path) {
  const bytes = await optionalFile(path)
  return bytes && digest(bytes)
}

// Each project has a single atomically replaced draft journal. A pending digest
// distinguishes a completed save from a process that stopped before the rename.
export async function workspace(command, dir, argument, validateCandidate) {
  const root = join(dir, 'rig.json'),
    journal = join(dir, '.rig-draft.json')
  const writing = !['preview', 'inspect', 'recover'].includes(command)
  // SQLite's operating-system file lock also releases if this process is killed.
  const lock = writing ? new DatabaseSync(join(dir, '.rig-write.sqlite')) : null
  try {
    if (lock) {
      lock.exec('PRAGMA busy_timeout=3000')
      lock.exec('BEGIN IMMEDIATE')
    }
    if (command === 'recover') {
      const saved = await optionalFile(journal)
      if (!saved) throw new Error('没有待恢复的草稿')
      const state = JSON.parse(saved)
      await writeFile(argument, jsonBytes(state.history[state.index]), { flag: 'wx' })
      return { recovered: argument }
    }
    const manifestPath = join(dir, 'manifest.json')
    const bytes = await readFile(manifestPath)
    const manifest = sliceManifestSchema.parse(JSON.parse(bytes))
    const disk = await optionalFile(root)
    const base = disk && digest(disk)
    const saved = await optionalFile(journal)
    function initial() {
      const raw = disk ? JSON.parse(disk) : emptyRig(manifest.sourceId)
      return { base, manifest: digest(bytes), clean: digest(jsonBytes(raw)), index: 0, history: [raw] }
    }
    let state = saved ? JSON.parse(saved) : initial()
    if (state.pending && state.pending === base) {
      state.base = base
      state.clean = base
    }
    delete state.pending
    if (state.base !== base || state.manifest !== digest(bytes)) {
      if (digest(jsonBytes(state.history[state.index])) !== state.clean)
        throw new Error('磁盘版本与草稿冲突；可用 rig recover 将草稿另存：' + journal)
      state = initial()
    }
    let rig = state.history[state.index]
    if (command === 'edit' || command === 'edit-save') {
      if (validateCandidate && digest(jsonBytes(rig)) !== state.clean)
        throw new Error('已有未保存草稿，请先保存或另存草稿再烘焙')
      rig = editRig(manifest, rig, JSON.parse(await readFile(argument)))
      state.history.splice(++state.index, Infinity, rig)
    } else if (command === 'undo' || command === 'redo') {
      const next = state.index + (command === 'undo' ? -1 : 1)
      if (next < 0 || next >= state.history.length)
        throw new Error('没有可' + (command === 'undo' ? '撤销' : '重做') + '的操作')
      state.index = next
      rig = state.history[next]
    }
    const model = createRig(manifest, rig)
    validateCandidate?.(manifest, rig, model, { base, manifestHash: digest(bytes) })
    if (command === 'preview') return previewRig(model, argument ? JSON.parse(await readFile(argument)) : {})
    if (command === 'inspect')
      return {
        bones: [...model.skeleton.byId.values()],
        bindings: model.bindings,
        groupTree: manifest.groupTree ?? [],
        layerSettings: [...model.settings.values()],
        sourceLayers: manifest.layers,
        layers: model.pose().parts.map((p) => p.layerId),
        undo: state.index,
        redo: state.history.length - 1 - state.index,
      }
    model.pose()
    const save = command === 'save' || command === 'edit-save'
    if (save) {
      state.pending = digest(jsonBytes(rig))
      await writeJson(journal, state)
      await writeJson(root, rig, async () => {
        if ((await fileHash(root)) !== base || (await fileHash(manifestPath)) !== state.manifest)
          throw new Error('保存期间企划已改变；草稿保留')
      })
      state.clean = state.pending
      state.base = state.pending
      delete state.pending
    }
    await writeJson(journal, state)
    return {
      rigId: model.caps.rigId,
      bones: model.skeleton.byId.size,
      revision: state.index,
      saved: save,
    }
  } finally {
    lock?.close()
  }
}
