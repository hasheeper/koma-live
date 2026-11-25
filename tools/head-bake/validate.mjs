import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { attachmentPoint, createRig, editRig, neutral, sliceManifestSchema } from '@koma-rig/rig-core'
import { digest, workspace } from '../../apps/rig-cli/workspace.mjs'

const [dir, editsFile, yaw, pitch, expectedRig, expectedManifest, layerIds, neck, action] = process.argv.slice(2)
const edits = JSON.parse(await readFile(editsFile))
const targetIds = new Set(JSON.parse(layerIds))
const [faceId, anchor] = JSON.parse(neck)
const isBaked = m => targetIds.has(m.layerId) && m.axes.length === 2 &&
  m.axes[0].parameter === yaw && m.axes[1].parameter === pitch

function validate(manifest, doc, model, { base, manifestHash }) {
  if (base !== expectedRig || manifestHash !== expectedManifest) throw new Error('切片或骨架已更改，请重新烘焙')
  const values = neutral(model.caps).values
  // Validate every target together, including layers currently hidden by a variant, authored visibility or opacity.
  const allVisible = createRig({
    ...manifest, layers: manifest.layers.map(l => targetIds.has(l.layerId) ? { ...l, visible: true, opacity: 1 } : l),
  }, {
    ...doc, eyes: [], morphs: doc.morphs.map(m => isBaked(m) ? {...m, minRatio: Math.max(.15, m.minRatio ?? 0)} : m),
    layerSettings: doc.layerSettings?.map(s => targetIds.has(s.layerId) ? { ...s, visible: true } : s),
    bindings: doc.bindings?.map(b => targetIds.has(b.layerId) ? { ...b, variant: undefined } : b),
  })
  const without = createRig(manifest, { ...doc, morphs: doc.morphs.filter(m => !isBaked(m)) })
  if (JSON.stringify(model.pose().parts) !== JSON.stringify(without.pose().parts))
    throw new Error('中性 Morph 改变了原始顶点')
  const [left, top, width, height] = manifest.layers.find(l => l.layerId === faceId).rect
  const local = [anchor[0] - left, anchor[1] - top]
  const checkNeck = targetIds.has(faceId) && local[0] >= 0 && local[0] <= width && local[1] >= 0 && local[1] <= height
  let maxNeckDrift = 0
  for (const y of [-1, -.5, 0, .5, 1]) for (const x of [-1, -.5, 0, .5, 1]) {
    const parameters = { ...values, [yaw]: x, [pitch]: y }
    model.pose(parameters)
    const pose = allVisible.pose(parameters)
    if (pose.parts.some(p => targetIds.has(p.layerId) && !p.visible)) throw new Error('目标图层未通过可见性体检')
    if (checkNeck) {
      const project = pose => attachmentPoint(pose.parts.find(p => p.layerId === faceId), [width,height], local)
      const a = project(pose), b = project(without.pose(parameters))
      maxNeckDrift = Math.max(maxNeckDrift, Math.hypot(a[0]-b[0], a[1]-b[1]))
    }
  }
  if (maxNeckDrift > .05) throw new Error(`烘焙后的颈部锚点偏移 ${maxNeckDrift.toFixed(4)} px`)
  if (checkNeck) console.log(`Maximum baked neck drift: ${maxNeckDrift.toFixed(6)} px.`)
}

if (action === '--apply') {
  console.log(JSON.stringify(await workspace('edit-save', dir, editsFile, validate)))
} else {
  const [rawManifest, rawRig] = await Promise.all(['manifest.json','rig.json'].map(f => readFile(join(dir,f))))
  const manifest = sliceManifestSchema.parse(JSON.parse(rawManifest))
  const doc = editRig(manifest, JSON.parse(rawRig), edits)
  validate(manifest, doc, createRig(manifest, doc), { base: digest(rawRig), manifestHash: digest(rawManifest) })
}
console.log(`Validated ${targetIds.size} target layers at 25 yaw/pitch samples, exact neutral geometry.`)
