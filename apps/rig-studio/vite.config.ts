import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import vue from '@vitejs/plugin-vue'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const MIME: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
}

function resolveInsideRepo(relPath: string): string | null {
  if (!relPath || relPath.includes('\0') || relPath.startsWith('/') || relPath.startsWith('\\')) return null
  const normalized = relPath.replace(/\\/g, '/')
  const segments = normalized.split('/').filter(Boolean)
  if (!segments.length || segments.some((s) => s === '..' || s === '.git' || s === 'node_modules')) return null
  const full = resolve(repoRoot, ...segments)
  if (full !== repoRoot && !full.startsWith(repoRoot + sep)) return null
  return full
}

async function listExampleWorks() {
  const examplesDir = join(repoRoot, 'examples')
  let entries
  try {
    entries = await readdir(examplesDir, { withFileTypes: true })
  } catch {
    return []
  }
  const works: Array<{
    path: string
    kind: 'work' | 'slices'
    id: string
    title: string
    hasPerformance: boolean
  }> = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const relDir = `examples/${entry.name}`
    const fullDir = join(examplesDir, entry.name)
    try {
      const rawWork = await readFile(join(fullDir, 'koma-work.json'), 'utf8')
      const parsed = JSON.parse(rawWork) as { id?: string; title?: string; performance?: string }
      works.push({
        path: relDir,
        kind: 'work',
        id: typeof parsed.id === 'string' && parsed.id ? parsed.id : entry.name,
        title: typeof parsed.title === 'string' && parsed.title ? parsed.title : parsed.id || entry.name,
        hasPerformance: typeof parsed.performance === 'string' && parsed.performance.length > 0,
      })
      continue
    } catch {
      // Fall through to plain slices check
    }
    try {
      const rawManifest = await readFile(join(fullDir, 'manifest.json'), 'utf8')
      const parsed = JSON.parse(rawManifest) as { sourceId?: string }
      let hasPerformance = false
      try {
        await stat(join(fullDir, 'performance.js'))
        hasPerformance = true
      } catch {
        hasPerformance = false
      }
      works.push({
        path: relDir,
        kind: 'slices',
        id: typeof parsed.sourceId === 'string' && parsed.sourceId ? parsed.sourceId : entry.name,
        title: typeof parsed.sourceId === 'string' && parsed.sourceId ? parsed.sourceId : entry.name,
        hasPerformance,
      })
    } catch {
      // Ignore directories that are neither koma-work nor slice packages
    }
  }
  works.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'work' ? -1 : 1
    return a.path.localeCompare(b.path)
  })
  return works
}

function devWorkspacePlugin(): Plugin {
  return {
    name: 'koma-dev-workspace',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__koma-workspace', async (req, res, next) => {
        try {
          const url = new URL(req.url || '/', 'http://127.0.0.1')
          const pathname = url.pathname

          if (req.method === 'GET' && pathname === '/list') {
            const works = await listExampleWorks()
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ works }))
            return
          }

          if (req.method === 'GET' && pathname === '/stat') {
            const relPaths = url.searchParams.getAll('path')
            const stats: Record<string, { mtimeMs: number; size: number } | null> = {}
            await Promise.all(
              relPaths.map(async (rel) => {
                const full = resolveInsideRepo(rel)
                if (!full) {
                  stats[rel] = null
                  return
                }
                try {
                  const info = await stat(full)
                  stats[rel] = info.isFile() ? { mtimeMs: Math.round(info.mtimeMs), size: info.size } : null
                } catch {
                  stats[rel] = null
                }
              }),
            )
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ stats }))
            return
          }

          if (req.method === 'GET' && pathname === '/file') {
            const rel = url.searchParams.get('path') ?? ''
            const full = resolveInsideRepo(rel)
            if (!full) {
              res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ error: 'Forbidden path' }))
              return
            }
            try {
              const [bytes, info] = await Promise.all([readFile(full), stat(full)])
              res.writeHead(200, {
                'content-type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
                'cache-control': 'no-store',
                'x-koma-mtime': String(Math.round(info.mtimeMs)),
              })
              res.end(bytes)
            } catch (err) {
              const code = (err as NodeJS.ErrnoException)?.code
              res.writeHead(code === 'ENOENT' ? 404 : 500, {
                'content-type': 'application/json; charset=utf-8',
                'cache-control': 'no-store',
              })
              res.end(JSON.stringify({ error: code === 'ENOENT' ? 'NotFound' : String(err) }))
            }
            return
          }

          if (req.method === 'PUT' && pathname === '/rig') {
            const rel = url.searchParams.get('path') ?? ''
            const full = resolveInsideRepo(rel)
            if (!full || basename(full) !== 'rig.json') {
              res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
              res.end(JSON.stringify({ error: '仅允许写回工作区内的 rig.json' }))
              return
            }
            const chunks: Buffer[] = []
            let total = 0
            for await (const chunk of req) {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
              total += buf.length
              if (total > 20 * 1024 * 1024) {
                res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' })
                res.end(JSON.stringify({ error: 'rig.json 体积超过限制' }))
                return
              }
              chunks.push(buf)
            }
            const text = Buffer.concat(chunks).toString('utf8')
            JSON.parse(text)
            await writeFile(full, text, 'utf8')
            const info = await stat(full)
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ ok: true, mtimeMs: Math.round(info.mtimeMs) }))
            return
          }

          next()
        } catch (err) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }))
        }
      })
    },
  }
}

export default defineConfig(({ command }) => ({
  base: './',
  define: {
    __KOMA_DEV_WORKSPACE__: JSON.stringify(command === 'serve'),
  },
  plugins: [vue(), devWorkspacePlugin()],
}))
