import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {Pipeline} from '../pipeline.mjs';
import {mapConcurrent,parseConcurrency,ImagePool,Timeline} from '../concurrency.mjs';
import {saveJSON} from '../images.mjs';
import {parseBleed,parseMode,resolveEffort} from './options.mjs';
import {resolveReasoning,STAGE_NAMES} from './routing.mjs';
import {runPlanning} from './plan.mjs';
export const hash=v=>createHash('sha256').update(v).digest('hex');
export const readJSON=f=>fs.readFile(f,'utf8').then(JSON.parse).catch(e=>{if(e.code==='ENOENT')return null;throw e;});
const exists=f=>fs.access(f).then(()=>true,()=>false);
export function pixels(box,width,height){return box.map((v,i)=>Math.round(v*(i%2?height:width)/1000));}
export function cropArea(box,width,height,kind){
 if(kind==='background')return{x:0,y:0,width,height};
 let[x,y,w,h]=pixels(box,width,height);const pad=Math.max(16,Math.round(Math.min(width,height)*.018));x-=pad;y-=pad;w+=pad*2;h+=pad*2;
 if(w/h>2.5){const d=Math.ceil(w/2.5-h);y-=Math.floor(d/2);h+=d;}if(h/w>2.5){const d=Math.ceil(h/2.5-w);x-=Math.floor(d/2);w+=d;}
 return{x,y,width:w,height:h};
}
export async function cropReference(source,area,dest){const meta=await sharp(source).metadata(),left=Math.max(0,area.x),top=Math.max(0,area.y),right=Math.min(meta.width,area.x+area.width),bottom=Math.min(meta.height,area.y+area.height);if(right<=left||bottom<=top)throw Error('Target outside source');const inner=await sharp(source).extract({left,top,width:right-left,height:bottom-top}).png().toBuffer();await sharp({create:{width:area.width,height:area.height,channels:4,background:'#00000000'}}).composite([{input:inner,left:left-area.x,top:top-area.y}]).png().toFile(dest);}
export class Separator{
 constructor({input,out,concurrency=3,bleed=.12,mode='baseline',effort={},reasoning,execution='ordered',ai}){this.input=path.resolve(input);this.dir=path.resolve(out);this.concurrency=parseConcurrency(concurrency);this.bleed=parseBleed(bleed);this.mode=parseMode(mode);
  if(!['ordered','overlap'].includes(execution))throw Error('Execution must be ordered or overlap');this.execution=execution;
  // A resolved routing object (parseOptions) wins; legacy callers may pass a profile name and/or plan/ocr/review efforts.
  this.reasoning=reasoning?.stages?reasoning:resolveReasoning(reasoning??'quality',{planEffort:effort.plan,ocrEffort:effort.ocr,reviewEffort:effort.review});
  this.effort=resolveEffort(this.mode,{image:effort.image,...Object.fromEntries(STAGE_NAMES.map(k=>[k,this.reasoning.stages[k].primary.effort]))});
  this.timeline=new Timeline();this.pool=new ImagePool(this.concurrency,this.timeline);this.ai=ai??new Pipeline({runDir:this.dir,concurrency:this.concurrency});}
 // Non-image agent turns (plan/OCR/review); they never take an image slot. route is a
 // stage name (its primary route) or a {role,model,effort} route; model null inherits.
 reason(id,stage,prompt,{images=[],schema}={},route='plan'){
  const r=typeof route==='string'?this.reasoning.stages[route].primary:route;
  return this.timeline.track(id,'reasoning',()=>this.ai.ai(stage,prompt,{images,schema,effort:r.effort,...(r.model?{model:r.model}:{})}),{meta:{stage,route:r.role,requestedModel:r.model,effort:r.effort}});
 }
 // Resolved {model,effort} identity of a route for cache keys: inherited routes resolve to
 // the actual global model, so changing CODEX_MODEL/the server default invalidates caches.
 async routeKey(route){
  if(!route)return null;
  const resolved=this.ai.resolveRoute?(await this.ai.resolveRoute(route)).resolvedModel:route.model??this.ai.model??null;
  return{model:resolved??null,effort:route.effort};
 }
 // Fail fast on unknown models/efforts before any expensive work; records the resolution.
 async preflight(){
  this.routeChecks={};if(!this.ai.resolveRoute)return this.routeChecks;
  for(const k of STAGE_NAMES)for(const role of['primary','escalation']){const r=this.reasoning.stages[k][role];if(r)this.routeChecks[`${k}.${role}`]=await this.ai.resolveRoute(r);}
  return this.routeChecks;
 }
 async init(){if(!await exists(this.input))throw Error('Input image not found: '+this.input);await fs.mkdir(this.dir,{recursive:true});const bytes=await sharp(this.input).rotate().png().toBuffer(),meta=await sharp(bytes).metadata();this.width=meta.width;this.height=meta.height;this.sourceHash=hash(bytes);this.source=path.join(this.dir,'source.png');const old=await readJSON(path.join(this.dir,'config.json'));if(old&&old.sourceHash!==this.sourceHash)throw Error('Output directory belongs to another source; use a new --out');await fs.writeFile(this.source,bytes);await saveJSON(path.join(this.dir,'config.json'),{sourceHash:this.sourceHash,width:this.width,height:this.height,concurrency:this.concurrency,bleed:this.bleed,mode:this.mode,execution:this.execution,effort:this.effort,reasoning:this.reasoning,algorithm:'generation-first-v9'});return this;}
 // A cached plan is reused whatever profile produced it (shared-plan benchmarks rely on this);
 // its producer is recorded in plan.json `planning` and compared in the timing report.
 async plan(){const old=await readJSON(path.join(this.dir,'plan.json'));if(old){if(old.sourceHash!==this.sourceHash)throw Error('Stale plan');this.planData=old;return old;}
 const{plan,planning}=await runPlanning(this);this.planData={...plan,width:this.width,height:this.height,sourceHash:this.sourceHash,planning};await saveJSON(path.join(this.dir,'plan.json'),this.planData);return this.planData;}
 async ensureDirs(){await fs.mkdir(path.join(this.dir,'assets'),{recursive:true});await fs.mkdir(path.join(this.dir,'crops'),{recursive:true});}
 // Content cache: source + complete job definition + prompt version. Provenance
 // (mode/effort) is recorded on the record but deliberately not part of the key.
 async prepareJob(job,repair){
 const baseHash=hash(JSON.stringify({sourceHash:this.sourceHash,job,version:6})),recordFile=path.join(this.dir,'assets',job.id+'.json'),old=await readJSON(recordFile);
 const cached=!repair&&old?.baseHash===baseHash&&await exists(path.join(this.dir,old.file))&&(!old.outpaint||await exists(path.join(this.dir,old.outpaint.cleanPlate)));
 this.timeline.cache('asset',job.id,cached);if(cached)console.log('cached '+job.id);
 return{job,baseHash,recordFile,old,repair,cached};
 }
 async assets({repairs={}}={}){
 await this.ensureDirs();const tasks=[],start=Date.now();
 try{await mapConcurrent(this.planData.jobs,this.concurrency,async job=>{const p=await this.prepareJob(job,repairs[job.id]);if(!p.cached)await this.runJob(p,{tasks});});}finally{await saveJSON(path.join(this.dir,`timing-${start}.json`),{concurrency:this.concurrency,wallMs:Date.now()-start,tasks});}
 }
 // The whole job (crop, one imagegen turn, validation, record) holds ONE image slot.
 runJob({job,baseHash,recordFile,old,repair},{priority=1,tasks=[],then,retries=1}={}){return this.pool.run(async()=>{
 const area=cropArea(job.bbox,this.width,this.height,job.kind),crop=path.join(this.dir,'crops',job.id+'.png');await cropReference(this.source,area,crop);
 const prior=(await fs.readdir(path.join(this.dir,'stages')).catch(()=>[])).filter(n=>n.startsWith('02-'+job.id+'-')).map(n=>Number(n.split('-').at(-1))).filter(Number.isFinite);
 const attempt=Math.max(old?.attempt||0,0,...prior)+1,stage='02-'+job.id+'-'+attempt,at=Date.now();
 const prompt=`Use case: background-extraction. Call imagegen exactly once. Image 1 is EDIT TARGET crop ${area.width}x${area.height}; image 2 is ONLY full-ad reference. Output exactly the crop aspect ratio, contents at original position and scale. Original crop origin (${area.x},${area.y}) on ${this.width}x${this.height} source. Do not substitute the full ad canvas, center/zoom the object, add elements or redesign.
 Target: ${job.name}. ${job.prompt}
 ${job.kind==='text'?`Generate ONLY the complete typography unit ${JSON.stringify(job.text)}. Preserve exact glyph shapes, mixed sizes, line breaks, color, gradient and intrinsic letter styling. Remove every adjacent letter fragment. Reconstruct complete strokes. NO new embossing, bevel, outline or shadow. Keep padding transparent.`:''}
 ${job.kind==='background'?'Generate an opaque clean photographic/background plate. Remove ALL text, bottles/products, decorative foreground, badges, buttons, panels, graphic glows/sparkles. Inpaint their former areas. Remove independently planned people/subjects as specified in the target prompt. Preserve already-visible photographic framing, focal points and lighting exactly. Keep natural photographic light; do not whiten/darken the entire photograph.':`Generate a COMPLETE independent RGBA asset, including the portions hidden by other layers. Remove all occluders. Every pixel outside the target is alpha 0, with native smoothly antialiased/translucent alpha. No painted checkerboard, source-background fragments, white matte, color-key or clipped strokes. ${job.kind==='effect'?'This is ONLY a translucent light/effect. No solid opaque background, no other objects. Match its subtle existing appearance; no invented flare points.':''}`}
 ${repair?'Targeted correction to previous attempt: '+repair:''}
 referenced_image_paths=${JSON.stringify([crop,this.source])}; transparent_background=${job.kind!=='background'}.`;
 try{const{outputs}=await this.ai.ai(stage,prompt,{images:[crop,this.source],effort:this.effort.image});if(outputs.length!==1)throw Error('Expected one generated image');const meta=await sharp(outputs[0]).metadata(),aspect=Math.abs(Math.log(meta.width/meta.height/(area.width/area.height)));if(aspect>.065)throw Error('Generation changed aspect ratio');const file=`assets/${job.id}-${attempt}.png`;await sharp(outputs[0]).resize(area.width,area.height,{fit:'fill'}).ensureAlpha().png().toFile(path.join(this.dir,file));const stats=await sharp(path.join(this.dir,file)).stats();if(job.kind!=='background'&&stats.channels[3].min===255)throw Error('Foreground is opaque; refusing false transparency');const record={...job,...area,type:'bitmap',file,baseHash,attempt,rawFile:path.relative(this.dir,outputs[0]),sourcePixelTransfer:false,textRasterCropping:false,generated:true,amodal:job.kind!=='text',method:'Codex app-server imagegen native RGBA',generationSize:{width:meta.width,height:meta.height},alpha:stats.channels[3],repair:repair||null,provenance:{mode:this.mode,imageWrapperEffort:this.effort.image,wrapperModel:this.ai.model??null,imageModel:'not exposed by app-server'}};await saveJSON(recordFile,record);tasks.push({id:job.id,status:'complete',durationMs:Date.now()-at});console.log('saved '+job.id);return record;}catch(e){tasks.push({id:job.id,status:'failed',durationMs:Date.now()-at,error:e.message});throw e;}
 },{id:'asset:'+job.id,priority,then}).catch(async error=>{
 // A rejected output is never stretched into compliance. Retry this asset once,
 // outside the released slot; preserve every other successful asset and OCR entry.
 const invalidOutput=/^(Expected one generated image|Generation changed aspect ratio|Foreground is opaque; refusing false transparency)$/.test(error.message);
 if(!invalidOutput||retries===0)throw error;
 console.log('retry '+job.id+': '+error.message);
 const correction=[repair,`The previous output was rejected: ${error.message}. Match the edit-target canvas aspect ratio exactly, with transparent padding around the complete object. Do not crop to a tighter object canvas or change its framing. Foreground must have genuine alpha, no opaque matte.`].filter(Boolean).join(' ');
 const next=await this.prepareJob(job,correction);
 return this.runJob(next,{priority,tasks,then,retries:retries-1});
 });}
 async writeTiming(extra={}){const file=path.join(this.dir,'timing',`run-${this.timeline.startedAt.replace(/[:.]/g,'-')}.json`);
  const reasoning={profile:this.reasoning.profile,escalationMode:this.reasoning.escalationMode,stages:this.reasoning.stages,routeChecks:this.routeChecks??null,planProducedBy:this.planData?this.planData.planning?.attempts??'plan without planning provenance (V7 or copied)':null,
   calls:(this.ai.calls||[]).map(c=>({...c})),note:'calls are measured per agent turn (thread start + turn) and include image-wrapper turns; durations of overlapping calls must not be summed into a sequential time.'};
  await saveJSON(file,{mode:this.mode,execution:this.execution,concurrency:this.concurrency,effort:this.effort,peakImageSlots:this.pool.peak,...extra,reasoning,...this.timeline.report()});return file;}
 close(){this.ai.close();}
}
