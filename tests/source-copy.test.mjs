import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {copyDisagreement,reconcileSourceCopy,readSourceCopy,reconcileReviewedCopy,novelNumericPatches} from '../src/separation/source-copy.mjs';
import {setupFake} from './helpers/fake-ai.mjs';
const p=texts=>({jobs:texts.map((text,i)=>({id:'t'+i,kind:'text',text,visibleBbox:[0,i*100,500,100]}))});
const c=texts=>({texts:texts.map(text=>({text,bbox:[0,0,500,100]}))});
test('source-copy audit catches omitted punctuation and swapped digits, allowing different line grouping',()=>{
 assert.equal(copyDisagreement(p(['30日ごとに1本お届け']),c(['30日ごとに1本お届け。'])).different,true);
 assert.equal(copyDisagreement(p(['3,278円']),c(['3,287円'])).different,true);
 assert.equal(copyDisagreement(p(['定期\n初回','3,278円']),c(['定期初回','3,278','円'])).different,false);
});

test('unverified numeric changes require a stronger independent source read before patching',async()=>{
 const plan=p(['3,278円']),copy=c(['3,278円']);assert.equal(novelNumericPatches(plan,copy,[{id:'t0',text:'9,999円'}]).length,1);
 const routes=[],s={dir:'/tmp',source:'/tmp/source.png',reasoning:{stages:{plan:{primary:{effort:'low'},escalation:{effort:'high'}}}},reason:async(_id,_stage,_prompt,_options,route)=>{routes.push(route.effort);return{result:{text:JSON.stringify({patches:route.effort==='low'?[{id:'t0',text:'9,999円'}]:[],unresolved:false,note:'Original is 3,278.'})}}}};
 const r=await reconcileSourceCopy(s,plan,copy,{force:true});assert.deepEqual(routes,['low','high']);assert.equal(r.plan.jobs[0].text,'3,278円');assert.ok(r.audit.numericEscalation);assert.equal(r.audit.residual.different,false);
});

test('copy preserved as artwork is accepted and recorded rather than aborting a valid plan',async()=>{
 const plan={jobs:[{id:'logo',kind:'decoration',name:'ブランドロゴ',text:'',visibleBbox:[0,0,500,100]},...p(['3,278円']).jobs]};
 const s={dir:'/tmp',source:'/tmp/source.png',reasoning:{stages:{plan:{primary:{}}}},reason:async()=>({result:{text:JSON.stringify({patches:[],representedBy:[{jobId:'logo',sourceText:'EXAMPLE'}],unresolved:false,note:'Logo is preserved in artwork.'})}})};
 const r=await reconcileSourceCopy(s,plan,c(['EXAMPLE','3,278円']));assert.equal(r.audit.residual.different,false);assert.equal(r.audit.representedBy[0].jobId,'logo');
 assert.equal(copyDisagreement({...plan,jobs:plan.jobs.map(j=>j.id==='logo'?{...j,text:'EXAMPLE'}:j)},c(['EXAMPLE','3,278円'])).different,false);
});

test('confirmed source-copy error updates the plan and repair target before regenerating the image',async t=>{
 const {s}=await setupFake(t,{reasoning:'accelerated',jobs:[['bg','background'],['h','text','お届け'],['p1','product'],['p2','product'],['p3','product']]});
 s.reason=async(_id,stage)=>({result:{text:JSON.stringify(stage==='00-source-copy-audit'?c(['お届け。']):{patches:[{id:'h',text:'お届け。'}],representedBy:[],unresolved:false,note:'Source has a final period.'})}});
 const r=await reconcileReviewedCopy(s,{findings:{issues:[{id:'h',action:'regenerate',defect:'wrong_text',note:'Period missing'}]},repairs:[{id:'h',reason:'Period missing',prompt:'Render wrong old target'}]});
 assert.equal(s.planData.jobs.find(j=>j.id==='h').text,'お届け。');assert.match(r.repairs[0].prompt,/ONLY exact text "お届け。"/);assert.doesNotMatch(r.repairs[0].prompt,/wrong old target/);
 const saved=JSON.parse(await fs.readFile(path.join(s.dir,'plan.json')));assert.equal(saved.jobs.find(j=>j.id==='h').text,'お届け。');
});

test('malformed independent copy output requests direct source reconciliation instead of discarding the completed plan',async t=>{
 const {s}=await setupFake(t,{reasoning:'accelerated'});s.reason=async()=>({result:{text:'not json'}});
 const r=await readSourceCopy(s);assert.equal(r.texts.length,0);assert.match(r.invalid,/malformed/);
});
test('source-copy discrepancies are decided against source; lighter read cannot silently replace numbers',async()=>{
 let calls=0;const s={dir:'/tmp',source:'/tmp/source.png',reasoning:{stages:{plan:{primary:{model:'gpt-6.1-sol',effort:'low'}}}},reason:async()=>{calls++;return{result:{text:JSON.stringify({patches:[],unresolved:false,note:'The source is 3,278.'})}}}};
 const r=await reconcileSourceCopy(s,p(['3,278円']),c(['3,287円']));assert.equal(calls,1);assert.equal(r.plan.jobs[0].text,'3,278円');
 s.reason=async()=>({result:{text:JSON.stringify({patches:[{id:'t0',text:'30日ごとに1本お届け。'}],unresolved:false,note:'Restore visible punctuation.'})}});
 assert.equal((await reconcileSourceCopy(s,p(['30日ごとに1本お届け']),c(['30日ごとに1本お届け。']))).plan.jobs[0].text,'30日ごとに1本お届け。');
 s.reason=async()=>({result:{text:JSON.stringify({patches:[],unresolved:true,note:'Missing entire unit.'})}});
 await assert.rejects(reconcileSourceCopy(s,p(['3,278円']),c(['3,278円','税込'])),/not fully represented/);
});
