const CONCURRENCY_ERROR='Concurrency must be an integer from 1 to 6';
export function parseConcurrency(value=process.env.LAYER_LAB_CONCURRENCY??3){
  // Reject booleans (`--concurrency` without a value) and fractional/blank strings.
  if(typeof value==='string'){value=value.trim();if(!/^\d+$/.test(value))throw new Error(CONCURRENCY_ERROR);}
  else if(typeof value!=='number')throw new Error(CONCURRENCY_ERROR);
  const count=Number(value);
  if(!Number.isInteger(count)||count<1||count>6)throw new Error(CONCURRENCY_ERROR);
  return count;
}

// Drain all independent tasks before returning an error. Callers can safely close
// a shared app-server afterwards, and successful outputs remain resumable.
export async function mapConcurrent(items,limit,work){
  limit=parseConcurrency(limit);
  const results=new Array(items.length),failures=[];let next=0;
  async function worker(){
    while(next<items.length){
      const index=next++;
      try{results[index]=await work(items[index],index);}
      catch(error){failures.push({index,error});}
    }
  }
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));
  if(failures.length){
    failures.sort((a,b)=>a.index-b.index);
    throw new AggregateError(failures.map(f=>f.error),failures.map(f=>`Task ${f.index+1}: ${f.error.message}`).join('; '));
  }
  return results;
}

// Wait for every promise, then fail with all errors. Nothing is left running when
// this rejects, so a shared app-server can be closed safely by the caller.
export async function settleAll(promises,label='Tasks failed'){
  const settled=await Promise.allSettled(promises),errors=settled.filter(r=>r.status==='rejected').map(r=>r.reason);
  if(errors.length)throw new AggregateError(errors,`${label}: ${errors.map(e=>e.message).join('; ')}`);
  return settled.map(r=>r.value);
}

// One global slot pool for every image-generation call (assets AND outpainting).
// Lower priority numbers start first; equal priorities are FIFO. Work must never
// call run() on the same pool from inside a slot, or it could deadlock. `then`
// continues a dependent call in the SAME slot (e.g. outpaint after its clean plate),
// so it starts immediately without exceeding the limit; it tracks its own timing.
export class ImagePool{
  constructor(limit,timeline=null){this.limit=parseConcurrency(limit);this.timeline=timeline;this.active=0;this.peak=0;this.queue=[];this.seq=0;}
  run(work,{id='image',priority=1,then}={}){
    const readyAtMs=this.timeline?.now();
    return new Promise((resolve,reject)=>{
      this.queue.push({priority,seq:this.seq++,go:async()=>{
        this.active++;this.peak=Math.max(this.peak,this.active);let ok=false,value;
        try{value=await(this.timeline?this.timeline.track(id,'image',work,{readyAtMs}):work());if(then)value=await then(value);ok=true;}
        catch(error){value=error;}
        finally{this.active--;}
        ok?resolve(value):reject(value);this.pump();
      }});
      this.pump();
    });
  }
  pump(){this.queue.sort((a,b)=>a.priority-b.priority||a.seq-b.seq);while(this.active<this.limit&&this.queue.length)this.queue.shift().go();}
}

// FIFO slot limit for non-image reasoning calls (OCR batches and their escalations).
// Callers must not wait on unrelated work while holding a slot.
export function limiter(limit){
  let active=0;const queue=[];
  const pump=()=>{while(active<limit&&queue.length){active++;const{work,resolve,reject}=queue.shift();Promise.resolve().then(work).then(resolve,reject).finally(()=>{active--;pump();});}};
  return work=>new Promise((resolve,reject)=>{queue.push({work,resolve,reject});pump();});
}

