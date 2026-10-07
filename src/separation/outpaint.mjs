import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {hash,readJSON,cropReference} from './core.mjs';
import {saveJSON} from '../images.mjs';
// Runs through the shared image pool, so outpainting counts against --concurrency.
// slotHeld: caller already owns the clean plate's slot and continues in it.
// Only touches the background record/crops, which no other task writes meanwhile.
export async function outpaint(s,{priority=0,slotHeld=false}={}){
 const job=s.planData.jobs.find(j=>j.kind==='background'),recordFile=path.join(s.dir,'assets',job.id+'.json'),r=await readJSON(recordFile);
 if(!r)throw Error('Missing generated background plate '+job.id);
 if(!s.bleed){if(r.outpaint){const restored={...r,x:0,y:0,width:s.width,height:s.height,file:r.outpaint.cleanPlate};delete restored.outpaint;await saveJSON(recordFile,restored);}return;}
 if(r.outpaint?.sourceHash===s.sourceHash&&r.width===s.width+2*Math.round(s.width*s.bleed)&&r.height===s.height+2*Math.round(s.height*s.bleed)){s.timeline.cache('outpaint',job.id,true);return;}
 s.timeline.cache('outpaint',job.id,false);
 const id='outpaint:'+job.id,slot=work=>slotHeld?s.timeline.track(id,'image',work):s.pool.run(work,{id,priority});
 await slot(async()=>{
 const cleanPlate=r.outpaint?.cleanPlate||r.file;
 const dx=Math.round(s.width*s.bleed),dy=Math.round(s.height*s.bleed),area={x:-dx,y:-dy,width:s.width+dx*2,height:s.height+dy*2},input=path.join(s.dir,'crops',job.id+'-outpaint.png');
 await sharp({create:{width:area.width,height:area.height,channels:4,background:'#08784a'}}).composite([{input:await fs.readFile(path.join(s.dir,cleanPlate)),left:dx,top:dy}]).png().toFile(input);
 const {outputs}=await s.ai.ai('03-background-outpaint',`Use case: precise-object-edit. Call imagegen once. Image1 is an already generated CLEAN background plate surrounded by green missing-image border. Replace ONLY the green border with coherent continuation of the photograph/background. The existing central ${s.width}x${s.height} scene at (${dx},${dy}) must keep the same scale and position. No reframing, zooming, recentering or adding subjects. No text, products or advertising overlays. Output opaque ${area.width}x${area.height}, full padded canvas. Preserve photographic lighting and natural edge continuity. referenced_image_paths=${JSON.stringify([input])}; transparent_background=false.`,{images:[input],effort:s.effort.image});
 if(outputs.length!==1)throw Error('Expected one outpainted image');
 const meta=await sharp(outputs[0]).metadata();if(Math.abs(Math.log(meta.width/meta.height/(area.width/area.height)))>.065)throw Error('Outpaint aspect drift');
 const file=`assets/${job.id}-${r.attempt}-outpaint.png`;await sharp(outputs[0]).resize(area.width,area.height).ensureAlpha().png().toFile(path.join(s.dir,file));
 await saveJSON(recordFile,{...r,...area,file,outpaint:{sourceHash:s.sourceHash,cleanPlate,rawFile:path.relative(s.dir,outputs[0]),provenance:{mode:s.mode,imageWrapperEffort:s.effort.image,wrapperModel:s.ai.model??null}},method:'Two-stage imagegen clean plate + outpainting'});
 await cropReference(s.source,area,path.join(s.dir,'crops',job.id+'.png'));
 });
}
