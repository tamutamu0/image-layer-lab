import {planSchema,validatePlan} from './schema.mjs';
import {compactPlanSchema,compactInstructions,expandCompactPlan,COMPACT_PLAN_VERSION} from './compact-plan.mjs';
import {readSourceCopy,reconcileSourceCopy} from './source-copy.mjs';
import {settleAll} from '../concurrency.mjs';
// V7 planning prompt with an explicit root-parent convention. Reused by evaluation.
export const planPrompt=({width,height})=>`Act as an experienced advertising designer planning GENERATION-FIRST decomposition. Source is ${width}x${height}. Decide useful semantic edit units and the full layer order yourself. Aim for 15-28 generation jobs and 6-10 root editing groups; complexity may justify up to 40 jobs. Each foreground job will be generated as a whole native transparent RGBA asset with hidden parts completed. Never plan source pixel extraction, color-key, character masks or residual overlays.
 Declare boxFormat: xywh means [x,y,width,height]; xyxy means [left,top,right,bottom]. Use the declared format consistently. Output normalized bounds in 0..1000 coordinates: bbox is the COMPLETE inferred object including hidden portions; visibleBbox is its visible extent. Background bbox is [0,0,1000,1000]. A complete object may extend at most 150 normalized units beyond the canvas. Accurate positions and visible ink boxes are important for generic geometric registration; don't include excess whitespace in bbox. Padding is added by code.
 Separate each replaceable text unit from its backing and from unrelated text: headlines by line (keep interleaved words together), brand and product name, supporting copy, each benefit chip, price amount WITH currency, discount percent WITH suffix, tax, CTA, each legal line. Generate these text units individually from the start; no later rectangular splitting. Keep linebreaks and mixed character sizes. Product packaging lettering remains on the product. Use native textMode for functional copy; raster for ornate lettering/logos where fidelity matters. No splitting into glyphs.
 Keep a blank button + text + arrow in a CTA group. Keep badge surface + complete price/discount lines + glints in an offer group. Each independent benefit chip can be a nested child group. No unnecessary one-child subgroup. Root group IDs must differ from job IDs. Each group has parent root or another group ID. Keep product independently selectable as a ROOT group: never put the product inside an offer/price group merely to preserve overlaps. If needed split offer backing and offer text into separate root groups. Arrange each group contiguously in BACK-TO-FRONT z so grouping doesn't change overlaps. Background light/atmosphere belong behind other objects; glints belong with their attached component. Foreground product shadow may stay with product only if inseparable; major white haze, steam/glow/reflections should be separate practical effect assets. Avoid duplicate glows across assets.
 People/models that can be moved or replaced are independent subject jobs in a subject ROOT group; never bake the main person into the background. Complete occluded hair, skin and clothing and extend cropped parts slightly beyond the artboard, without inventing a whole unseen body. Background is ONE clean opaque plate with all overlays AND independent people/subjects removed, photographic content completed, original framing retained. First remove overlays on original canvas, then code separately outpaints the clean generated plate. Do not include footer/badge/text plates in the photograph: each simple visible panel needed as a movable element gets a surface job. Complete product under price/CTA. Never redesign the ad.
 Names/purpose/risks in Japanese. Per-job prompt in English specifies only the target, exact styling, which overlaps to remove, which hidden parts to complete, and which nearby letters/graphics to exclude. Text must be exact as visible, no correction of real copy. Every top-level group MUST have parent="root", never an empty parent. Return JSON.`;

