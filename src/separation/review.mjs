import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import Ajv from 'ajv';
import {hash,readJSON} from './core.mjs';
import {saveJSON} from '../images.mjs';
const esc=s=>s.replace(/[<>&]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]));
// Bump when the review prompt/schema/inventory changes; it is part of every review cache key.
export const REVIEW_VERSION='designer-review-v8-compact';
const repairItem={type:'object',additionalProperties:false,required:['id','reason','prompt','priority'],properties:{id:{type:'string'},reason:{type:'string'},prompt:{type:'string'},priority:{type:'string',enum:['high','medium']}}};
const adjustmentItem={type:'object',additionalProperties:false,required:['id','dx','dy','scale','opacity','reason'],properties:{id:{type:'string'},dx:{type:'number'},dy:{type:'number'},scale:{type:'number'},opacity:{type:'number'},reason:{type:'string'}}};
const reviewProps={verdict:{type:'string',enum:['usable','needs_improvement']},summary:{type:'string'},strengths:{type:'array',maxItems:3,items:{type:'string'}},limitations:{type:'array',maxItems:3,items:{type:'string'}},repairs:{type:'array',maxItems:4,items:repairItem},adjustments:{type:'array',items:adjustmentItem}};
export const reviewSchema={type:'object',additionalProperties:false,required:Object.keys(reviewProps),properties:reviewProps};
export const confirmSchema={type:'object',additionalProperties:false,required:[...Object.keys(reviewProps),'rejected'],properties:{...reviewProps,rejected:{type:'array',items:{type:'object',additionalProperties:false,required:['kind','id','reason'],properties:{kind:{type:'string',enum:['repair','adjustment']},id:{type:'string'},reason:{type:'string'}}}}}};
const round=v=>typeof v==='number'?Math.round(v):v;
const checkShape=new Ajv({strict:false}).compile({...reviewSchema,additionalProperties:true});
// Compact metadata: registration internals (matrices, inlier counts) are replaced by the method name.
export const reviewInventory=m=>m.layers.map(l=>({id:l.id,name:l.name,kind:l.kind,x:round(l.x),y:round(l.y),width:round(l.width),height:round(l.height),group:l.group,expectedText:l.text||undefined,registration:l.registration?.method}));
export const reviewTree=m=>m.tree.map(g=>({id:g.id,name:g.name,role:g.role,children:g.layers.map(n=>({id:n.id,role:n.role,children:n.layers?.map(c=>c.id)}))}));
const CONCISE='Be concise: summary at most 2 sentences; at most 3 strengths and 3 limitations, each one short sentence; each reason one short sentence.';
export const reviewPrompt=m=>`You are reviewing a GENERATION-FIRST ad layer tool for real Figma editing. Image1 original, image2 recomposed generated layers, remaining images show ALL isolated generated assets on medium gray with their IDs. User acceptance criterion: visually sufficiently close and properly separated for moving/hiding/replacing; pixel equality is NOT required. Judge composition, accurate readable copy, clean complete glyph edges, no source-background halos/fragments, complete plausible hidden object parts, coherent editing hierarchy. Pay special attention to skinny product edges, clear holes, translucent haze, decorative borders and price/type proportions. Do NOT demand perfect original-font or photographic-texture recovery. Do not invent issues from gray proof background. Inspect visible evidence.
 Propose only concrete meaningful fixes. repairs regenerate whole asset through imagegen; prioritize high only when usability/visible resemblance suffers. At most 4 repairs. adjustments are GLOBAL whole-layer placement/scale/opacity, not masks: use small dx/dy in ORIGINAL PIXELS, scale .8..1.2, opacity0..1 absolute. Use them for noticeable misplacement/excess effect strength. No correction overlays, source-pixel restoration, color-threshold edges. Empty lists are appropriate when already useful. Return Japanese explanations, English targeted repair prompts. ${CONCISE} Layer inventory ${JSON.stringify(reviewInventory(m))}. Actual exported hierarchy ${JSON.stringify(reviewTree(m))}.`;
