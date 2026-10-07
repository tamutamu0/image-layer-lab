// Compact review (stages.review.format==='compact'): bounded defect/action records instead of
// verbose repair paragraphs. Repair prompts are compiled locally from the records plus the asset
// identity; the imagegen wrapper still carries the full original target prompt. The persisted
// report keeps the legacy API (verdict, summary, strengths, limitations, repairs[], adjustments[]).
import fs from 'node:fs/promises';
import path from 'node:path';
import Ajv from 'ajv';
import {hash,readJSON} from './core.mjs';
import {saveJSON} from '../images.mjs';
import {ocrKey} from './ocr.mjs';
import {reviewInventory,reviewTree} from './review.mjs';
// Bump when the compact prompt/schema/normalization/confirmation policy changes (part of every key).
export const COMPACT_REVIEW_VERSION='designer-review-v9-compact-issues-2';
export const DEFECTS=['missing','halo','fragment','clipped','wrong_text','incomplete_hidden','misplaced','effect_strength','style_drift','other'];
// Whole-layer geometry/opacity cannot fix pixel defects such as halos or clipped strokes.
export const ADJUSTABLE=new Set(['misplaced','effect_strength','style_drift','other']);
export const NOTE_MAX=100,SUMMARY_MAX=240,ISSUES_MAX=8;
export const COMPACT_POLICY={format:'compact',adjustments:'bounded, unconfirmed, post-adjustment review required',regeneration:'strong confirmation unless OCR-confirmed wrong_text',ocr:'current OCR checks generated-to-plan text, never overrides source-image findings',final:'record-only; invalid output escalates once'};
const num={type:['number','null']};
const issueItem={type:'object',additionalProperties:false,required:['id','defect','severity','action','note','dx','dy','scale','opacity'],properties:{id:{type:'string'},defect:{type:'string',enum:DEFECTS},severity:{type:'string',enum:['high','medium']},action:{type:'string',enum:['regenerate','adjust']},note:{type:'string'},dx:num,dy:num,scale:num,opacity:num}};
const props={verdict:{type:'string',enum:['usable','needs_improvement']},summary:{type:'string'},issues:{type:'array',maxItems:ISSUES_MAX,items:issueItem}};
export const compactReviewSchema={type:'object',additionalProperties:false,required:Object.keys(props),properties:props};
const rejectedItem={type:'object',additionalProperties:false,required:['id','defect','note'],properties:{id:{type:'string'},defect:{type:'string',enum:DEFECTS},note:{type:'string'}}};
export const compactConfirmSchema={type:'object',additionalProperties:false,required:[...Object.keys(props),'rejected'],properties:{...props,rejected:{type:'array',maxItems:ISSUES_MAX*2,items:rejectedItem}}};
const ajv=new Ajv({strict:false,allErrors:true});
const checkReview=ajv.compile({...compactReviewSchema,additionalProperties:true}),checkConfirm=ajv.compile({...compactConfirmSchema,additionalProperties:true});
const clip=(t,n)=>{t=t.replace(/\s+/g,' ').trim();return t.length>n?t.slice(0,n-1)+'…':t;};
export const compactInventory=m=>reviewInventory(m).map((l,i)=>{const o=m.layers[i].opacity;return Number.isFinite(o)&&o!==1?{...l,opacity:o}:l;});

// Strict OCR evidence for the CURRENT generated text images only: the entry's cache key must
// match the asset record and the manifest layer must come from the same attempt. Anything else
// is ambiguous and never used to pre-confirm a finding.
export async function ocrEvidence(s,m){
 const text=await readJSON(path.join(s.dir,'text.json')),out=[];if(!text?.texts)return out;
 const strongRoute=!s.reasoning.stages.ocr.escalation;
 for(const l of m.layers.filter(l=>l.kind==='text')){
  const t=text.texts.find(t=>t?.id===l.id),a=await readJSON(path.join(s.dir,'assets',l.id+'.json'));
  if(!t||!a||typeof t.correct!=='boolean'||a.attempt!==l.attempt||t.cacheKey!==await ocrKey(s,a))continue;
  out.push({id:l.id,status:t.correct?'correct':'incorrect',text:t.text,expected:a.text,readBy:t.readBy??null,strong:t.readBy==='escalation'||strongRoute});
 }
 return out;
}
const ocrNote=ocr=>ocr.length?` Strict OCR of the current generated text images against the PLAN (not proof that the plan matches Image1; report wrong_text if source copy differs): ${JSON.stringify(ocr.map(o=>o.status==='correct'?{id:o.id,ocr:'correct'}:{id:o.id,ocr:'incorrect',read:o.text,expected:o.expected}))}.`:'';