// Deterministic structure checks on an already validatePlan()-normalized (xywh) plan.
// defects: clear self-inconsistencies that would produce wrong crops; they may trigger
// ONE escalation. warnings are recorded only. Neither proves semantic quality: a plan can
// pass every check and still merge objects, miss copy or misread text.
const VISIBLE_TOLERANCE=40;
export function planDiagnostics(p){
 const defects=[],warnings=[],bg=p.jobs.find(j=>j.kind==='background');
 if(bg){const[x,y,w,h]=bg.bbox;if(x>10||y>10||x+w<990||y+h<990)defects.push(`background ${bg.id} bbox does not cover the canvas`);}
 for(const j of p.jobs){
  const[bx,by,bw,bh]=j.bbox,[vx,vy,vw,vh]=j.visibleBbox;
  if(vx<bx-VISIBLE_TOLERANCE||vy<by-VISIBLE_TOLERANCE||vx+vw>bx+bw+VISIBLE_TOLERANCE||vy+vh>by+bh+VISIBLE_TOLERANCE)defects.push(`${j.id} visibleBbox extends outside its complete bbox`);
  if(vx+vw<=0||vy+vh<=0||vx>=1000||vy>=1000)defects.push(`${j.id} is not visible on the canvas`);
  if(j.kind==='text'&&j.textMode==='none')warnings.push(`${j.id} is text with textMode none`);
  if(j.kind!=='text'&&j.textMode!=='none')warnings.push(`${j.id} is ${j.kind} with textMode ${j.textMode}`);
 }
 const z=p.jobs.map(j=>j.z);if(new Set(z).size!==z.length)warnings.push('duplicate z values; plan order breaks ties');
 const used=new Set(p.jobs.map(j=>j.group));for(const g of p.groups)if(!used.has(g.id)&&!p.groups.some(c=>c.parent===g.id))warnings.push(`group ${g.id} is empty`);
 const texts=p.jobs.filter(j=>j.kind==='text').map(j=>j.text.trim());if(new Set(texts).size!==texts.length)warnings.push('duplicate text units');
 if(!texts.length)warnings.push('no text jobs');
 if(p.jobs.length<15)warnings.push(`${p.jobs.length} jobs; prompt targets 15-28`);
 return{defects,warnings};
}

// Primary route first; ONE escalation only for unparseable/invalid output or defects.
// Transport/auth/rate errors from s.reason propagate unchanged (no model substitution).
export async function runPlanning(s){
 const st=s.reasoning.stages.plan,attempts=[],compact=st.format==='compact';
 const prompt=compact?planPrompt(s).replace('Every top-level group MUST have parent="root", never an empty parent. Return JSON.','')+'\n'+compactInstructions:planPrompt(s);
 const attempt=async(route,stage)=>{
  const t0=performance.now(),{result}=await s.reason('plan',stage,prompt,{images:[s.source],schema:compact?compactPlanSchema:planSchema},route);
  let plan=null,diag;
  try{plan=compact?expandCompactPlan(JSON.parse(result.text)):validatePlan(JSON.parse(result.text));diag=planDiagnostics(plan);}catch(e){diag={defects:['invalid plan: '+e.message],warnings:[]};}
  attempts.push({role:route.role,model:route.model,effort:route.effort,stage,format:compact?'compact':'full',outputCharacters:result.text.length,durationMs:Math.round(performance.now()-t0),valid:!!plan,defects:diag.defects,warnings:diag.warnings});
  return{plan,diag};
 };
 // Independent source-copy read overlaps the longest planning call. Every branch
 // drains before failure so no shared app-server work is abandoned.
 const [first,copy]=await settleAll([attempt(st.primary,'01-semantic-plan'),st.copyAudit?readSourceCopy(s):Promise.resolve(null)],'Planning failed');
 let out=first,acceptedIndex=0;
 if(out.diag.defects.length&&st.escalation){
  console.log('plan: escalating after '+out.diag.defects.join('; '));
  const next=await attempt(st.escalation,'01-semantic-plan-escalated');
  // Legacy quality may keep a structurally valid primary when a custom retry is malformed.
  if(!(s.reasoning.profile==='quality'&&out.plan&&!next.plan)){out=next;acceptedIndex=1;}
 }
 // V7 parity: an invalid plan fails; a valid plan with defects is kept (and recorded) when no stronger route remains.
 if(!out.plan)throw Error(out.diag.defects[0]);
 if(out.diag.defects.length&&s.reasoning.profile!=='quality')throw Error('Unresolved plan geometry after bounded validation: '+out.diag.defects.join('; '));
 const reconciled=copy?await reconcileSourceCopy(s,out.plan,copy):{plan:out.plan,audit:null};
 return{plan:reconciled.plan,planning:{sourceCopyAudit:reconciled.audit,compilerVersion:compact?COMPACT_PLAN_VERSION:null,policy:{primary:st.primary,escalation:st.escalation,escalationNote:st.escalationNote},attempts,acceptedRole:attempts[acceptedIndex].role,defects:out.diag.defects,warnings:out.diag.warnings,
  note:'Deterministic checks cover schema, IDs, tree, bounds and geometry consistency only; they cannot prove semantic decomposition quality.'}};
}
