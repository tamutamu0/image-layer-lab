import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Separator} from '../src/separation/core.mjs';
import {parseOptions} from '../src/separation/options.mjs';
import {resolveReasoning,MODEL_CANDIDATES} from '../src/separation/routing.mjs';
import {generate,runFast} from '../src/separation/run.mjs';
import {ocr,chunk} from '../src/separation/ocr.mjs';
import {build} from '../src/separation/build.mjs';
import {planDiagnostics} from '../src/separation/plan.mjs';
import {validatePlan} from '../src/separation/schema.mjs';
import {Pipeline,checkRoute} from '../src/pipeline.mjs';
import {evaluate,parseEvalArgs,resolveVariants} from '../src/evaluate-reasoning.mjs';
import {setupFake,fakeAi,newLog,planFor,byId,GLOBAL} from './helpers/fake-ai.mjs';
const{sol:SOL,luna:LUNA}=MODEL_CANDIDATES;
const luna=(o={})=>resolveReasoning('luna',o);
const read=async(s,f)=>JSON.parse(await fs.readFile(path.join(s.dir,f),'utf8'));
const price=[['bg','background'],['price','text','3,278円'],['tax','text','(税込)'],['cta','text','初回価格で試す'],['p1','product']];

test('CLI: profiles, explicit stage overrides and escalation precedence are strict and independent of the image wrapper',()=>{
 const base=['--input=a.png','--out=x'],st=o=>o.reasoning.stages;
 let o=parseOptions(base,{});
 assert.equal(o.reasoning.profile,'accelerated');
 assert.equal(st(o).plan.format,'compact');assert.equal(st(o).plan.copyAudit,true);assert.equal(o.execution,'overlap');
 assert.deepEqual(['plan','ocr','review'].map(k=>[st(o)[k].primary.model,st(o)[k].primary.effort]),[[SOL,'low'],[LUNA,'low'],[SOL,'low']]);
 assert.equal(st(o).ocr.criticalDirect,false);
 o=parseOptions([...base,'--reasoning-profile=quality'],{});
 assert.equal(o.reasoning.profile,'quality');
 for(const k of['plan','ocr','review'])assert.deepEqual([st(o)[k].primary.model,st(o)[k].primary.effort,st(o)[k].escalation],[null,'high',null],'quality = V7: inherited model, high, no escalation');
 assert.deepEqual([st(o).ocr.batchSize,st(o).ocr.parallel,o.effort.image],['all',1,'low']);
 o=parseOptions([...base,'--reasoning-profile=luna'],{});
 for(const k of['plan','ocr','review'])assert.deepEqual([st(o)[k].primary.model,st(o)[k].primary.effort,st(o)[k].escalation?.model,st(o)[k].escalation?.effort],[LUNA,'low',SOL,'high']);
 assert.deepEqual([o.effort.image,o.effort.ocr],['low','low']);
 assert.equal(parseOptions([...base,'--reasoning-profile=luna','--mode=baseline'],{}).effort.image,'high','image wrapper effort follows mode, not the profile');
 assert.equal(parseOptions([...base,'--reasoning-profile=luna','--image-effort=medium'],{}).effort.image,'medium');
 // Explicit stage model wins and is NOT auto-escalated; an effort-only flag keeps escalation.
 o=parseOptions([...base,'--reasoning-profile=balanced','--ocr-model=custom-ocr','--review-effort=medium'],{});
 assert.deepEqual(st(o).ocr.primary,{role:'primary',model:'custom-ocr',effort:'low'});assert.equal(st(o).ocr.escalation,null);assert.match(st(o).ocr.escalationNote,/explicit --ocr-model/);
 assert.equal(st(o).ocr.criticalDirect,false,'no direct strong route without escalation');
 assert.deepEqual([st(o).review.primary.effort,st(o).review.source.effort,st(o).review.escalation.model],['medium','flag',SOL]);
 assert.equal(st(parseOptions([...base,'--reasoning-profile=balanced','--ocr-model=custom-ocr','--escalation=always'],{})).ocr.escalation.model,SOL);
 // Raising balanced plan to the escalation route makes escalation a no-op.
 o=parseOptions([...base,'--reasoning-profile=balanced','--plan-effort=high'],{});assert.equal(st(o).plan.escalation,null);assert.match(st(o).plan.escalationNote,/equals/);
 assert.ok(Object.values(st(parseOptions([...base,'--reasoning-profile=luna','--escalation=off'],{}))).every(x=>x.escalation===null));
 o=parseOptions([...base,'--escalation-model=gpt-6.1-sol','--ocr-batch-size=2','--ocr-parallel=2'],{});
 assert.deepEqual(st(o).plan.escalation,{role:'escalation',model:SOL,effort:'high'});assert.deepEqual([st(o).ocr.batchSize,st(o).ocr.parallel],[2,2]);
 for(const bad of[['--reasoning-profile=fast'],['--reasoning-profile'],['--plan-model='],['--plan-model=bad id'],['--ocr-model=-x'],['--ocr-parallel=4'],['--ocr-parallel=0'],['--ocr-batch-size=0'],['--ocr-batch-size=9'],['--ocr-batch-size=two'],
  ['--escalation=maybe'],['--escalation-effort=max'],['--review-effort=xhigh'],['--reasoning-profile=luna','--reasoning-profile=quality']])assert.throws(()=>parseOptions([...base,...bad],{}),undefined,bad.join());
});