const union=intervals=>{const out=[];for(const[a,b]of intervals.map(t=>[t.startedAtMs,t.endedAtMs]).sort((x,y)=>x[0]-y[0])){if(out.length&&a<=out.at(-1)[1])out.at(-1)[1]=Math.max(out.at(-1)[1],b);else out.push([a,b]);}return out;};
const length=spans=>spans.reduce((n,[a,b])=>n+b-a,0);
const overlap=(tasks,spans)=>tasks.reduce((n,t)=>n+spans.reduce((m,[a,b])=>m+Math.max(0,Math.min(b,t.endedAtMs)-Math.max(a,t.startedAtMs)),0),0);
const round=v=>Math.round(v*10)/10;

// Records ACTUAL measured intervals. Nothing here estimates a sequential baseline.
export class Timeline{
  constructor(clock=()=>performance.now()){this.clock=clock;this.t0=clock();this.startedAt=new Date().toISOString();this.tasks=[];this.cacheEvents=[];this.active={};this.peak={};}
  now(){return round(this.clock()-this.t0);}
  cache(kind,id,hit){this.cacheEvents.push({kind,id,hit,atMs:this.now()});}
  async track(id,kind,work,{readyAtMs,meta}={}){
    const task={id,kind,...meta,readyAtMs:readyAtMs??this.now(),startedAtMs:this.now(),endedAtMs:null,status:'running'};this.tasks.push(task);
    this.active[kind]=(this.active[kind]||0)+1;this.peak[kind]=Math.max(this.peak[kind]||0,this.active[kind]);
    try{const result=await work();task.status='complete';return result;}
    catch(error){task.status='failed';task.error=error.message;throw error;}
    finally{task.endedAtMs=this.now();this.active[kind]--;}
  }
  report(){
    const done=this.tasks.filter(t=>t.endedAtMs!==null),images=done.filter(t=>t.kind==='image'),imageSpans=union(images);
    const outpaints=images.filter(t=>t.id.startsWith('outpaint:')),assetSpans=union(images.filter(t=>!t.id.startsWith('outpaint:')));
    const ocrs=done.filter(t=>t.kind==='reasoning'&&t.id==='ocr');
    // Diagnostic serial chain inferred from intervals, NOT a dependency critical path.
    // Latest prior end does not prove a dependency or queue predecessor.
    const observedSerialChain=[],seen=new Set();let current=done.reduce((a,t)=>!a||t.endedAtMs>a.endedAtMs?t:a,null);
    while(current){seen.add(current);const prev=done.filter(t=>!seen.has(t)&&t.endedAtMs<=current.startedAtMs).reduce((a,t)=>!a||t.endedAtMs>a.endedAtMs?t:a,null);
      observedSerialChain.unshift({id:current.id,kind:current.kind,startedAtMs:current.startedAtMs,endedAtMs:current.endedAtMs,queueWaitMs:round(current.startedAtMs-current.readyAtMs),gapBeforeMs:round(current.startedAtMs-(prev?.endedAtMs??0))});current=prev;}
    const cache={};for(const e of this.cacheEvents){const c=cache[e.kind]||={hits:0,misses:0,hitIds:[],missIds:[]};if(e.hit){c.hits++;c.hitIds.push(e.id);}else{c.misses++;c.missIds.push(e.id);}}
    return{startedAt:this.startedAt,wallMs:this.now(),peakConcurrency:{...this.peak},imageBusyMs:round(length(imageSpans)),imageTaskSumMs:round(images.reduce((n,t)=>n+t.endedAtMs-t.startedAtMs,0)),
      overlap:{ocrWithImageGenerationMs:round(overlap(union(ocrs).map(([startedAtMs,endedAtMs])=>({startedAtMs,endedAtMs})),imageSpans)),outpaintWithOtherImageGenerationMs:round(overlap(outpaints,assetSpans))},observedSerialChain,cache,
      tasks:this.tasks.map(t=>({...t,queueWaitMs:round(t.startedAtMs-t.readyAtMs),durationMs:t.endedAtMs===null?null:round(t.endedAtMs-t.startedAtMs)})),
      note:'All values are measured intervals from this process. imageTaskSumMs is a sum of overlapping tasks, not a sequential baseline; compare against a separate --mode=baseline run.'};
  }
}
