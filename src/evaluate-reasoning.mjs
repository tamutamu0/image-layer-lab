// Compare reasoning profiles for plan / OCR / review on an EXISTING separation run, with
// no imagegen calls. Every (repeat, fixture, profile) gets a fresh workspace copy, so no
// cache entry is ever shared between profiles; profile order alternates per repeat.
// Fixture mutations are deterministic local edits (no AI): a changed expected text makes
// the true generated image a known mismatch; damaged layers are known review defects.
// Results contain only measured durations and observed outputs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import sharp from 'sharp';
import {Separator,readJSON} from './separation/core.mjs';
import {resolveReasoning,PROFILE_NAMES,ESCALATION_MODES} from './separation/routing.mjs';
import {runPlanning} from './separation/plan.mjs';
import {ocr,sameText} from './separation/ocr.mjs';
import {review} from './separation/review.mjs';
import {composite,saveJSON,writeFileAtomic} from './images.mjs';

export const EVAL_STAGES=['plan','ocr','review'],DAMAGE_TYPES=['missing','erase-half','shift'];
export const EVAL_USAGE=`Usage: node src/evaluate-reasoning.mjs --run=<existing separate --out dir> --out=<new dir> [--profiles=${PROFILE_NAMES.join(',')}|--variants=variants.json] [--stages=ocr,review|plan,...] [--repeat=1..5] [--fixtures=fixtures.json] [--escalation=auto|off|always]`;
// Variant: {name, profile, overrides?} where overrides use resolveReasoning keys, e.g.
// {"name":"quality-batch4","profile":"quality","overrides":{"ocrBatchSize":4,"ocrParallel":3}}.
const OVERRIDE_KEYS=['planModel','ocrModel','reviewModel','planEffort','ocrEffort','reviewEffort','escalation','escalationModel','escalationEffort','ocrBatchSize','ocrParallel','planFormat','reviewFormat'];
export function resolveVariants(list,escalation='auto'){
 if(!Array.isArray(list)||!list.length)throw Error('Variants must be a non-empty array');const out={};
 for(const v of list){if(typeof v?.name!=='string'||!/^[a-z0-9][a-z0-9_-]*$/i.test(v.name)||v.name in out)throw Error('Each variant needs a unique simple name');
  const extra=Object.keys(v.overrides||{}).filter(k=>!OVERRIDE_KEYS.includes(k));if(extra.length)throw Error(`Unknown variant override ${extra.join(', ')}`);
  out[v.name]=resolveReasoning(v.profile,{escalation,...v.overrides});}
 return out;
}
export function parseEvalArgs(argv){
 const known=['run','out','profiles','variants','stages','repeat','fixtures','escalation'],args={};
 for(const a of argv){if(!a.startsWith('--'))throw Error(`Unexpected argument ${a}\n${EVAL_USAGE}`);const[k,...v]=a.slice(2).split('=');if(!known.includes(k))throw Error(`Unknown option --${k}\n${EVAL_USAGE}`);if(k in args)throw Error(`Duplicate option --${k}`);if(!v.length||!v.join('='))throw Error(`--${k} needs a value`);args[k]=v.join('=');}
 if(!args.run||!args.out)throw Error(EVAL_USAGE);
 const list=(v,allowed,label)=>{const out=v.split(',');if(!out.length||out.some(x=>!allowed.includes(x))||new Set(out).size!==out.length)throw Error(`${label} must be a comma list of ${allowed.join(', ')}`);return out;};
 const repeat=Number(args.repeat??1);if(!Number.isInteger(repeat)||repeat<1||repeat>5)throw Error('--repeat must be an integer from 1 to 5');
 const escalation=args.escalation??'auto';if(!ESCALATION_MODES.includes(escalation))throw Error(`--escalation must be one of ${ESCALATION_MODES.join(', ')}`);
 if(args.profiles&&args.variants)throw Error('Use either --profiles or --variants');
 return{run:path.resolve(args.run),out:path.resolve(args.out),profiles:args.variants?null:list(args.profiles??'quality,luna',PROFILE_NAMES,'--profiles'),variants:args.variants?path.resolve(args.variants):null,stages:list(args.stages??'ocr,review',EVAL_STAGES,'--stages'),repeat,fixtures:args.fixtures?path.resolve(args.fixtures):null,escalation};
}
// Fixture: {name, expectText?:{textJobId:newExpected}, replaceAsset?:{textJobId:pngPath}, damage?:[{id,type}]}
export function validateFixtures(list){
 if(!Array.isArray(list)||!list.length)throw Error('Fixtures must be a non-empty array');
 const names=new Set();
 for(const f of list){if(typeof f?.name!=='string'||!/^[a-z0-9][a-z0-9_-]*$/i.test(f.name)||names.has(f.name))throw Error('Each fixture needs a unique simple name');names.add(f.name);
  for(const d of f.damage||[])if(!DAMAGE_TYPES.includes(d?.type))throw Error(`Damage type must be one of ${DAMAGE_TYPES.join(', ')}`);}
 return list;
}

