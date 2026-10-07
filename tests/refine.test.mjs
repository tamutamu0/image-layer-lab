import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {anchorVisiblePixels} from '../src/refine.mjs';
import {composite,compare,saveJSON} from '../src/images.mjs';

test('Visible pixel projection improves composition without changing hidden RGB or alpha',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'layer-anchor-'));
  try{
    await mkdir(path.join(dir,'layers'));
    const width=12,height=12;
    await sharp({create:{width,height,channels:4,background:'#aabbcc'}}).png().toFile(path.join(dir,'layers/back.png'));
    const front=Buffer.alloc(6*6*4);for(let p=0;p<36;p++){front[p*4]=220;front[p*4+1]=60;front[p*4+2]=90;front[p*4+3]=p<18?255:128;}
    await sharp(front,{raw:{width:6,height:6,channels:4}}).png().toFile(path.join(dir,'layers/front.png'));
    const manifest={title:'Test',width,height,source:'source.png',composite:'composite.png',layers:[
      {id:'back',name:'Background',file:'layers/back.png',x:0,y:0,width,height},
      {id:'front',name:'Front',file:'layers/front.png',x:3,y:3,width:6,height:6}]};
    await saveJSON(path.join(dir,'manifest.json'),manifest);
    // Different target colours challenge both opaque and semi-transparent regions.
    const target=await sharp({create:{width,height,channels:4,background:'#cc9955'}}).png().toBuffer();await writeFile(path.join(dir,'source.png'),target);
    const before=await compare(target,await composite(manifest,dir));
    const out=await anchorVisiblePixels(dir),after=JSON.parse(await readFile(path.join(out,'manifest.json')));
    const metric=await compare(target,await composite(after,out));assert.ok(metric.mae<1);assert.ok(metric.mae<before.mae/10);
    const back=await sharp(path.join(out,'layers/back.png')).ensureAlpha().raw().toBuffer();const p=(3*width+3)*4;
    assert.deepEqual([...back.subarray(p,p+4)],[170,187,204,255]);
    const updated=await sharp(path.join(out,'layers/front.png')).ensureAlpha().raw().toBuffer();
    for(let p=0;p<36;p++)assert.equal(updated[p*4+3],front[p*4+3]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