test('Pipeline: a per-call model is validated, recorded with timing, never mutates the image wrapper model and never falls back',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-route-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const p=new Pipeline({runDir:dir,onProgress:()=>{}}),threads=[];let turnError=null;
 p.connection=Promise.resolve();p.model=SOL;
 p.catalog=[{model:SOL,isDefault:true,supportedReasoningEfforts:['low','medium','high'].map(reasoningEffort=>({reasoningEffort}))},{model:LUNA,supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}]}];
 const server={thread:async o=>{threads.push(o);return{thread:{id:'t'+threads.length},model:o.model};},turn:async()=>{if(turnError)throw turnError;return{text:'{}',items:[],raw:[],turn:{id:'x',status:'completed'}};}};p.server=server;
 const r=await p.ai('04-ocr','p',{schema:{},effort:'low',model:LUNA});
 assert.equal(threads[0].model,LUNA);assert.equal(p.model,SOL,'global/image-wrapper model untouched');
 assert.match(threads[0].developerInstructions,/READ-ONLY/);assert.match(threads[0].developerInstructions,/NEVER call imagegen/);
 assert.deepEqual([r.call.requestedModel,r.call.resolvedModel,r.call.threadModel,r.call.requestedEffort,r.call.modelValidation,r.call.status],[LUNA,LUNA,LUNA,'low','listed','complete']);
 assert.ok(Number.isFinite(r.call.durationMs));assert.equal((await fs.readFile(path.join(dir,'stages/04-ocr/request.json'),'utf8')).includes(`"model": "${LUNA}"`),true);
 await p.ai('02-asset-1','image prompt',{effort:'low'});assert.equal(threads[1].model,SOL,'image wrapper keeps the inherited model');
 assert.match(threads[1].developerInstructions,/When imagegen is requested, call it exactly once/);
 await assert.rejects(p.ai('x','p',{schema:{},model:'gpt-unknown'}),/not listed.*refusing to substitute/);
 await assert.rejects(p.ai('x','p',{schema:{},model:LUNA,effort:'high'}),/not supported/);
 assert.equal(threads.length,2,'invalid routes never start a thread');
 p.server={...server,thread:async o=>{threads.push(o);return{thread:{id:'z'},model:'some-other-model'};}};
 await assert.rejects(p.ai('x','p',{schema:{},model:LUNA,effort:'low'}),/refusing silent model substitution/);
 p.server=server;turnError=Error('429 rate limited');const before=threads.length;
 await assert.rejects(p.ai('x','p',{schema:{},model:LUNA,effort:'low'}),/429/);
 assert.equal(threads.length,before+1,'a transport/rate failure is not retried on another model');assert.equal(p.calls.at(-1).status,'failed');
 assert.match(checkRoute(p.catalog,{model:'gpt-x',allowUnlisted:true}).validation,/unlisted/);
 assert.match(checkRoute([],{model:'gpt-x'}).validation,/unverified/);
});

