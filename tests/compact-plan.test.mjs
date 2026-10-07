import test from 'node:test';
import assert from 'node:assert/strict';
import {expandCompactPlan,COMPACT_PLAN_VERSION} from '../src/separation/compact-plan.mjs';
import {planDiagnostics} from '../src/separation/plan.mjs';
import {parseOptions} from '../src/separation/options.mjs';
import {setupFake} from './helpers/fake-ai.mjs';
const input=()=>({title:'広告',groups:[{n:'背景',r:'background',p:-1},{n:'商品',r:'product',p:-1},{n:'コピー',r:'headline',p:-1}],jobs:[
 {n:'背景',k:'background',g:0,b:[0,0,1000,1000],v:[0,0,1000,1000],t:'',h:'Warm cream photograph.',o:true,r:false},
 {n:'商品',k:'product',g:1,b:[500,-50,300,1100],v:[500,0,300,800],t:'',h:'White serum bottle, silver cap, hidden base behind CTA.',o:true,r:false},
 {n:'光',k:'effect',g:1,b:[450,0,400,1000],v:[450,0,400,1000],t:'',h:'Soft violet aura.',o:false,r:false},
 {n:'価格',k:'text',g:2,b:[0,800,500,100],v:[0,800,500,100],t:'3,520円',h:'Gold numeral and smaller yen.',o:false,r:false},
 {n:'見出し',k:'text',g:2,b:[0,100,500,200],v:[0,100,500,200],t:'泡立てない。',h:'Dark brown serif.',o:false,r:false}
]});
test('compact planning preserves AI boxes, copy, overlap, distinct effects and semantic groups',()=>{
 const raw=input(),p=expandCompactPlan(raw);assert.equal(p.jobs.length,5);assert.equal(p.jobs[3].text,'3,520円');assert.deepEqual(p.jobs[1].bbox,raw.jobs[1].b);assert.equal(p.jobs[1].occluded,true);
 assert.equal(p.groups[1].parent,'root');assert.equal(p.jobs[2].kind,'effect');assert.match(p.jobs[1].prompt,/silver cap/);assert.match(p.jobs[1].prompt,/packaging lettering/);
 assert.deepEqual(planDiagnostics(p).defects,[]);assert.match(COMPACT_PLAN_VERSION,/v9/);
});
test('compact planning rejects invalid parent/copy without inventing missing semantic data',()=>{
 const raw=input();raw.groups[1].p=1;assert.throws(()=>expandCompactPlan(raw),/group tree/);
 const empty=input();empty.jobs[3].t='';assert.throws(()=>expandCompactPlan(empty),/Missing text/);
 const hint=input();hint.jobs[1].h='x'.repeat(181);assert.throws(()=>expandCompactPlan(hint),/compact plan/);
});
test('compact planner records compiler provenance and source-aligned instructions',async t=>{
 const {s,log}=await setupFake(t,{reasoning:'balanced',plan:()=>input()});s.reasoning.stages.plan.format='compact';const p=await s.plan();assert.equal(log.plans.length,1);assert.equal(p.planning.compilerVersion,COMPACT_PLAN_VERSION);assert.equal(p.planning.attempts[0].format,'compact');
 const first=p;await s.plan();assert.deepEqual(s.planData,first);assert.equal(log.plans.length,1,'reuses accepted plan');
});
test('CLI accepts explicit compact/full formats and overlap policy without changing image effort',()=>{
 const args=['--input=a','--out=b','--plan-format=compact','--review-format=compact','--execution=overlap'];const o=parseOptions(args,{});assert.equal(o.reasoning.stages.plan.format,'compact');assert.equal(o.execution,'overlap');assert.equal(o.effort.image,'low');assert.throws(()=>parseOptions(['--input=a','--out=b','--plan-format=wrong'],{}),/format/);
});

test('accelerated planning overlaps independent source-copy read and drains both before accepting',async t=>{
 const {s}=await setupFake(t,{reasoning:'accelerated'});let active=0,peak=0;
 s.ai.ai=async stage=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,stage==='00-source-copy-audit'?10:30));active--;
  const data=stage==='00-source-copy-audit'?{texts:input().jobs.filter(j=>j.k==='text').map(j=>({text:j.t,bbox:j.b}))}:input();return{result:{text:JSON.stringify(data)}};
 };
 const p=await s.plan();assert.equal(peak,2);assert.equal(active,0);assert.equal(p.planning.sourceCopyAudit.status,'independent copy agrees');
});