// Copies the run's inputs (never its OCR/review caches) and applies the fixture locally.
export async function prepareWorkspace(run,ws,fixture){
 await fs.mkdir(ws,{recursive:true});
 for(const f of['source.png','plan.json','manifest.json','composite.png','registered.json'])await fs.copyFile(path.join(run,f),path.join(ws,f)).catch(e=>{if(e.code!=='ENOENT')throw e;});
 await fs.cp(path.join(run,'assets'),path.join(ws,'assets'),{recursive:true});
 const plan=await readJSON(path.join(ws,'plan.json'));if(!plan)throw Error('Run has no plan.json');
 const manifest=await readJSON(path.join(ws,'manifest.json')),truth={expectMismatch:[],replaced:[],damaged:[]};
 const textJob=id=>{const j=plan.jobs.find(j=>j.id===id&&j.kind==='text');if(!j)throw Error('Fixture refers to unknown text job '+id);return j;};
 const record=async(id,change)=>{const file=path.join(ws,'assets',id+'.json'),r=await readJSON(file);if(!r)throw Error('Missing asset record '+id);await saveJSON(file,await change(r));};
 for(const[id,text]of Object.entries(fixture.expectText||{})){const j=textJob(id);truth.expectMismatch.push({id,imageExpected:j.text,mutatedExpected:text});j.text=text;await record(id,r=>({...r,text}));for(const l of manifest?.layers||[])if(l.id===id)l.text=text;}
 for(const[id,png]of Object.entries(fixture.replaceAsset||{})){textJob(id);const file=`assets/eval-replaced-${id}.png`,meta=await sharp(png).metadata();await fs.copyFile(png,path.join(ws,file));await record(id,r=>({...r,file,width:meta.width,height:meta.height}));truth.replaced.push({id,file:png});}
 if(fixture.damage?.length){
  if(!manifest)throw Error('Damage fixtures need a manifest.json (run build first)');
  await fs.mkdir(path.join(ws,'eval-damage'),{recursive:true});
  for(const{id,type}of fixture.damage){
   const l=manifest.layers.find(l=>l.id===id);if(!l)throw Error('Fixture refers to unknown layer '+id);
   if(type==='shift')l.x=Math.round(l.x+manifest.width*.06);
   else{const im=await sharp(path.join(ws,l.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true}),{width,height}=im.info;
    for(let y=0;y<height;y++)for(let x=type==='missing'?0:Math.floor(width/2);x<width;x++)im.data[(y*width+x)*4+3]=0;
    const file=`eval-damage/${id}.png`;await sharp(im.data,{raw:im.info}).png().toFile(path.join(ws,file));l.file=file;}
   truth.damaged.push({id,type});
  }
  await saveJSON(path.join(ws,'manifest.json'),manifest);await writeFileAtomic(path.join(ws,'composite.png'),await composite(manifest,ws));
 }
 await saveJSON(path.join(ws,'plan.json'),plan);
 return{plan,manifest,truth};
}

