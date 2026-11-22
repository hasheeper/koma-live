// Run after building rig-core and installing the offline PSD environment.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const run = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const python =
  process.env.KOMA_RIG_PYTHON ||
  join(root, 'tools/psd/.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
const cli = async (...args) =>
  JSON.parse((await run(process.execPath, [join(root, 'apps/rig-cli/rig.mjs'), ...args])).stdout)
const read = async (path) => JSON.parse(await readFile(path))
const write = (path, obj) => writeFile(path, JSON.stringify(obj))
async function setup(t) {
  const temp = await mkdtemp(join(tmpdir(), 'koma-rig-test-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const dir = join(temp, 'hinge')
  await cp(join(root, 'tests/fixtures/hinge'), dir, { recursive: true })
  await cli('edit', dir, join(dir, 'setup.json'))
  return { dir, temp }
}

test('CLI reopens drafts, separates preview and save, rejects stale edits, supports recovery', async (t) => {
  const { dir, temp } = await setup(t)
  const setupState = await cli('inspect', dir)
  assert.equal(setupState.bones.length, 2)
  await assert.rejects(stat(join(dir, 'rig.json')), { code: 'ENOENT' })
  const action = join(temp, 'action.json')
  await write(action, [{ op: 'unbind', layerId: 'tip' }])
  await cli('edit', dir, action)
  await cli('undo', dir)
  assert.equal((await cli('inspect', dir)).bindings[1].boneId, 'tip-joint')
  await cli('redo', dir)
  assert.equal((await cli('inspect', dir)).bindings[1].boneId, undefined)
  await cli('undo', dir)
  await cli('save', dir)
  const saved = await readFile(join(dir, 'rig.json'))
  await write(action, { rotations: { 'base-joint': 5 } })
  const rotated = await cli('preview', dir, action)
  assert.deepEqual(rotated.bones[0].end, rotated.bones[1].start)
  await cli('render', dir, join(temp, 'rest.png'))
  await cli('render', dir, join(temp, 'tilted.png'), action)
  assert.notDeepEqual(await readFile(join(temp, 'rest.png')), await readFile(join(temp, 'tilted.png')))
  assert.deepEqual(await readFile(join(dir, 'rig.json')), saved)
  await cli('edit', dir, join(dir, 'grid.json'))
  await write(action, { parameters: { bend: 1 } })
  const bent = await cli('preview', dir, action)
  assert.equal(bent.controls[0].points.length, 9)
  assert.equal(bent.parts[1].geometry.indices.length, 96)
  const [pixels] = await Promise.all([
    cli('verify-slices', dir),
    cli('render', dir, join(temp, 'grid.png'), action),
  ])
  assert.equal(pixels.maxError, 0)
  const before = await cli('inspect', dir)
  await write(action, [{ op: 'reparent', boneId: 'base-joint', parentBoneId: 'tip-joint' }])
  await assert.rejects(cli('edit', dir, action), /循环骨架/)
  assert.deepEqual(await cli('inspect', dir), before)
  await write(join(dir, 'rig.json'), { ...JSON.parse(saved), rigVersion: 2 })
  await assert.rejects(cli('save', dir), /磁盘版本与草稿冲突/)
  const recovery = join(temp, 'recovered.json')
  await cli('recover', dir, recovery)
  assert.equal((await read(recovery)).bindings[1].deformer.kind, 'ffd')
  assert.equal((await read(join(dir, 'rig.json'))).rigVersion, 2)
})

test('reimport retains source IDs through explicit mapping and rejects a missing bound layer', async (t) => {
  const { dir, temp } = await setup(t)
  await cli('save', dir)
  const next = join(temp, 'slices'),
    out = join(temp, 'converted')
  await cp(join(root, 'tests/fixtures/hinge'), next, { recursive: true })
  const manifest = await read(join(next, 'manifest.json'))
  manifest.layers[1].layerId = 'repaint'
  manifest.layers[1].name = '改名'
  await write(join(next, 'manifest.json'), manifest)
  const imported = join(temp, 'imported')
  assert.equal((await cli('import', next, imported)).pixels.maxError, 0)
  assert.equal((await cli('inspect', imported)).bones.length, 0)
  manifest.layers[1].visible = false
  await write(join(next, 'manifest.json'), manifest)
  const failed = join(temp, 'failed-import')
  await assert.rejects(cli('import', next, failed), /mismatches/)
  await assert.rejects(stat(failed), { code: 'ENOENT' })
  manifest.layers[1].visible = true
  await write(join(next, 'manifest.json'), manifest)
  const report = await cli('reimport', dir, next)
  assert.equal(report.valid, false)
  assert.deepEqual(report.reviewBindings, ['tip'])
  await assert.rejects(cli('reimport', dir, next, '--out', out), /绑定缺少图层/)
  await assert.rejects(stat(out), { code: 'ENOENT' })
  const map = join(temp, 'mapping.json')
  await write(map, { layers: { tip: 'repaint' } })
  await cli('reimport', dir, next, '--map', map, '--out', out)
  assert.equal((await read(join(out, 'manifest.json'))).layers[1].layerId, 'tip')
  assert.deepEqual((await cli('preview', dir)).parts, (await cli('preview', out)).parts)
  manifest.layers[1].rect[0] += 1
  await write(join(next, 'manifest.json'), manifest)
  assert.ok((await cli('reimport', dir, next, '--map', map)).changed[0].fields.includes('rect'))
})

test('review checks signed-off bytes and packages only the reviewed runtime assets', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'koma-release-'))
  t.after(() => rm(temp, { recursive: true, force: true }))
  const dir = join(temp, 'project')
  await cp(join(root, 'tests/fixtures/layered-parts'), dir, { recursive: true })
  const args = [dir, 'idle.json', 'activate.json']
  const report = await cli('review', ...args)
  assert.equal(report.slices.mismatches, 0)
  assert.equal(report.rest.mismatches, 0)
  const review = join(temp, 'review.json'),
    zip = join(temp, 'test.zip')
  await write(review, { reviewId: 'stale', reviewer: 'automated test fixture', approved: true })
  await assert.rejects(cli('publish', ...args, zip, review), /reviewId/)
  await write(review, { reviewId: report.reviewId, reviewer: 'automated test fixture', approved: true })
  await cli('publish', ...args, zip, review)
  const script =
    'import zipfile,sys,json,hashlib\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({p:hashlib.sha256(z.read(p)).hexdigest() for p in z.namelist()}))\n print(z.read("release.json").decode().replace("\\n",""))'
  const { stdout } = await run(python, ['-c', script, zip])
  const [hashes, release] = stdout
    .trim()
    .split('\n')
    .map((s) => JSON.parse(s))
  for (const [name, hash] of Object.entries(release.files)) assert.equal(hashes[name], hash)
  assert.equal(Object.keys(hashes).length, Object.keys(release.files).length + 1)
  const before = createHash('sha256')
    .update(await readFile(zip))
    .digest('hex')
  await assert.rejects(cli('publish', ...args, zip, review), /EEXIST/)
  assert.equal(
    createHash('sha256')
      .update(await readFile(zip))
      .digest('hex'),
    before,
  )
})