const RULES=`Acceptance criterion: visually close and useful, properly separated for moving/hiding/replacing; pixel equality, original fonts and photographic texture recovery are NOT required. Medium-gray proof background is not a halo; do not invent issues from it. Check skinny product edges, clear holes, translucent haze, decorative borders, readable copy and price/type proportions. Return compact records only: one per asset+defect, note<=${NOTE_MAX} chars in English naming where/what is visibly wrong. action regenerate = whole-asset imagegen redo (slow, may add defects): severity high only when usability or visible resemblance suffers. action adjust = whole-layer move/scale/fade, only for ${[...ADJUSTABLE].join('/')}: dx/dy ORIGINAL PIXELS within 10% of the canvas, scale .8..1.2, opacity 0..1 absolute, null = unchanged; regenerate records set all four null. No masks, correction overlays, source-pixel restoration or color-threshold edges. Empty issues is correct when already useful. summary: Japanese, at most 2 short sentences.`;
const context=(m,ocr)=>`${ocrNote(ocr)} Layer inventory ${JSON.stringify(compactInventory(m))}. Actual exported hierarchy ${JSON.stringify(reviewTree(m))}.`;
const IMAGES='Image1 original, image2 recomposed generated layers, remaining images show ALL isolated generated assets on medium gray with their IDs.';
export const compactReviewPrompt=(m,ocr=[])=>`You review a GENERATION-FIRST ad layer tool for real Figma editing. ${IMAGES} ${RULES}${context(m,ocr)}`;
export const compactConfirmPrompt=(m,proposal,ocr=[])=>`You are the CONFIRMING senior reviewer of a GENERATION-FIRST ad layer tool for real Figma editing. ${IMAGES} ${proposal.invalid?`The first-pass reviewer output was invalid (${proposal.invalid}); perform the full review yourself and return rejected=[].`:`A faster first-pass reviewer proposed the regeneration records below. Verify each against visible evidence. issues = ONLY records you confirm (you may correct severity/note) plus any additional clearly visible usability-blocking defect (severity high); rejected = every unconfirmed proposal with a short note. acceptedAdjustments are bounded and already accepted; repeat one only to change its values.`} ${RULES} First-pass proposal ${JSON.stringify(proposal)}.${context(m,ocr)}`;

// Validates and normalizes one compact output. Throws on anything unsafe or contradictory
// (unknown asset, non-finite/out-of-bounds geometry, adjust for a pixel defect, conflicting
// adjustments); normalizes the harmless (long notes, regenerate geometry, duplicates, no-ops).
export function normalizeCompact(data,m,{width,height},{ocr=[],confirm=false}={}){
 const check=confirm?checkConfirm:checkReview;
 if(!check(data))throw Error('Invalid compact review shape: '+JSON.stringify(check.errors));
 const layers=new Map(m.layers.map(l=>[l.id,l])),evidence=new Map(ocr.map(o=>[o.id,o])),issues=[],omitted=[];
 for(const r of [...data.issues,...(confirm?data.rejected:[])])if(!layers.has(r.id))throw Error('Review refers to missing asset '+r.id);
 for(const raw of data.issues){
  const i={id:raw.id,defect:raw.defect,severity:raw.severity,action:raw.action,note:clip(raw.note,NOTE_MAX)};
  if(i.action==='adjust'){
   if(!ADJUSTABLE.has(i.defect))throw Error(`Unsafe geometry adjustment ${i.id}: ${i.defect} needs regeneration`);
   for(const k of['dx','dy','scale','opacity']){const v=raw[k];if(v===null)continue;if(!Number.isFinite(v))throw Error(`Unsafe geometry adjustment ${i.id}: ${k} not finite`);i[k]=v;}
   if(Math.abs(i.dx??0)>width*.1||Math.abs(i.dy??0)>height*.1||(i.scale??1)<.8||(i.scale??1)>1.2||(i.opacity??1)<0||(i.opacity??1)>1)throw Error('Unsafe geometry adjustment '+i.id);
  }
  const o=evidence.get(i.id);
  if(i.defect==='wrong_text'&&o?.status==='incorrect')i.ocr={text:o.text,expected:o.expected,strong:o.strong};
  const same=issues.find(x=>x.id===i.id&&x.defect===i.defect&&x.action===i.action);
  if(same){if(i.severity==='high')same.severity='high';if(i.note&&!same.note.includes(i.note))same.note=clip(same.note+'; '+i.note,NOTE_MAX*2);if(i.action==='adjust')mergeGeometry(same,i);}
  else issues.push(i);
 }
 // Several adjust records on one layer combine field-wise; contradictory values are invalid.
 const byLayer=new Map();for(const i of issues.filter(i=>i.action==='adjust'))mergeGeometry(byLayer.get(i.id)??byLayer.set(i.id,{id:i.id}).get(i.id),i);
 return{verdict:data.verdict,summary:clip(data.summary,SUMMARY_MAX),issues,omitted,...(confirm?{rejected:data.rejected.map(r=>({...r,note:clip(r.note,NOTE_MAX)}))}:{})};
}
function mergeGeometry(into,from){for(const k of['dx','dy','scale','opacity'])if(from[k]!==undefined){if(into[k]!==undefined&&into[k]!==from[k])throw Error('Conflicting geometry adjustments for '+from.id);into[k]=from[k];}}

