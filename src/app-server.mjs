import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdirSync, appendFileSync, writeFileSync, copyFileSync, existsSync} from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';

// Official JSONL app-server protocol. Authentication stays inside Codex.
export class CodexServer extends EventEmitter {
  constructor({cwd=process.cwd(), logDir, config=[]}={}) {
    super(); this.cwd=cwd; this.pending=new Map(); this.seq=0; this.logDir=logDir;
    if(logDir) mkdirSync(logDir,{recursive:true});
    const localBin=path.join(cwd,'node_modules','.bin','codex');
    this.proc=spawn(process.env.CODEX_BIN || (existsSync(localBin)?localBin:'codex'),['app-server',...config.flatMap(x=>['-c',x])],{cwd,stdio:['pipe','pipe','pipe']});
    this.proc.stderr.on('data',b=>{if(logDir) appendFileSync(path.join(logDir,'stderr.log'),b);});
    createInterface({input:this.proc.stdout}).on('line',line=>{
      let msg;try{msg=JSON.parse(line);}catch{return;}
      if(msg.id!==undefined && !msg.method){const p=this.pending.get(msg.id);if(p){this.pending.delete(msg.id);clearTimeout(p.timer);msg.error?p.reject(new Error(JSON.stringify(msg.error))):p.resolve(msg.result);}return;}
      if(msg.method && msg.id!==undefined){
        // Never approve commands implicitly. The pipeline only needs hosted image tools.
        this.proc.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Interactive action not supported by Layer Lab'}})+'\n');
      }
      this.emit('notification',msg);
    });
    this.proc.on('error',e=>{this.emit('serverError',e);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();});
    this.proc.on('exit',code=>{const e=new Error(`app-server exited (${code})`);for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);}this.pending.clear();this.emit('serverExit',e);});
  }
  request(method,params={},timeout=60000){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Timed out: ${method}`));},timeout);this.pending.set(id,{resolve,reject,timer});this.proc.stdin.write(JSON.stringify({id,method,params})+'\n');});}
  async init(){const info=await this.request('initialize',{clientInfo:{name:'layer_lab',title:'Layer Lab',version:'0.1.0'},capabilities:{experimentalApi:true}});this.proc.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');return info;}
  async thread(options={}){return this.request('thread/start',{cwd:this.cwd,ephemeral:true,experimentalRawEvents:true,approvalPolicy:'never',sandbox:'read-only',...options});}
  async turn(threadId,{prompt,images=[],schema,effort='high',timeout=1200000,onEvent=()=>{}}){
    const items=[],raw=[];let text='',turnId,abort;
    const completed=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{if(turnId)this.request('turn/interrupt',{threadId,turnId}).catch(()=>{});abort(new Error('Generation timed out'));},timeout);
      const cleanup=()=>{clearTimeout(timer);this.off('notification',listener);this.off('serverExit',abort);this.off('serverError',abort);};
      abort=e=>{cleanup();reject(e);};
      const listener=msg=>{
        const p=msg.params||{};
        // Untagged/global messages must never complete another thread's turn.
        if(p.threadId!==threadId)return;
        if(turnId&&(p.turnId||p.turn?.id)&&(p.turnId||p.turn?.id)!==turnId)return;
        if(msg.method==='item/completed'){items.push(p.item);if(p.item?.type==='agentMessage'&&p.item.phase!=='commentary')text+=p.item.text+'\n';}
        if(msg.method==='rawResponseItem/completed')raw.push(p.item);
        onEvent(msg);
        if(msg.method==='turn/completed'){cleanup();p.turn?.status!=='completed'?reject(new Error(JSON.stringify(p.turn.error||p.turn.status))):resolve({text:text.trim(),items,raw,turn:p.turn});}
      };this.on('notification',listener);this.on('serverExit',abort);this.on('serverError',abort);
    });
    completed.catch(()=>{});
    try{const result=await this.request('turn/start',{threadId,effort,input:[...images.map(p=>({type:'localImage',path:path.resolve(p),detail:'original'})),{type:'text',text:prompt}],...(schema?{outputSchema:schema}:{})});turnId=result.turn.id;}catch(e){abort(e);}
    return completed;
  }
  close(){this.proc.stdin.end();this.proc.kill();}
}

export function saveTurn(result,dir){
  mkdirSync(dir,{recursive:true});let idx=0;const images=[];
  const clean=JSON.parse(JSON.stringify(result,(k,v)=> typeof v==='string' && v.length>100000 ? `[binary omitted: ${v.length} chars]`:v));
  for(const item of result.items){if(item?.type!=='imageGeneration')continue;const dest=path.join(dir,`image-${++idx}.png`);
    if(item.savedPath&&existsSync(item.savedPath))copyFileSync(item.savedPath,dest);
    else if(item.result?.startsWith('data:'))writeFileSync(dest,Buffer.from(item.result.split(',')[1],'base64'));
    else if(item.result?.length>1000)writeFileSync(dest,Buffer.from(item.result,'base64'));
    else continue;
    images.push(dest);
  }
  writeFileSync(path.join(dir,'turn.json'),JSON.stringify(clean,null,2));
  return images;
}
