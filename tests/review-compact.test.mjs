import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {resolveReasoning,MODEL_CANDIDATES} from '../src/separation/routing.mjs';
import {generate,runFast} from '../src/separation/run.mjs';
import {build} from '../src/separation/build.mjs';
import {review,actionableRepairs,isActionable} from '../src/separation/review.mjs';
import {normalizeCompact,toReport,repairPrompt,compactReviewSchema,compactConfirmSchema,DEFECTS} from '../src/separation/review-compact.mjs';
import {setupFake,byId,GLOBAL} from './helpers/fake-ai.mjs';
const{sol:SOL,luna:LUNA}=MODEL_CANDIDATES;
const read=async(s,f)=>JSON.parse(await fs.readFile(path.join(s.dir,f),'utf8'));
const compact=(name='luna')=>{const r=resolveReasoning(name);r.stages.review.format='compact';return r;};
const jobs=[['bg','background'],['h1','text','A'],['p1','product'],['p2','product'],['p3','product']];
const I=(id,defect,o={})=>({id,defect,severity:'high',action:'regenerate',note:'',dx:null,dy:null,scale:null,opacity:null,...o});
const C=(issues=[],o={})=>({verdict:issues.length?'needs_improvement':'usable',summary:'',issues,...o});
const CF=(issues=[],rejected=[],o={})=>({...C(issues,o),rejected});
// Generated assets + OCR + real preview build, then the real review(); prompts are captured.
async function setup(t,reasoning,reviewFn,o={}){
 const{s,log}=await setupFake(t,{reasoning,jobs,review:reviewFn,...o});
 await generate(s,{repairText:false});await build(s,{partial:true});
 const base=s.ai.ai;log.prompts=[];s.ai.ai=async(stage,prompt,opts)=>{if(stage.startsWith('05-'))log.prompts.push(prompt);return base(stage,prompt,opts);};
 return{s,log};
}
const M={layers:[{id:'bg',kind:'background',name:'bg'},{id:'h1',kind:'text',name:'見出し',text:'3,278円'},{id:'p1',kind:'product',name:'bottle',opacity:.5},{id:'e1',kind:'effect',name:'glow'}]},S={width:200,height:100};

test('compact: normalization keeps records bounded and compiles legacy repairs/adjustments',()=>{
 const long='x'.repeat(300);
 const n=normalizeCompact(C([I('h1','clipped',{note:long,dx:5}),I('h1','clipped',{severity:'medium',note:'right edge'}),I('h1','halo',{severity:'medium',note:'gray matte'}),I('p1','misplaced',{action:'adjust',severity:'medium',dx:-4,note:'too low'}),I('e1','effect_strength',{action:'adjust',severity:'medium',opacity:.6}),I('e1','misplaced',{action:'adjust',severity:'medium',dy:2})],{summary:long}),M,S);
 assert.equal(n.issues.filter(i=>i.id==='h1').length,2,'duplicate id+defect merged');
 const h=n.issues.find(i=>i.defect==='clipped');assert.equal(h.severity,'high');assert.ok(h.note.length<=200);assert.equal(h.dx,undefined,'regenerate geometry dropped');assert.ok(n.summary.length<=240);
 const r=toReport(n,M);
 assert.deepEqual(Object.keys(r).slice(0,6),['verdict','summary','strengths','limitations','repairs','adjustments']);
 assert.deepEqual(r.repairs.map(x=>[x.id,x.priority,x.defects]),[['h1','high',['clipped','halo']]]);
 assert.match(r.repairs[0].prompt,/text asset h1 .*exact text "3,278円".*clipped strokes.*halo/);
 assert.deepEqual(r.adjustments.map(a=>[a.id,a.dx,a.dy,a.scale,a.opacity]),[['p1',-4,0,1,.5],['e1',0,2,1,.6]],'null keeps current opacity; records on one layer combine');
 assert.deepEqual(actionableRepairs(r).map(x=>x.id),['h1']);assert.ok(isActionable(r,{highOnly:true}));
 assert.equal(r.findings.format,'compact');
 // OCR generated-to-plan agreement cannot suppress a source-copy mismatch.
 const ocr=[{id:'h1',status:'correct',text:'3,278円',expected:'3,278円',strong:true}];
 const f=normalizeCompact(C([I('h1','wrong_text',{note:'reads 3,27B'}),I('h1','clipped')]),M,S,{ocr});
 assert.deepEqual(f.issues.map(i=>i.defect),['wrong_text','clipped']);assert.equal(f.omitted.length,0);
 const w=normalizeCompact(C([I('h1','wrong_text')]),M,S,{ocr:[{...ocr[0],status:'incorrect',text:'3,27B'}]});
 assert.match(repairPrompt(M.layers[1],w.issues),/transcribed as "3,27B".*exact requested text "3,278円"/);
 assert.ok(DEFECTS.includes('incomplete_hidden'));assert.equal(compactReviewSchema.properties.issues.items.required.length,9);assert.ok(compactConfirmSchema.required.includes('rejected'));
});