test('Pipeline: a tool attempt invalidates a read-only reasoning result even if its JSON is valid',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pipeline-readonly-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const p=new Pipeline({runDir:dir,onProgress:()=>{}});p.connection=Promise.resolve();p.model=SOL;p.catalog=[];
 p.server={thread:async()=>({thread:{id:'readonly'},model:SOL}),turn:async()=>({text:'{}',items:[{type:'imageGeneration',status:'failed'}],raw:[],turn:{id:'attempt',status:'completed'}})};
 await assert.rejects(p.ai('source-copy','read text',{schema:{},effort:'low'}),/Read-only reasoning attempted image generation/);
 assert.equal(p.calls[0].status,'failed');
 assert.match((await fs.readFile(path.join(dir,'stages/source-copy/call.json'),'utf8')),/output rejected/);
});

test('routing: reasoning stages use their routes while every imagegen wrapper keeps the global model',async t=>{
 const{s,log}=await setupFake(t,{reasoning:luna(),jobs:price});
 await generate(s);
 assert.ok(log.images.length>0&&log.images.every(c=>c.model===undefined&&c.effort==='low'),'image calls pass no model override');
 assert.ok(log.ocr.length>0&&log.ocr.every(c=>c.model===LUNA&&c.effort==='low'));
 const rec=await read(s,'assets/p1.json');assert.equal(rec.provenance.wrapperModel,GLOBAL);
 const text=await read(s,'text.json');assert.deepEqual(text.policy.primary,{model:LUNA,effort:'low'});assert.deepEqual(text.policy.escalation,{model:SOL,effort:'high'});
 assert.equal(s.timeline.tasks.filter(t=>t.kind==='reasoning').every(t=>t.requestedModel===LUNA&&t.route==='primary'),true);
});

test('OCR mini-batches: stable near-equal batches, bounded parallel calls, each text read once, batches start before all text is generated',async t=>{
 assert.deepEqual(chunk([1,2,3,4,5,6,7,8,9,10,11,12,13],4).map(b=>b.length),[4,3,3,3]);assert.deepEqual(chunk([1,2,3],'all'),[[1,2,3]]);
 const jobs=[['bg','background'],...Array.from({length:8},(_,i)=>['t'+i,'text','文字'+i]),['p1','product']];
 const{s,log}=await setupFake(t,{reasoning:luna({ocrBatchSize:3,ocrParallel:2}),jobs,concurrency:2,delays:{image:20,ocr:30}});
 const text=await generate(s);
 assert.deepEqual(log.ocr.map(c=>c.ids),[['t0','t1','t2'],['t3','t4','t5'],['t6','t7']]);
 assert.ok(log.ocrPeak<=2);
 assert.deepEqual(text.texts.map(t=>t.id),jobs.filter(j=>j[1]==='text').map(j=>j[0]),'plan order');
 const lastText=Math.max(...log.images.filter(c=>/^t\d$/.test(c.id)).map(c=>c.end));
 assert.ok(log.ocr[0].start<lastText,'first batch overlapped later text generation');
 assert.equal((await fs.readdir(path.join(s.dir,'ocr-cache'))).filter(f=>f.endsWith('.json')).length,8);
});

