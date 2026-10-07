import path from 'node:path';
import * as fontkit from 'fontkit';
import sharp from 'sharp';
const fonts=new Map();
function fontFor(family,weight){const key=family+weight;if(!fonts.has(key))fonts.set(key,fontkit.openSync(path.resolve('assets',family.replaceAll(' ','')+'.ttf')).getVariation({wght:weight}));return fonts.get(key);}
export function mapOCRBox(text,asset){const[x,y,w,h]=text.bbox;let corners=[[x,y],[x+w,y],[x,y+h],[x+w,y+h]];if(asset.registration?.matrix){const[u,v]=asset.registration.matrix,o=asset.registration.canvasOffset;corners=corners.map(([a,b])=>[u[0]*a+u[1]*b+u[2]-o[0],v[0]*a+v[1]*b+v[2]-o[1]]);}const sx=asset.width/(asset.pixelWidth||asset.width),sy=asset.height/(asset.pixelHeight||asset.height);corners=corners.map(([x,y])=>[x*sx,y*sy]);const l=Math.min(...corners.map(p=>p[0])),t=Math.min(...corners.map(p=>p[1]));return{x:asset.x+l,y:asset.y+t,width:Math.max(...corners.map(p=>p[0]))-l,height:Math.max(...corners.map(p=>p[1]))-t};}
export async function nativeAlternative(text,asset,{width,height,dir}){
 // Restrict to cloud styles verified available in Figma; missing SemiBold blocks editing.
 text={...text,runs:text.runs.map(r=>({...r,weight:r.weight>=800?900:r.weight>=600?700:400}))};
 const box=mapOCRBox(text,asset),lineHeight=Math.max(...text.runs.map(r=>r.fontSize))*1.18,lines=[[]];
 for(const r of text.runs){const parts=r.text.split('\n');for(let i=0;i<parts.length;i++){if(parts[i])lines.at(-1).push({...r,text:parts[i]});if(i<parts.length-1)lines.push([]);}}
 const layout=lines.map(line=>{let cursor=0;const glyphs=[];for(const r of line){const font=fontFor(text.family,r.weight),unit=r.fontSize/font.unitsPerEm,run=font.layout(r.text);run.glyphs.forEach((g,i)=>{const pos=run.positions[i];glyphs.push({glyph:g,x:cursor+pos.xOffset*unit,y:-pos.yOffset*unit,unit,color:r.color});cursor+=pos.xAdvance*unit;});}return{glyphs,advance:cursor};});
 const maxAdvance=Math.max(...layout.map(l=>l.advance));let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
 for(const [i,line]of layout.entries()){const shift=text.alignment==='center'?(maxAdvance-line.advance)/2:text.alignment==='right'?maxAdvance-line.advance:0;for(const g of line.glyphs){g.x+=shift;g.y+=i*lineHeight;const b=g.glyph.bbox;minX=Math.min(minX,g.x+b.minX*g.unit);maxX=Math.max(maxX,g.x+b.maxX*g.unit);minY=Math.min(minY,g.y-b.maxY*g.unit);maxY=Math.max(maxY,g.y-b.minY*g.unit);}}
 const scale=Math.min(box.width/(maxX-minX),box.height/(maxY-minY)),originX=box.x+(box.width-(maxX-minX)*scale)/2-minX*scale,originY=box.y+(box.height-(maxY-minY)*scale)/2-minY*scale;
 const largest=text.runs.reduce((a,b)=>a.fontSize>b.fontSize?a:b),font=fontFor(text.family,largest.weight),fs=largest.fontSize*scale,lh=lineHeight*scale,baseline=font.ascent/font.unitsPerEm*fs+(lh-(font.ascent-font.descent)/font.unitsPerEm*fs)/2;
 const native={id:asset.id,type:'text',name:asset.name+' / 編集可能',text:text.text,fontFamily:text.family,weight:largest.weight,fontSize:fs,color:largest.color,alignment:text.alignment,lineHeight:lh,tracking:0,textBehaviour:1,x:originX,y:originY-baseline,width:Math.ceil(maxAdvance*scale+3),height:Math.ceil(lh*lines.length+3),runs:text.runs.map(r=>({...r,fontSize:r.fontSize*scale}))};
 let paths='';for(const line of layout)for(const g of line.glyphs)paths+=`<path fill="${g.color}" d="${g.glyph.path.toSVG()}" transform="translate(${originX+g.x*scale},${originY+g.y*scale}) scale(${g.unit*scale},${-g.unit*scale})"/>`;
 const file=`native/${asset.id}.png`;await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${paths}</svg>`)).png().toFile(path.join(dir,file));return{native,preview:{...asset,file,x:0,y:0,width,height}};
}
