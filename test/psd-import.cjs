/** PSD/PSB inspection, layer conversion and safe copy import. */
const fs = require('fs'), path = require('path'), assert = require('assert/strict')
const { writePsdBuffer } = require('ag-psd')
const root = fs.mkdtempSync(path.join(__dirname, '.tmp-psd-'))
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
    assert.ok(summary.warnings.some(w=>w.layer==='文字' && w.message.includes('可编辑')))
    // The checked snapshot is used even if the source changes before confirmation.
    fs.writeFileSync(file,'changed')
    const saved = psd.commit(summary.token)
    assert.deepEqual(saved.layers.map(l=>l.type),['image','rect','text'])
    assert.equal(saved.layers[1].fill,'#ff0000'); assert.equal(saved.layers[2].text,'Hello')
    assert.equal(saved.artboard.w,25.4); assert.equal(saved.artboard.h,20.32)
    assert.equal(designs.getDesign(saved.id).layers[2].text,'Hello')
    assert.throws(()=>psd.commit(summary.token),/失效/)
    fs.writeFileSync(file,original)
    const cancel = await psd.inspect(file); psd.cancel(cancel.token)
    assert.throws(()=>psd.commit(cancel.token),/失效/)
    assert.ok(fs.readFileSync(file).equals(original), 'inspection and cancellation preserve source')
  }
  const invalid = path.join(root,'invalid.psd'); fs.writeFileSync(invalid,Buffer.alloc(30))
  await assert.rejects(psd.inspect(invalid),/有效/)
  const cmyk = writePsdBuffer(source); cmyk.writeUInt16BE(4,24); fs.writeFileSync(invalid,cmyk)
  await assert.rejects(psd.inspect(invalid),/8 位 RGB/)
  console.log('PSD_IMPORT_OK: PSD/PSB, editable layers, copied snapshot, cancellation and invalid formats')
}
main().catch(e=>{console.error(e);process.exitCode=1})