test('OCR escalation re-reads only the suspicious entry; the accepted text is the strong transcription, and disagreement is surfaced',async t=>{
 const transcribe=(a,c)=>c.model===LUNA&&a.id==='price'?{text:'3,276円',correct:true}:{text:a.expected,correct:true};
 const{s,log}=await setupFake(t,{reasoning:luna(),jobs:price,transcribe});
 const text=await generate(s);
 assert.deepEqual(log.ocr.map(c=>[c.model,c.effort,c.ids]),[[LUNA,'low',['price','tax','cta']],[SOL,'high',['price']]]);
 assert.equal(byId(log,'price').length,1,'confirmed by the strong read, so no image regeneration');
 const p=text.texts.find(t=>t.id==='price');
 assert.deepEqual([p.text,p.correct,p.readBy,p.attempts[0].text,p.disagreement.digitsDiffer],['3,278円',true,'escalation','3,276円',true]);
 assert.deepEqual(text.warnings.map(w=>[w.id,w.type]),[['price','digit-disagreement']]);
 assert.ok(text.texts.filter(t=>t.id!=='price').every(t=>t.attempts.length===1&&t.readBy==='primary'));
});

test('OCR: repeated strong disagreement leaves the text incorrect, keeps the misread verbatim, and all work is bounded',async t=>{
 const{s,log}=await setupFake(t,{reasoning:luna(),jobs:price,transcribe:a=>a.id==='price'?{text:'3,276円',correct:true}:{text:a.expected,correct:true}});
 const text=await generate(s);
 assert.deepEqual(log.ocr.map(c=>[c.model,c.ids.join()]),[[LUNA,'price,tax,cta'],[SOL,'price'],[LUNA,'price'],[SOL,'price']]);
 assert.equal(byId(log,'price').length,2,'exactly one text repair round');
 const p=text.texts.find(t=>t.id==='price');
 assert.deepEqual([p.text,p.runs.map(r=>r.text).join(''),p.expected,p.correct,p.textMatchesExpected],['3,276円','3,276円','3,278円',false,false]);
 await build(s,{partial:true});
});

test('OCR: malformed or missing light entries escalate alone and good entries are never re-read',async t=>{
 const transcribe=(a,c)=>c.model===LUNA&&a.id==='tax'?{omit:true}:c.model===LUNA&&a.id==='cta'?{text:a.expected,correct:true,badRuns:true}:{text:a.expected,correct:true};
 const{s,log}=await setupFake(t,{reasoning:luna(),jobs:price,transcribe});
 const text=await generate(s);
 assert.deepEqual(log.ocr.map(c=>c.ids.slice().sort()),[['cta','price','tax'],['cta','tax']]);
 assert.equal(log.images.filter(c=>['price','tax','cta'].includes(c.id)).length,3,'no text was regenerated');
 const by=id=>text.texts.find(t=>t.id===id);
 assert.equal(by('tax').attempts[0].problem,'missing entry');assert.match(by('cta').attempts[0].problem,/runs/);assert.ok(text.texts.every(t=>t.correct));
});

test('OCR without escalation (quality): a malformed entry fails only after valid entries are saved; rerun re-reads only it',async t=>{
 let broken=true;const transcribe=a=>({text:a.expected,correct:true,badRuns:broken&&a.id==='cta'});
 const{s,log}=await setupFake(t,{jobs:price,transcribe});
 await assert.rejects(generate(s),/Invalid OCR output.*cta: runs/);
 assert.equal(log.ocr.length,1);assert.equal((await fs.readdir(path.join(s.dir,'ocr-cache'))).filter(f=>f.endsWith('.json')).length,2);
 broken=false;await generate(s);assert.deepEqual(log.ocr.at(-1).ids,['cta']);assert.equal(log.ocr.length,2);
});