test('rotated rest pixels survive rebind and concurrent draft edits both persist', async (t) => {
  const { dir, temp } = await setup(t)
  async function edit(name, actions) {
    const path = join(temp, name + '.json')
    await write(path, actions)
    return cli('edit', dir, path)
  }
  await Promise.all([
    edit('rotate-rest', [{ op: 'edit-bone', boneId: 'base-joint', changes: { x: 26, y: 34, rotation: 19 } }]),
    edit('joint', [{ op: 'add-bone', boneId: 'other', start: [90, 21], end: [62, 47] }]),
  ])
  const proof = async (name) => {
    const out = join(temp, name + '.png')
    await cli('render', dir, out)
    return readFile(out)
  }
  const moved = await proof('rest-of-rotated-skeleton')
  assert.equal((await cli('inspect', dir)).bones.length, 3)
  await edit('mount', [{ op: 'bind', layerId: 'tip', boneId: 'other' }])
  assert.deepEqual(await proof('rebound'), moved)
  await edit('detach', [{ op: 'unbind', layerId: 'tip' }])
  assert.deepEqual(await proof('unbound'), moved)
})

test('a single paper strip renders identically at rest and bends at 40 degrees in the CLI',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'koma-rig-chain-'))
  t.after(()=>rm(dir,{recursive:true,force:true}))
  await cp(join(root,'tests/fixtures/chain-strip'),dir,{recursive:true})
  await cli('edit',dir,join(dir,'setup.json'))
  const posed=await cli('preview',dir,join(dir,'bend.json'))
  assert.equal(posed.parts.length,1)
  assert.equal(posed.parameters.bend,40)
  await cli('render',dir,join(dir,'rest.png'))
  await cli('render',dir,join(dir,'bent.png'),join(dir,'bend.json'))
  const script=`from PIL import Image
import numpy as np,sys
p=lambda name: np.asarray(Image.open(sys.argv[1]+'/'+name+'.png').convert('RGBA')).astype(int)
ref,rest,bent=map(p,['reference','rest','bent'])
pma=lambda im: np.concatenate((np.rint(im[:,:,:3]*im[:,:,3:4]/255),im[:,:,3:4]),axis=2)
assert abs(pma(ref)-pma(rest)).max()<=1
assert (abs(rest-bent)>1).any()
assert np.array_equal(rest[60:68,20:40],bent[60:68,20:40])
assert bent[96,110,3]>240 and rest[96,110,3]==0`
  await run(python,['-c',script,dir])
  await cli('save',dir)
  assert.deepEqual((await read(join(dir,'rig.json'))).bindings[0].boneChain,['base','tip'])
})
