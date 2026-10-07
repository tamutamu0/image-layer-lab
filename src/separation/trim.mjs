import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {readJSON} from './core.mjs';
import {saveJSON,composite,compare} from '../images.mjs';
export async function trimTransparentMargins(dir){
 const p=await readJSON(path.join(dir,'plan.json')),before=await readJSON(path.join(dir,'registered.json')),after=[];
 for(const a of before){if(a.kind==='background'){after.push(a);continue;}
  const im=await sharp(path.join(dir,a.file)).ensureAlpha().raw().toBuffer({resolveWithObject:true});let left=im.info.width,top=im.info.height,right=-1,bottom=-1;
  for(let y=0;y<im.info.height;y++)for(let x=0;x<im.info.width;x++)if(im.data[(y*im.info.width+x)*4+3]!==0){left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);}
  if(right<left)throw Error('Generated asset is empty: '+a.id);
  left=Math.max(0,left-2);top=Math.max(0,top-2);right=Math.min(im.info.width-1,right+2);bottom=Math.min(im.info.height-1,bottom+2);
  const width=right-left+1,height=bottom-top+1,file=`assets/${a.id}-${a.attempt}-tight.png`;
  await sharp(path.join(dir,a.file)).extract({left,top,width,height}).png().toFile(path.join(dir,file));
  const registration=a.registration?.matrix?structuredClone(a.registration):{method:a.registration?.method||'identity',matrix:[[1,0,0],[0,1,0]],canvasOffset:[0,0]};registration.canvasOffset[0]+=left;registration.canvasOffset[1]+=top;
  after.push({...a,file,x:a.x+left,y:a.y+top,width,height,registration,transparentMarginTrim:{left,top,right:im.info.width-right-1,bottom:im.info.height-bottom-1,discardedNonzeroAlphaPixels:0}});
 }
 const test=await compare(await composite({width:p.width,height:p.height,layers:before},dir),await composite({width:p.width,height:p.height,layers:after},dir));if(!test.identical)throw Error('Transparent trimming changed visible pixels');
 await saveJSON(path.join(dir,'registered.json'),after);await saveJSON(path.join(dir,'trim-verification.json'),test);
}