test('compact: unsafe or contradictory records are invalid, harmless ones are normalized',()=>{
 const bad=[[I('ghost','halo')],[I('p1','misplaced',{action:'adjust',scale:1.5})],[I('p1','misplaced',{action:'adjust',dx:21})],[I('p1','misplaced',{action:'adjust',opacity:-.1})],[I('p1','misplaced',{action:'adjust',dx:Infinity})],
  [I('p1','halo',{action:'adjust',dx:1})],[I('p1','misplaced',{action:'adjust',dx:1}),I('p1','other',{action:'adjust',dx:2})],Array.from({length:9},()=>I('p1','halo'))];
 for(const issues of bad)assert.throws(()=>normalizeCompact(C(issues),M,S),/missing asset|Unsafe geometry|Conflicting|shape/,JSON.stringify(issues[0]));
 assert.throws(()=>normalizeCompact({...C(),issues:[{...I('p1','halo'),defect:'blurry'}]},M,S),/shape/);
 assert.throws(()=>normalizeCompact(C(),M,S,{confirm:true}),/shape/,'confirm output needs rejected');
 assert.throws(()=>normalizeCompact(CF([],[{id:'ghost',defect:'halo',note:''}]),M,S,{confirm:true}),/missing asset ghost/);
 const noop=toReport(normalizeCompact(C([I('p1','misplaced',{action:'adjust',severity:'medium'})]),M,S),M);
 assert.equal(noop.adjustments.length,0);assert.equal(noop.findings.omitted[0].reason,'no-op adjustment');
});

test('compact: adjustment-only proposals are applied without strong confirmation and flagged for post-adjustment review',async t=>{
 const{s,log}=await setup(t,compact(),()=>C([I('p2','misplaced',{action:'adjust',severity:'medium',dx:3,note:'2px low'})],{verdict:'usable'}));
 const r=await review(s);
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false]]);
 assert.match(log.reviews[0].stage,/compact/);assert.match(log.prompts[0],/Medium-gray proof background is not a halo/);assert.match(log.prompts[0],/pixel equality.*NOT required/);assert.match(log.prompts[0],/Strict OCR.*"h1","ocr":"correct"/);
 assert.deepEqual(r.adjustments.map(a=>[a.id,a.dx]),[['p2',3]]);assert.equal(r.requiresPostAdjustmentReview,true);
 assert.match(r.confirmation.status,/not needed/);assert.equal(r.confirmation.adjustments.requiresPostAdjustmentReview,true);
 assert.deepEqual(await read(s,'review.json'),JSON.parse(JSON.stringify(r)));
});

