import {mkdir,readFile,copyFile,access} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import Ajv from 'ajv';
import {createHash} from 'node:crypto';
import {CodexServer,saveTurn} from './app-server.mjs';
import {planSchema} from './plan-schema.mjs';
import {normalizeLayer,composite,compare,saveJSON} from './images.mjs';
import {exportSketch,renderSketch} from './sketch.mjs';
import {mapConcurrent,parseConcurrency} from './concurrency.mjs';

const root=process.cwd();
const exists=async f=>{try{await access(f);return true;}catch{return false;}};
export const defaultBrief=`Create a single square 1024x1024 advertising design for a fictional, unbranded product. Include a product photograph, a headline, grouped benefit copy and a call-to-action. Use only fictional brand names and supplied user copy. Do not invent prices, discounts, testimonials or product efficacy claims. Produce one flattened banner without mockup devices or explanatory captions.`;

export class Pipeline {
  constructor({runDir='runs/example',onProgress=console.log,allowDefaultImagegen=true,concurrency}={}){
    this.dir=path.resolve(runDir);this.progress=onProgress;this.allowDefaultImagegen=allowDefaultImagegen;
    this.concurrency=parseConcurrency(concurrency);
  }
  async connect(){
    if(!this.connection)this.connection=this.initialize().catch(error=>{this.server?.close();this.server=null;this.connection=null;throw error;});
    return this.connection;
  }
  async initialize(){
    await mkdir(this.dir,{recursive:true});
    this.server=new CodexServer({cwd:root,logDir:path.join(this.dir,'logs')});
    const init=await this.server.init();
    this.catalog=await listModels(this.server);
    this.model=process.env.CODEX_MODEL||this.catalog.find(m=>m.isDefault)?.model;
    const account=await this.server.request('account/read',{});
    if(!account.account)throw new Error('Run codex login first. No API key is required.');
    await saveJSON(path.join(this.dir,'runtime.json'),{transport:'official Codex app-server JSONL',client:init,reasoningModel:this.model,
      reasoningModelSource:process.env.CODEX_MODEL?'CODEX_MODEL':'app-server default',listedModels:this.catalog.map(m=>({model:m.model??m.id,isDefault:!!m.isDefault,efforts:supportedEfforts(m)})),
      requestedImageModel:'GPT Image 2.5',actualImageModel:'not exposed by app-server; no model selector',
      defaultImagegenExplicitlyAllowed:this.allowDefaultImagegen,startedAt:new Date().toISOString()});
  }
  // A per-call route never mutates this.model, which the imagegen wrapper keeps using.
  async resolveRoute({model=null,effort='high'}={}){
    await this.connect();
    return checkRoute(this.catalog||[],{model,effort,fallbackModel:this.model,allowUnlisted:process.env.LAYER_LAB_ALLOW_UNLISTED_MODELS==='1'});
  }
  // effort is the agent turn's reasoning effort (default high). It never selects the
  // hosted image model or image quality; app-server exposes no such control.
  // model optionally overrides the reasoning model for THIS call only (validated, never substituted).
  async ai(stage,prompt,{images=[],schema,effort='high',model=null}={}){
    await this.connect();const dir=path.join(this.dir,'stages',stage);await mkdir(dir,{recursive:true});
    const route=await this.resolveRoute({model,effort});
    const effectivePrompt=schema||stage==='99-review'?prompt:'Use GPT Image 2.5 for image generation/editing if available in the hosted imagegen route. This is a user preference; do not claim that this prompt guarantees model selection.\n\n'+prompt;
    await saveJSON(path.join(dir,'request.json'),{stage,prompt:effectivePrompt,images,schema,model:route.resolvedModel,requestedModel:route.requestedModel,modelValidation:route.validation,effort});
    // Measured wall time of thread start + turn; no fallback route is ever tried here.
    const call={stage,requestedModel:route.requestedModel,resolvedModel:route.resolvedModel,modelValidation:route.validation,requestedEffort:effort,
      threadModel:null,threadReasoningEffort:null,startedAt:new Date().toISOString(),durationMs:null,status:'running'};
    (this.calls||=[]).push(call);const t0=performance.now();
    try{
      const thread=await this.server.thread({model:route.resolvedModel,developerInstructions:schema?
        'You are a READ-ONLY visual reasoning engine. Inspect the supplied images directly and return only the requested structured JSON. NEVER call imagegen, image generation/editing, exec, browser, filesystem or any other tool. This task is analysis/transcription/planning only, not image creation. Do not ask questions.':
        'You are the engine of a local image-layer laboratory. Follow the task exactly. Use only the hosted imagegen tool for image synthesis/editing. Do not use exec, filesystem editing, browser, or other tools. Input local images may be passed directly to imagegen by their absolute paths. Do not ask questions. When imagegen is requested, call it exactly once and then report the generated image. Never claim a specific image model unless exposed by the tool.'});
      // Record what app-server reports, if anything; null means it was not exposed.
      call.threadModel=thread?.model??null;call.threadReasoningEffort=thread?.reasoningEffort??null;
      if(route.requestedModel&&call.threadModel&&call.threadModel!==route.resolvedModel)throw new Error(`app-server started ${call.threadModel} instead of requested ${route.resolvedModel}; refusing silent model substitution`);
      this.progress(`${stage}: AI running`);
      const result=await this.server.turn(thread.thread.id,{prompt:effectivePrompt,images,schema,effort,onEvent:msg=>{
        if(msg.method==='item/started'&&msg.params?.item?.type==='imageGeneration')this.progress(`${stage}: imagegen started`);
      }});
      const outputs=saveTurn(result,dir);
      if(schema&&(result.items??[]).some(i=>i.type==='imageGeneration'))throw new Error('Read-only reasoning attempted image generation; output rejected');
      call.status='complete';this.progress(`${stage}: complete`);return {result,outputs,call};
    }catch(error){call.status='failed';call.error=error.message;throw error;}
    finally{call.durationMs=Math.round(performance.now()-t0);await saveJSON(path.join(dir,'call.json'),call).catch(()=>{});}
  }
  async generate(brief=defaultBrief,{referenceImages=[]}={}){
    this.requireImagegen();
    if(await exists(path.join(this.dir,'source.png')))throw new Error('This run already contains a source image. Use --run=runs/new-name to create a separate experiment.');
    const refs=referenceImages.map(file=>path.resolve(file));
    const {outputs}=await this.ai('00-banner',`Use imagegen to generate this finished banner. Set transparent_background=false. Use referenced_image_paths=${JSON.stringify(refs)}.\n\n${brief}`,{images:refs});
    if(outputs.length!==1)throw new Error(`Expected one imagegen output; got ${outputs.length}. Inspect stages/00-banner/turn.json.`);
    await sharp(outputs[0]).png().toFile(path.join(this.dir,'source.png'));
    return path.join(this.dir,'source.png');
  }
  requireImagegen(){if(!this.allowDefaultImagegen)throw new Error('This Codex imagegen exposes no model selector. GPT Image 2.5 cannot be guaranteed. Explicitly allow the default tool (--allow-default-imagegen) before generation.');}
  async plan(){
    const source=path.join(this.dir,'source.png');
    if(await exists(path.join(this.dir,'manifest.json')))throw new Error('This run already has extracted layers. Create a new run before changing its plan.');
    const meta=await sharp(source).metadata();
    const {result}=await this.ai('01-plan',`Inspect this flattened advertising image. Decide its semantic editable layer structure YOURSELF. Return JSON only. Layers are ordered BACK TO FRONT. Use production-useful granularity, normally 12–24 layers for a dense ad. Separately identify each benefit-circle surface, its icons, ribbon body, CTA body and arrow, offer badge, product, typography blocks, shadows and visual effects. White haze, local text halos, and sparkle highlights must be independent effect layers rather than omitted or baked into photography. Keep connected copy blocks together; do not split individual glyphs. Do not merge disconnected objects merely to reduce layer count. Every layer must include its entire object, including portions hidden by other layers (amodal completion). The background must contain a full clean plate behind all objects. Identify which front layers occlude each layer. Bbox coordinates are normalized to 0–1000 on the full ${meta.width}×${meta.height} canvas and should include the inferred hidden extent. Names and explanations in Japanese, extractionPrompt in English. Each extractionPrompt should precisely identify only that layer and describe how to recover missing content while preserving exact placement, appearance, shape, scale, typography and lighting. Do not invent or remove elements. Describe actual uncertainty. First layer must have kind background.`,{images:[source],schema:planSchema});
    const plan=JSON.parse(result.text);const validate=new Ajv({strict:false}).compile(planSchema);
    if(!validate(plan))throw new Error(`Invalid AI plan: ${JSON.stringify(validate.errors)}`);
    if(plan.layers[0].kind!=='background')throw new Error('AI plan must start with background');
    const ids=new Set(plan.layers.map(l=>l.id));if(ids.size!==plan.layers.length)throw new Error('Duplicate AI layer ids');
    for(const [i,l] of plan.layers.entries())for(const occluder of l.occludedBy)if(!plan.layers.slice(i+1).some(a=>a.id===occluder))throw new Error(`Invalid occlusion order: ${l.id} / ${occluder}`);
    await saveJSON(path.join(this.dir,'plan.json'),{...plan,width:meta.width,height:meta.height,sourceHash:await hashFile(source)});return plan;
  }
  async extract({only}={}){
    this.requireImagegen();
    const plan=JSON.parse(await readFile(path.join(this.dir,'plan.json'),'utf8'));
    const source=path.join(this.dir,'source.png');const layers=new Array(plan.layers.length);
    if(plan.sourceHash&&plan.sourceHash!==await hashFile(source))throw new Error('The source changed after planning. Use a new run.');
    const planHash=createHash('sha256').update(JSON.stringify(plan)).digest('hex');
    // Validate every cache before starting any remote work.
    const pending=[];
    for(const [i,layer] of plan.layers.entries()){
      const file=`layers/${layer.id}.png`,record=path.join(this.dir,`layers/${layer.id}.json`);
      if(await exists(record)){const cached=JSON.parse(await readFile(record,'utf8'));if(cached.planHash!==planHash)throw new Error(`Cached layer ${layer.id} belongs to another plan. Use a new run.`);if(await exists(path.join(this.dir,file))){layers[i]=cached;continue;}}
      if(only&&layer.id!==only)continue;
      pending.push({i,layer,file,record});
    }
    const cachedCount=layers.filter(Boolean).length;
    const started=Date.now(),active=new Set(),failed=[],timings=[];
    let writes=Promise.resolve();
    const snapshot=()=>{
      const state={completed:layers.filter(Boolean).map(l=>l.id),active:[...active],failed:[...failed],total:plan.layers.length,concurrency:this.concurrency};
      writes=writes.then(()=>saveJSON(path.join(this.dir,'progress.json'),state));return writes;
    };
    this.progress(`Extracting ${pending.length} layers; concurrency ${this.concurrency}`);
    await snapshot();
    try{await mapConcurrent(pending,this.concurrency,async({i,layer,file,record})=>{
      const start=Date.now();active.add(layer.id);await snapshot();
      try{
      const stage=`${String(i+2).padStart(2,'0')}-${layer.id}`;
      const background=layer.kind==='background';
      const instruction=background?
        'Return a completely filled opaque CLEAN BACKGROUND PLATE. Remove every other semantic object, all typography, product, pedestal and decorations unless explicitly part of this background layer. Fill the holes seamlessly. The parts of the background already visible should remain unchanged.':
        'Return an RGBA PNG with TRUE alpha transparency everywhere outside this ONE layer. No solid background, no checkerboard drawn into pixels, no new shadows unless this layer explicitly includes them. Keep this layer in EXACTLY its original location and scale on the FULL-SIZED canvas. Do not crop to the object or center it. Reconstruct the COMPLETE object including portions occluded by other layers; remove the occluding objects completely. Preserve all visible pixels and typography as closely as possible.';
      const prompt=`Use imagegen exactly once to edit the input image. referenced_image_paths=${JSON.stringify([source])}; transparent_background=${!background}.\nAMODAL LAYER EXTRACTION, not redesign. Canvas ${plan.width}×${plan.height}, same aspect ratio as input.\nTarget layer: ${layer.name}\nDescription: ${layer.description}\nApproximate full object bbox (0–1000): ${JSON.stringify(layer.bbox)}\nHidden content to complete: ${layer.hiddenContent}\n${layer.extractionPrompt}\n${instruction}\nDo not include any other layer. No labels, annotations or border.`;
      const {outputs}=await this.ai(stage,prompt,{images:[source]});
      if(outputs.length!==1)throw new Error(`Expected one output for ${layer.id}, got ${outputs.length}`);
      const geometry=await normalizeLayer(outputs[0],path.join(this.dir,file),{width:plan.width,height:plan.height,background});
      const saved={...layer,...geometry,file,planHash,amodal:true,method:'app-server-imagegen-amodal'};
      await saveJSON(record,saved);layers[i]=saved;
      }catch(error){failed.push({id:layer.id,error:error.message});throw error;}
      finally{const ended=Date.now();timings.push({id:layer.id,startedAt:new Date(start).toISOString(),endedAt:new Date(ended).toISOString(),durationMs:ended-start,status:layers[i]?'completed':'failed'});active.delete(layer.id);await snapshot();}
    });}finally{
      await writes;
      await saveJSON(path.join(this.dir,'extraction-timing.json'),{concurrency:this.concurrency,wallMs:Date.now()-started,tasks:timings,cached:cachedCount,note:'Sum of overlapping task durations is not a measured sequential baseline.'});
    }
    if(layers.filter(Boolean).length===plan.layers.length){
      this.model ||= JSON.parse(await readFile(path.join(this.dir,'runtime.json'),'utf8').catch(()=>'{}')).reasoningModel;
      const manifest={title:plan.title,width:plan.width,height:plan.height,source:'source.png',layers,
      composite:'composite.png',provenance:{planner:this.model,imageTool:'Codex app-server imagegen',imageModel:'not exposed',requestedImageModel:'GPT Image 2.5'}};
      await saveJSON(path.join(this.dir,'manifest.json'),manifest);return manifest;}
    return {completed:layers.filter(Boolean).length,total:plan.layers.length};
  }
  async build(){
    const manifest=JSON.parse(await readFile(path.join(this.dir,'manifest.json'),'utf8'));
    const merged=await composite(manifest,this.dir);await copyBuffer(merged,path.join(this.dir,'composite.png'));
    const decomposition=await compare(path.join(this.dir,'source.png'),merged,{diffPath:path.join(this.dir,'difference.png')});
    const file=path.join(this.dir,'layers.sketch');const archive=await exportSketch(manifest,file,{root:this.dir});
    const roundtrip=await renderSketch(file);await copyBuffer(roundtrip,path.join(this.dir,'sketch-roundtrip.png'));
    const serialization=await compare(merged,roundtrip);
    const report={decomposition,serialization,archive,note:'Decomposition similarity and Sketch serialization fidelity are separate. Hidden pixels are inferred, not recovered ground truth. Figma/Sketch UI import must be checked separately.'};
    await saveJSON(path.join(this.dir,'report.json'),report);this.progress('Sketch export and pixel checks complete');return report;
  }
  async review(){
    const plan=JSON.parse(await readFile(path.join(this.dir,'plan.json'),'utf8'));
    const {result}=await this.ai('99-review',`Compare images in order: ORIGINAL banner, RECOMPOSED layers, then each isolated layer in back-to-front order. Evaluate honestly in Japanese: placement/scale drift, text/brand changes, halos, missing elements, and whether hidden portions are plausibly complete. Distinguish exact appearance preservation from semantic approximation. Do not assume high quality. Give specific per-layer issues and a pass/needs-improvement verdict for professional banner editing. AI plan: ${JSON.stringify(plan)}`,{images:[path.join(this.dir,'source.png'),path.join(this.dir,'composite.png'),...plan.layers.map(l=>path.join(this.dir,`layers/${l.id}.png`))]});
    const {writeFile}=await import('node:fs/promises');await writeFile(path.join(this.dir,'review.md'),result.text+'\n');return result.text;
  }
  close(){this.server?.close();this.server=null;this.connection=null;}
}
async function listModels(server){
  const data=[];let cursor;
  for(let page=0;page<20;page++){const r=await server.request('model/list',cursor?{cursor}:{});data.push(...(r?.data||[]));cursor=r?.nextCursor;if(!cursor)break;}
  return data;
}
export function supportedEfforts(entry){return (entry?.supportedReasoningEfforts||[]).map(e=>typeof e==='string'?e:e?.reasoningEffort??e?.effort).filter(Boolean);}
// Strict model/effort validation against model/list. A requested model that is not
// listed is an error (LAYER_LAB_ALLOW_UNLISTED_MODELS=1 records it instead); there is
// no substitution with another model, including after network/auth/rate failures.
export function checkRoute(catalog,{model=null,effort='high',fallbackModel=null,allowUnlisted=false}={}){
  const wanted=model??fallbackModel??null,entry=wanted?catalog.find(m=>m.model===wanted||m.id===wanted):undefined;
  let validation;
  if(entry)validation='listed';
  else if(model){
    if(!catalog.length)validation='unverified: empty model/list';
    else if(allowUnlisted)validation='unlisted: allowed by LAYER_LAB_ALLOW_UNLISTED_MODELS';
    else throw new Error(`Model ${model} is not listed by app-server model/list; refusing to substitute another model. Listed: ${catalog.map(m=>m.model??m.id).join(', ')}`);
  }else validation=wanted?'inherited: not listed':'app-server default';
  const efforts=supportedEfforts(entry);
  if(efforts.length&&!efforts.includes(effort))throw new Error(`Reasoning effort ${effort} is not supported by ${wanted} (supported: ${efforts.join(', ')})`);
  return {requestedModel:model,resolvedModel:entry?.model??wanted,effort,validation,supportedEfforts:efforts.length?efforts:null};
}
async function copyBuffer(buf,file){const {writeFile}=await import('node:fs/promises');await writeFile(file,buf);}
async function hashFile(file){return createHash('sha256').update(await readFile(file)).digest('hex');}
