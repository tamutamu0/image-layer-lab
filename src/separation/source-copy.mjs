import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import Ajv from 'ajv';
import {saveJSON} from '../images.mjs';
export const SOURCE_COPY_VERSION='source-copy-v2';
const box={type:'array',items:{type:'number'},minItems:4,maxItems:4};
export const sourceCopySchema={type:'object',additionalProperties:false,required:['texts'],properties:{texts:{type:'array',minItems:1,maxItems:45,items:{type:'object',additionalProperties:false,required:['text','bbox'],properties:{text:{type:'string'},bbox:box}}}}};
const check=new Ajv({strict:false}).compile(sourceCopySchema);
const norm=t=>t.normalize('NFKC').replace(/\s/g,'');
const bag=t=>[...norm(t)].sort().join('');
// Different line/group boundaries are permitted; punctuation/digits are not dropped.
export function copyDisagreement(plan,copy){
 const texts=plan.jobs.filter(j=>j.text?.trim()).map(j=>j.text),source=(copy.texts??[]).map(t=>t.text);
 const a=texts.join(''),b=source.join('');
 const missing=texts.filter(t=>!norm(b).includes(norm(t)));
 return{different:bag(a)!==bag(b)||missing.length>0,planTexts:texts,sourceTexts:source,missing};
}
export async function readSourceCopy(s){
 await fs.mkdir(path.join(s.dir,'inspection'),{recursive:true});
 const footer=path.join(s.dir,'inspection','source-footer.png'),top=Math.floor(s.height*.8);
 await sharp(s.source).extract({left:0,top,width:s.width,height:s.height-top}).png().toFile(footer);
 const route=s.reasoning.stages.ocr.primary;
 const {result}=await s.reason('source-copy','00-source-copy-audit',`Independently transcribe ALL visible advertising copy from Image1, a ${s.width}x${s.height} banner. Image2 is a zoom of the bottom 20% of Image1, solely to read small legal copy; never duplicate its text. Exclude lettering printed ON product packaging and separate CTA arrow/icon graphics (they are separate decoration layers). Keep punctuation and footnote markers. Preserve exact digits, punctuation, suffixes, legal notes and brand copy. Read the image, do not invent or correct marketing copy. Each text can be a semantic unit or line. bbox is its approximate xywh in normalized 0..1000 coordinates of Image1. Return only text+bbox, no style or commentary.`,{images:[s.source,footer],schema:sourceCopySchema},route);
 let copy;try{copy=JSON.parse(result.text);if(!check(copy))throw Error('Invalid shape');}catch{copy={texts:[],invalid:'Independent read malformed; require direct source reconciliation.'};}
 await saveJSON(path.join(s.dir,'source-copy.json'),{...copy,version:SOURCE_COPY_VERSION});return copy;
}
// Any independent discrepancy is decided against the SOURCE by Sol, not silently
// patched from the lighter OCR. This runs before imagegen, avoiding expensive redos.
export const numericTokens=t=>norm(t).match(/[0-9]+(?:[,.][0-9]+)*|[%¥￥円]/g)??[];
export function novelNumericPatches(plan,copy,patches){const allowed=new Set([...plan.jobs.map(j=>j.text??''),...(copy.texts??[]).map(t=>t.text)].flatMap(numericTokens));return patches.filter(p=>numericTokens(p.text).some(t=>!allowed.has(t)));}
export async function reconcileSourceCopy(s,plan,copy,{force=false,notes=[]}={}){
 const difference=copyDisagreement(plan,copy);if(!force&&!copy.invalid&&!difference.different)return{plan,audit:{status:'independent copy agrees',version:SOURCE_COPY_VERSION}};
 const ids=plan.jobs.filter(j=>j.kind==='text').map(j=>j.id);
 const artwork=plan.jobs.filter(j=>j.kind!=='text');
 const schema={type:'object',additionalProperties:false,required:['patches','representedBy','unresolved','note'],properties:{patches:{type:'array',maxItems:ids.length,items:{type:'object',additionalProperties:false,required:['id','text'],properties:{id:{type:'string',enum:ids.length?ids:plan.jobs.map(j=>j.id)},text:{type:'string'}}}},representedBy:{type:'array',items:{type:'object',additionalProperties:false,required:['jobId','sourceText'],properties:{jobId:{type:'string',enum:artwork.length?artwork.map(j=>j.id):ids},sourceText:{type:'string'}}}},unresolved:{type:'boolean'},note:{type:'string'}}};
 const prompt=`Compare planned copy with the ORIGINAL banner. Independent OCR may also be wrong. Correct ONLY literal text on existing text IDs when clearly visible in the original; preserve each unit's line-break/group boundaries. Never duplicate words or alter claims/digits. If visible copy is already represented by a non-text artwork/logo job, list it in representedBy (jobId + exact sourceText), NOT unresolved. Separate CTA arrow/icon graphics are not copy. Only genuinely missing copy that no existing job can represent makes unresolved=true. Source OCR: ${JSON.stringify(copy)}. Plan units: ${JSON.stringify(plan.jobs.map(j=>({id:j.id,kind:j.kind,name:j.name,text:j.text,bbox:j.visibleBbox})))}. Confirmed reviewer concerns (if any): ${JSON.stringify(notes)}. Output necessary patches, artwork coverage, unresolved and a short note.`;
 const valid=new Ajv({strict:false}).compile(schema),parse=text=>{const out={representedBy:[],...JSON.parse(text)};if(!valid(out)||out.patches.some(p=>!p.text.trim())||new Set(out.patches.map(p=>p.id)).size!==out.patches.length||out.representedBy.some(r=>!artwork.some(j=>j.id===r.jobId)||!r.sourceText.trim()))throw Error('Invalid source-copy reconciliation');return out;};
 const images=[s.source,path.join(s.dir,'inspection','source-footer.png')];
 let out=parse((await s.reason('source-copy','01-source-copy-reconcile',prompt,{images,schema},s.reasoning.stages.plan.primary)).result.text),numericEscalation=null;
 const novel=novelNumericPatches(plan,copy,out.patches);
 if(novel.length){
  const route=s.reasoning.stages.plan.escalation;if(!route)throw Error('Source-copy patch introduces unverified numbers; no stronger confirmation route');
  numericEscalation={trigger:'new numeric/currency/percent sequence',proposed:novel};
  out=parse((await s.reason('source-copy','01-source-copy-numeric-confirm',prompt+'\nThe first read proposed numeric text not present in either candidate. Independently read Image1 and approve only numbers plainly visible in the source. Proposed patches: '+JSON.stringify(novel),{images,schema},route)).result.text);
 }
 if(out.unresolved)throw Error('Source copy is not fully represented in the plan: '+out.note);
 const patches=new Map(out.patches.map(p=>[p.id,p.text]));
 const next={...plan,jobs:plan.jobs.map(j=>patches.has(j.id)?{...j,text:patches.get(j.id)}:j)};
 const sourceCorpus=norm((copy.texts??[]).map(t=>t.text).join(''));
 // Packaging copy may be acknowledged by the adjudicator but is outside the OCR
 // inventory by design. Do not add it as a spurious residual discrepancy.
 const represented={...next,jobs:[...next.jobs,...out.representedBy.filter(r=>sourceCorpus.includes(norm(r.sourceText))&&!next.jobs.some(j=>norm(j.text??'').includes(norm(r.sourceText)))).map(r=>({text:r.sourceText}))]};
 return{plan:next,audit:{status:'source checked after independent disagreement',version:SOURCE_COPY_VERSION,...out,difference,residual:copyDisagreement(represented,copy),numericEscalation}};
}

