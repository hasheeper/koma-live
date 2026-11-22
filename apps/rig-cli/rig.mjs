import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { assetCommand } from './assets.mjs'
import { parseExportWorkArgs, runExportWork } from './export-work.mjs'
import { parseAutoMeshArgs, parseCheckBendArgs, runAutoMesh, runCheckBend } from './mesh-tools.mjs'
import { workspace, writeJson } from './workspace.mjs'
import { auditMotions, capabilitiesJsonSchema, createPlayer, createRig, editRig, emptyRig, exportCapabilities, exportRigSpec, sliceManifestSchema, validateMotion } from '@koma-rig/rig-core'

async function main() {
  const [command, file, target, ...extra] = process.argv.slice(2)
  if (command === 'auto-mesh') {
    console.log(JSON.stringify(await runAutoMesh(parseAutoMeshArgs(process.argv.slice(3))), null, 2))
    return
  }
  if (command === 'check-bend') {
    console.log(JSON.stringify(await runCheckBend(parseCheckBendArgs(process.argv.slice(3))), null, 2))
    return
  }
  if (command === 'export-work') {
    console.log(JSON.stringify(await runExportWork(parseExportWorkArgs(process.argv.slice(3))), null, 2))
    return
  }
  if (['import','render','verify-slices','reimport','review','publish'].includes(command)) {
    console.log(JSON.stringify(await assetCommand(command, process.argv.slice(3))))
    return
  }
  if (['edit', 'undo', 'redo', 'save', 'inspect', 'preview', 'recover'].includes(command)) {
    if (!file || extra.length || (['edit','recover'].includes(command) && !target) || (target && !['edit','preview','recover'].includes(command)))
      throw new Error('用法: rig edit <目录> <操作.json> | preview <目录> [试动.json] | undo/redo/save/inspect <目录> | recover <目录> <新文件>')
    console.log(JSON.stringify(await workspace(command, file, target)))
    return
  }
  if(command==='audit') {
    const [response,...rest]=extra
    if(!file || !target || !response || rest.length || [target,response].some(name=>basename(name)!==name))
      throw new Error('用法: rig audit <角色目录> <待机.json> <交互.json>')
    const read=async name=>JSON.parse(await readFile(join(file,name),'utf8'))
    const names=(await readdir(join(file,'motions'))).filter(name=>name.endsWith('.json')).sort()
    const motions=Object.fromEntries(await Promise.all(names.map(async name=>['motions/'+name,await read('motions/'+name)])))
    console.log(JSON.stringify(auditMotions(sliceManifestSchema.parse(await read('manifest.json')),await read('rig.json'),
      motions,'motions/'+target,'motions/'+response)))
    return
  }
  if(command==='sample') {
    const [time,...options]=extra
    if(!file || !target || time===undefined || !time.trim() || !Number.isFinite(Number(time)) || Number(time)<0)
      throw new Error('用法: rig sample <rig.json> <motion.json> <毫秒> [--loop [true|false]] [--manifest <manifest.json>]')
    let loop=false, manifestPath
    while(options.length) {
      const flag=options.shift()
      if(flag==='--loop') loop=['true','false'].includes(options[0]) ? options.shift()==='true' : true
      else if(flag==='--manifest' && options[0]) manifestPath=options.shift()
      else throw new Error('未知采样选项 '+flag)
    }
    const read=async path=>JSON.parse(await readFile(path,'utf8'))
    const rig=await read(file), motion=await read(target)
    let manifest
    try {manifest=await read(manifestPath??join(dirname(file),'manifest.json'))}
    catch(error) {
      if(manifestPath || error.code!=='ENOENT') throw error
      manifest={format:'koma-rig.slices.v1',sourceId:rig.rigId,canvas:{width:1,height:1},reference:'reference.png',layers:[]}
    }
    const model=createRig(sliceManifestSchema.parse(manifest),rig)
    console.log(JSON.stringify(createPlayer(model,rig,motion,loop).advanceTo(Number(time))))
    return
  }
  if (command === 'spec') {
    if (!file || extra.length) throw new Error('用法: rig spec <目录> [输出.json]')
    const manifestPath = join(file, 'manifest.json')
    const manifest = sliceManifestSchema.parse(JSON.parse(await readFile(manifestPath, 'utf8')))
    const rigPath = join(file, 'rig.json')
    const setupPath = join(file, 'setup.json')
    const rigDoc = existsSync(rigPath)
      ? JSON.parse(await readFile(rigPath, 'utf8'))
      : existsSync(setupPath)
        ? editRig(manifest, emptyRig(manifest.sourceId), JSON.parse(await readFile(setupPath, 'utf8')))
        : emptyRig(manifest.sourceId)
    const spec = exportRigSpec(manifest, rigDoc)
    if (target) {
      await mkdir(dirname(target), { recursive: true })
      await writeJson(target, spec)
      console.log(JSON.stringify({
        output: target,
        rigId: spec.rigId,
        rigVersion: spec.rigVersion,
        bones: spec.bones.length,
        layers: spec.layers.length,
        slots: spec.slots.length,
      }))
    } else {
      console.log(JSON.stringify(spec, null, 2))
    }
    return
  }
  if (extra.length || !file || !['capabilities', 'check-motion'].includes(command) || (command === 'check-motion' && !target)) {
    throw new Error('用法: rig spec <目录> [输出.json] | rig capabilities <rig.json> [输出目录] | rig check-motion <rig.json> <motion.json>')
  }
  const rig = JSON.parse(await readFile(file, 'utf8'))
  if (command === 'check-motion') {
    validateMotion(rig, JSON.parse(await readFile(target, 'utf8')))
    console.log('动作草稿通过契约校验')
    return
  }
  const caps = exportCapabilities(rig)
  const dir = target ?? dirname(file)
  await mkdir(dir, { recursive: true })
  await writeJson(join(dir, 'rig-capabilities.schema.json'), capabilitiesJsonSchema(caps.format))
  await writeJson(join(dir, 'rig-capabilities.json'), caps)
  console.log(`已导出 ${caps.rigId} v${caps.rigVersion} 的语义契约`)
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