test('compact: actionable regeneration gets ONE strong confirmation; rejected proposals never reach imagegen',async t=>{
 let{s,log}=await setup(t,compact(),c=>c.confirm?CF([],[{id:'p1',defect:'halo',note:'gray proof only'}]):C([I('p1','halo',{note:'white rim'}),I('p3','style_drift',{severity:'medium',note:'warmer'}),I('p2','effect_strength',{action:'adjust',severity:'medium',opacity:.7})]));
 let r=await review(s);
 assert.deepEqual(log.reviews.map(c=>[c.model,c.effort,c.confirm]),[[LUNA,'low',false],[SOL,'high',true]]);
 const proposal=JSON.parse(log.prompts[1].slice(log.prompts[1].indexOf('First-pass proposal ')+20,log.prompts[1].indexOf('. Strict OCR')));
 assert.deepEqual(proposal.issues.map(i=>i.id),['p1'],'only high regeneration is sent; medium is record-only');
 assert.deepEqual(proposal.acceptedAdjustments.map(i=>[i.id,i.opacity]),[['p2',.7]]);
 assert.deepEqual(r.repairs,[]);assert.deepEqual(r.adjustments.map(a=>a.id),['p2'],'bounded adjustment kept without confirmation');
 assert.equal(r.confirmation.trigger,'actionable regeneration');assert.equal(r.confirmation.rejected[0].id,'p1');assert.equal(r.primaryReview.issues.length,3);
 assert.deepEqual(r.findings.recorded.map(i=>i.id),['p3']);
 // Confirmed through the real runner: the compiled prompt drives exactly one bounded repair.
 ({s,log}=await setupFake(t,{reasoning:compact(),jobs,review:(c,n)=>n===1?C([I('p1','halo',{note:'white rim left side'})]):c.confirm?CF([I('p1','halo',{note:'white rim confirmed'})]):C()}));
 await runFast(s,{deps:{register:async()=>{},build:async(x,o={})=>o.partial?build(x,o):{ok:true}}});
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false],[SOL,true],[LUNA,false]]);assert.equal(byId(log,'p1').length,2);
 const rec=await read(s,'assets/p1.json');assert.match(rec.repair,/^Reviewer-confirmed defects in product asset p1 .*halo.*white rim confirmed/);
});

test('compact: source mismatch survives OCR agreement; OCR-confirmed wrong text needs no duplicate confirmation',async t=>{
 let{s,log}=await setup(t,compact(),c=>c.confirm?CF([I('h1','clipped',{note:'A crossbar cut'})]):C([I('h1','wrong_text',{note:'looks like 4'}),I('h1','clipped',{note:'A crossbar cut'})]));
 let r=await review(s);
 assert.equal(log.reviews.length,2);assert.match(log.prompts[1].slice(log.prompts[1].indexOf('First-pass proposal')),/wrong_text"/,'source mismatch must still be confirmed');
 assert.deepEqual(r.repairs.map(x=>[x.id,x.defects]),[['h1',['clipped']]]);assert.equal(r.findings.omitted.length,0);
 // OCR (escalated strict reread) says incorrect: wrong_text is acted on without a second strong review.
 ({s,log}=await setup(t,compact(),c=>c.confirm?assert.fail('no confirmation'):C([I('h1','wrong_text',{note:'B instead of A'})]),{transcribe:a=>({text:a.id==='h1'?'B':a.expected,correct:true})}));
 r=await review(s);
 assert.deepEqual(log.ocr.filter(c=>c.ids.includes('h1')).map(c=>c.model),[LUNA,SOL]);assert.equal(log.reviews.length,1);
 assert.match(r.confirmation.status,/strict OCR/);assert.deepEqual(r.confirmation.ocrConfirmed,['h1']);
 assert.match(r.repairs[0].prompt,/transcribed as "B".*exact requested text "A"/);
 // Stale/absent OCR evidence is ambiguous: the finding goes through normal confirmation.
 ({s,log}=await setup(t,compact(),c=>c.confirm?CF([],[{id:'h1',defect:'wrong_text',note:'reads fine'}]):C([I('h1','wrong_text')])));
 await fs.rm(path.join(s.dir,'text.json'));r=await review(s);
 assert.equal(log.reviews.length,2);assert.deepEqual(r.repairs,[]);
});

test('compact: invalid output escalates once to the strong route with full context, then fails; quality keeps V7 failure',async t=>{
 let{s,log}=await setup(t,compact(),c=>c.confirm?CF([I('p2','misplaced',{action:'adjust',severity:'medium',dx:4})]):C([I('p2','misplaced',{action:'adjust',dx:999})]));
 let r=await review(s);
 assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[LUNA,false],[SOL,true]]);
 assert.match(log.prompts[1],/output was invalid \(Unsafe geometry adjustment p2\)/);assert.match(log.prompts[1],/Layer inventory/);
 assert.equal(r.confirmation.trigger,'invalid primary output');assert.match(r.primaryReview.error,/Unsafe geometry/);assert.deepEqual(r.adjustments.map(a=>a.dx),[4]);
 ({s,log}=await setup(t,compact(),c=>c.confirm?CF([I('p2','halo',{action:'adjust',dx:1})]):'not json'));
 await assert.rejects(review(s),/Unsafe geometry adjustment p2/);assert.equal(log.reviews.length,2,'bounded to one escalation');
 ({s,log}=await setup(t,compact(),()=>C([I('ghost','halo')])));
 s.reasoning.stages.review.escalation=null;await assert.rejects(review(s),/missing asset ghost/);assert.equal(log.reviews.length,1);
 ({s,log}=await setup(t,compact('quality'),()=>C([I('p1','halo')])));
 r=await review(s);assert.deepEqual(log.reviews.map(c=>[c.model,c.confirm]),[[GLOBAL,false]]);assert.deepEqual(r.repairs.map(x=>x.id),['p1'],'no escalation route: primary acts directly (V7 parity)');
});