const flagged=e=>[...new Set([...(e?.repairs||[]).map(r=>r.id),...(e?.adjustments||[]).map(a=>a.id)])];
async function stagePlan(s,reference){
 const{plan,planning}=await runPlanning(s);await saveJSON(path.join(s.dir,'plan-eval.json'),{...plan,planning});
 // Text inventory difference against the run's plan: informative, not a semantic score.
 const texts=plan.jobs.filter(j=>j.kind==='text').map(j=>j.text),refTexts=reference.jobs.filter(j=>j.kind==='text').map(j=>j.text);
 return{jobs:plan.jobs.length,groups:plan.groups.length,textJobs:texts.length,escalated:planning.attempts.length>1,attempts:planning.attempts,defects:planning.defects,warnings:planning.warnings,
  referenceTextsMissing:refTexts.filter(t=>!texts.some(x=>sameText(x,t))),textsNotInReference:texts.filter(t=>!refTexts.some(x=>sameText(x,t)))};
}
async function stageOcr(s,truth){
 const text=await ocr(s),injected=new Set([...truth.expectMismatch.map(m=>m.id),...truth.replaced.map(r=>r.id)]);
 const primaryPass=t=>t.attempts[0].textMatchesExpected===true&&t.attempts[0].modelClaimedCorrect===true;
 return{entries:text.texts.map(t=>({id:t.id,expected:t.expected,text:t.text,correct:t.correct,readBy:t.readBy,attempts:t.attempts,disagreement:t.disagreement})),
  calls:text.calls.map(c=>({stage:c.stage,role:c.role,ids:c.ids})),warnings:text.warnings,
  escalatedIds:text.texts.filter(t=>t.attempts.length>1).map(t=>t.id),finalIncorrectIds:text.texts.filter(t=>!t.correct).map(t=>t.id),
  injected:{ids:[...injected],detectedFinal:text.texts.filter(t=>injected.has(t.id)&&!t.correct).map(t=>t.id),missedFinal:text.texts.filter(t=>injected.has(t.id)&&t.correct).map(t=>t.id),
   detectedByFirstRead:text.texts.filter(t=>injected.has(t.id)&&!primaryPass(t)).map(t=>t.id)},
  // Ground truth for un-mutated images is unknown: these may be real generation defects.
  rejectedUninjectedIds:text.texts.filter(t=>!injected.has(t.id)&&!t.correct).map(t=>t.id)};
}
async function stageReview(s,truth){
 const r=await review(s),first=r.primaryReview??r,damaged=truth.damaged.map(d=>d.id),text=e=>[e?.summary,...(e?.limitations||[])].join(' ');
 return{verdict:r.verdict,primaryVerdict:first.verdict??null,confirmation:r.confirmation,flaggedFinal:flagged(r),flaggedByFirstPass:flagged(first),rejected:r.confirmation?.rejected??[],
  injected:{ids:damaged,flaggedFinal:damaged.filter(id=>flagged(r).includes(id)),flaggedByFirstPass:damaged.filter(id=>flagged(first).includes(id)),mentionedInText:damaged.filter(id=>text(r).includes(id))},
  flaggedUninjected:flagged(r).filter(id=>!damaged.includes(id))};
}
const median=v=>{const a=[...v].sort((x,y)=>x-y);return a.length?a.length%2?a[(a.length-1)/2]:(a[a.length/2-1]+a[a.length/2])/2:null;};
export function summarize(rows){
 const groups={};for(const r of rows){const g=groups[`${r.profile}/${r.stage}/${r.fixture}`]||={profile:r.profile,stage:r.stage,fixture:r.fixture,runs:0,errors:0,wallMs:[]};g.runs++;if(r.error)g.errors++;else g.wallMs.push(r.wallMs);}
 return Object.values(groups).map(g=>({...g,wallMs:{min:g.wallMs.length?Math.min(...g.wallMs):null,median:median(g.wallMs),max:g.wallMs.length?Math.max(...g.wallMs):null,samples:g.wallMs}}));
}

