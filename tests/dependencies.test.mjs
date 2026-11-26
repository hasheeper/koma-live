import { readFileSync, readdirSync } from 'node:fs'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const json = file => JSON.parse(readFileSync(resolve(root, file), 'utf8'))
const allowed = {
  'packages/rig-core': ['zod'],
  'packages/rig-renderer': ['@koma-rig/rig-core', 'pixi.js'],
  'apps/rig-cli': ['@koma-rig/rig-core'],
  'apps/rig-studio': ['vue', '@koma-rig/rig-core', '@koma-rig/rig-renderer'],
}
const blacklisted = new Set(['gsap','animejs','framer-motion','matter-js','ag-psd'])
const pkg = path => path.startsWith('@') ? path.split('/').slice(0,2).join('/') : path.split('/')[0]
function sources(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = resolve(dir, entry.name)
    if (['node_modules','dist','test'].includes(entry.name)) return []
    return entry.isDirectory() ? sources(file) : ['.js','.ts','.mjs','.vue'].includes(extname(file)) ? [file] : []
  })
}

it.each(Object.entries(allowed))('%s declares only allowed runtime dependencies', (dir, names) => {
  const manifest = json(dir + '/package.json')
  const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
  expect(Object.keys(dependencies).filter(name => !names.includes(name))).toEqual([])
})

it.each([
  ['packages/rig-core', ['pixi.js', 'vue', 'react', 'react-dom']],
  ['packages/rig-renderer', ['vue', 'react', 'react-dom']],
])('%s excludes its UI and rendering blacklist in every dependency section', (dir, forbidden) => {
  const { dependencies, optionalDependencies, peerDependencies, devDependencies } = json(dir + '/package.json')
  for (const [name, version] of Object.entries({ ...dependencies, ...optionalDependencies, ...peerDependencies, ...devDependencies })) {
    expect(forbidden.includes(name) || forbidden.some(b => version.startsWith('npm:' + b + '@')), name).toBe(false)
  }
})

it('excludes tween, physics and browser PSD libraries from all workspaces and the lockfile', () => {
  const manifests = ['package.json', ...Object.keys(allowed).map(dir => dir + '/package.json')].map(json)
  const locked = json('package-lock.json').packages
  for (const path of Object.keys(locked)) {
    expect(blacklisted.has(path.split('node_modules/').at(-1)), path).toBe(false)
  }
  for (const entry of [...manifests, ...Object.values(locked)]) {
    const deps = { ...entry.dependencies, ...entry.devDependencies, ...entry.optionalDependencies }
    for (const [name, version] of Object.entries(deps)) {
      expect(blacklisted.has(name) || [...blacklisted].some(b => version.startsWith('npm:' + b + '@')), name).toBe(false)
    }
  }
  for (const dir of Object.keys(allowed)) {
    for (const file of sources(resolve(root, dir))) {
      const imports = ts.preProcessFile(readFileSync(file, 'utf8'), true, true).importedFiles
      for (const ref of imports) expect(blacklisted.has(pkg(ref.fileName)), file).toBe(false)
    }
  }
})

it.each(['packages/rig-core', 'packages/rig-renderer'])('%s imports only its own source and allowed packages', dir => {
  const src = resolve(root, dir, 'src')
  for (const path of sources(src)) {
    const contents = readFileSync(path, 'utf8')
    for (const { fileName } of ts.preProcessFile(contents, true, true).importedFiles) {
      if (fileName.startsWith('.')) expect(resolve(dirname(path), fileName).startsWith(src + sep), path).toBe(true)
      else expect(allowed[dir], path).toContain(pkg(fileName))
    }
  }
})

it('compiles the core against ECMAScript globals only, including dependency declarations', () => {
  const dir = resolve(root, 'packages/rig-core')
  const config = ts.getParsedCommandLineOfConfigFile(dir + '/tsconfig.json', {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(String(d.messageText)) },
  })
  expect(config.options.lib).toEqual(['lib.es2022.d.ts'])
  expect(config.options.types).toEqual([])
  const program = ts.createProgram(config.fileNames, config.options)
  expect(program.getSourceFiles().filter(f => /lib\.(dom|webworker)(\.|$)/.test(f.fileName))).toEqual([])
  expect(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText,'\n'))).toEqual([])
}, 20_000)
