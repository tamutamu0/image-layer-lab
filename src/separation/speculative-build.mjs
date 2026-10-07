import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {createHash} from 'node:crypto';
import {build} from './build.mjs';
import {writeFileAtomic} from '../images.mjs';

// The runner drains BOTH review and export before any mutation. The snapshot owns
// its output files, so a rejected export never becomes the user-facing artifact.
export async function speculativeBuild(s,{buildFn=build}={}){
 const dir=path.join(s.dir,'.speculative',randomUUID());await fs.mkdir(dir,{recursive:true});
 try{
  const inputs=['source.png','registered.json','adjustments.json','text.json','plan.json'];
  for(const file of inputs)await fs.copyFile(path.join(s.dir,file),path.join(dir,file)).catch(e=>{if(e.code!=='ENOENT')throw e;});
  await fs.symlink(path.join(s.dir,'assets'),path.join(dir,'assets'),'dir');
  const snapshot=Object.assign(Object.create(Object.getPrototypeOf(s)),s,{dir,source:path.join(dir,'source.png')}),report=await buildFn(snapshot);
  let disposed=false;
  return{report,dir,
   async commit(){
    if(disposed)throw Error('Speculative export already disposed');
    try{
     const files=[];
     const walk=async sub=>{for(const entry of await fs.readdir(path.join(dir,sub),{withFileTypes:true})){const rel=path.join(sub,entry.name);if(!sub&&['assets',...inputs].includes(entry.name))continue;if(entry.isDirectory())await walk(rel);else if(entry.isFile())files.push(rel);else throw Error('Unexpected generated symlink '+rel);}};
     await walk('');
     // The self-contained Sketch ZIP is the published artifact: replace it LAST,
     // atomically, after auxiliaries. A commit receipt detects interrupted sidecar
     // promotion; no claim of a multi-file filesystem transaction is made.
     files.sort((a,b)=>Number(a==='layers.sketch')-Number(b==='layers.sketch'));
     const hashes={};for(const file of files){const bytes=await fs.readFile(path.join(dir,file));await writeFileAtomic(path.join(s.dir,file),bytes);hashes[file]=createHash('sha256').update(bytes).digest('hex');}
     await writeFileAtomic(path.join(s.dir,'export-commit.json'),JSON.stringify({id:path.basename(dir),files:hashes,committedAt:new Date().toISOString()},null,2));
     return report;
    }finally{disposed=true;await fs.rm(dir,{recursive:true,force:true});}
   },
   async discard(){if(!disposed){disposed=true;await fs.rm(dir,{recursive:true,force:true});}}
  };
 }catch(error){await fs.rm(dir,{recursive:true,force:true});throw error;}
}
