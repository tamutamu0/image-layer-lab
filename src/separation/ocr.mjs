import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {hash,readJSON} from './core.mjs';
import {saveJSON} from '../images.mjs';
import {limiter} from '../concurrency.mjs';
const runSchema={type:'object',additionalProperties:false,required:['text','fontSize','weight','color'],properties:{text:{type:'string'},fontSize:{type:'number'},weight:{type:'integer',enum:[400,500,600,700,900]},color:{type:'string'}}};
const entrySchema=ids=>({type:'object',additionalProperties:false,required:['id','text','correct','bbox','family','alignment','runs','risk'],properties:{id:{type:'string',enum:ids},text:{type:'string'},correct:{type:'boolean'},bbox:{type:'array',items:{type:'number'},minItems:4,maxItems:4},family:{type:'string',enum:['Noto Serif JP','Noto Sans JP']},alignment:{type:'string',enum:['left','center','right']},runs:{type:'array',minItems:1,items:runSchema},risk:{type:'string'}}});
export const ocrSchema=ids=>({type:'object',additionalProperties:false,required:['assessment','texts'],properties:{assessment:{type:'string'},texts:{type:'array',items:entrySchema(ids)}}});
// Bump when the OCR prompt, schema, validation or routing procedure changes: every cached entry is then re-read.
export const OCR_VERSION='generated-text-ocr-v8-routed';
// OCR cannot reliably distinguish full/half-width parentheses in a raster.
// Normalize only these glyph-width variants; never normalize numbers or missing copy.
const normalizeText=t=>t.replace(/\r\n?/g,'\n').replaceAll('（','(').replaceAll('）',')').normalize('NFC');
export const sameText=(a,b)=>normalizeText(a)===normalizeText(b);
// The model's verdict alone never makes text correct: the transcription must equal the plan.
export function strictEntry(t,expected){const modelClaimedCorrect=t.modelClaimedCorrect??t.correct,textMatchesExpected=sameText(t.text,expected);return{...t,expected,modelClaimedCorrect,textMatchesExpected,correct:modelClaimedCorrect&&textMatchesExpected};}
// Copy where a misread is costly: digits, currency, percent, notes, offer and legal groups.
const CRITICAL=/[0-9０-９%％¥￥$€£円※]/;
export function criticalText(job,groups=[]){const role=groups.find(g=>g.id===job.group)?.role;return CRITICAL.test(job.text)||role==='offer'||role==='footer';}
const digits=t=>(t.normalize('NFKC').match(/\d/g)||[]).join('');
// V7 prompt, unchanged; reusable by the evaluation entrypoint. Must end with the image list.
export const buildOcrPrompt=list=>`Inspect ONLY these independently GENERATED text images, shown on neutral gray. Each image is ONE semantic text object. Return exactly one entry per image, preserve its ID. Transcribe actual visible text; expected text is validation context, not authority to silently repair. correct=false for any wrong/missing/extra characters. bbox=[x,y,width,height] is visible ink bounds in LOCAL IMAGE PIXELS, with 2 px padding. Do not subdivide/crop the image. Family is nearest Noto approximation. runs must concatenate EXACTLY to text, including linebreaks; assign different sizes to large numeral/smaller currency, 66 vs %OFF, or mixed colors. Each run has fontSize in this image's pixels, weight, hex #RRGGBB. Keep base and suffix on the same baseline. Prefer few runs with meaningful typography differences; never create a run per glyph unnecessarily. These runs create a SINGLE editable Figma text layer, not detached glyphs. Explain approximation risks. Images in order: ${JSON.stringify(list)}`;
// Per generated text image: bytes, real pixel size, record size, expected text and prompt version.
export async function ocrContentKey(s,a){const bytes=await fs.readFile(path.join(s.dir,a.file)),meta=await sharp(bytes).metadata();return hash(JSON.stringify({version:OCR_VERSION,schema:hash(JSON.stringify(entrySchema([a.id]))),id:a.id,expected:a.text,file:hash(bytes),pixels:[meta.width,meta.height],record:[a.width,a.height]}));}
// Resolved routes are part of every key, so distinct profiles/models never share entries.
export async function ocrPolicy(s){const st=s.reasoning.stages.ocr;return{primary:await s.routeKey(st.primary),escalation:await s.routeKey(st.escalation),batchSize:st.batchSize,criticalDirect:st.criticalDirect};}
export async function ocrKey(s,a,policy){return hash(JSON.stringify({content:await ocrContentKey(s,a),policy:policy??await ocrPolicy(s)}));}
export function ocrCorrections(s,text){return Object.fromEntries(text.texts.filter(t=>!t.correct).map(t=>[t.id,`The previous image was transcribed as ${JSON.stringify(t.text)}. Regenerate the ONLY exact requested text ${JSON.stringify(s.planData.jobs.find(j=>j.id===t.id).text)}. No extra fragments or missing punctuation. Preserve reference style.`]));}
// Stable, near-equal batches in plan order ('all' = one batch).
export function chunk(list,size){if(!list.length)return[];const n=size==='all'?1:Math.ceil(list.length/size),out=[];for(let i=0,start=0;i<n;i++){const len=Math.floor(list.length/n)+(i<list.length%n?1:0);out.push(list.slice(start,start+len));start+=len;}return out;}

