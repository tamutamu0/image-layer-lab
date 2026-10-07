import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import {exportSketch,renderSketch} from '../src/sketch.mjs';
import {composite,compare} from '../src/images.mjs';

test('Sketch round-trip preserves overlapping RGBA pixels, coordinates and order',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-lab-'));
  try{
    const a=await sharp({create:{width:80,height:60,channels:4,background:'#d8c7aa'}}).png().toBuffer();
    const b=await sharp({create:{width:23,height:35,channels:4,background:{r:70,g:120,b:190,alpha:.5}}}).png().toBuffer();
    const c=await sharp({create:{width:11,height:12,channels:4,background:'#ed3279'}}).png().toBuffer();
    await Promise.all([a,b,c].map((b,i)=>writeFile(path.join(dir,`${i}.png`),b)));
    const manifest={title:'Fixture',width:80,height:60,layers:[
      {id:'background',name:'Background',file:'0.png',x:0,y:0},
      {id:'behind',name:'Behind / amodal',file:'1.png',x:12,y:9,amodal:true,opacity:.37},
      {id:'front',name:'Front',file:'2.png',x:19,y:17}]};
    const out=path.join(dir,'test.sketch');
    const check=await exportSketch(manifest,out,{root:dir,reference:false});
    assert.equal(check.bitmapCount,3);assert.ok(check.schemaValid);
    const diff=await compare(await composite(manifest,dir),await renderSketch(out));assert.equal(diff.identical,true);
    const hidden={...manifest,layers:manifest.layers.slice(0,2)};
    assert.equal((await compare(await composite(manifest,dir),await composite(hidden,dir))).identical,false);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Japanese editable text preserves UTF-16 ranges, styling and font naming modes',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-text-'));
  try{
    const text='価格\n3,278円 ✨';
    const manifest={title:'Editable text',width:300,height:200,layers:[{type:'text',id:'price',text,x:10,y:20,width:280,height:120,fontFamily:'Noto Sans JP',fontSize:36,weight:700,color:'#FFCC00',alignment:'center',lineHeight:42}]};
    for(const compatible of [false,true]){
      const file=path.join(dir,`${compatible}.sketch`);
      const report=await exportSketch({...manifest,figmaFontNames:compatible},file,{root:dir,reference:false});
      assert.equal(report.textCount,1);assert.equal(report.bitmapCount,0);
      const zip=new AdmZip(file),doc=JSON.parse(zip.readAsText('document.json'));
      const layer=JSON.parse(zip.readAsText(doc.pages[0]._ref+'.json')).layers[0].layers[0];
      assert.equal(layer.attributedString.string,text);
      const attr=layer.attributedString.attributes[0];assert.equal(attr.length,text.length);
      assert.equal(attr.attributes.MSAttributedStringFontAttribute.attributes.name,compatible?'Noto Sans JP-Bold':'NotoSansJP-Bold');
      assert.equal(attr.attributes.paragraphStyle.alignment,2);assert.equal(layer.textBehaviour,2);
    }
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Nested semantic groups retain local offsets and transparent effect pixels',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-groups-'));
  try{
    await sharp({create:{width:16,height:12,channels:4,background:{r:255,g:255,b:255,alpha:.4}}}).png().toFile(path.join(dir,'haze.png'));
    const flat={width:80,height:60,layers:[{id:'haze',name:'White veil',file:'haze.png',x:18,y:17,width:16,height:12}]};
    const grouped={...flat,exportLayers:[{type:'group',name:'Effects',x:10,y:8,width:50,height:40,layers:[{type:'group',name:'Haze',x:5,y:5,width:30,height:20,layers:[{...flat.layers[0],x:3,y:4}]}]}]};
    const file=path.join(dir,'groups.sketch');
    assert.equal((await exportSketch(grouped,file,{root:dir,reference:false})).schemaValid,true);
    assert.equal((await compare(await composite(flat,dir),await renderSketch(file))).identical,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('Overflow assets survive negative group offsets, frame clipping and full-extent readback',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-overflow-'));
  try{
    const pixels=Buffer.alloc(14*12*4);
    for(let y=0;y<12;y++)for(let x=0;x<14;x++){
      const i=(y*14+x)*4;pixels[i]=x*15;pixels[i+1]=y*18;pixels[i+2]=80;pixels[i+3]=50+x*10;
    }
    const png=await sharp(pixels,{raw:{width:14,height:12,channels:4}}).png().toBuffer();
    await writeFile(path.join(dir,'large.png'),png);
    const layer={id:'outside',name:'Outside photograph',file:'large.png',x:-3,y:-2,width:14,height:12};
    const m={width:8,height:6,layers:[layer],exportLayers:[{type:'group',name:'Photo',x:-5,y:-4,width:16,height:14,layers:[{...layer,x:2,y:2}]}],additionalBoards:[{name:'Full extent',width:14,height:12,layers:[{...layer,x:0,y:0}]}]};
    const file=path.join(dir,'overflow.sketch');await exportSketch(m,file,{root:dir,reference:false});
    const zip=new AdmZip(file),d=JSON.parse(zip.readAsText('document.json')),boards=JSON.parse(zip.readAsText(d.pages[0]._ref+'.json')).layers;
    const stored=boards[0].layers[0].layers[0];assert.deepEqual(zip.readFile(stored.image._ref),png);
    assert.equal(boards[0].layers[0].frame.x,-5);assert.equal(boards[1].frame.width,14);
    const expectedFull=await sharp({create:{width:14,height:12,channels:4,background:'#00000000'}}).composite([{input:png,left:0,top:0}]).png().toBuffer();
    const crop=await renderSketch(file);const expected=await sharp(expectedFull).extract({left:3,top:2,width:8,height:6}).png().toBuffer();
    assert.equal((await compare(crop,expected)).identical,true);
    assert.equal((await compare(crop,await composite(m,dir))).identical,true);
    const viewport={x:-3,y:-2,width:14,height:12};
    assert.equal((await compare(await renderSketch(file,0,{viewport}),expectedFull)).identical,true);
    const raw=await sharp(await renderSketch(file,0,{viewport})).ensureAlpha().raw().toBuffer();
    assert.deepEqual(raw,await sharp(expectedFull).raw().toBuffer());
    for(let i=3;i<pixels.length;i+=4)assert.equal(raw[i],pixels[i]);
    assert.equal((await compare(await composite(m,dir,{viewport}),await renderSketch(file,1))).identical,true);
  }finally{await rm(dir,{recursive:true,force:true});}
});