export const confirmPrompt=(m,proposal)=>`You are the CONFIRMING senior reviewer of a GENERATION-FIRST ad layer tool for real Figma editing. Image1 original, image2 recomposed generated layers, remaining images show ALL isolated generated assets on medium gray with their IDs. A faster first-pass reviewer proposed the findings below. Each repair regenerates a whole asset with imagegen (slow, and can introduce new defects); each adjustment moves/scales/fades a whole layer. Verify every proposal against visible evidence. Put in repairs/adjustments ONLY proposals you confirm (you may correct id, priority, prompt or values), plus any additional clearly visible issue that blocks usability (priority high). List every rejected proposal in rejected with a short reason. Acceptance criterion: visually sufficiently close and properly separated for moving/hiding/replacing; pixel equality, original fonts and photographic texture recovery are NOT required. Do not invent issues from gray proof background. adjustments: small dx/dy in ORIGINAL PIXELS, scale .8..1.2, opacity0..1 absolute. Return Japanese explanations, English targeted repair prompts. ${CONCISE} First-pass proposal ${JSON.stringify(proposal)}. Layer inventory ${JSON.stringify(reviewInventory(m))}. Actual exported hierarchy ${JSON.stringify(reviewTree(m))}.`;
// The repairs the runners act on: high ones, or every repair when the verdict fails.
export function actionableRepairs(e){const high=e.repairs.filter(r=>r.priority==='high');return high.length?high:e.verdict==='needs_improvement'?e.repairs:[];}
export const isActionable=(e,{highOnly=false}={})=>(highOnly?e.repairs.some(r=>r.priority==='high'):actionableRepairs(e).length>0)||e.adjustments.length>0;
function checkReview(data,m,s){
 if(!checkShape(data))throw Error('Invalid review shape: '+JSON.stringify(checkShape.errors));
 const ids=new Set(m.layers.map(l=>l.id));
 for(const r of data.repairs)if(!ids.has(r.id))throw Error('Review refers to missing asset '+r.id);
 for(const a of data.adjustments)if(!ids.has(a.id)||![a.dx,a.dy,a.scale,a.opacity].every(Number.isFinite)||a.scale<.8||a.scale>1.2||a.opacity<0||a.opacity>1||Math.abs(a.dx)>s.width*.1||Math.abs(a.dy)>s.height*.1)throw Error('Unsafe geometry adjustment '+a.id);
 return data;
}
export async function contactSheets(s,m){
 const sheets=[];await fs.mkdir(path.join(s.dir,'inspection'),{recursive:true});
 for(let start=0;start<m.layers.length;start+=8){const images=[];for(const[i,l]of m.layers.slice(start,start+8).entries()){const x=i%4*350,y=Math.floor(i/4)*300;const thumb=await sharp(path.join(s.dir,l.file)).resize(330,248,{fit:'contain',background:'#747078'}).flatten({background:'#747078'}).png().toBuffer();images.push({input:thumb,left:x+10,top:y+36},{input:Buffer.from(`<svg width="350" height="32"><text x="10" y="23" font-family="sans-serif" font-size="15" fill="white">${esc(l.id)}</text></svg>`),left:x,top:y});}const file=path.join(s.dir,'inspection',`contact-${start}.png`);await sharp({create:{width:1400,height:600,channels:4,background:'#302d35'}}).composite(images).png().toFile(file);sheets.push(file);}
 return sheets;
}
// Every review sees the source, the composite and ALL isolated assets (no incremental review).
// The primary route reviews first. If it proposes anything the runners would act on (or its
// output is invalid), ONE confirmation on the escalation route decides the final findings, so
// a light reviewer alone never triggers imagegen repairs or adjustments. final=true marks a
// record-only review (nothing acts on it): its findings are not confirmed, only invalid output is.
export async function review(s,{final=false,highOnly=false}={}){
 const m=await readJSON(path.join(s.dir,'manifest.json')),composite=path.join(s.dir,'composite.png'),sheets=await contactSheets(s,m),st=s.reasoning.stages.review;
 if(st.format==='compact')return(await import('./review-compact.mjs')).reviewCompact(s,{m,composite,sheets,final,highOnly});
 const escalation=st.confirm!=='never'?st.escalation:null,confirmRoute=final?null:escalation;
 const content=hash(JSON.stringify({version:REVIEW_VERSION,source:s.sourceHash,composite:hash(await fs.readFile(composite)),sheets:await Promise.all(sheets.map(async f=>hash(await fs.readFile(f)))),inventory:reviewInventory(m),tree:reviewTree(m)}));
 const routes={primary:await s.routeKey(st.primary),confirm:await s.routeKey(escalation),confirmPolicy:confirmRoute?st.confirm:final&&escalation?'invalid-output-only':null,repairPolicy:highOnly?'high-only':'actionable'};
 const signature=hash(JSON.stringify({content,routes})),cacheFile=path.join(s.dir,'reviews',signature+'.json'),cache=await readJSON(cacheFile);
 s.timeline.cache('review',signature.slice(0,8),cache?.signature===signature);if(cache?.signature===signature){await saveJSON(path.join(s.dir,'review.json'),cache);return cache;}
 const images=[s.source,composite,...sheets];
 const first=await s.reason('review','05-designer-review-'+signature.slice(0,8),reviewPrompt(m),{images,schema:reviewSchema},st.primary);
 let primary=null,problem=null;try{primary=checkReview(JSON.parse(first.result.text),m,s);}catch(e){problem=e.message;}
 if(problem&&!escalation)throw Error(problem); // V7 parity without a stronger route
 // Invalid output is a content failure: escalated once even for a record-only review.
 const trigger=problem?'invalid primary output':confirmRoute&&isActionable(primary,{highOnly})?'actionable findings':confirmRoute&&st.confirm==='always'?'policy always':null;
 let out;
 if(!trigger){
  const status=final?'skipped: record-only review':!st.escalation?'unavailable: no escalation route':st.confirm==='never'?'disabled by profile':'not needed: no actionable findings';
  out={...primary,signature,routes,confirmation:{status,recall:st.escalation&&!final?'A clear primary review is accepted unconfirmed; this reviewer\'s recall of missed defects is unmeasured.':undefined}};
 }else{
  const second=await s.reason('review','05-designer-review-confirm-'+signature.slice(0,8),confirmPrompt(m,primary?{verdict:primary.verdict,repairs:primary.repairs,adjustments:primary.adjustments}:{invalid:problem}),{images,schema:confirmSchema},escalation);
  const{rejected,...data}=checkReview(JSON.parse(second.result.text),m,s);
  out={...data,signature,routes,primaryReview:primary??{error:problem},confirmation:{status:'confirmed',trigger,rejected}};
 }
 await saveJSON(path.join(s.dir,'review.json'),out);await saveJSON(cacheFile,out);return out;
}
export async function applyAdjustments(s,review){const m=await readJSON(path.join(s.dir,'manifest.json')),adjust=await readJSON(path.join(s.dir,'adjustments.json'))||{};for(const a of review.adjustments){const l=m.layers.find(l=>l.id===a.id);adjust[a.id]={x:Math.round(l.x+a.dx+l.width*(1-a.scale)/2),y:Math.round(l.y+a.dy+l.height*(1-a.scale)/2),width:Math.round(l.width*a.scale),height:Math.round(l.height*a.scale),opacity:a.opacity};}await saveJSON(path.join(s.dir,'adjustments.json'),adjust);}