const HINT={missing:'restore the missing visible parts',halo:'remove the source-background halo/matte; clean native alpha edges',fragment:'remove stray fragments of neighbouring elements',clipped:'complete the clipped strokes/edges inside the canvas',wrong_text:'render exactly the requested text',incomplete_hidden:'complete the plausible hidden/occluded parts',misplaced:'keep the object at its original position and scale',effect_strength:'match the subtle original effect strength',style_drift:'match the original colour and style',other:'fix the noted defect'};
// One targeted correction per asset: short evidence + identity; appended to the full target prompt by the wrapper.
export function repairPrompt(layer,issues){
 const wrong=issues.find(i=>i.ocr);
 return[`Reviewer-confirmed defects in ${layer.kind} asset ${layer.id} (${JSON.stringify(layer.name)})${layer.text?` with exact text ${JSON.stringify(layer.text)}`:''}: ${issues.map(i=>HINT[i.defect]+(i.note?` (${i.note})`:'')).join('; ')}.`,
  wrong?`The current image was transcribed as ${JSON.stringify(wrong.ocr.text)}; regenerate ONLY the exact requested text ${JSON.stringify(wrong.ocr.expected)} with no extra fragments or missing punctuation.`:'',
  'Fix only these; keep the identity, position, scale, colours and style of the reference. Visually close is enough: no pixel-exact copying, no added outlines, overlays or mattes.'].filter(Boolean).join(' ');
}
// Actionable regeneration records, mirroring actionableRepairs()/isActionable({highOnly}).
export function actionableIssues(e,{highOnly=false}={}){const regen=e.issues.filter(i=>i.action==='regenerate'),high=regen.filter(i=>i.severity==='high');return high.length||highOnly?high:e.verdict==='needs_improvement'?regen:[];}
// OCR already escalated/strict-read this text as wrong: the reread is the strong confirmation.
export const ocrConfirmed=i=>i.action==='regenerate'&&i.defect==='wrong_text'&&i.ocr?.strong===true;

// Legacy-compatible report from normalized issues; findings keep the structured records.
export function toReport({verdict,summary,issues,omitted=[],recorded=[]},m){
 omitted=[...omitted];const layers=new Map(m.layers.map(l=>[l.id,l])),repairs=[],adjustments=[];
 for(const id of new Set(issues.filter(i=>i.action==='regenerate').map(i=>i.id))){const list=issues.filter(i=>i.id===id&&i.action==='regenerate');repairs.push({id,priority:list.some(i=>i.severity==='high')?'high':'medium',reason:clip(list.map(i=>i.note||i.defect).join('; '),NOTE_MAX*2),prompt:repairPrompt(layers.get(id),list),defects:list.map(i=>i.defect)});}
 repairs.sort((a,b)=>(a.priority==='high'?0:1)-(b.priority==='high'?0:1));
 for(const id of new Set(issues.filter(i=>i.action==='adjust').map(i=>i.id))){
  const list=issues.filter(i=>i.id===id&&i.action==='adjust'),g={};list.forEach(i=>mergeGeometry(g,i));
  const current=layers.get(id).opacity??1,a={id,dx:g.dx??0,dy:g.dy??0,scale:g.scale??1,opacity:g.opacity??current,reason:clip(list.map(i=>i.note||i.defect).join('; '),NOTE_MAX*2),defects:list.map(i=>i.defect)};
  if(a.dx===0&&a.dy===0&&a.scale===1&&a.opacity===current){omitted.push({...list[0],reason:'no-op adjustment'});continue;}
  adjustments.push(a);
 }
 const limitations=[...recorded,...omitted].slice(0,3).map(i=>clip(`${i.id} ${i.defect}: ${i.reason??i.note}`,NOTE_MAX*2));
 return{verdict,summary,strengths:[],limitations,repairs,adjustments,findings:{format:'compact',issues,omitted,recorded}};
}

