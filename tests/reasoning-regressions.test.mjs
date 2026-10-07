import test from 'node:test';
import assert from 'node:assert/strict';
import {Timeline} from '../src/concurrency.mjs';
import {resolveReasoning} from '../src/separation/routing.mjs';
import {generate} from '../src/separation/run.mjs';
import {isActionable} from '../src/separation/review.mjs';
import {setupFake,planFor} from './helpers/fake-ai.mjs';

test('parallel OCR overlap counts wall-time union, not simultaneous batch durations twice',()=>{
 const t=new Timeline(()=>0);t.tasks=[
  {id:'asset:x',kind:'image',startedAtMs:0,endedAtMs:100,readyAtMs:0},
  {id:'ocr',kind:'reasoning',startedAtMs:20,endedAtMs:80,readyAtMs:20},
  {id:'ocr',kind:'reasoning',startedAtMs:40,endedAtMs:120,readyAtMs:40},
 ];
 assert.equal(t.report().overlap.ocrWithImageGenerationMs,80);
});

test('balanced planner refuses definite geometry defects that remain after its single escalation',async t=>{
 const jobs=[['bg','background'],['h','text','見出し'],['p1','product'],['p2','product'],['p3','product']];
 const p=planFor(jobs);p.jobs.find(j=>j.id==='p1').visibleBbox=[100,100,200,200];
 const{s,log}=await setupFake(t,{reasoning:resolveReasoning('balanced'),plan:()=>p});
 await assert.rejects(s.plan(),/Unresolved plan geometry/);
 assert.deepEqual(log.plans.map(c=>[c.model,c.effort]),[['gpt-6.1-sol','low'],['gpt-6.1-sol','high']]);
});

test('malformed light OCR geometry is reread alone, without regenerating any image',async t=>{
 const jobs=[['bg','background'],['price','text','3,520円'],['tax','text','税込'],['cta','text','詳しく見る'],['p','product']];
 const{s,log}=await setupFake(t,{jobs,reasoning:resolveReasoning('balanced')});
 const base=s.ai.ai;s.ai.ai=async(stage,prompt,opts)=>{
  const r=await base(stage,prompt,opts);
  if(stage.startsWith('04-')&&opts.model==='gpt-6-luna'){
   const d=JSON.parse(r.result.text),x=d.texts.find(x=>x.id==='price');
   if(x){x.runs=[null];r.result.text=JSON.stringify(d);}
  }
  return r;
 };
 const text=await generate(s);
 assert.equal(text.texts.find(t=>t.id==='price').correct,true);
 assert.deepEqual(log.ocr.map(c=>[c.model,c.ids]),[['gpt-6-luna',['price','tax','cta']],['gpt-6.1-sol',['price']]]);
 assert.equal(log.images.filter(c=>c.id==='price').length,1);
});

test('baseline confirmation policy matches the high-only repairs it actually applies',()=>{
 const e={verdict:'needs_improvement',repairs:[{id:'x',priority:'medium'}],adjustments:[]};
 assert.equal(isActionable(e),true);
 assert.equal(isActionable(e,{highOnly:true}),false);
 assert.equal(isActionable({...e,adjustments:[{id:'x'}]},{highOnly:true}),true);
});

test('legacy quality keeps the valid first plan if its optional stronger retry is malformed',async t=>{
 const p=planFor([['bg','background'],['h','text','見出し'],['p1','product'],['p2','product'],['p3','product']]);
 p.jobs.find(j=>j.id==='p1').visibleBbox=[100,100,200,200];
 const{s,log}=await setupFake(t,{reasoning:resolveReasoning('quality',{escalationModel:'gpt-6.1-sol'}),plan:(_c,n)=>n===1?p:'invalid json'});
 const result=await s.plan();assert.equal(result.planning.acceptedRole,'primary');assert.equal(log.plans.length,2);
 assert.equal(result.planning.attempts[1].valid,false);
});