test('OCR transport failure drains other batches, persists them, and never escalates or substitutes a model',async t=>{
 let fail=true;const{s,log}=await setupFake(t,{reasoning:luna({ocrBatchSize:1,ocrParallel:3}),jobs:price,delays:{ocr:15},failOcr:c=>fail&&c.ids.includes('tax')});
 let activeAtReject;await assert.rejects(generate(s).finally(()=>{activeAtReject=log.ocrActive;}),/429 rate limited/);
 assert.equal(activeAtReject,0);assert.ok(log.ocr.every(c=>c.model===LUNA),'no stronger/other model was tried');
 assert.equal((await fs.readdir(path.join(s.dir,'ocr-cache'))).filter(f=>f.endsWith('.json')).length,2);
 fail=false;const n=log.ocr.length;await generate(s);assert.deepEqual(log.ocr.slice(n).map(c=>c.ids),[['tax']]);
});

test('OCR cache is model-aware: profiles never share entries, each stays reusable, and an inherited-model change invalidates',async t=>{
 const{s,log}=await setupFake(t,{reasoning:luna(),jobs:price});
 await generate(s);const n=log.ocr.length;
 const q=new Separator({input:s.input,out:s.dir,concurrency:2,mode:'fast',bleed:.1});await q.init();await q.plan();q.ai=s.ai;
 await ocr(q);assert.deepEqual(log.ocr.slice(n).map(c=>[c.model,c.ids.length]),[[GLOBAL,3]],'quality re-reads everything with its own route');
 await ocr(s);await ocr(q);assert.equal(log.ocr.length,n+1,'both profiles reuse their own entries');
 s.ai.model='global-model-2';await ocr(q);assert.deepEqual(log.ocr.at(-1),{...log.ocr.at(-1),model:'global-model-2'});assert.equal(log.ocr.length,n+2);
 await ocr(s);assert.equal(log.ocr.length,n+2,'explicit Luna route unaffected by the global model');
});

test('plan: structurally invalid light plan escalates once; explicit overrides are not escalated; the quality profile keeps V7 acceptance',async t=>{
 const jobs=[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']],good=planFor(jobs);
 const defective={...good,jobs:good.jobs.map(j=>j.id==='p1'?{...j,visibleBbox:[100,100,200,200]}:j)};
 const run=async(reasoning,answers)=>{const{s,log}=await setupFake(t,{reasoning,plan:(_c,n)=>answers[n-1]});return{s,log,result:await s.plan().then(p=>p,e=>e)};};
 let r=await run(luna(),['not json',good]);
 assert.deepEqual(r.log.plans.map(c=>[c.model,c.effort]),[[LUNA,'low'],[SOL,'high']]);
 const saved=await read(r.s,'plan.json');assert.deepEqual(saved.planning.attempts.map(a=>[a.role,a.valid]),[['primary',false],['escalation',true]]);assert.match(saved.planning.note,/cannot prove semantic/);
 r=await run(luna({planModel:LUNA}),['not json',good]);assert.ok(r.result instanceof Error);assert.equal(r.log.plans.length,1,'explicit model override: no automatic escalation');
 r=await run(luna(),['not json','{"also":"bad"}']);assert.ok(r.result instanceof Error);assert.equal(r.log.plans.length,2,'bounded to one escalation');
 r=await run(luna(),[defective,good]);assert.equal(r.log.plans.length,2);assert.equal(r.result.planning.acceptedRole,'escalation');
 r=await run(resolveReasoning('quality'),[defective]);assert.equal(r.log.plans.length,1);assert.match(r.result.planning.defects[0],/p1 visibleBbox/);
 r=await run(luna(),[good]);assert.equal(r.log.plans.length,1);assert.equal(r.result.planning.acceptedRole,'primary');
});

test('planDiagnostics separates escalation-worthy defects from recorded warnings',()=>{
 const p=validatePlan(planFor([['bg','background'],['h1','text','A'],['h2','text','A'],['p1','product'],['p2','product']]));
 assert.deepEqual(planDiagnostics(p).defects,[]);assert.ok(planDiagnostics(p).warnings.includes('duplicate text units'));
 const small={...p,jobs:p.jobs.map(j=>j.kind==='background'?{...j,bbox:[0,0,500,1000]}:j)};assert.match(planDiagnostics(small).defects[0],/background/);
 const off={...p,jobs:p.jobs.map(j=>j.id==='p2'?{...j,visibleBbox:[1100,1100,50,50]}:j)};assert.ok(planDiagnostics(off).defects.some(d=>/not visible/.test(d)));
});

// Real review() and build preview; register/full export are stubbed.
const reviewRun=async(t,reasoning,review)=>{
 const{s,log}=await setupFake(t,{reasoning,jobs:[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']],review});
 const deps={register:async()=>{},build:async(x,o={})=>o.partial?build(x,o):{ok:true}};
 await runFast(s,{deps});return{s,log};
};
const R=(o={})=>({verdict:'usable',summary:'',strengths:[],limitations:[],repairs:[],adjustments:[],...o});
const high={id:'p1',reason:'edge',prompt:'fix edge',priority:'high'};

test('review: a light reviewer cannot trigger repairs or adjustments that the stronger confirmation rejects',async t=>{
 const{s,log}=await reviewRun(t,luna(),c=>c.confirm?{...R(),rejected:[{kind:'repair',id:'p1',reason:'not visible'},{kind:'adjustment',id:'p2',reason:'aligned'}]}:R({verdict:'needs_improvement',repairs:[high],adjustments:[{id:'p2',dx:3,dy:0,scale:1,opacity:1,reason:''}]}));
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false],[SOL,true]]);
 assert.equal(byId(log,'p1').length,1,'no imagegen repair');
 assert.equal(await fs.access(path.join(s.dir,'adjustments.json')).then(()=>true,()=>false),false);
 const r=await read(s,'review.json');assert.equal(r.confirmation.status,'confirmed');assert.equal(r.primaryReview.repairs[0].id,'p1');assert.equal(r.confirmation.rejected.length,2);
});

test('review: confirmed findings are repaired; a clear light review is accepted with its unmeasured recall recorded',async t=>{
 const{s,log}=await reviewRun(t,luna(),(c,n)=>n===1?R({verdict:'needs_improvement',repairs:[high]}):c.confirm?{...R({verdict:'needs_improvement',repairs:[high]}),rejected:[]}:R());
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false],[SOL,true],[LUNA,false]]);
 assert.equal(byId(log,'p1').length,2);
 const r=await read(s,'review.json');assert.match(r.confirmation.status,/not needed/);assert.match(r.confirmation.recall,/unmeasured/);
});

