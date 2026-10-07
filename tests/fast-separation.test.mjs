import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Separator} from '../src/separation/core.mjs';
import {validatePlan} from '../src/separation/schema.mjs';
import {generate,runFast,runBaseline} from '../src/separation/run.mjs';
import {ocr,strictEntry} from '../src/separation/ocr.mjs';
import {parseOptions,parseBleed} from '../src/separation/options.mjs';
import {ImagePool,Timeline,parseConcurrency} from '../src/concurrency.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const box=[300,300,200,200];

// Offline stand-in for Pipeline.ai: generated pixels are synthetic, never source pixels.
async function setup(t,{jobs,concurrency=2,delays={},fail=new Set(),transcribe=a=>({text:a.expected,correct:true}),mode='fast',bleed=.1}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fast-sep-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.png');await sharp({create:{width:200,height:100,channels:3,background:'#336699'}}).png().toFile(input);
 const s=new Separator({input,out:path.join(dir,'run'),concurrency,mode,bleed});await s.init();
 const plan=validatePlan({title:'t',assessment:'',boxFormat:'xywh',groups:[{id:'grp',name:'g',parent:'root',role:'headline',purpose:''}],jobs:jobs.map(([id,kind,text=''],z)=>({id,name:id,group:'grp',kind,bbox:kind==='background'?[0,0,1000,1000]:box,visibleBbox:kind==='background'?[0,0,1000,1000]:box,z,text,textMode:kind==='text'?'native':'none',occluded:false,prompt:'p',risk:''}))});
 await fs.writeFile(path.join(s.dir,'plan.json'),JSON.stringify({...plan,width:s.width,height:s.height,sourceHash:s.sourceHash}));await s.plan();
 const log={active:0,peak:0,images:[],ocr:[]},t0=performance.now(),now=()=>performance.now()-t0;
 s.ai={model:'fake-model',close(){log.closed=now();},ai:async(stage,prompt,{images=[],schema,effort}={})=>{
  if(schema){const list=JSON.parse(prompt.slice(prompt.indexOf('Images in order: ')+17)),call={stage,ids:list.map(a=>a.id),start:now(),effort};log.ocr.push(call);await delay(delays.ocr??5);call.end=now();
   return{outputs:[],result:{text:JSON.stringify({assessment:'ok',texts:list.map(a=>{const r=transcribe(a,log.ocr.length);return{id:a.id,text:r.text,correct:r.correct,bbox:[2,2,10,10],family:'Noto Sans JP',alignment:'left',runs:[{text:r.text,fontSize:12,weight:400,color:'#112233'}],risk:''};})})}};}
  const id=stage.startsWith('03-')?'outpaint':stage.slice(3).replace(/-\d+$/,''),call={id,stage,effort,start:now()};log.images.push(call);log.peak=Math.max(log.peak,++log.active);
  try{await delay(delays[id]??5);if(fail.has(id)){fail.delete(id);throw Error('simulated failure '+id);}
   const{width,height}=await sharp(images[0]).metadata(),opaque=id==='outpaint'||jobs.find(j=>j[0]===id)?.[1]==='background',raw=Buffer.alloc(width*height*4);
   for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,inside=opaque||(x>width/4&&x<width*3/4&&y>height/4&&y<height*3/4);raw.set([200,(log.images.length*37)%255,40,inside?255:0],i);}
   const file=path.join(s.dir,'fake-'+stage+'.png');await sharp(raw,{raw:{width,height,channels:4}}).png().toFile(file);return{outputs:[file]};}
  finally{call.end=now();log.active--;}
 }};
 return{s,log,dir};
}
const byId=(log,id)=>log.images.filter(c=>c.id===id);

