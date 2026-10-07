import sharp from 'sharp';
import path from 'node:path';
import {writeFile,mkdir,rename,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';

export async function composite(manifest,root=process.cwd(),{viewport}={}){
  const area=viewport||{x:0,y:0,width:manifest.width,height:manifest.height};
  const overlays=[];
  for(const layer of manifest.layers)if(layer.visible!==false){
    const input=path.resolve(root,layer.file),meta=await sharp(input).metadata();
    const x=Math.round((layer.x||0)-area.x),y=Math.round((layer.y||0)-area.y);
    const width=layer.width||meta.width,height=layer.height||meta.height;
    const left=Math.max(0,x),top=Math.max(0,y),right=Math.min(area.width,x+width),bottom=Math.min(area.height,y+height);
    if(right<=left||bottom<=top)continue;
    let bytes=await sharp(input).resize(width,height).extract({left:left-x,top:top-y,width:right-left,height:bottom-top}).png().toBuffer();
    if(layer.opacity!==undefined&&layer.opacity!==1){const raw=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});for(let p=3;p<raw.data.length;p+=4)raw.data[p]=Math.round(raw.data[p]*layer.opacity);bytes=await sharp(raw.data,{raw:raw.info}).png().toBuffer();}
    overlays.push({input:bytes,left,top});
  }
  return sharp({create:{width:area.width,height:area.height,channels:4,background:'#00000000'}}).composite(overlays).png().toBuffer();
}

export async function compare(a,b,{diffPath}={}){
  const [aa,bb]=await Promise.all([a,b].map(x=>sharp(x).flatten({background:'#fff'}).removeAlpha().raw().toBuffer({resolveWithObject:true})));
  if(aa.info.width!==bb.info.width||aa.info.height!==bb.info.height)throw new Error('Comparison dimensions differ');
  let ae=0,se=0,max=0,exact=0;const diff=Buffer.alloc(aa.data.length);
  for(let p=0;p<aa.data.length;p+=3){let pixelMax=0;for(let c=0;c<3;c++){
    const e=Math.abs(aa.data[p+c]-bb.data[p+c]);ae+=e;se+=e*e;max=Math.max(max,e);pixelMax=Math.max(pixelMax,e);diff[p+c]=Math.min(255,e*5);
  }if(pixelMax===0)exact++;}
  if(diffPath)await sharp(diff,{raw:aa.info}).png().toFile(diffPath);
  const n=aa.data.length,mse=se/n;
  return {mae:ae/n,rmse:Math.sqrt(mse),psnr:mse===0?null:10*Math.log10(255*255/mse),maxChannelError:max,
    exactPixelPercent:exact/(n/3)*100,identical:se===0,width:aa.info.width,height:aa.info.height};
}

// Preserve full canvas alignment, then trim only alpha=0 margins. Never rescale an extracted object to its guessed bounding box.
export async function normalizeLayer(input,output,{width,height,background=false}={}){
  const meta=await sharp(input).metadata();
  if(Math.abs(meta.width/meta.height-width/height)>.025)throw new Error(`Imagegen changed the canvas aspect ratio: ${meta.width}x${meta.height}`);
  const raw=await sharp(input).resize(width,height,{fit:'fill'}).ensureAlpha().raw().toBuffer();
  let left=width,top=height,right=-1,bottom=-1,opaque=0;
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const a=raw[(y*width+x)*4+3];if(a>2){left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);}if(a===255)opaque++;
  }
  if(right<left)throw new Error('Generated layer is empty');
  if(!background&&opaque===width*height)throw new Error('Foreground has no alpha channel; refusing a flattened/checkerboard layer');
  if(background){left=0;top=0;right=width-1;bottom=height-1;}
  await mkdir(path.dirname(output),{recursive:true});
  await sharp(raw,{raw:{width,height,channels:4}}).extract({left,top,width:right-left+1,height:bottom-top+1}).png().toFile(output);
  return {x:left,y:top,width:right-left+1,height:bottom-top+1,originalGenerationSize:{width:meta.width,height:meta.height},opaquePixelPercent:opaque/(width*height)*100};
}

// Readers running concurrently see either the old or the new complete file.
export async function writeFileAtomic(file,bytes){
  await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+randomUUID()+'.tmp';
  try{await writeFile(temporary,bytes);await rename(temporary,file);}
  finally{await rm(temporary,{force:true});}
}

export async function saveJSON(file,data){await writeFileAtomic(file,JSON.stringify(data,null,2)+'\n');}