test('review: repair loop stays bounded and the record-only final review is never confirmed; quality acts without confirmation',async t=>{
 const always=c=>c.confirm?{...R({verdict:'needs_improvement',repairs:[high]}),rejected:[]}:R({verdict:'needs_improvement',repairs:[high]});
 let{s,log}=await reviewRun(t,luna(),always);
 assert.deepEqual(log.reviews.map(c=>c.model),[LUNA,SOL,LUNA,SOL,LUNA]);assert.equal(byId(log,'p1').length,3,'two repair rounds at most');
 assert.match((await read(s,'review.json')).confirmation.status,/record-only/);
 ({log}=await reviewRun(t,resolveReasoning('quality'),c=>R({verdict:'usable',repairs:[high]})));
 assert.ok(log.reviews.every(c=>!c.confirm&&c.model===GLOBAL));assert.equal(log.reviews.length,3);assert.equal(byId(log,'p1').length,3,'V7 behaviour: high repairs acted on directly, two rounds at most');
});

test('review: invalid light output is escalated once instead of failing the run; quality keeps V7 failure',async t=>{
 const ghost={...high,id:'ghost'};
 const{s,log}=await reviewRun(t,luna(),c=>c.confirm?{...R(),rejected:[]}:R({verdict:'needs_improvement',repairs:[ghost]}));
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false],[SOL,true]]);
 const r=await read(s,'review.json');assert.equal(r.confirmation.trigger,'invalid primary output');assert.match(r.primaryReview.error,/missing asset ghost/);
 await assert.rejects(reviewRun(t,resolveReasoning('quality'),()=>R({repairs:[ghost]})),/missing asset ghost/);
});

