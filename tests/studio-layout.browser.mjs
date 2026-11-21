import assert from 'node:assert/strict'
import { once } from 'node:events'
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'
import { preview } from 'vite'

// Measure the loaded production CSS. Checking just the outer row height misses
// the regression where every label and both transparent fields packed to the right.
async function readBindingLayout(panel) {
  return panel.evaluate(el => {
    const heading = el.querySelector('.section-heading').getBoundingClientRect()
    return Array.from(el.querySelectorAll('.property-row'), row => {
      const [label, field] = row.children
      const labelBox = label.getBoundingClientRect()
      const fieldBox = field.getBoundingClientRect()
      return {
        label: label.textContent,
        labelOffset: labelBox.left - heading.left,
        fieldOffset: fieldBox.left - heading.left,
        trailingGap: heading.right - fieldBox.right,
        fieldTop: fieldBox.top,
        fieldHeight: fieldBox.height,
        radius: getComputedStyle(field).borderRadius,
        border: getComputedStyle(field).borderTopWidth,
        background: getComputedStyle(field).backgroundColor,
        panelColor: getComputedStyle(el).backgroundColor,
      }
    })
  })
}

async function visibleGridSpacing(page) {
  return page.locator('.workspace-grid').evaluate(canvas => {
    const mat = getComputedStyle(canvas).getPropertyValue('--canvas-bg').trim()
    const backgroundRed = parseInt(mat.slice(1,3),16)
    const width = canvas.width
    const rows = canvas.getContext('2d').getImageData(0,0,width,2).data
    for (let y=0; y<2; y++) {
      let previous = -Infinity, closest = Infinity
      for (let x=0; x<width; x++) {
        if (rows[4*(y*width+x)] === backgroundRed) continue
        closest = Math.min(closest,x-previous)
        previous = x
      }
      // A horizontal ruling occupies at most one of the two device rows.
      if (closest>1 && Number.isFinite(closest)) return closest/devicePixelRatio
    }
    throw new Error('Missing vertical graduations')
  })
}

async function openStudio(t) {
  const root = fileURLToPath(new URL('../apps/rig-studio', import.meta.url))
  const server = await preview({ root, logLevel: 'error', preview: { host: '127.0.0.1', port: 0 } })
  t.after(() => server.close())
  if (!server.httpServer.listening) await once(server.httpServer, 'listening')
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  t.after(() => browser.close())
  const page = await browser.newPage({ viewport: {width: 1280, height: 800}, colorScheme: 'dark', reducedMotion: 'reduce' })
  await page.goto('http://127.0.0.1:' + server.httpServer.address().port)
  return page
}