// Same contract as review(): primary reviews everything; ONE strong confirmation only for
// actionable regeneration (or invalid output, even when final). Bounded adjustments are never
// strong-confirmed but are flagged for the mandatory post-adjustment review.
export async function reviewCompact(s,{m,composite,sheets,final=false,highOnly=false}){
 const st=s.reasoning.stages.review,escalation=st.confirm!=='never'?st.escalation:null,confirmRoute=final?null:escalation;
 const ocr=await ocrEvidence(s,m),images=[s.source,composite,...sheets];
 const content=hash(JSON.stringify({version:COMPACT_REVIEW_VERSION,source:s.sourceHash,composite:hash(await fs.readFile(composite)),sheets:await Promise.all(sheets.map(async f=>hash(await fs.readFile(f)))),inventory:compactInventory(m),tree:reviewTree(m),ocr}));
 const routes={primary:await s.routeKey(st.primary),confirm:await s.routeKey(escalation),confirmPolicy:confirmRoute?st.confirm:final&&escalation?'invalid-output-only':null,repairPolicy:highOnly?'high-only':'actionable',compactPolicy:COMPACT_POLICY,final,highOnly};
 const signature=hash(JSON.stringify({content,routes})),cacheFile=path.join(s.dir,'reviews',signature+'.json'),cache=await readJSON(cacheFile);
 s.timeline.cache('review',signature.slice(0,8),cache?.signature===signature);if(cache?.signature===signature){await saveJSON(path.join(s.dir,'review.json'),cache);return cache;}
 const tag=signature.slice(0,8),strong=async proposal=>normalizeCompact(JSON.parse((await s.reason('review','05-designer-review-compact-confirm-'+tag,compactConfirmPrompt(m,proposal,ocr),{images,schema:compactConfirmSchema},escalation)).result.text),m,s,{ocr,confirm:true});
 const first=await s.reason('review','05-designer-review-compact-'+tag,compactReviewPrompt(m,ocr),{images,schema:compactReviewSchema},st.primary);
 let primary=null,problem=null;try{primary=normalizeCompact(JSON.parse(first.result.text),m,s,{ocr});}catch(e){problem=e.message;}
 if(problem&&!escalation)throw Error(problem);
 const adjusts=primary?.issues.filter(i=>i.action==='adjust')??[],regen=primary?.issues.filter(i=>i.action==='regenerate')??[];
 const actionable=primary?actionableIssues(primary,{highOnly}):[],pre=actionable.filter(ocrConfirmed),unconfirmed=actionable.filter(i=>!ocrConfirmed(i));
 const trigger=problem?'invalid primary output':confirmRoute&&unconfirmed.length?'actionable regeneration':confirmRoute&&st.confirm==='always'?'policy always':null;
 let report,confirmation;
 if(!trigger){
  report=toReport(primary,m);
  const status=final?'skipped: record-only review':!st.escalation?'unavailable: no escalation route':st.confirm==='never'?'disabled by profile':pre.length?'not needed: regeneration confirmed by strict OCR':'not needed: no actionable regeneration';
  confirmation={status,ocrConfirmed:pre.map(i=>i.id),recall:st.escalation&&!final?'A clear primary review is accepted unconfirmed; this reviewer\'s recall of missed defects is unmeasured.':undefined};
 }else if(problem){
  const second=await strong({invalid:problem});
  report=toReport(second,m);confirmation={status:'confirmed',trigger,rejected:second.rejected};
 }else{
  const sent=st.confirm==='always'?regen.filter(i=>!ocrConfirmed(i)):unconfirmed,brief=i=>({id:i.id,defect:i.defect,severity:i.severity,note:i.note});
  const second=await strong({verdict:primary.verdict,issues:sent.map(brief),acceptedAdjustments:adjusts.map(i=>({...brief(i),dx:i.dx??null,dy:i.dy??null,scale:i.scale??null,opacity:i.opacity??null}))});
  // Strong adjust records for a layer replace the primary's; unsent primary regeneration is record-only.
  const strongAdjusted=new Set(second.issues.filter(i=>i.action==='adjust').map(i=>i.id));
  const recorded=regen.filter(i=>!sent.includes(i)&&!pre.includes(i)).map(i=>({...i,reason:'not actionable; not confirmed'}));
  report=toReport({verdict:second.verdict,summary:second.summary,issues:[...pre,...second.issues.filter(i=>!pre.some(p=>p.id===i.id&&p.defect===i.defect)),...adjusts.filter(i=>!strongAdjusted.has(i.id))],omitted:[...primary.omitted,...second.omitted],recorded},m);
  confirmation={status:'confirmed',trigger,proposed:sent.length,rejected:second.rejected,ocrConfirmed:pre.map(i=>i.id)};
 }
 const requiresPostAdjustmentReview=!final&&report.adjustments.length>0;
 confirmation.adjustments=report.adjustments.length?{status:'bounded adjustments need no strong confirmation',requiresPostAdjustmentReview,ids:report.adjustments.map(a=>a.id)}:undefined;
 const out={...report,requiresPostAdjustmentReview,signature,routes,...(trigger?{primaryReview:primary??{error:problem}}:{}),confirmation};
 await saveJSON(path.join(s.dir,'review.json'),out);await saveJSON(cacheFile,out);return out;
}