function entryProblem(t,a){
 if(typeof t?.text!=='string'||typeof t.correct!=='boolean'||!Array.isArray(t.bbox)||t.bbox.length!==4||!Array.isArray(t.runs)||!t.runs.length)return'missing fields';
 const[x,y,w,h]=t.bbox;if(!t.bbox.every(Number.isFinite)||x<0||y<0||w<=0||h<=0||x+w>a.width+2||y+h>a.height+2)return'bbox outside image';
 if(!['Noto Serif JP','Noto Sans JP'].includes(t.family)||!['left','center','right'].includes(t.alignment))return'invalid text family/alignment';
 if(t.runs.some(r=>!r||typeof r.text!=='string'||!Number.isFinite(r.fontSize)||!(r.fontSize>0)||![400,500,600,700,900].includes(r.weight)||!/^#[0-9a-f]{6}$/i.test(r.color)))return'invalid run style';
 if(t.runs.map(r=>r.text).join('')!==t.text)return'runs do not concatenate to text';
 return null;
}
// Validates each entry independently: one malformed/missing entry never discards the others.
function parseRead(text,members){
 const out=new Map();let data;
 try{data=JSON.parse(text);}catch{for(const a of members)out.set(a.id,{problem:'unparseable OCR output'});return{out,assessment:''};}
 const list=Array.isArray(data?.texts)?data.texts:[];
 for(const a of members){const found=list.filter(t=>t?.id===a.id),problem=found.length===0?'missing entry':found.length>1?'duplicate entries':entryProblem(found[0],a);out.set(a.id,problem?{problem}:{entry:found[0]});}
 return{out,assessment:typeof data?.assessment==='string'?data.assessment:''};
}
async function readBatch(s,route,fresh,slot){
 await fs.mkdir(path.join(s.dir,'inspection'),{recursive:true});const images=[];
 for(const{a,key}of fresh){const file=path.join(s.dir,'inspection',`${a.id}-${key.slice(0,8)}-ocr.png`);await sharp(path.join(s.dir,a.file)).flatten({background:'#858585'}).png().toFile(file);images.push(file);}
 const ids=fresh.map(f=>f.a.id),stage=`04-generated-text-ocr-${route.role}-${hash(fresh.map(f=>f.key).join()).slice(0,8)}`;
 const{result}=await slot(()=>s.reason('ocr',stage,buildOcrPrompt(fresh.map(({a})=>({id:a.id,width:a.width,height:a.height,expected:a.text}))),{images,schema:ocrSchema(ids)},route));
 return{stage,...parseRead(result.text,fresh.map(f=>f.a))};
}
const attemptOf=(route,key,stage,r,expected)=>({role:route.role,model:key?.model??null,effort:route.effort,stage,...(r.entry?{text:r.entry.text,modelClaimedCorrect:r.entry.correct,textMatchesExpected:sameText(r.entry.text,expected)}:{problem:r.problem})});

// Reads generated text images in bounded parallel batches. A batch starts when ITS assets
// are ready (`ready`: id -> generation promise). Each accepted entry is saved atomically
// to its own cache file at once. Light-route entries that are malformed, missing, or
// fail strict equality get ONE re-read on the escalation route; the accepted entry is
// always a verbatim transcription (never replaced by the expected text). Transport errors
// propagate without any fallback. All batches settle before this resolves or rejects.
export async function ocr(s,{ready}={}){
 const st=s.reasoning.stages.ocr,jobs=s.planData.jobs.filter(j=>j.kind==='text'),policy=await ocrPolicy(s),cacheDir=path.join(s.dir,'ocr-cache');
 await fs.mkdir(cacheDir,{recursive:true});
 const direct=j=>Boolean(st.criticalDirect&&st.escalation&&criticalText(j,s.planData.groups)),batches=[];
 for(const role of['primary','escalation'])batches.push(...chunk(jobs.filter(j=>(direct(j)?'escalation':'primary')===role),st.batchSize).map(members=>({role,members})));
 const slot=limiter(st.parallel),final=new Map(),files=new Map(),skipped=[],calls=[];
 const accept=async({a,key},entry,attempts)=>{
  const e={...strictEntry(entry,a.text),cacheKey:key,readBy:attempts.at(-1).role,attempts},first=attempts[0];
  if(attempts.length>1&&first.text!==undefined&&!sameText(first.text,e.text))e.disagreement={primaryText:first.text,acceptedText:e.text,digitsDiffer:digits(first.text)!==digits(e.text)};
  await saveJSON(path.join(cacheDir,key+'.json'),e);final.set(a.id,e);
 };
 const runBatch=async({role,members})=>{
  if(ready){const settled=await Promise.allSettled(members.map(j=>ready.get(j.id)??Promise.resolve()));skipped.push(...members.filter((_,i)=>settled[i].status==='rejected').map(j=>j.id));members=members.filter((_,i)=>settled[i].status==='fulfilled');}
  const assets=await Promise.all(members.map(j=>readJSON(path.join(s.dir,'assets',j.id+'.json'))));if(assets.some(a=>!a))throw Error('Missing generated text asset');
  const fresh=[];
  for(const a of assets){files.set(a.id,a.file);const key=await ocrKey(s,a,policy),hit=await readJSON(path.join(cacheDir,key+'.json'));s.timeline.cache('ocr',a.id,hit?.cacheKey===key);if(hit?.cacheKey===key)final.set(a.id,hit);else fresh.push({a,key});}
  if(!fresh.length)return;
  const route=st[role],first=await readBatch(s,route,fresh,slot),suspicious=[],errors=[];calls.push({stage:first.stage,role,ids:fresh.map(f=>f.a.id),assessment:first.assessment});
  for(const f of fresh){const r=first.out.get(f.a.id),attempts=[attemptOf(route,policy[role],first.stage,r,f.a.text)];
   if(r.entry&&(role==='escalation'||strictEntry(r.entry,f.a.text).correct))await accept(f,r.entry,attempts);
   else if(role==='primary'&&st.escalation)suspicious.push({...f,attempts});
   else if(r.entry)await accept(f,r.entry,attempts); // no stronger route (V7 parity): the strict verdict stands
   else errors.push(`${f.a.id}: ${r.problem}`);
  }
  if(suspicious.length){
   const second=await readBatch(s,st.escalation,suspicious,slot);calls.push({stage:second.stage,role:'escalation',ids:suspicious.map(f=>f.a.id),assessment:second.assessment});
   for(const f of suspicious){const r=second.out.get(f.a.id);if(r.entry)await accept(f,r.entry,[...f.attempts,attemptOf(st.escalation,policy.escalation,second.stage,r,f.a.text)]);else errors.push(`${f.a.id}: ${r.problem} after escalation`);}
  }
  if(errors.length)throw Error('Invalid OCR output (valid entries are saved; a rerun re-reads only these): '+errors.join('; '));
 };
 const failures=(await Promise.allSettled(batches.map(runBatch))).filter(r=>r.status==='rejected').map(r=>r.reason);
 if(failures.length)throw new AggregateError(failures,'OCR failed: '+failures.map(e=>e.message).join('; '));
 if(skipped.length)return{skipped};
 const texts=jobs.map(j=>final.get(j.id)),prior=await readJSON(path.join(s.dir,'text.json'));
 // Surfaced for review, never silently resolved: the light read differed from the accepted read.
 const warnings=texts.filter(t=>t.disagreement).map(t=>({id:t.id,type:t.disagreement.digitsDiffer?'digit-disagreement':'transcription-disagreement',...t.disagreement,acceptedCorrect:t.correct}));
 for(const w of warnings)console.log(`OCR ${w.type} ${w.id}: light ${JSON.stringify(w.primaryText)} vs accepted ${JSON.stringify(w.acceptedText)}`);
 const output={assessment:calls.map(c=>c.assessment).filter(Boolean).join('\n')||prior?.assessment||'',texts,warnings,calls,lastCall:calls.at(-1)??prior?.lastCall??null,ocrVersion:OCR_VERSION,
  policy:{...policy,parallel:st.parallel},source:'Generated images only',assets:jobs.map(j=>({id:j.id,file:files.get(j.id)}))};
 await saveJSON(path.join(s.dir,'text.json'),output);return output;
}
