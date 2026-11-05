/** PSD/PSB inspection, layer conversion and safe copy import. */
const fs = require('fs'), path = require('path'), os = require('os'), zlib = require('zlib'), assert = require('assert/strict')
const { writePsdBuffer, readPsd, initializeCanvas } = require('ag-psd')
initializeCanvas(()=>{throw new Error('Unexpected canvas allocation')},(width,height)=>({width,height,data:new Uint8ClampedArray(width*height*4)}))
const { rmDeepSafe } = require('./helpers/rm.cjs')
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-psd-import-'))
process.env.PRINTPRESS_DATA_DIR = path.join(root, 'data')
const psd = require('../electron/psd-import.cjs')
const designs = require('../electron/designs.cjs')
const rgba = (w,h) => ({ width:w,height:h,data:new Uint8ClampedArray(w*h*4).fill(255) })
const rectangle = { paths:[{open:false,operation:'combine',knots:[[0,0],[10,0],[10,10],[0,10]].map(([x,y])=>({linked:false,points:[x,y,x,y,x,y]}))}] }
const source = { width:100,height:80,imageData:rgba(100,80),imageResources:{resolutionInfo:{horizontalResolution:100,horizontalResolutionUnit:'PPI',verticalResolution:100,verticalResolutionUnit:'PPI',widthUnit:'Inches',heightUnit:'Inches'}},children:[
  { name:'文字',left:4,top:5,imageData:rgba(10,10),text:{text:'Hello',style:{fontSize:12,font:{name:'ArialMT'},fillColor:{r:255,g:0,b:0}}} },
  { name:'矩形',imageData:rgba(10,10),vectorFill:{type:'color',color:{r:255,g:0,b:0}},vectorMask:rectangle },
  { name:'图片',left:10,top:20,imageData:rgba(10,10) },
] }
async function main() {
  for (const ext of ['psd','psb']) {
    const file = path.join(root, `source.${ext}`), original = writePsdBuffer(source,{psb:ext==='psb'})
    fs.writeFileSync(file,original)
    const summary = await psd.inspect(file)
    assert.equal(summary.kind,'psd'); assert.equal(summary.width,100); assert.equal(summary.dpi,100)
    assert.equal(summary.stats.layerCount,3)
    assert.equal(summary.stats.imageCount,1,'文字备选预览不计入现有图片层')
    assert.equal(summary.textPreview.available,1)
    assert.ok(summary.warnings.some(w=>w.layer==='文字' && w.message.includes('可编辑')))
    const withPreview = await psd.inspect(file)
    // The checked snapshot is used even if the source changes before confirmation.
    fs.writeFileSync(file,'changed')
    const saved = psd.commit(summary.token)
    assert.deepEqual(saved.layers.map(l=>l.type),['text','rect','image'])
    assert.equal(saved.layers[1].fill,'#ff0000'); assert.equal(saved.layers[0].text,'Hello')
    assert.equal(saved.artboard.w,25.4); assert.equal(saved.artboard.h,20.32)
    assert.equal(designs.getDesign(saved.id).layers[0].text,'Hello')
    const preserved = psd.commit(withPreview.token,{rasterizeText:true})
    assert.deepEqual(preserved.layers.map(l=>l.type),['image','rect','image'],`${ext} 有预览文字转图片，其余层不变`)
    assert.deepEqual(preserved.fontAssets,{},'文字转图片后不依赖本机字体')
    assert.equal(preserved.layers[0].x,1.016); assert.equal(preserved.layers[0].y,1.27)
    const previewPng=fs.readFileSync(path.join(process.env.PRINTPRESS_DATA_DIR,preserved.assets[preserved.layers[0].assetId].path))
    assert.ok(previewPng.equals(psd.pngFromPixels(rgba(10,10))),`${ext} 文字像素来自检查时的 PSD 快照`)
    assert.throws(()=>psd.commit(summary.token),/失效/)
    fs.writeFileSync(file,original)
    const cancel = await psd.inspect(file); psd.cancel(cancel.token)
    assert.throws(()=>psd.commit(cancel.token),/失效/)
    assert.ok(fs.readFileSync(file).equals(original), 'inspection and cancellation preserve source')
  }
  {
    const blankPreview = path.join(root,'no-text-preview.psd')
    fs.writeFileSync(blankPreview,writePsdBuffer({ ...source,children:[{...source.children[0],imageData:{width:10,height:10,data:new Uint8ClampedArray(400)}}] }))
    const summary=await psd.inspect(blankPreview)
    assert.equal(summary.textPreview.available,0)
    assert.equal(summary.textPreview.unavailable,1)
    assert.equal(psd.commit(summary.token,{rasterizeText:true}).layers[0].type,'text','缺少预览时保留可编辑文字')
  }
  // 按 PSD 原始堆叠顺序创建有明确遮挡关系的画面，包含分组、嵌套分组及隐藏层。
  const solid = (w,h,c) => ({ width:w,height:h,data:new Uint8ClampedArray(Array.from({length:w*h},()=>c).flat()) })
  const image = (name,x,y,size,c,extra={}) => ({ name,left:x,top:y,imageData:solid(size,size,c),...extra })
  const expected = solid(40,40,[255,0,0,255])
  function paint(x,y,size,c) { for(let py=y;py<y+size;py++) for(let px=x;px<x+size;px++) expected.data.set(c,(py*40+px)*4) }
  paint(4,4,32,[0,255,0,255]); paint(8,8,24,[0,0,255,255]); paint(12,12,16,[255,255,0,255]); paint(16,16,8,[255,255,255,255])
  const stacked = { ...source,width:40,height:40,imageData:expected,children:[
    image('底层',0,0,40,[255,0,0,255]),
    {name:'外层组',children:[image('组下',4,4,32,[0,255,0,255]),{name:'嵌套组',children:[image('嵌套下',8,8,24,[0,0,255,255]),image('嵌套上',12,12,16,[255,255,0,255])]}]},
    image('前景',16,16,8,[255,255,255,255]),
    image('隐藏',0,0,40,[0,0,0,255],{hidden:true}),
  ] }
  for (const ext of ['psd','psb']) {
    const file = path.join(root,`stack.${ext}`), bytes = writePsdBuffer(stacked,{psb:ext==='psb'})
    fs.writeFileSync(file,bytes)
    const checked = await psd.inspect(file), saved = psd.commit(checked.token)
    assert.deepEqual(saved.layers.map(l=>l.name),['底层','组下','嵌套下','嵌套上','前景','隐藏'])
    assert.deepEqual(saved.groups[0].layerIds,saved.layers.slice(1,4).map(l=>l.id))
    assert.equal(saved.layers.at(-1).visible,false)
    const restored = Buffer.alloc(40*40*4)
    for (const layer of designs.getDesign(saved.id).layers.filter(l=>l.visible)) {
      const png = fs.readFileSync(path.join(process.env.PRINTPRESS_DATA_DIR,saved.assets[layer.assetId].path))
      const compressed=[]
      for(let at=8;at<png.length;) { const size=png.readUInt32BE(at); if(png.toString('ascii',at+4,at+8)==='IDAT') compressed.push(png.subarray(at+8,at+8+size)); at+=size+12 }
      const w=png.readUInt32BE(16),h=png.readUInt32BE(20),rows=zlib.inflateSync(Buffer.concat(compressed))
      const left=Math.round(layer.x*100/25.4),top=Math.round(layer.y*100/25.4)
      for(let y=0;y<h;y++) { assert.equal(rows[y*(w*4+1)],0); rows.copy(restored,((top+y)*40+left)*4,y*(w*4+1)+1,(y+1)*(w*4+1)) }
    }
    const composite=readPsd(bytes,{useImageData:true,skipThumbnail:true}).imageData
    assert.ok(restored.equals(Buffer.from(composite.data)),`${ext} 导入层合成与原文件合并画面逐像素一致`)

    // 稀疏尾部使文件真实超过旧上限，无需创建数百 MB 像素数据。
    const large = path.join(root,`large.${ext}`), fd=fs.openSync(large,'w')
    try { fs.writeSync(fd,bytes); fs.ftruncateSync(fd,129*1024*1024) } finally { fs.closeSync(fd) }
    const summary=await psd.inspect(large)
    assert.equal(summary.totalBytes,129*1024*1024,`${ext} 超过 128 MB 也可完成检查`)
    assert.deepEqual(psd.commit(summary.token).layers.map(l=>l.name),saved.layers.map(l=>l.name))
    const oversized=fs.openSync(large,'r+')
    try { fs.ftruncateSync(oversized,512*1024*1024+1) } finally { fs.closeSync(oversized) }
    await assert.rejects(psd.inspect(large),/超过 512 MB/)
  }
  const invalid = path.join(root,'invalid.psd'); fs.writeFileSync(invalid,Buffer.alloc(30))
  await assert.rejects(psd.inspect(invalid),/有效/)
  const cmyk = writePsdBuffer(source); cmyk.writeUInt16BE(4,24); fs.writeFileSync(invalid,cmyk)
  await assert.rejects(psd.inspect(invalid),/8 位 RGB/)
  console.log('PSD_IMPORT_OK: PSD/PSB, stacking pixels and groups, >128 MB import, 512 MB limit, editable layers, snapshots and cancellation')
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>rmDeepSafe(root))
