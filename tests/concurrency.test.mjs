import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {mapConcurrent,parseConcurrency} from '../src/concurrency.mjs';
import {CodexServer} from '../src/app-server.mjs';
import {Pipeline} from '../src/pipeline.mjs';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('bounded pool preserves order and drains other work after a failure',async()=>{
  let active=0,peak=0;const done=[];
  const results=await mapConcurrent([30,5,10,1],2,async(ms,i)=>{
    peak=Math.max(peak,++active);await delay(ms);active--;return i;
  });
  assert.equal(peak,2);assert.deepEqual(results,[0,1,2,3]);
  await assert.rejects(mapConcurrent([0,1,2],2,async i=>{
    if(i===0)throw new Error('one failed');await delay(5);done.push(i);
  }),AggregateError);
  assert.deepEqual(done.sort(),[1,2]);assert.equal(active,0);
  for(const value of [0,7,1.5,'bad',''])assert.throws(()=>parseConcurrency(value));
});

test('concurrent callers share initialization and wait for it to finish',async()=>{
  const pipeline=new Pipeline();let calls=0,ready=false;
  pipeline.initialize=async()=>{calls++;pipeline.server={close(){}};await delay(15);ready=true;};
  await Promise.all(Array.from({length:6},async()=>{await pipeline.connect();assert.equal(ready,true);}));
  assert.equal(calls,1);pipeline.close();
});

test('interleaved app-server events cannot mix threads, turns or untagged messages',async()=>{
  const client=new EventEmitter();Object.setPrototypeOf(client,CodexServer.prototype);
  client.request=async(_method,{threadId})=>({turn:{id:'turn-'+threadId}});
  const a=client.turn('a',{prompt:'A'}),b=client.turn('b',{prompt:'B'});
  await Promise.resolve();
  const event=(method,params)=>client.emit('notification',{method,params});
  event('turn/completed',{turn:{id:'unowned',status:'completed'}});
  event('item/completed',{threadId:'a',turnId:'old-a',item:{type:'agentMessage',text:'stale'}});
  event('item/completed',{threadId:'b',turnId:'turn-b',item:{type:'imageGeneration',savedPath:'b.png'}});
  event('item/completed',{threadId:'a',turnId:'turn-a',item:{type:'imageGeneration',savedPath:'a.png'}});
  event('turn/completed',{threadId:'b',turn:{id:'turn-b',status:'completed'}});
  event('item/completed',{threadId:'a',turnId:'turn-a',item:{type:'agentMessage',phase:'final_answer',text:'A'}});
  event('turn/completed',{threadId:'a',turn:{id:'turn-a',status:'completed'}});
  const [aa,bb]=await Promise.all([a,b]);
  assert.equal(aa.items[0].savedPath,'a.png');assert.equal(aa.text,'A');
  assert.equal(bb.items[0].savedPath,'b.png');assert.equal(bb.items.length,1);
  assert.equal(client.listenerCount('notification'),0);assert.equal(client.listenerCount('serverError'),0);
});

test('parallel extraction checkpoints successes, resumes only failure, and preserves layer stack',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-parallel-'));
  try{
    await sharp({create:{width:16,height:16,channels:4,background:'#ffffff'}}).png().toFile(path.join(dir,'source.png'));
    const layers=['background','slow','failure','fast'].map((id,i)=>({id,name:id,kind:i===0?'background':'product',bbox:{x:0,y:0,width:1000,height:1000}}));
    await writeFile(path.join(dir,'plan.json'),JSON.stringify({title:'Parallel test',width:16,height:16,layers}));
    const pipeline=new Pipeline({runDir:dir,concurrency:2,onProgress:()=>{}});
    let active=0,peak=0,fail=true;const calls=[];
    pipeline.ai=async(stage)=>{
      const id=stage.slice(3);calls.push(id);peak=Math.max(peak,++active);
      try{
        await delay(id==='slow'?30:5);
        if(id==='failure'&&fail)throw new Error('test failure');
        const file=path.join(dir,id+'.png');
        await sharp({create:{width:16,height:16,channels:4,background:{r:30,g:40,b:50,alpha:id==='background'?1:.5}}}).png().toFile(file);
        return {outputs:[file]};
      }finally{active--;}
    };
    await assert.rejects(pipeline.extract(),AggregateError);
    assert.equal(peak,2);assert.equal(active,0);
    const progress=JSON.parse(await readFile(path.join(dir,'progress.json')));
    assert.deepEqual(progress.completed,['background','slow','fast']);assert.deepEqual(progress.active,[]);
    assert.equal(progress.failed[0].id,'failure');
    calls.length=0;fail=false;
    const manifest=await pipeline.extract();
    assert.deepEqual(calls,['failure']);assert.deepEqual(manifest.layers.map(l=>l.id),layers.map(l=>l.id));
    const timing=JSON.parse(await readFile(path.join(dir,'extraction-timing.json')));assert.equal(timing.cached,3);
  }finally{await rm(dir,{recursive:true,force:true});}
});
