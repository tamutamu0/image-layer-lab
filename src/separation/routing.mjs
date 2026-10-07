// Stage-specific reasoning routes for the NON-image agent turns (plan / OCR / review).
// The imagegen wrapper turn is NOT routed here: it always uses Pipeline.model
// (CODEX_MODEL or the app-server default) and --image-effort, independent of profiles.
export const EFFORTS=['low','medium','high'];
export const STAGE_NAMES=['plan','ocr','review'];
export const ESCALATION_MODES=['auto','off','always'];
// Candidate IDs supplied by the operator. Availability is NOT assumed: every route is
// validated against app-server model/list before use (Pipeline.resolveRoute).
export const MODEL_CANDIDATES={sol:'gpt-6.1-sol',luna:'gpt-6-luna'};
const {sol,luna}=MODEL_CANDIDATES;
// Balanced selected from the V8 three-banner evaluation (evidence/v8): Sol 6.1
// preserves useful planning/effect granularity; Luna reads generated text accurately.
// model:null inherits CODEX_MODEL / the app-server default, exactly as V7 did.
// escalation: ONE stronger route used only on deterministic content signals
// (invalid plan, malformed/mismatched OCR entry, actionable light review), never on
// network/auth/rate failures. batchSize 'all' = one OCR call for every unread text.
// criticalDirect: OCR text with digits/currency/percent/※ or in offer/footer groups is
// read by the escalation route directly instead of the light route.
// confirm: 'actionable' confirms light-review findings before repairs; 'always' also
// confirms clear verdicts; 'never' trusts the primary reviewer.
export const PROFILES={
 accelerated:{note:'V9: compact Sol plans with parallel source-copy audit, compact reviews and bounded regeneration.',
  plan:{model:sol,effort:'low',format:'compact',copyAudit:true},ocr:{model:luna,effort:'low',batchSize:4,parallel:3,criticalDirect:false},review:{model:sol,effort:'low',format:'compact',confirm:'actionable'},escalation:{model:sol,effort:'high'}},
 quality:{note:'V7 control: inherited model, high effort, single OCR call, no escalation.',
  plan:{model:null,effort:'high'},ocr:{model:null,effort:'high',batchSize:'all',parallel:1,criticalDirect:false},review:{model:null,effort:'high',confirm:'actionable'},escalation:null},
 balanced:{note:'Measured V8 default: Sol 6.1 low plans/reviews, Luna low reads text; suspicious outputs alone escalate to Sol 6.1 high.',
  plan:{model:sol,effort:'low'},ocr:{model:luna,effort:'low',batchSize:4,parallel:3,criticalDirect:false},review:{model:sol,effort:'low',confirm:'actionable'},escalation:{model:sol,effort:'high'}},
 luna:{note:'Candidate: every reasoning stage on Luna low; one strong escalation on deterministic failure signals.',
  plan:{model:luna,effort:'low'},ocr:{model:luna,effort:'low',batchSize:4,parallel:3,criticalDirect:false},review:{model:luna,effort:'low',confirm:'actionable'},escalation:{model:sol,effort:'high'}},
};
export const PROFILE_NAMES=Object.keys(PROFILES);
export const OCR_PARALLEL_MAX=3,OCR_BATCH_MAX=8;
export function parseReasoningFormat(value){if(!['compact','full'].includes(value))throw Error('Reasoning format must be compact or full');return value;}

export function parseModelId(value,flag='model'){
 if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value))throw Error(`--${flag} must be a model ID such as ${luna}`);
 return value;
}
export function parseEffort(value,label){if(!EFFORTS.includes(value))throw Error(`${label} effort must be one of ${EFFORTS.join(', ')}`);return value;}
export function parseBatchSize(value){
 if(value==='all')return value;
 const n=typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value):value;
 if(!Number.isInteger(n)||n<1||n>OCR_BATCH_MAX)throw Error(`OCR batch size must be "all" or an integer from 1 to ${OCR_BATCH_MAX}`);
 return n;
}
export function parseOcrParallel(value){
 const n=typeof value==='string'&&/^\d+$/.test(value.trim())?Number(value):value;
 if(!Number.isInteger(n)||n<1||n>OCR_PARALLEL_MAX)throw Error(`OCR parallel calls must be an integer from 1 to ${OCR_PARALLEL_MAX}`);
 return n;
}
const sameRoute=(a,b)=>a.model===b.model&&a.effort===b.effort;

// Precedence per stage: explicit --<stage>-model/--<stage>-effort > profile constant.
// A null model inherits the global model. An explicit stage model is never escalated
// automatically; --escalation=always opts in, --escalation=off disables all escalation.
export function resolveReasoning(name='quality',o={}){
 if(!PROFILE_NAMES.includes(name))throw Error(`Reasoning profile must be one of ${PROFILE_NAMES.join(', ')}`);
 const p=PROFILES[name],mode=o.escalation??'auto';
 if(!ESCALATION_MODES.includes(mode))throw Error(`Escalation must be one of ${ESCALATION_MODES.join(', ')}`);
 const customTarget=o.escalationModel!==undefined||o.escalationEffort!==undefined;
 const target=customTarget?{model:o.escalationModel===undefined?p.escalation?.model??null:parseModelId(o.escalationModel,'escalation-model'),effort:o.escalationEffort===undefined?p.escalation?.effort??'high':parseEffort(o.escalationEffort,'escalation')}:p.escalation;
 const stages={};
 for(const stage of STAGE_NAMES){
  const base=p[stage],modelFlag=o[stage+'Model'],effortFlag=o[stage+'Effort'];
  const primary={role:'primary',model:modelFlag===undefined?base.model:parseModelId(modelFlag,stage+'-model'),effort:effortFlag===undefined?base.effort:parseEffort(effortFlag,stage)};
  let escalation=null,escalationNote=null;
  if(mode==='off')escalationNote='disabled by --escalation=off';
  else if(!target)escalationNote='profile has no escalation route';
  else if(modelFlag!==undefined&&mode!=='always')escalationNote=`explicit --${stage}-model is not auto-escalated (use --escalation=always)`;
  else if(sameRoute(primary,target))escalationNote='escalation route equals the primary route';
  else escalation={role:'escalation',model:target.model,effort:target.effort};
  const entry={primary,escalation,escalationNote,source:{model:modelFlag!==undefined?'flag':base.model?'profile':'inherit',effort:effortFlag!==undefined?'flag':'profile'}};
  if(stage==='plan'||stage==='review')entry.format=parseReasoningFormat(o[stage+'Format']??base.format??'full');
  if(stage==='plan')entry.copyAudit=Boolean(base.copyAudit);
  if(stage==='ocr')Object.assign(entry,{batchSize:o.ocrBatchSize===undefined?base.batchSize:parseBatchSize(o.ocrBatchSize),parallel:o.ocrParallel===undefined?base.parallel:parseOcrParallel(o.ocrParallel),criticalDirect:Boolean(base.criticalDirect&&escalation)});
  if(stage==='review')entry.confirm=base.confirm;
  stages[stage]=entry;
 }
 return{profile:name,note:p.note,escalationMode:mode,stages};
}
