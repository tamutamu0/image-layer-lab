import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import AdmZip from 'adm-zip';
import {validatePlan} from '../src/separation/schema.mjs';
import {cropArea} from '../src/separation/core.mjs';
import {hierarchy} from '../src/separation/build.mjs';
import {flattenTree} from '../src/designer-hierarchy.mjs';
import {exportSketch} from '../src/sketch.mjs';
test('Coordinate format is explicit and normalized before generic crop calculations',()=>{
 const jobs=Array.from({length:5},(_,i)=>({id:'j'+i,name:'item',group:'root_group',kind:i?'text':'background',bbox:i?[600,100,900,200]:[0,0,1000,1000],visibleBbox:i?[600,100,900,200]:[0,0,1000,1000],z:i,text:i?'text':'',textMode:i?'native':'none',occluded:false,prompt:'prompt',risk:''}));
 const p=validatePlan({title:'Test',assessment:'',boxFormat:'xyxy',groups:[{id:'root_group',name:'Group',parent:'root',role:'headline',purpose:''}],jobs});assert.deepEqual(p.jobs[1].bbox,[600,100,300,100]);
 const c=cropArea(p.jobs[1].bbox,1600,900,'text');assert.ok(c.x<=960&&c.y<=90);assert.ok(c.x+c.width>=1440&&c.y+c.height>=180);assert.ok(c.width/c.height<=2.5);assert.throws(()=>validatePlan({...p,boxFormat:undefined}));
});
test('Interleaved offer never traps product or changes visual stack',()=>{
 const p={groups:[{id:'offer',name:'Offer',parent:'root',role:'offer',purpose:''},{id:'product',name:'Product',parent:'offer',role:'product',purpose:''}]};
 const layers=[['plate','offer'],['bottle','product'],['price','offer']].map(([id,group],z)=>({id,group,z,x:10,y:20,width:100,height:90,type:'bitmap'}));
 const t=hierarchy(p,layers);assert.deepEqual(flattenTree(t).map(l=>l.id),['plate','bottle','price']);assert.equal(t.length,3);assert.equal(t[1].role,'product');assert.equal(flattenTree([t[0]]).some(l=>l.id==='bottle'),false);assert.equal(flattenTree([t[2]]).some(l=>l.id==='bottle'),false);
});
test('Mixed size price remains ONE editable text with complete UTF-16 ranges',async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'rich-price-'));try{const file=path.join(dir,'price.sketch');const text={id:'price',type:'text',text:'3,278円',x:0,y:0,width:300,height:100,fontFamily:'Noto Serif JP',weight:700,fontSize:96,color:'#FFCC22',alignment:'left',lineHeight:110,runs:[{text:'3,278',fontSize:96,weight:700,color:'#FFCC22'},{text:'円',fontSize:50,weight:600,color:'#FFF0AA'}]};await exportSketch({width:400,height:300,layers:[text],figmaFontNames:true},file,{root:dir,reference:false});const z=new AdmZip(file),d=JSON.parse(z.readAsText('document.json')),l=JSON.parse(z.readAsText(d.pages[0]._ref+'.json')).layers[0].layers[0];assert.equal(l._class,'text');assert.equal(l.attributedString.string,'3,278円');assert.deepEqual(l.attributedString.attributes.map(r=>[r.location,r.length,r.attributes.MSAttributedStringFontAttribute.attributes.size]),[[0,5,96],[5,1,50]]);}finally{await fs.rm(dir,{recursive:true,force:true});}
});
test('Transparent-margin trimming preserves alpha=1 glow and composite pixels',async()=>{
 const {default:sharp}=await import('sharp');const {trimTransparentMargins}=await import('../src/separation/trim.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'trim-alpha-'));try{await fs.mkdir(path.join(dir,'assets'));const raw=Buffer.alloc(40*40*4);for(const[x,y,a]of[[8,9,1],[20,21,255]]){const i=(y*40+x)*4;raw[i]=255;raw[i+3]=a;}await sharp(raw,{raw:{width:40,height:40,channels:4}}).png().toFile(path.join(dir,'assets/test.png'));await fs.writeFile(path.join(dir,'plan.json'),JSON.stringify({width:60,height:60}));await fs.writeFile(path.join(dir,'registered.json'),JSON.stringify([{id:'glow',kind:'effect',attempt:1,file:'assets/test.png',x:5,y:6,width:40,height:40,type:'bitmap'}]));await trimTransparentMargins(dir);const [a]=JSON.parse(await fs.readFile(path.join(dir,'registered.json')));assert.equal(a.x,11);assert.equal(a.y,13);const im=await sharp(path.join(dir,a.file)).raw().toBuffer({resolveWithObject:true});assert.equal(im.data[(2*im.info.width+2)*4+3],1);assert.equal(JSON.parse(await fs.readFile(path.join(dir,'trim-verification.json'))).identical,true);}finally{await fs.rm(dir,{recursive:true,force:true});}
});

test('a broad alpha fade is not expanded like a hard rectangular surface',async t=>{
 const {default:sharp}=await import('sharp');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fade-registration-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 await fs.mkdir(path.join(dir,'assets'));await fs.mkdir(path.join(dir,'crops'));
 const jobs=[];
 for(const id of ['fade','hard']){
  const width=400,height=160,raw=Buffer.alloc(width*height*4);
  for(let y=40;y<100;y++)for(let x=0;x<300;x++){
   const a=id==='hard'?(x<200?255:0):x<120?255:Math.max(0,Math.round(255*(300-x)/180));raw.set([85,40,10,a],(y*width+x)*4);
  }
  const file=`assets/${id}.png`;await sharp(raw,{raw:{width,height,channels:4}}).png().toFile(path.join(dir,file));
  await sharp({create:{width,height,channels:3,background:'#eeeeee'}}).png().toFile(path.join(dir,`crops/${id}.png`));
  const job={id,kind:'surface',bbox:[0,250,1000,375]};jobs.push(job);await fs.writeFile(path.join(dir,`assets/${id}.json`),JSON.stringify({...job,file,x:0,y:0,width,height,attempt:1}));
 }
 await fs.writeFile(path.join(dir,'plan.json'),JSON.stringify({width:400,height:160,jobs}));
 await promisify(execFile)(path.resolve('.venv/bin/python'),['src/separation/register.py',dir]);
 const [fade,hard]=JSON.parse(await fs.readFile(path.join(dir,'registered.json')));
 assert.equal(fade.registration.preservedFadeAxes.x,true);assert.equal(fade.registration.matrix[0][0],1);
 const image=await sharp(path.join(dir,fade.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});
 assert.equal(image.data[(60*image.info.width+330)*4+3],0,'transparent right-hand area remains transparent');
 assert.equal(hard.registration.preservedFadeAxes.x,false);assert.ok(hard.registration.matrix[0][0]>1.5,'ordinary hard surface still aligns to planned bounds');
});