export async function evaluate({run,out,profiles,variants=null,stages,repeat=1,fixtures=null,escalation='auto',makeAi}){
 if(await fs.access(out).then(()=>true,()=>false))throw Error('Output exists; use a new --out so no cache or result is reused');
 const fixtureList=validateFixtures(fixtures?JSON.parse(await fs.readFile(fixtures,'utf8')):[{name:'clean'}]);
 const reference=await readJSON(path.join(run,'plan.json'));if(!reference)throw Error('Run has no plan.json');
 const routes=variants?resolveVariants(Array.isArray(variants)?variants:JSON.parse(await fs.readFile(variants,'utf8')),escalation):Object.fromEntries(profiles.map(p=>[p,resolveReasoning(p,{escalation})]));
 profiles=Object.keys(routes);const rows=[];await fs.mkdir(out,{recursive:true});
 for(let r=0;r<repeat;r++)for(const[fi,fixture]of fixtureList.entries())for(const profile of r%2?[...profiles].reverse():profiles){
  const ws=path.join(out,`r${r+1}`,fixture.name,profile);let s;
  try{
   const{plan,truth}=await prepareWorkspace(run,ws,fixture);
   s=new Separator({input:path.join(ws,'source.png'),out:ws,reasoning:routes[profile],ai:makeAi?.(ws)});await s.init();await s.preflight();s.planData=plan;
   // Planning ignores fixtures, so it is measured once per repeat/profile.
   for(const stage of stages.filter(x=>x!=='plan'||fi===0)){
    const tasks=s.timeline.tasks.length,calls=(s.ai.calls||[]).length,t0=performance.now(),row={repeat:r+1,fixture:fixture.name,profile,stage};
    try{Object.assign(row,stage==='plan'?await stagePlan(s,reference):stage==='ocr'?await stageOcr(s,truth):await stageReview(s,truth));}
    catch(e){row.error=e.message;}
    row.wallMs=Math.round(performance.now()-t0);
    row.reasoningTasks=s.timeline.tasks.slice(tasks).map(t=>({stage:t.stage,route:t.route,requestedModel:t.requestedModel,effort:t.effort,status:t.status,durationMs:t.endedAtMs===null?null:Math.round(t.endedAtMs-t.startedAtMs)}));
    row.agentCalls=(s.ai.calls||[]).slice(calls).map(c=>({stage:c.stage,requestedModel:c.requestedModel,resolvedModel:c.resolvedModel,threadModel:c.threadModel,requestedEffort:c.requestedEffort,status:c.status,durationMs:c.durationMs,error:c.error}));
    rows.push(row);await saveJSON(path.join(ws,`eval-${stage}.json`),row);
   }
  }catch(e){rows.push({repeat:r+1,fixture:fixture.name,profile,stage:'setup',error:e.message});}
  finally{s?.close();}
 }
 const result={createdAt:new Date().toISOString(),run,profiles:routes,stages,repeat,fixtures:fixtureList,rows,summary:summarize(rows),
  notes:['Durations are measured wall times of this process; app-server load varies, so compare repeated, order-alternated runs.','Injected-defect detection measures recall only on these synthetic mutations; it is not a general accuracy estimate.','rejectedUninjected/flaggedUninjected may be real defects: their ground truth is unknown.']};
 await saveJSON(path.join(out,'results.json'),result);return result;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const o=parseEvalArgs(process.argv.slice(2)),result=await evaluate(o);
 console.log(JSON.stringify(result.summary,null,2));console.log('Results: '+path.join(o.out,'results.json'));
}
