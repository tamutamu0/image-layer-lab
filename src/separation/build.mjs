import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import AdmZip from 'adm-zip';
import {readJSON} from './core.mjs';
import {nativeAlternative} from './native.mjs';
import {composite,compare,saveJSON,writeFileAtomic} from '../images.mjs';
import {exportSketch,renderSketch} from '../sketch.mjs';
import {localizeTree,flattenTree} from '../designer-hierarchy.mjs';
export function hierarchy(plan,layers){
 // A product must remain independently selectable, even if an AI planner
 // nested it in an offer to explain an occlusion. Split interleaved groups
 // into contiguous stack segments instead of moving pixels or trapping it.
 const groups=new Map(plan.groups.map(g=>[g.id,{...g,parent:['product','subject'].includes(g.role)?'root':g.parent}]));
 const rootOf=id=>{let g=groups.get(id);while(g.parent!=='root')g=groups.get(g.parent);return g.id;};
 const segments=[];
 for(const l of [...layers].sort((a,b)=>a.z-b.z)){const root=rootOf(l.group);if(segments.at(-1)?.root===root)segments.at(-1).items.push(l);else segments.push({root,items:[l]});}
 const counts=new Map();for(const s of segments)counts.set(s.root,(counts.get(s.root)||0)+1);const seen=new Map();
 function subtree(group,items,suffix){
  const children=[...items.filter(l=>l.group===group.id)];
  for(const child of groups.values())if(child.parent===group.id){const n=subtree(child,items,suffix);if(n)children.push(n);}
  if(!children.length)return null;children.sort((a,b)=>a.z-b.z);
  const x=Math.min(...children.map(l=>l.x)),y=Math.min(...children.map(l=>l.y));
  return {...group,id:group.id+suffix,logicalGroup:group.id,type:'group',locked:group.role==='background',layers:children,z:Math.min(...children.map(l=>l.z)),x,y,width:Math.max(...children.map(l=>l.x+l.width))-x,height:Math.max(...children.map(l=>l.y+l.height))-y};
 }
 return segments.map(segment=>{const total=counts.get(segment.root),index=(seen.get(segment.root)||0)+1;seen.set(segment.root,index);const suffix=total>1?'-stack-'+index:'';const g=subtree(groups.get(segment.root),segment.items,suffix);if(total>1){g.name+=' / '+(index===1?'背面':index===total?'前面':'中間');g.purpose+=' 重なり順を保つため、独立したまとまりに分けています。';}return g;});
}
export async function build(s,{partial=false}={}){
 const registered=await readJSON(path.join(s.dir,'registered.json'));let layers=registered||await Promise.all(s.planData.jobs.map(j=>readJSON(path.join(s.dir,'assets',j.id+'.json'))));if(layers.some(l=>!l))throw Error('Missing generated layer');
 const corrections=await readJSON(path.join(s.dir,'adjustments.json'))||{};layers=layers.map(l=>({...l,pixelWidth:l.width,pixelHeight:l.height,...corrections[l.id],textId:l.kind==='text'?l.id:undefined,preferredMode:l.textMode,opacity:corrections[l.id]?.opacity??1}));
 const tree=hierarchy(s.planData,layers),flat=flattenTree(tree),dx=Math.round(s.width*s.bleed),dy=Math.round(s.height*s.bleed),contentBounds={x:-dx,y:-dy,width:s.width+dx*2,height:s.height+dy*2};
 const m={title:s.planData.title,width:s.width,height:s.height,source:'source.png',composite:'composite.png',tree,layers:flat,contentBounds,artboardName:'01 · 生成素材 / 見た目を保って編集',referenceName:'04 · 元のバナー',figmaFontNames:true,exportLayers:localizeTree(tree),algorithm:'generation-first-v9'};
 const merged=await composite(m,s.dir);await writeFileAtomic(path.join(s.dir,'composite.png'),merged);
 const regrouped=await compare(await composite({...m,layers:[...layers].sort((a,b)=>a.z-b.z)},s.dir),merged);await saveJSON(path.join(s.dir,'manifest.json'),m);
 if(partial)return m;
 const ocr=await readJSON(path.join(s.dir,'text.json'));if(!ocr)throw Error('Missing generated-image OCR');const native=new Map(),previews=new Map();await fs.mkdir(path.join(s.dir,'native'),{recursive:true});
 for(const l of flat.filter(l=>l.kind==='text')){const t=ocr.texts.find(t=>t.id===l.id);if(!t?.correct)continue;const n=await nativeAlternative(t,l,{width:s.width,height:s.height,dir:s.dir});native.set(l.id,n.native);previews.set(l.id,n.preview);}
 m.additionalBoards=[{name:'02 · 文字を直接編集 / 近似フォント',layers:localizeTree(tree,{x:0,y:0},native)},{name:'03 · 枠外・隠れた部分を含む素材',width:contentBounds.width,height:contentBounds.height,layers:localizeTree(tree,contentBounds)}];
 await fs.writeFile(path.join(s.dir,'native-preview.png'),await composite({...m,layers:flat.map(l=>previews.get(l.id)||l)},s.dir));
 const file=path.join(s.dir,'layers.sketch'),archive=await exportSketch(m,file,{root:s.dir});const rt=await renderSketch(file),wide=await renderSketch(file,0,{viewport:contentBounds});await fs.writeFile(path.join(s.dir,'sketch-roundtrip.png'),rt);await fs.writeFile(path.join(s.dir,'unclipped.png'),wide);
 const serialization=await compare(merged,rt),overflowSerialization=await compare(await composite(m,s.dir,{viewport:contentBounds}),wide);if(!serialization.identical||!overflowSerialization.identical)throw Error('Sketch changed generated composition');
 const zip=new AdmZip(file),doc=JSON.parse(zip.readAsText('document.json')),boards=JSON.parse(zip.readAsText(doc.pages[0]._ref+'.json')).layers;const leaf=ns=>ns.flatMap(n=>n._class==='group'?leaf(n.layers):[n]);
 const stored=leaf(boards[0].layers);for(const l of flat){const b=stored.find(b=>b.userInfo?.['layer-lab']?.id===l.id);if(!zip.readFile(b.image._ref).equals(await fs.readFile(path.join(s.dir,l.file))))throw Error('Incomplete PNG in Sketch '+l.id);}
 const report={algorithm:'generation-first-v9',rootCount:tree.length,leafCount:flat.length,nativeTextCount:native.size,textImageCount:flat.filter(l=>l.kind==='text').length,effectCount:flat.filter(l=>l.kind==='effect').length,sourcePixelTransfer:false,textRasterCropping:false,ocrVerified:ocr.texts.every(t=>t.correct),textErrors:ocr.texts.filter(t=>!t.correct).map(t=>t.id),textWarnings:ocr.warnings??[],decomposition:await compare(s.source,merged,{diffPath:path.join(s.dir,'difference.png')}),serialization,overflowSerialization,regrouped,archive};
 await saveJSON(path.join(s.dir,'manifest.json'),m);await saveJSON(path.join(s.dir,'native-texts.json'),[...native.values()]);await saveJSON(path.join(s.dir,'report.json'),report);return report;
}
