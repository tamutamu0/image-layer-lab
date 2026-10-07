import path from 'node:path';
import {spawn} from 'node:child_process';
import {outpaint} from './outpaint.mjs';
import {ocr,ocrCorrections} from './ocr.mjs';
import {build} from './build.mjs';
import {review,applyAdjustments,actionableRepairs} from './review.mjs';
import {trimTransparentMargins} from './trim.mjs';
import {settleAll} from '../concurrency.mjs';
import {runOverlap} from './run-overlap.mjs';
import {reconcileReviewedCopy} from './source-copy.mjs';
export async function register(s){await new Promise((resolve,reject)=>{const p=spawn(path.resolve('.venv/bin/python'),['src/separation/register.py',s.dir],{stdio:'inherit'});p.on('error',reject);p.on('exit',c=>c?reject(Error('Registration failed')):resolve());});await trimTransparentMargins(s.dir);}
const steps={register,build,review,applyAdjustments};
const pickRepairs=evaluation=>Object.fromEntries(evaluation.repairs.filter(r=>r.priority==='high').slice(0,3).map(r=>[r.id,r.prompt]));
const local=(s,id,work)=>s.timeline.track(id,'local',work);
const RESUME='Completed assets, outpaint and OCR entries are content-cached; rerun the same command to resume.';

// Original V6 sequencing, kept for direct comparison: whole stages run one after another.
export async function runBaseline(s,{stage,deps={}}={}){
 const d={...steps,...deps};
 await s.assets();if(stage==='assets')return null;
 await outpaint(s);await local(s,'register',()=>d.register(s));
 let text=await ocr(s);const corrections=ocrCorrections(s,text);
 if(Object.keys(corrections).length){await s.assets({repairs:corrections});await local(s,'register',()=>d.register(s));text=await ocr(s);}
 await local(s,'build:full',()=>d.build(s));
 if(stage!=='build'){
  const evaluation=await reconcileReviewedCopy(s,await d.review(s,{highOnly:true}));await d.applyAdjustments(s,evaluation);
  const repairs=pickRepairs(evaluation);
  if(Object.keys(repairs).length){await s.assets({repairs});await outpaint(s);await local(s,'register',()=>d.register(s));await ocr(s);}
  if(Object.keys(repairs).length||evaluation.adjustments.length){await local(s,'build:full',()=>d.build(s));await d.review(s,{final:true});}
 }
 return local(s,'build:full',()=>d.build(s));
}

// Dependency-aware generation. Every image call shares s.pool (background and its
// outpaint first, then text, then other assets). Each OCR batch waits only for its own
// text assets and overlaps the remaining image calls. Resolves/rejects only after everything settled.
export async function generate(s,{repairs={},withOutpaint=true,withOCR=true,repairText=true}={}){
 await s.ensureDirs();
 const rank=j=>s.execution==='overlap'?(j.kind==='background'?0:['subject','product'].includes(j.kind)?1:j.kind==='text'?2:3):(j.kind==='background'?0:j.kind==='text'?1:2),jobs=[...s.planData.jobs].sort((a,b)=>rank(a)-rank(b));
 // All cache checks finish before enqueueing, so pool order is deterministic.
 const prepared=await Promise.all(jobs.map(j=>s.prepareJob(j,repairs[j.id])));
 // A fresh clean plate is outpainted in the slot it already holds; a cached one queues first.
 const chain=p=>p.job.kind==='background'&&withOutpaint?()=>outpaint(s,{slotHeld:true}):undefined;
 const runs=new Map(prepared.map(p=>[p.job.id,p.cached?Promise.resolve(p.old):s.runJob(p,{priority:rank(p.job),then:chain(p)})]));
 const SKIPPED=Symbol('dependency failed'),branches=[];
 if(withOutpaint&&prepared.find(p=>p.job.kind==='background').cached)branches.push(outpaint(s,{priority:0}));
 let text=null;
 if(withOCR)branches.push((async()=>{
  // Ready batches are read and cached even if another text asset fails; then OCR is skipped.
  const read=await ocr(s,{ready:new Map(jobs.filter(j=>j.kind==='text').map(j=>[j.id,runs.get(j.id)]))});if(read.skipped)return SKIPPED;
  text=read;if(!repairText)return;
  const corrections=ocrCorrections(s,text);if(!Object.keys(corrections).length)return;
  const retry=await Promise.all(Object.keys(corrections).map(id=>s.prepareJob(s.planData.jobs.find(j=>j.id===id),corrections[id])));
  await settleAll(retry.map(p=>s.runJob(p,{priority:1})),'Text repair failed');
  text=await ocr(s);
 })());
 await settleAll([...runs.values(),...branches],'Generation failed ('+RESUME+')');
 return text;
}

export async function runFast(s,{stage,deps={}}={}){
 const d={...steps,...deps};
 if(s.execution==='overlap')return runOverlap(s,{stage,d,generate});
 if(stage==='assets'){await generate(s,{withOutpaint:false,withOCR:false});return null;}
 await generate(s);await local(s,'register',()=>d.register(s));
 if(stage==='build')return local(s,'build:full',()=>d.build(s));
 await local(s,'build:preview',()=>d.build(s,{partial:true}));
 let evaluation=await d.review(s);
 // At most two bounded quality rounds. If a confirmation still says unusable,
 // medium issues become actionable too; do not silently deliver a failed gate.
 // With a light reviewer, review() has already confirmed these findings on the stronger route.
 for(let round=0;round<2;round++){
  evaluation=await reconcileReviewedCopy(s,evaluation);
  const repairs=Object.fromEntries(actionableRepairs(evaluation).slice(0,3).map(r=>[r.id,r.prompt]));
  const repaired=Object.keys(repairs).length>0,adjusted=evaluation.adjustments.length>0;
  if(!repaired&&!adjusted)break;
  await d.applyAdjustments(s,evaluation);
  if(repaired){await generate(s,{repairs,repairText:false});await local(s,'register',()=>d.register(s));}
  await local(s,'build:preview',()=>d.build(s,{partial:true}));
  if(round===1){
   // Record-only final verdict: nothing acts on it, so it is not confirmed.
   const[,report]=await settleAll([d.review(s,{final:true}),local(s,'build:full',()=>d.build(s))],'Final review/build failed');
   return report;
  }
  evaluation=await d.review(s);
 }
 return local(s,'build:full',()=>d.build(s));
}
