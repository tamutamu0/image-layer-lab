import {parseConcurrency} from '../concurrency.mjs';
import {EFFORTS,PROFILE_NAMES,resolveReasoning} from './routing.mjs';
export {EFFORTS};
export const MODES=['fast','baseline'],STAGES=['plan','assets','build'];
// image = reasoning effort of the Codex agent turn that WRAPS one hosted imagegen call.
// It does not select the image model or its quality; app-server exposes neither.
// plan/ocr/review defaults come from the reasoning profile (routing.mjs).
const EFFORT_DEFAULTS={fast:{image:'low',plan:'high',ocr:'high',review:'high'},baseline:{image:'high',plan:'high',ocr:'high',review:'high'}};
const KNOWN=['input','out','stage','mode','concurrency','bleed','image-effort','plan-effort','ocr-effort','review-effort',
 'reasoning-profile','plan-model','ocr-model','review-model','escalation','escalation-model','escalation-effort','ocr-batch-size','ocr-parallel','plan-format','review-format','execution'];
export const USAGE='Usage: node src/separate.mjs --input=image.png --out=runs/example [--mode=fast|baseline] [--stage=plan|assets|build] [--concurrency=1..6] [--bleed=0..0.25] [--image-effort|--plan-effort|--ocr-effort|--review-effort=low|medium|high] '+
 `[--reasoning-profile=${PROFILE_NAMES.join('|')}] [--plan-model|--ocr-model|--review-model=ID] [--escalation=auto|off|always] [--escalation-model=ID] [--escalation-effort=low|medium|high] [--ocr-batch-size=all|1..8] [--ocr-parallel=1..3] [--plan-format=compact|full] [--review-format=compact|full] [--execution=overlap|ordered]`;
export function parseMode(mode){if(!MODES.includes(mode))throw Error(`Mode must be one of ${MODES.join(', ')}`);return mode;}
export function parseBleed(value){
 // Fraction of width/height outpainted on EACH side. Planner allows 0.15 overflow.
 if(typeof value==='string'){if(!/^\s*(\d+(\.\d*)?|\.\d+)\s*$/.test(value))throw Error('Bleed must be a number from 0 to 0.25');value=Number(value);}
 if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>.25)throw Error('Bleed must be a number from 0 to 0.25');
 return value;
}
export function resolveEffort(mode,overrides={}){
 const out={...EFFORT_DEFAULTS[parseMode(mode)]};
 for(const[key,value]of Object.entries(overrides)){if(value===undefined)continue;if(!(key in out))throw Error('Unknown effort '+key);if(!EFFORTS.includes(value))throw Error(`${key} effort must be one of ${EFFORTS.join(', ')}`);out[key]=value;}
 return out;
}
export function parseOptions(argv,env=process.env){
 const args={};
 for(const a of argv){if(!a.startsWith('--'))throw Error(`Unexpected argument ${a}\n${USAGE}`);const[k,...v]=a.slice(2).split('=');if(!KNOWN.includes(k))throw Error(`Unknown option --${k}\n${USAGE}`);if(k in args)throw Error(`Duplicate option --${k}`);args[k]=v.length?v.join('='):true;}
 const value=k=>{if(args[k]===undefined)return undefined;if(args[k]===true||args[k]==='')throw Error(`--${k} needs a value\n${USAGE}`);return args[k];};
 const input=value('input'),out=value('out');if(!input||!out)throw Error(USAGE);
 const mode=parseMode(value('mode')??'fast'),stage=value('stage');if(stage!==undefined&&!STAGES.includes(stage))throw Error(`Stage must be one of ${STAGES.join(', ')}`);
 // Explicit flag > LAYER_LAB_CONCURRENCY > mode default (fast 6, baseline 3).
 const concurrency=value('concurrency')!==undefined?parseConcurrency(value('concurrency')):env.LAYER_LAB_CONCURRENCY!==undefined?parseConcurrency(env.LAYER_LAB_CONCURRENCY):mode==='fast'?6:3;
 const bleed=value('bleed')===undefined?.12:parseBleed(value('bleed'));
 // Fast CLI uses V9 compact reasoning; baseline retains the legacy quality control.
 const reasoning=resolveReasoning(value('reasoning-profile')??(mode==='fast'?'accelerated':'quality'),{planModel:value('plan-model'),ocrModel:value('ocr-model'),reviewModel:value('review-model'),
  planEffort:value('plan-effort'),ocrEffort:value('ocr-effort'),reviewEffort:value('review-effort'),escalation:value('escalation'),escalationModel:value('escalation-model'),
  escalationEffort:value('escalation-effort'),ocrBatchSize:value('ocr-batch-size'),ocrParallel:value('ocr-parallel'),planFormat:value('plan-format'),reviewFormat:value('review-format')});
 // The image wrapper effort stays mode-based and independent of the reasoning profile.
 const effort=resolveEffort(mode,{image:value('image-effort'),plan:reasoning.stages.plan.primary.effort,ocr:reasoning.stages.ocr.primary.effort,review:reasoning.stages.review.primary.effort});
 const execution=value('execution')??(mode==='fast'?'overlap':'ordered');if(!['ordered','overlap'].includes(execution))throw Error('Execution must be ordered or overlap');
 return{input,out,mode,stage,concurrency,bleed,effort,reasoning,execution};
}
