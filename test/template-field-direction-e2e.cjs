/** Exercise field direction, resizing, persistence and the real print renderer. */
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const assert = require('assert/strict')
const ROOT = path.resolve(__dirname, '..')
const tmp = fs.mkdtempSync(path.join(__dirname, '.tmp-field-direction-'))
process.env.PRINTPRESS_DATA_DIR = path.join(tmp, 'data')
app.setPath('userData', path.join(tmp, 'userData'))
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('in-process-gpu')
app.on('window-all-closed', () => {})
const timer = setTimeout(() => { console.error('FIELD_DIRECTION_TIMEOUT'); app.exit(1) }, 90000)
let ui
const evaluate = async code => {
  try { return await ui.webContents.executeJavaScript(code) }
  catch (error) { throw new Error(`${error.message}\nExpression: ${code}`) }
}
async function wait(code, label) {
  const start = Date.now()
  while (Date.now() - start < 15000) {
    if (await evaluate(code)) return
    await new Promise(resolve => setTimeout(resolve, 75))
  }
  throw Error('Waiting for ' + label)
}
async function clickText(selector, label) {
  await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(e => e.textContent.trim() === ${JSON.stringify(label)}); if (!el) throw Error('missing '+${JSON.stringify(label)}); el.click() })()`)
}
app.whenReady().then(async () => {
  const store = require('../electron/store.cjs')
  store.saveJson('settings', { onboarded: true, demoSeeded: true })
  store.saveJson('datasets', [{ id: 'ds_fields', name: '测试名单', columns: [{ key: 'name', alias: '姓名', printOn: true }], rows: [{ name: '张三' }, { name: '王小明' }] }])
  store.saveJson('templates', [{ id: 'tpl_fields', name: '方向测试', origin: 'user', datasetId: 'ds_fields', pageSize: { id: 'a4-landscape', w: 297, h: 210 }, fields: [] }])
  require('../electron/ipc.cjs').registerIpc()
  ipcMain.handle('app:meta', () => ({ version: 'test' }))
  ui = new BrowserWindow({ show: false, width: 1440, height: 1100, webPreferences: { preload: path.join(ROOT, 'electron/preload.cjs'), sandbox: false, contextIsolation: true, offscreen: true, backgroundThrottling: false } })
  ui.webContents.on('console-message', (_event, level, message) => { if (level >= 3) console.error('RENDERER_ERROR', message) })
  await ui.loadFile(path.join(ROOT, 'dist/index.html'))
  await wait(`!![...document.querySelectorAll('.nav-label')].find(e=>e.textContent.trim()==='模板')`, 'navigation')
  await clickText('.nav-label', '模板')
  await clickText('[role="tab"]', '常用')
  await wait(`!!document.querySelector('.tpl-name')`, 'template list')
  await clickText('.tpl-name', '方向测试')
  await wait(`!!document.querySelector('.palette-chip')`, 'field palette')
  await evaluate(`document.querySelector('.palette-chip').click()`)
  await wait(`!!document.querySelector('.field-box.selected .field-resize')`, 'new field')
  const choose = async label => {
    await evaluate(`([...document.querySelectorAll('.prop-row')].find(e=>e.textContent.includes('排列方向'))).querySelector('.cs-trigger').click()`)
    await clickText('.cs-option-label', label)
  }
  for (const [label, mode] of [['竖排 · 文字朝上','vertical'], ['竖排 · 文字朝左','vertical-left'], ['竖排 · 文字朝右','vertical-right']]) {
    await choose(label)
    assert.equal(await evaluate(`document.querySelectorAll('.field-box.selected .field-glyph').length`), 2)
    assert.equal(await evaluate(`document.querySelector('.field-box.selected .field-glyph > span').className`), mode)
  }
  const before = await evaluate(`(() => {const b=document.querySelector('.field-box.selected');return {width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,font:parseFloat(getComputedStyle(b).fontSize)} })()`)
  await evaluate(`(() => { const h=document.querySelector('.field-resize'), r=h.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2; h.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,clientX:x,clientY:y})); window.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,clientX:x+35,clientY:y+50})); window.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,clientX:x+35,clientY:y+50})); })()`)
  const after = await evaluate(`(() => {const b=document.querySelector('.field-box.selected');return {width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height,font:parseFloat(getComputedStyle(b).fontSize)} })()`)
  assert.ok(after.width > before.width + 30 && after.height > before.height + 45 && after.font > before.font)
  await clickText('.toolbar button', '保存')
  await wait(`document.querySelector('.notice.success')?.textContent.includes('模板已保存')`, 'save')
  const tpl = require('../electron/templates.cjs').getTemplate('tpl_fields')
  assert.equal(tpl.fields[0].direction, 'vertical-right')
  assert.ok(tpl.fields[0].boxWidth > 0 && tpl.fields[0].boxHeight > 0 && tpl.fields[0].fontSize > 24)
  const html = require('../electron/render-engine.cjs').buildHtml(tpl, [{ name: '张三' }, { name: '王小明' }], { withToolbar: false })
  const preview = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await preview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  const result = await preview.webContents.executeJavaScript(`(() => {const f=[...document.querySelectorAll('.pf')];return f.map(e=>({text:e.textContent, glyphs:e.querySelectorAll('.field-glyph').length, transform:getComputedStyle(e.querySelector('.field-glyph > span')).transform, w:e.style.width, h:e.style.height}))})()`)
  assert.deepEqual(result.map(x => [x.text, x.glyphs]), [['张三', 2], ['王小明', 3]])
  assert.ok(result.every(x => x.transform === 'matrix(0, 1, -1, 0, 0, 0)' && x.w && x.h))
  assert.ok((await preview.webContents.printToPDF({ printBackground: true, preferCSSPageSize: true })).length > 1000)
  for (const layout of [{ mode: 'grid', itemW: 90, itemH: 60 }, { mode: 'fold' }]) {
    const html = require('../electron/render-engine.cjs').buildHtml({ ...tpl, layout }, [{ name: '张三' }], { withToolbar: false })
    await preview.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
    const measure = await preview.webContents.executeJavaScript(`(() => { const f=document.querySelector('.pf'), frame=f.closest('.cell, .fold-half');return {ratio:f.getBoundingClientRect().width/frame.getBoundingClientRect().width, glyphs:f.querySelectorAll('.vertical-right').length} })()`)
    assert.ok(Math.abs(measure.ratio - tpl.fields[0].boxWidth / 100) < 0.002 && measure.glyphs === 2, layout.mode)
  }
  preview.destroy()
  store.saveJson('templates', [...store.loadJson('templates'), { ...tpl, id: 'tpl_overflow', fields: [{ ...tpl.fields[0], y: 98 }] }])
  assert.ok(require('../electron/print.cjs').validateBatch('ds_fields', 'tpl_overflow').issues.some(issue => issue.overlong === 2), 'vertical overflow is reported')
  await clickText('.tpl-name', '方向测试')
  await wait(`!!document.querySelector('.field-box .vertical-right')`, 'reopened field')
  console.log('FIELD_DIRECTION_E2E_OK: directions, resize, save/reopen, variable records and PDF')
  clearTimeout(timer)
  ui.destroy()
  app.exit(0)
}).catch(error => { console.error(error); clearTimeout(timer); if (ui && !ui.isDestroyed()) ui.destroy(); app.exit(1) })