test('floating studio keeps the artboard interactive and the inspector aligned in both themes', async t => {
  const page = await openStudio(t)
  const panel = page.getByRole('complementary', {name: '属性检查器'})
  const pick = panel.getByRole('button', {name: '拾取起骨'})
  await pick.waitFor()
  await page.locator('.pixi-surface canvas').waitFor()
  await page.evaluate(() => document.fonts.ready)
  const box = selector => page.locator(selector).boundingBox()
  const button = name => page.getByRole('button', {name,exact:true})
  const painted = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))))
  async function checkFit() {
    await painted()
    const frame = await box('.camera-frame'), art = await box('.pixi-surface canvas')
    assert.ok(art.x >= frame.x && art.y >= frame.y)
    assert.ok(art.x + art.width <= frame.x + frame.width && art.y + art.height <= frame.y + frame.height)
    assert.ok(Math.abs(art.x+art.width/2-frame.x-frame.width/2)<.1)
    assert.deepEqual(art, await box('.pixi-surface'))
    const corners = await box('.document-corners')
    for (const key of ['x','y','width','height']) assert.ok(Math.abs(corners[key]-art[key])<.03, key)
  }
  // Check the actual composited pixels on either side of the document edge.
  // The surrounding workspace and the transparent part of the slice must have
  // the same base and show a visible grid in both themes.
  async function checkContinuousGrid() {
    const art = await box('.pixi-surface')
    const centerX = Math.round(art.x)
    const clip = {x:centerX-32,y:Math.round(art.y+art.height*.22),width:64,height:24}
    const png = await page.screenshot({clip})
    const [outside,inside] = await page.evaluate(async encoded => {
      const img = await createImageBitmap(await (await fetch('data:image/png;base64,'+encoded)).blob())
      const ctx = new OffscreenCanvas(img.width,img.height).getContext('2d')
      ctx.drawImage(img,0,0)
      img.close()
      return [0,32].map(x => {
        const data = ctx.getImageData(x,0,32,24).data, colors = new Map()
        for (let i=0;i<data.length;i+=4) {
          const rgb = data.slice(i,i+3).join(',')
          colors.set(rgb,(colors.get(rgb) ?? 0)+1)
        }
        return [...colors].sort((a,b)=>b[1]-a[1]).map(([rgb])=>rgb)
      })
    },png.toString('base64'))
    assert.equal(outside[0],inside[0],'canvas fill must continue across the document bounds')
    assert.ok(outside.length>1 && inside.length>1,'grid should be visible on both sides')
    return outside[0]
  }
  const viewport = page.viewportSize()
  assert.deepEqual(await box('.viewport'), {x:0,y:0,...viewport})
  assert.equal((await box('.hierarchy')).x,10)
  const inspector = await panel.boundingBox()
  assert.equal(inspector.x + inspector.width, viewport.width-10)
  assert.equal(inspector.y + inspector.height, viewport.height-10)
  assert.equal(await panel.getByText('属性检查器', {exact:true}).count(),0)
  const middle = await box('.modes')
  assert.equal(middle.x+middle.width/2,viewport.width/2)
  const centerY = rect => rect.y + rect.height / 2
  for (const selector of ['.brand-mark', '.brand-title', '.file-button', '.file-caret', '.history-controls button:first-child', '.view-controls']) {
    assert.equal(centerY(await box(selector)), centerY(middle), selector)
  }
  // The RIG subtitle shares the wordmark's baseline rather than its box centre.
  const title = await box('.brand-title'), subtitle = await box('.brand-subtitle')
  assert.ok(Math.abs(title.y + title.height - (subtitle.y + subtitle.height)) <= 1.5, 'RIG sits on the Koma baseline')
  const undo = button('撤销'), clean = await undo.boundingBox()
  await page.locator('.tree-row[data-kind=layer]').first().getByTitle('锁定图层').click()
  assert.match(await button('企划菜单').getAttribute('title'), /未导出/)
  assert.deepEqual(await undo.boundingBox(), clean)
  await undo.click()
  assert.doesNotMatch(await button('企划菜单').getAttribute('title'), /未导出/)
  await checkFit()
  const mats = []
  assert.equal(await page.getByRole('combobox',{name:'画布背景'}).count(),0)
  for (const theme of ['dark', 'light']) {
    if (theme === 'light') await page.getByRole('button', {name: '切换主题'}).click()
    assert.equal(await page.locator('.studio').getAttribute('data-theme'), theme)
    mats.push(await checkContinuousGrid())
    // Check the rendered pixels: the old grid reader treated the new hex tokens as numbers.
    const gridColors = await page.locator('.workspace-grid').evaluate(canvas => {
      const {data} = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height)
      const colors = new Set()
      for (let i=0; i<data.length; i+=4) colors.add((data[i]<<16) | (data[i+1]<<8) | data[i+2])
      return [...colors].sort((a,b) => a-b)
    })
    assert.deepEqual(gridColors, theme==='dark' ? [0x17181B,0x1B1C20,0x202227] : [0xD5D8DE,0xDBDDE2,0xE2E4E8])
    const background = selector => page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor)
    const raised = theme==='dark' ? 'rgb(42, 45, 52)' : 'rgb(255, 255, 255)'
    assert.equal(await background('.object-head'), 'rgba(0, 0, 0, 0)')
    assert.equal(await background('.toolstrip button[aria-pressed=true]:first-child'), raised)
    assert.equal(await background('.tree-row.chosen'), theme==='dark' ? 'rgba(61, 242, 255, 0.1)' : 'rgba(8, 145, 178, 0.1)')
    const rows = await readBindingLayout(panel)
    assert.deepEqual(rows.map(row => row.label), ['起骨', '末骨', '关节柔化'])
    for (const [i, row] of rows.entries()) {
      assert.equal(row.labelOffset, 0, row.label)
      assert.equal(row.fieldOffset, 72, row.label)
      assert.equal(row.trailingGap, 0, row.label)
      assert.ok(row.fieldHeight >= 22 && row.fieldHeight <= 25)
      if (i) assert.equal(row.fieldTop - rows[i - 1].fieldTop - rows[i-1].fieldHeight, 6)
      assert.equal(row.border,'0px')
      assert.equal(row.radius,'6px')
      assert.notEqual(row.background, 'rgba(0, 0, 0, 0)', row.label)
      assert.notEqual(row.background, row.panelColor, row.label)
    }
    await pick.click()
    assert.equal(await pick.getAttribute('aria-pressed'), 'true')
    const [active, resting] = await readBindingLayout(panel)
    assert.notEqual(active.background, resting.background)
    await page.keyboard.press('Escape')
    assert.equal(await pick.getAttribute('aria-pressed'), 'false')
  }
  assert.notEqual(mats[0],mats[1])
  const projectIsland = await box('.project-island')
  const gapX = (projectIsland.x+projectIsland.width+middle.x)/2
  const artBefore = await box('.pixi-surface')
  await button('平移').click()
  await page.mouse.move(gapX,24)
  await page.mouse.down()
  await page.mouse.move(gapX+35,46)
  await page.mouse.up()
  await painted()
  const panned = await box('.pixi-surface')
  assert.ok(Math.abs(panned.x-artBefore.x-35)<.1 && Math.abs(panned.y-artBefore.y-22)<.1)
  await button('适屏').click()
  await button('切换层级树').click()
  await checkFit()
  assert.equal(await page.locator('.hierarchy').isVisible(),false)
  await button('切换层级树').click()
  const closeSpacing = await visibleGridSpacing(page)
  await button('企划菜单').click()
  assert.equal((await box('.file-menu')).x, (await box('.file-button')).x)
  await page.mouse.click(viewport.width/2, viewport.height/2)
  assert.equal(await page.locator('.file-menu').count(), 0)
  await button('企划菜单').click()
  await button('多图层练习').click()
  await page.waitForFunction(() => document.querySelector('.file-button')?.textContent.includes('多图层'))
  await page.locator('.pixi-surface canvas').waitFor()
  await painted()
  const overviewSpacing = await visibleGridSpacing(page)
  assert.ok(overviewSpacing >= 47, 'whole-character view should omit crowded subdivisions')
  assert.ok(closeSpacing < overviewSpacing, 'close-up editing should reveal finer graduations')
  await page.setViewportSize({width:390,height:740})
  await checkFit()
  const tools = await box('.toolstrip'), shelf = await panel.boundingBox()
  assert.ok(tools.y+tools.height <= shelf.y-10)
  assert.ok((await box('.hierarchy')).x + (await box('.hierarchy')).width <= shelf.x-10)
})