// A confirmed review can discover an error in the PLAN itself. Correct its target
// before imagegen; otherwise the same wrong copy would be regenerated twice.
export async function reconcileReviewedCopy(s,evaluation){
 const suspect=(evaluation.findings?.issues??[]).filter(i=>i.action==='regenerate'&&i.defect==='wrong_text'&&!i.ocr);
 if(!suspect.length)return evaluation;
 const copy=await readSourceCopy(s),r=await reconcileSourceCopy(s,s.planData,copy,{force:true,notes:suspect});
 if(!r.audit.patches?.length)return{...evaluation,sourceCopyRepair:r.audit};
 const changed=new Map(r.audit.patches.map(p=>[p.id,p.text]));
 s.planData={...r.plan,planning:{...s.planData.planning,sourceCopyRepairs:[...(s.planData.planning?.sourceCopyRepairs??[]),r.audit]}};
 await saveJSON(path.join(s.dir,'plan.json'),s.planData);
 const repairs=evaluation.repairs.map(r=>changed.has(r.id)?{...r,prompt:`The source-copy check corrected the plan. Generate ONLY exact text ${JSON.stringify(changed.get(r.id))}, preserving source typography and placement. Resolve the confirmed visible defects: ${r.reason}.`}:r);
 const out={...evaluation,repairs,sourceCopyRepair:r.audit};await saveJSON(path.join(s.dir,'review.json'),out);return out;
}
