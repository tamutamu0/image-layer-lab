import {readFile,mkdir,writeFile,copyFile} from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {saveJSON} from './images.mjs';

// Bounded least-squares projection onto the original visible RGB. Alpha, geometry,
// layer order, and fully occluded generated pixels are unchanged. This improves
// reconstruction, but a wrong alpha mask can bake a ghost into the wrong layer.
// The raw result and a correction map are always retained for honest inspection.
export async function anchorVisiblePixels(runDir){
  const root=path.resolve(runDir),manifest=JSON.parse(await readFile(path.join(root,'manifest.json'),'utf8'));
  const {width,height}=manifest,n=manifest.layers.length;
  const src=await sharp(path.join(root,manifest.source)).flatten({background:'#fff'}).removeAlpha().raw().toBuffer();
  const buffers=[];
  for(const l of manifest.layers)buffers.push(await sharp({create:{width,height,channels:4,background:'#00000000'}})
    .composite([{input:path.join(root,l.file),left:l.x,top:l.y}]).raw().toBuffer());
  const alpha=buffers[0];for(let p=3;p<alpha.length;p+=4)if(alpha[p]!==255)throw new Error('Pixel anchoring needs an opaque background plate');
  const weights=new Float64Array(n),values=new Float64Array(n);
  const changes=new Float64Array(n),hidden=new Float64Array(n),visible=new Float64Array(n);
  const heat=Buffer.alloc(width*height*3);let uncoveredHighChange=0;
  for(let p=0;p<width*height;p++){
    const o=p*4;let remaining=1;
    for(let i=n-1;i>=0;i--){const a=buffers[i][o+3]/255;weights[i]=remaining*a;remaining*=1-a;if(weights[i]===0&&a>0)hidden[i]++;else if(weights[i]>0)visible[i]++;}
    let pixelChange=0;
    for(let c=0;c<3;c++){
      let sum=0;for(let i=0;i<n;i++){values[i]=buffers[i][o+c];sum+=weights[i]*values[i];}
      let error=src[p*3+c]-sum;
      for(let iteration=0;iteration<=n&&Math.abs(error)>.0001;iteration++){
        let denominator=0;for(let i=0;i<n;i++)if((error>0?values[i]<255:values[i]>0))denominator+=weights[i]*weights[i];
        if(denominator===0)break;
        const correction=error/denominator;sum=0;
        for(let i=0;i<n;i++){values[i]=Math.max(0,Math.min(255,values[i]+correction*weights[i]));sum+=weights[i]*values[i];}
        error=src[p*3+c]-sum;
      }
      for(let i=0;i<n;i++){
        if(weights[i]===0)continue;
        const value=Math.round(values[i]),delta=Math.abs(value-buffers[i][o+c]);
        changes[i]+=delta;pixelChange=Math.max(pixelChange,delta);buffers[i][o+c]=value;
      }
    }
    if(weights[0]>.99&&pixelChange>32)uncoveredHighChange++;
    heat[p*3]=Math.min(255,pixelChange*4);heat[p*3+1]=Math.min(255,pixelChange);heat[p*3+2]=Math.min(255,pixelChange*.4);
  }
  const out=path.join(root,'anchored');await mkdir(path.join(out,'layers'),{recursive:true});
  const layers=[];
  for(const [i,l] of manifest.layers.entries()){
    await sharp(buffers[i],{raw:{width,height,channels:4}}).extract({left:l.x,top:l.y,width:l.width,height:l.height}).png().toFile(path.join(out,l.file));
    layers.push({...l,method:l.method+'+visible-pixel-projection',meanVisibleColorAdjustment:changes[i]/Math.max(1,visible[i]*3),fullyHiddenPixelsPreserved:hidden[i]});
  }
  await copyFile(path.join(root,manifest.source),path.join(out,'source.png'));
  try{await copyFile(path.join(root,'plan.json'),path.join(out,'plan.json'));}catch(e){if(e.code!=='ENOENT')throw e;}
  const anchored={...manifest,layers,provenance:{...manifest.provenance,refinement:'source RGB projection; alpha and fully occluded RGB unchanged'}};
  await saveJSON(path.join(out,'manifest.json'),anchored);
  await sharp(heat,{raw:{width,height,channels:3}}).png().toFile(path.join(out,'corrections.png'));
  await saveJSON(path.join(out,'anchoring.json'),{method:'bounded least-squares visible RGB projection',
    note:'Composite similarity does not prove correct semantic separation. Inspect isolated/moved layers for ghosts, especially high-correction areas.',
    uncoveredHighCorrectionPixelPercent:uncoveredHighChange/(width*height)*100,
    layers:layers.map(l=>({id:l.id,meanVisibleColorAdjustment:l.meanVisibleColorAdjustment,fullyHiddenPixelsPreserved:l.fullyHiddenPixelsPreserved}))});
  return out;
}