test('evaluation entrypoint: isolated per-profile workspaces, injected price mismatch and missing layer, measured timings only, source run untouched',async t=>{
 const{s}=await setupFake(t,{jobs:price});await generate(s);await build(s,{partial:true});
 const before=await fs.readFile(path.join(s.dir,'assets/price.json'),'utf8');
 const out=path.join(path.dirname(s.dir),'eval'),fixtures=path.join(path.dirname(s.dir),'fixtures.json');
 await fs.writeFile(fixtures,JSON.stringify([{name:'clean'},{name:'corrupt',expectText:{price:'3,276円'},damage:[{id:'p1',type:'missing'}]}]));
 // Luna here "echoes" the expected text; the inherited model reads the true image (3,278円).
 const truth={price:'3,278円',tax:'(税込)',cta:'初回価格で試す'},logs=[];
 const makeAi=()=>{const log=newLog();logs.push(log);return fakeAi(log,{transcribe:(a,c)=>({text:c.model===LUNA?a.expected:truth[a.id],correct:true}),review:c=>c.confirm?{...R(),rejected:[]}:R()});};
 const o=parseEvalArgs([`--run=${s.dir}`,`--out=${out}`,'--profiles=quality,luna','--stages=ocr,review','--repeat=2',`--fixtures=${fixtures}`]);
 const result=await evaluate({...o,makeAi});
 const row=(p,st,f,r=1)=>result.rows.find(x=>x.profile===p&&x.stage===st&&x.fixture===f&&x.repeat===r);
 assert.equal(result.rows.filter(r=>r.error).length,0,JSON.stringify(result.rows.filter(r=>r.error)));
 assert.deepEqual(row('quality','ocr','corrupt').injected.detectedFinal,['price']);
 assert.deepEqual(row('luna','ocr','corrupt').injected.missedFinal,['price'],'an echoing light reader is exposed, not hidden');
 assert.deepEqual(row('luna','ocr','clean').finalIncorrectIds,[]);
 assert.deepEqual(row('quality','review','corrupt').injected.ids,['p1']);
 assert.ok(result.rows.every(r=>Number.isFinite(r.wallMs)&&r.reasoningTasks.every(t=>Number.isFinite(t.durationMs))));
 assert.deepEqual(result.rows.filter(r=>r.stage==='ocr'&&r.fixture==='clean').map(r=>[r.repeat,r.profile]),[[1,'quality'],[1,'luna'],[2,'luna'],[2,'quality']],'order alternates');
 for(const p of['quality','luna'])assert.ok((await fs.readdir(path.join(out,'r1/corrupt',p,'ocr-cache'))).length>0);
 assert.equal(await fs.readFile(path.join(s.dir,'assets/price.json'),'utf8'),before);
 assert.ok(logs.every(l=>l.images.length===0),'no image calls');
 await assert.rejects(evaluate({...o,makeAi}),/Output exists/);
 assert.throws(()=>parseEvalArgs([`--run=x`,`--out=y`,'--profiles=quality,turbo']));
 assert.throws(()=>parseEvalArgs([`--run=x`,`--out=y`,'--profiles=quality','--variants=v.json']));
 // 2x2 separation of batching from model choice, without editing profile constants.
 const variants=[{name:'quality-batch1',profile:'quality',overrides:{ocrBatchSize:1,ocrParallel:3}},{name:'luna-single',profile:'luna',overrides:{ocrBatchSize:'all'}}];
 const v=await evaluate({run:s.dir,out:out+'-variants',variants,stages:['ocr'],makeAi});
 const calls=name=>v.rows.find(r=>r.profile===name).reasoningTasks.length;
 assert.deepEqual([calls('quality-batch1'),calls('luna-single')],[3,1]);
 assert.throws(()=>resolveVariants([{name:'x',profile:'quality',overrides:{imageEffort:'low'}}]),/Unknown variant override/);
});