test('opens source directories with pixel verification and edits bone poses in Studio', async t => {
  const page = await openStudio(t)
  const folder = page.locator('input[webkitdirectory]')
  const name = page.locator('.file-name')
  const strip = fileURLToPath(new URL('../examples/chain-strip', import.meta.url))
  await folder.setInputFiles(strip)
  await name.getByText('chain-strip', {exact:true}).waitFor()
  await page.getByRole('button', {name:'试动', exact:true}).click()
  const rotate = page.getByRole('spinbutton', {name:'旋转', exact:true})
  await rotate.press('ArrowRight')
  assert.equal(await rotate.getAttribute('aria-valuenow'), '0.5')
  await page.getByRole('button', {name:'姿势复位'}).click()
  assert.equal(await rotate.getAttribute('aria-valuenow'), '0')
  assert.equal(await page.getByRole('toolbar', {name:'画布工具'}).getByRole('button', {name:'播放'}).count(), 0)

  await folder.setInputFiles(fileURLToPath(new URL('../apps/rig-studio/src/samples/gbot', import.meta.url)))
  await name.getByText('gbot', {exact:true}).waitFor()
  await page.getByRole('button', {name:'试动', exact:true}).click()
  await rotate.waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)

  const misaligned = await mkdtemp(join(tmpdir(), 'koma-misaligned-'))
  t.after(() => rm(misaligned, {recursive:true, force:true}))
  await cp(strip, misaligned, {recursive:true})
  const manifestPath = join(misaligned, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.layers[0].rect[0] += 1
  await writeFile(manifestPath, JSON.stringify(manifest))
  await folder.setInputFiles(misaligned)
  await page.getByRole('alert').getByText(/像素超差/).waitFor()
  assert.equal(await name.textContent(), 'gbot')
})

test('generates a boneChain contour mesh in one click from BoneBinding and supports undo', async t => {
  const page = await openStudio(t)
  const panel = page.getByRole('complementary', { name: '属性检查器' })
  const autoMeshBtn = panel.getByRole('button', { name: '生成骨链轮廓网格' })
  await autoMeshBtn.waitFor()
  await autoMeshBtn.click()
  // Once generated, the button disappears because the boneChain layer now has a contour mesh
  await page.waitForFunction(() => !document.querySelector('.chain-mesh-cta'))
  assert.match(await page.getByRole('button', { name: '企划菜单' }).getAttribute('title'), /未导出/)
  // Undo cleanly restores the pre-mesh state and brings the CTA back
  await page.getByRole('button', { name: '撤销', exact: true }).click()
  await autoMeshBtn.waitFor()
})