test('compact: final review is record-only (invalid output alone escalates) and reviews are content-cached',async t=>{
 const{s,log}=await setup(t,compact(),c=>c.confirm?CF():C([I('p1','halo')]));
 let r=await review(s,{final:true});
 assert.equal(log.reviews.length,1);assert.match(r.confirmation.status,/record-only/);assert.equal(r.routes.confirmPolicy,'invalid-output-only');assert.equal(r.requiresPostAdjustmentReview,false);
 assert.deepEqual(await review(s,{final:true}),JSON.parse(JSON.stringify(r)),'warm cache');assert.equal(log.reviews.length,1);
 r=await review(s);assert.equal(log.reviews.length,3,'final/actionable policies never share a key');assert.equal(r.repairs.length,0);
 await review(s);assert.equal(log.reviews.length,3);
 await review(s,{highOnly:true});assert.equal(log.reviews.length,5,'highOnly is part of the key');
 // OCR evidence is part of the key.
 const text=await read(s,'text.json');text.texts[0].correct=false;await fs.writeFile(path.join(s.dir,'text.json'),JSON.stringify(text));
 const n=log.reviews.length;r=await review(s,{final:true});assert.ok(log.reviews.length>n);
 // Invalid final output: one strong call even though findings are not confirmed.
 const x=await setup(t,compact(),c=>c.confirm?CF([I('p1','halo')]):'garbage');
 r=await review(x.s,{final:true});assert.deepEqual(x.log.reviews.map(c=>c.confirm),[false,true]);assert.equal(r.confirmation.trigger,'invalid primary output');
});

test('compact format is opt-in: the legacy review path and schema are unchanged otherwise',async t=>{
 const R={verdict:'usable',summary:'',strengths:[],limitations:[],repairs:[],adjustments:[]};
 const{s,log}=await setup(t,resolveReasoning('luna'),()=>R);
 const r=await review(s);assert.doesNotMatch(log.reviews[0].stage,/compact/);assert.equal(r.findings,undefined);assert.match(log.prompts[0],/Propose only concrete meaningful fixes/);
});
