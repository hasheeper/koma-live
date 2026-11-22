import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import {
  collectCaptureGroups,
  expandTimeRange,
  parseCliArgs,
  validateInspectPlan,
} from '../apps/rig-cli/inspect-plan.mjs'

const execFileAsync = promisify(execFile)
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

describe('koma-rig.inspect.v1 validation & grouping (apps/rig-cli boundary)', () => {
  it('expands time ranges by count or step without losing endpoints', () => {
    expect(expandTimeRange({ from: 100, to: 500, count: 5 })).toEqual([100, 200, 300, 400, 500])
    expect(expandTimeRange({ from: 0, to: 250, every: 100 })).toEqual([0, 100, 200, 250])
    expect(expandTimeRange({ from: 180, to: 180, count: 4 })).toEqual([180])
  })

  it('validates all four panel primitives, alpha channel, and rejects invalid plans', () => {
    const plan = validateInspectPlan({
      format: 'koma-rig.inspect.v1',
      source: { work: './tests/fixtures/live-demo/koma-work.json' },
      timeline: [
        { at: 0, state: 'breeze' },
        { at: 120, trigger: 'flick' },
      ],
      boards: [
        {
          file: 'composite.png',
          sections: [
            {
              columns: 1,
              panels: [
                { kind: 'strip', frames: [0, { t: 120, label: 'flick' }, 260], overlays: { guides: [{ y: 64 }] } },
              ],
            },
            {
              columns: [1.2, 1, 1],
              panels: [
                { kind: 'onion', range: { from: 120, to: 360, count: 5 }, focus: 240, tint: 'spine' },
                { kind: 'frame', t: 260, channel: 'alpha', crop: [10, 20, 100, 80] },
                {
                  kind: 'compare',
                  mode: 'side-by-side',
                  entries: [
                    { t: 260, label: 'full', container: [800, 600], viewport: { fit: 'contain', anchor: [0.5, 1] } },
                    { t: 260, label: 'card', container: [360, 540], viewport: { fit: 'contain', anchor: [0.5, 1] } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    })

    expect(plan.boards[0].sections[1].panels[1].channel).toBe('alpha')

    // Grouping isolates each viewport compare context while keeping logical frames in a single pass
    const groups = collectCaptureGroups(plan)
    expect(groups).toHaveLength(3)
    const logical = groups.find((g) => g.kind === 'logical')
    const viewports = groups.filter((g) => g.kind === 'viewport')
    expect(logical?.times).toEqual([0, 120, 180, 240, 260, 300, 360])
    expect(viewports).toHaveLength(2)
    expect(viewports.map((v) => v.container)).toEqual([
      [800, 600],
      [360, 540],
    ])
    expect(viewports.every((v) => v.times.length === 1 && v.times[0] === 260)).toBe(true)

    expect(() =>
      validateInspectPlan({
        format: 'koma-rig.inspect.v1',
        source: {},
        boards: [],
      }),
    ).toThrow(/work 或 rig/)

    expect(() =>
      validateInspectPlan({
        format: 'koma-rig.inspect.v1',
        source: { rig: './slices' },
        boards: [{ file: 'a.png', sections: [{ panels: [{ kind: 'frame', t: 0, channel: 'depth' }] }] }],
      }),
    ).toThrow(/rgba.*alpha/)

    expect(() =>
      validateInspectPlan({
        format: 'koma-rig.inspect.v1',
        source: { rig: './slices' },
        boards: [{ file: 'a.png', sections: [{ panels: [{ kind: 'compare', entries: [{ t: 0 }] }] }] }],
      }),
    ).toThrow(/至少需要 2 项/)
  })

  it('translates shortcut CLI flags and supports --plan stdin mode', () => {
    const planMode = parseCliArgs(['--plan', '-', '--out', '.tmp/custom'])
    expect(planMode).toEqual({ mode: 'plan', planPath: '-', outDirOverride: '.tmp/custom' })

    const shortcut = parseCliArgs([
      './tests/fixtures/live-demo/koma-work.json',
      '--state',
      'gust@0',
      '--trigger',
      'flick@120',
      '--times',
      '0,120,260',
      '--onion',
      '120..420:4',
      '--arcs',
      'tip.end',
      '--guides',
      'y=64:center',
      '--channel',
      'alpha',
      '--out',
      '.tmp/out',
    ])
    expect(shortcut.mode).toBe('shortcut')
    expect(shortcut.plan.timeline).toEqual([
      { at: 0, state: 'gust' },
      { at: 120, trigger: 'flick' },
    ])
    expect(shortcut.plan.boards[0].sections).toHaveLength(2)
    expect(shortcut.plan.boards[0].sections[0].panels[0].channel).toBe('alpha')
    expect(shortcut.plan.boards[0].sections[1].panels[0].kind).toBe('onion')
    expect(shortcut.plan.boards[0].sections[1].panels[0].overlays.arcs).toEqual([
      { target: 'tip', point: 'end', color: undefined, dots: true },
    ])
  })

  it('exports rig-spec.json via rig spec CLI for both rig.json and setup.json-only directories', async () => {
    const rigCli = join(repoRoot, 'apps/rig-cli/rig.mjs')

    // 1) Directory with saved rig.json -> prints koma-rig.spec.v1 directly to stdout
    const { stdout: demoOut } = await execFileAsync(
      process.execPath,
      [rigCli, 'spec', join(repoRoot, 'tests/fixtures/live-demo/slices')],
      { cwd: repoRoot },
    )
    const demoSpec = JSON.parse(demoOut)
    expect(demoSpec.format).toBe('koma-rig.spec.v1')
    expect(demoSpec.bones.map((b: { boneId: string }) => b.boneId)).toEqual(['base', 'tip'])

    // 2) Source directory with setup.json only (no rig.json) -> synthesizes skeleton in memory
    const { stdout: chainOut } = await execFileAsync(
      process.execPath,
      [rigCli, 'spec', join(repoRoot, 'tests/fixtures/chain-strip')],
      { cwd: repoRoot },
    )
    const chainSpec = JSON.parse(chainOut)
    expect(chainSpec.format).toBe('koma-rig.spec.v1')
    expect(chainSpec.bones.map((b: { boneId: string }) => b.boneId)).toEqual(['base', 'tip'])

    // 3) GBot example directory + atomic output path write
    const { stdout: gbotOut } = await execFileAsync(
      process.execPath,
      [rigCli, 'spec', join(repoRoot, 'examples/gbot/slices')],
      { cwd: repoRoot },
    )
    const gbotSpec = JSON.parse(gbotOut)
    expect(gbotSpec.format).toBe('koma-rig.spec.v1')
    expect(gbotSpec.canvas).toEqual({ width: 625, height: 995 })
    expect(gbotSpec.bones.length).toBe(14)
    expect(gbotSpec.bones.some((b: { boneId: string }) => b.boneId === 'foot_r')).toBe(true)

    const tempDir = await mkdtemp(join(tmpdir(), 'koma-rig-spec-'))
    try {
      const outPath = join(tempDir, 'rig-spec.json')
      const { stdout: fileSummary } = await execFileAsync(
        process.execPath,
        [rigCli, 'spec', join(repoRoot, 'examples/gbot/slices'), outPath],
        { cwd: repoRoot },
      )
      const meta = JSON.parse(fileSummary)
      expect(meta.output).toBe(outPath)
      expect(meta.bones).toBe(14)
      const written = JSON.parse(await readFile(outPath, 'utf8'))
      expect(written).toEqual(gbotSpec)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
