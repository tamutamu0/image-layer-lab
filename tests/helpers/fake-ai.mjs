// Offline stand-in for Pipeline: routes by stage prefix, records model/effort per call,
// and never touches the network. Generated pixels are synthetic, never source pixels.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {Separator} from '../../src/separation/core.mjs';
import {validatePlan} from '../../src/separation/schema.mjs';
export const delay=ms=>new Promise(r=>setTimeout(r,ms));
export const GLOBAL='global-model';
export const box=[300,300,200,200];
const ok=a=>({text:a.expected,correct:true});
export function planFor(jobs,{groups=[['grp','headline'],['offer','offer']]}={}){
 return{title:'t',assessment:'',boxFormat:'xywh',groups:groups.map(([id,role])=>({id,name:id,parent:'root',role,purpose:''})),
  jobs:jobs.map(([id,kind,text='',group='grp'],z)=>({id,name:id,group,kind,bbox:kind==='background'?[0,0,1000,1000]:box,visibleBbox:kind==='background'?[0,0,1000,1000]:box,z,text,textMode:kind==='text'?'native':'none',occluded:false,prompt:'p',risk:''}))};
}
export function fakeAi(log,o={}){
 const transcribe=o.transcribe??ok,t0=performance.now(),now=()=>performance.now()-t0;
 const ai={model:GLOBAL,calls:[],close(){log.closed=now();},
  async resolveRoute(r){return{resolvedModel:r.model??ai.model}},
  ai:async(stage,prompt,{images=[],schema,effort,model}={})=>{
   const m=model??ai.model;
   if(schema&&stage.startsWith('04-')){
    const list=JSON.parse(prompt.slice(prompt.indexOf('Images in order: ')+17)),call={stage,ids:list.map(a=>a.id),model:m,effort,start:now()};log.ocr.push(call);
    log.ocrPeak=Math.max(log.ocrPeak||0,log.ocrActive=(log.ocrActive||0)+1);
    try{await delay(o.delays?.ocr??5);if(o.failOcr?.(call))throw Error('429 rate limited');
     const texts=list.map(a=>({a,r:transcribe(a,call)})).filter(x=>!x.r.omit).map(({a,r})=>({id:a.id,text:r.text,correct:r.correct,bbox:[2,2,10,10],family:'Noto Sans JP',alignment:'left',runs:[{text:r.badRuns?r.text+'?':r.text,fontSize:12,weight:400,color:'#112233'}],risk:''}));
     return{outputs:[],result:{text:JSON.stringify({assessment:'ok',texts})}};}
    finally{call.end=now();log.ocrActive--;}
   }
   if(schema&&stage.startsWith('05-')){const call={stage,model:m,effort,confirm:stage.includes('confirm')};log.reviews.push(call);return{outputs:[],result:{text:JSON.stringify(o.review(call,log.reviews.length))}};}
   if(schema&&stage.startsWith('01-')){const call={stage,model:m,effort};log.plans.push(call);const p=o.plan(call,log.plans.length);return{outputs:[],result:{text:typeof p==='string'?p:JSON.stringify(p)}};}
   const id=stage.startsWith('03-')?'outpaint':stage.slice(3).replace(/-\d+$/,''),call={id,stage,effort,model,start:now()};log.images.push(call);
   try{await delay(o.delays?.[id]??o.delays?.image??5);
    const{width,height}=await sharp(images[0]).metadata(),opaque=id==='outpaint'||o.background===id,raw=Buffer.alloc(width*height*4);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4,inside=opaque||(x>width/4&&x<width*3/4&&y>height/4&&y<height*3/4);raw.set([200,(log.images.length*37)%255,40,inside?255:0],i);}
    const file=path.join(path.dirname(images[0]),'..','fake-'+stage+'-'+log.images.length+'.png');await sharp(raw,{raw:{width,height,channels:4}}).png().toFile(file);return{outputs:[file]};}
   finally{call.end=now();}
  }};
 return ai;
}
export const newLog=()=>({images:[],ocr:[],reviews:[],plans:[]});
export async function setupFake(t,{jobs,groups,reasoning,concurrency=2,mode='fast',bleed=.1,...o}={}){
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'routing-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const input=path.join(dir,'input.png');await sharp({create:{width:200,height:100,channels:3,background:'#336699'}}).png().toFile(input);
 const s=new Separator({input,out:path.join(dir,'run'),concurrency,mode,bleed,reasoning});await s.init();
 const log=newLog();s.ai=fakeAi(log,{background:jobs?.find(j=>j[1]==='background')?.[0],...o});
 if(jobs){const plan=validatePlan(planFor(jobs,{groups}));await fs.writeFile(path.join(s.dir,'plan.json'),JSON.stringify({...plan,width:s.width,height:s.height,sourceHash:s.sourceHash}));await s.plan();}
 return{s,log,dir};
}
export const byId=(log,id)=>log.images.filter(c=>c.id===id);