test('pool never exceeds capacity, background first, outpaint overlaps other assets in the same bound',async t=>{
 const {s,log}=await setup(t,{concurrency:2,jobs:[['p1','product'],['p2','product'],['bg','background'],['p3','product'],['p4','product']],delays:{bg:10,p1:40,p2:40,p3:40,p4:40,outpaint:10}});
 await generate(s);
 assert.equal(log.peak,2);assert.equal(s.pool.peak,2);assert.equal(s.pool.active,0);
 const[bg]=byId(log,'bg'),[out]=byId(log,'outpaint');assert.equal(s.timeline.tasks[0].id,'asset:bg','background takes the first image slot');
 assert.ok(out.start>=bg.end,'outpaint depends on its clean plate');
 assert.ok(out.end<=Math.max(...log.images.filter(c=>c.id.startsWith('p')).map(c=>c.end)),'outpaint ran while other assets were still generating');
 // At every call start, count image calls in flight (outpaint included).
 for(const c of log.images)assert.ok(log.images.filter(o=>o.start<=c.start&&o.end>c.start).length<=2);
 const record=JSON.parse(await fs.readFile(path.join(s.dir,'assets/bg.json')));assert.equal(record.width,240);assert.ok(record.outpaint.cleanPlate);
 const report=s.timeline.report();assert.equal(report.peakConcurrency.image,2);assert.ok(report.overlap.outpaintWithOtherImageGenerationMs>0);assert.ok(report.observedSerialChain.length>=2);
 assert.ok(log.images.every(c=>c.effort==='low'),'fast mode wraps imagegen with low reasoning effort');
});

test('OCR waits only for text assets and overlaps remaining non-text generation',async t=>{
 const {s,log}=await setup(t,{concurrency:3,jobs:[['bg','background'],['h1','text','夜の'],['h2','text','塗る針ケア'],['bottle','product'],['seal','surface']],delays:{bg:5,h1:5,h2:5,bottle:80,seal:80,ocr:10}});
 const text=await generate(s);
 const textEnd=Math.max(...['h1','h2'].map(id=>byId(log,id)[0].end)),otherEnd=Math.max(...['bottle','seal'].map(id=>byId(log,id)[0].end));
 assert.equal(log.ocr.length,1);assert.deepEqual(log.ocr[0].ids.sort(),['h1','h2']);assert.equal(log.ocr[0].effort,'high');
 assert.ok(log.ocr[0].start>=textEnd);assert.ok(log.ocr[0].end<otherEnd,'OCR finished while product/surface still generating');
 assert.ok(text.texts.every(t=>t.correct));assert.ok(s.timeline.report().overlap.ocrWithImageGenerationMs>0);
});

test('a failure drains every in-flight task before rejecting; rerun resumes only the failure',async t=>{
 const fail=new Set(['p2']);const {s,log}=await setup(t,{concurrency:2,fail,jobs:[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']],delays:{p1:30,p2:5,p3:30}});
 let activeAtReject;await assert.rejects(generate(s).finally(()=>{activeAtReject=log.active;}),e=>e instanceof AggregateError&&/simulated failure p2/.test(e.message)&&/rerun/.test(e.message));
 assert.equal(activeAtReject,0);assert.equal(s.pool.active,0);assert.ok(log.images.every(c=>c.end!==undefined));
 for(const id of['bg','h1','p1','p3'])assert.ok(JSON.parse(await fs.readFile(path.join(s.dir,'assets',id+'.json'))).generated);
 await assert.rejects(fs.access(path.join(s.dir,'assets/p2.json')));
 s.close();assert.ok(log.closed>=Math.max(...log.images.map(c=>c.end)),'shared server closed only after draining');
 log.images.length=0;log.ocr.length=0;await generate(s);
 assert.deepEqual(log.images.map(c=>c.id),['p2']);assert.equal(log.ocr.length,0,'OCR entries of unchanged text are reused');
});

test('cached rerun makes no image or OCR calls and reports cache hits',async t=>{
 const {s,log}=await setup(t,{jobs:[['bg','background'],['h1','text','3,278円'],['h2','text','(税込)'],['p1','product'],['p2','product']]});
 await generate(s);const first=log.images.length;assert.equal(first,6);
 const again=new Separator({input:s.input,out:s.dir,concurrency:2,mode:'baseline',bleed:.1});await again.init();await again.plan();again.ai=s.ai;
 await generate(again);assert.equal(log.images.length,first);assert.equal(log.ocr.length,1);
 const cache=again.timeline.report().cache;assert.equal(cache.asset.hits,5);assert.equal(cache.asset.misses,0);assert.equal(cache.outpaint.hits,1);assert.equal(cache.ocr.hits,2);
 // Provenance belongs to the producer run, not to the run that reused the cache.
 assert.equal(JSON.parse(await fs.readFile(path.join(s.dir,'assets/p1.json'))).provenance.imageWrapperEffort,'low');
 // Content invalidation: a changed job definition regenerates that job only.
 const plan=JSON.parse(await fs.readFile(path.join(s.dir,'plan.json')));plan.jobs.find(j=>j.id==='p2').prompt='changed';await fs.writeFile(path.join(s.dir,'plan.json'),JSON.stringify(plan));
 again.planData=plan;await generate(again);assert.deepEqual(log.images.slice(first).map(c=>c.id),['p2']);
 // A deleted asset file is never treated as cached.
 const rec=JSON.parse(await fs.readFile(path.join(s.dir,'assets/h1.json')));await fs.rm(path.join(s.dir,rec.file));await generate(again);
 assert.deepEqual(log.images.slice(first+1).map(c=>c.id),['h1']);assert.deepEqual(log.ocr.at(-1).ids,['h1']);
});

test('strict OCR: claimed-correct mismatch is repaired and only the changed text is re-read',async t=>{
 const transcribe=(a,n)=>a.id==='price'&&n===1?{text:'3,276円',correct:true}:{text:a.expected,correct:true};
 const {s,log}=await setup(t,{transcribe,jobs:[['bg','background'],['price','text','3,278円'],['tax','text','(税込)'],['cta','text','初回価格で試す'],['p1','product']]});
 const text=await generate(s);
 assert.equal(log.ocr.length,2);assert.deepEqual(log.ocr[0].ids.sort(),['cta','price','tax']);assert.deepEqual(log.ocr[1].ids,['price']);
 assert.equal(byId(log,'price').length,2);assert.match(byId(log,'price')[1].stage,/^02-price-2$/);
 const repaired=JSON.parse(await fs.readFile(path.join(s.dir,'assets/price.json')));assert.match(repaired.repair,/3,276円.*3,278円/);
 assert.ok(text.texts.every(t=>t.correct&&t.textMatchesExpected));
 assert.deepEqual(strictEntry({text:'3,276円',correct:true},'3,278円').correct,false);
 assert.equal(strictEntry({text:'夜の\r\n塗る',correct:true},'夜の\n塗る').correct,true);
 assert.equal(strictEntry({text:'3,278円',correct:false},'3,278円').correct,false);
 const cache=JSON.parse(await fs.readFile(path.join(s.dir,'text.json')));assert.ok(cache.texts.every(t=>/^[0-9a-f]{64}$/.test(t.cacheKey)));
 assert.equal((await ocr(s)).texts.length,3);assert.equal(log.ocr.length,2);
});

test('fast run renders preview-only before review and exports the full build exactly once',async t=>{
 const {s}=await setup(t,{jobs:[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']]});
 const calls=[];let reviews=0;
 const deps={register:async()=>calls.push('register'),build:async(_s,{partial=false}={})=>{calls.push(partial?'preview':'full');return{ok:true};},
  review:async()=>{calls.push('review');return ++reviews===1?{repairs:[{id:'p1',priority:'high',prompt:'fix edge',reason:''}],adjustments:[]}:{repairs:[],adjustments:[]};},applyAdjustments:async()=>calls.push('adjust')};
 assert.deepEqual(await runFast(s,{deps}),{ok:true});
 assert.equal(calls.filter(c=>c==='full').length,1);assert.equal(calls.indexOf('preview'),1);assert.ok(calls.indexOf('review')>calls.indexOf('preview'));
 assert.deepEqual(calls.slice(0,5),['register','preview','review','adjust','register']);
 const base=[];await runBaseline(s,{deps:{...deps,build:async(_s,o={})=>{base.push(o.partial?'preview':'full');return{};},review:async()=>({repairs:[],adjustments:[]})}});
 assert.deepEqual(base,['full','full'],'baseline keeps the original repeated full builds');
});

test('user input is validated and mode defaults are explicit',()=>{
 const base=['--input=a.png','--out=runs/x'];
 assert.deepEqual([parseOptions(base,{}).mode,parseOptions(base,{}).concurrency,parseOptions(base,{}).effort.image],['fast',6,'low']);
 const b=parseOptions([...base,'--mode=baseline'],{});assert.equal(b.concurrency,3);assert.deepEqual(b.effort,{image:'high',plan:'high',ocr:'high',review:'high'});
 assert.equal(parseOptions([...base,'--mode=baseline','--concurrency=5'],{}).concurrency,5);assert.equal(parseOptions(base,{LAYER_LAB_CONCURRENCY:'2'}).concurrency,2);
 assert.equal(parseOptions([...base,'--image-effort=high'],{}).effort.image,'high');
 for(const bad of[['--concurrency'],['--concurrency=7'],['--concurrency=2.5'],['--bleed'],['--bleed=abc'],['--bleed=-0.1'],['--bleed=0.9'],['--mode=turbo'],['--stage=ocr'],['--ocr-effort=max'],['--typo=1'],['--input=b.png'],['stray']])assert.throws(()=>parseOptions([...base,...bad],{}),undefined,bad.join());
 assert.throws(()=>parseOptions(['--out=x'],{}));assert.equal(parseBleed('0'),0);assert.equal(parseBleed('.25'),.25);assert.throws(()=>parseConcurrency(true));
 assert.throws(()=>new Separator({input:'a.png',out:'b',bleed:Number(true)}));
});

test('priority pool: queued dependents start before lower-priority work and timeline is measured',async()=>{
 const timeline=new Timeline(),pool=new ImagePool(1,timeline),order=[];
 const first=pool.run(async()=>{await delay(5);order.push('first');},{id:'first',priority:2});
 const low=pool.run(async()=>{order.push('low');},{id:'low',priority:2}),high=pool.run(async()=>{order.push('high');},{id:'high',priority:0});
 await Promise.all([first,low,high]);assert.deepEqual(order,['first','high','low']);
 await assert.rejects(pool.run(()=>{throw Error('sync throw');}),/sync throw/);assert.equal(pool.active,0);
 const r=timeline.report();assert.equal(r.peakConcurrency.image,1);assert.ok(r.tasks.find(t=>t.id==='low').queueWaitMs>0);assert.match(r.note,/not a sequential baseline/);
});


test('fast quality gate repairs remaining medium issues only when confirmation still fails, before one export',async t=>{
 const {s,log}=await setup(t,{jobs:[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']]});
 const calls=[];let count=0;
 const deps={register:async()=>{},build:async(_s,{partial=false}={})=>{calls.push(partial?'preview':'full');return{ok:true};},applyAdjustments:async()=>{},review:async()=>{
  count++;return count===1?{verdict:'needs_improvement',repairs:[{id:'p1',priority:'high',prompt:'fix',reason:''}],adjustments:[]}:count===2?{verdict:'needs_improvement',repairs:[{id:'p2',priority:'medium',prompt:'fix seam',reason:''}],adjustments:[]}:{verdict:'usable',repairs:[{id:'p3',priority:'medium',prompt:'optional',reason:''}],adjustments:[]};
 }};
 await runFast(s,{deps});assert.equal(count,3);assert.equal(byId(log,'p1').length,2);assert.equal(byId(log,'p2').length,2);assert.equal(byId(log,'p3').length,1);assert.equal(calls.filter(x=>x==='full').length,1);
});

test('a wrong-aspect output retries only that asset once without exceeding the pool',async t=>{
 const {s,log}=await setup(t,{concurrency:2,jobs:[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']]});
 const ai=s.ai.ai;let first=true;
 s.ai.ai=async(...args)=>{const out=await ai(...args);if(first&&args[0].startsWith('02-p1-')){first=false;await sharp({create:{width:25,height:250,channels:4,background:'#00000000'}}).png().toFile(out.outputs[0]);}return out;};
 await generate(s);assert.equal(byId(log,'p1').length,2);assert.equal(byId(log,'p2').length,1);assert.ok(s.pool.peak<=2);assert.equal(log.ocr.length,1);
 assert.match(JSON.parse(await fs.readFile(path.join(s.dir,'assets/p1.json'))).repair,/aspect ratio/);
});


test('OCR ignores parenthesis width only, while prices and missing punctuation remain strict',()=>{
 assert.equal(strictEntry({text:'(税込)',correct:true},'（税込）').correct,true);
 assert.equal(strictEntry({text:'(税込',correct:true},'（税込）').correct,false);
 assert.equal(strictEntry({text:'3,276円',correct:true},'3,278円').correct,false);
 assert.equal(strictEntry({text:'レチノール（保湿成分）',correct:true},'レチノール（保湿成分）').correct,true);
});
