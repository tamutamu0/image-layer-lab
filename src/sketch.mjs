import {readFile, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {randomUUID, createHash} from 'node:crypto';
import path from 'node:path';
import AdmZip from 'adm-zip';
import Ajv from 'ajv';
import sharp from 'sharp';

const require=createRequire(import.meta.url);
const validators=Object.fromEntries(['document','page','meta','user'].map(name=>{
  const schema=require(`@sketch-hq/sketch-file-format/dist/${name}.schema.json`);
  return [name,new Ajv({strict:false,allErrors:true,unicodeRegExp:false}).compile(schema)];
}));
const uuid=()=>randomUUID().toUpperCase();
const frame=(x,y,width,height)=>({_class:'rect',constrainProportions:false,x,y,width,height});
const ruler=()=>({_class:'rulerData',base:0,guides:[]});
const style=()=>({_class:'style',do_objectID:uuid(),endMarkerType:0,miterLimit:10,startMarkerType:0,windingRule:1,
  blur:{_class:'blur',isEnabled:false,center:'{0.5, 0.5}',motionAngle:0,radius:10,saturation:1,type:0},
  borderOptions:{_class:'borderOptions',isEnabled:true,dashPattern:[],lineCapStyle:0,lineJoinStyle:0},borders:[],
  colorControls:{_class:'colorControls',isEnabled:false,brightness:0,contrast:1,hue:0,saturation:1},
  contextSettings:{_class:'graphicsContextSettings',blendMode:0,opacity:1},fills:[],innerShadows:[],shadows:[]});
const base=(name,x,y,width,height)=>({do_objectID:uuid(),name,nameIsFixed:true,
  booleanOperation:-1,exportOptions:{_class:'exportOptions',exportFormats:[],includedLayerIds:[],layerOptions:0,shouldTrim:false},
  frame:frame(x,y,width,height),isFixedToViewport:false,isFlippedHorizontal:false,isFlippedVertical:false,
  isLocked:false,isTemplate:false,isVisible:true,layerListExpandedType:0,resizingConstraint:63,resizingType:0,rotation:0,shouldBreakMaskChain:false,
  hasClippingMask:false,clippingMaskMode:0,style:style()});

function nativeText(text,figmaFontNames=false){
  const family=figmaFontNames?text.fontFamily:text.fontFamily.replaceAll(' ','');
  const font={_class:'fontDescriptor',attributes:{name:text.fontPostscript||family+'-'+({900:'Black',700:'Bold',600:'SemiBold',500:'Medium',400:'Regular'}[text.weight]||'Regular'),size:text.fontSize}};
  const hex=text.color.replace('#',''),color={_class:'color',alpha:1,red:parseInt(hex.slice(0,2),16)/255,green:parseInt(hex.slice(2,4),16)/255,blue:parseInt(hex.slice(4,6),16)/255};
  const attributes={MSAttributedStringFontAttribute:font,MSAttributedStringColorAttribute:color,kerning:text.tracking||0,
    paragraphStyle:{_class:'paragraphStyle',alignment:{left:0,right:1,center:2}[text.alignment]||0,maximumLineHeight:text.lineHeight||text.fontSize*1.1,minimumLineHeight:text.lineHeight||text.fontSize*1.1},textStyleVerticalAlignmentKey:0};
  let ranges=[{_class:'stringAttribute',location:0,length:text.text.length,attributes}];
  if(text.runs){
    if(text.runs.map(r=>r.text).join('')!==text.text)throw new Error('Rich text runs must exactly cover the string');
    let cursor=0;ranges=text.runs.map(r=>{const hex=(r.color||text.color).replace('#',''),runColor={_class:'color',alpha:1,red:parseInt(hex.slice(0,2),16)/255,green:parseInt(hex.slice(2,4),16)/255,blue:parseInt(hex.slice(4,6),16)/255};
      const attr={...attributes,MSAttributedStringFontAttribute:{_class:'fontDescriptor',attributes:{name:family+'-'+({900:'Black',700:'Bold',600:'SemiBold',500:'Medium',400:'Regular'}[r.weight||text.weight]||'Regular'),size:r.fontSize||text.fontSize}},MSAttributedStringColorAttribute:runColor};
      const range={_class:'stringAttribute',location:cursor,length:r.text.length,attributes:attr};cursor+=r.text.length;return range;});
  }
  const layer={...base(text.name||text.text,text.x,text.y,text.width,text.height),_class:'text',
    attributedString:{_class:'attributedString',string:text.text,attributes:ranges},
    automaticallyDrawOnUnderlyingPath:false,dontSynchroniseWithSymbol:false,glyphBounds:`{{0, 0}, {${text.width}, ${text.height}}}`,
    lineSpacingBehaviour:2,textBehaviour:text.textBehaviour??2};
  layer.style.textStyle={_class:'textStyle',verticalAlignment:0,encodedAttributes:attributes};
  layer.userInfo={'layer-lab':{id:text.id,method:'AI OCR + replaceable font approximation',originalAppearanceGuaranteed:false}};
  return layer;
}

// PNG pixels remain lossless. The order in the manifest is back to front.
export async function exportSketch(manifest,output,{root=process.cwd(),reference=true}={}){
  const zip=new AdmZip();
  async function bitmap(layer){
    const bytes=await readFile(path.resolve(root,layer.file));
    const info=await sharp(bytes).metadata();
    if(info.format!=='png')throw new Error('Sketch assets must be lossless PNG');
    // Sketch and Figma's importer expect the conventional 40-character SHA-1 asset key.
    const hash=createHash('sha1').update(bytes).digest('hex');
    const ref=`images/${hash}.png`;if(!zip.getEntry(ref))zip.addFile(ref,bytes);
    const basis=base(layer.name,layer.x||0,layer.y||0,layer.width||info.width,layer.height||info.height);basis.style.contextSettings.opacity=layer.opacity??1;basis.isLocked=!!layer.locked;
    return {...basis,
      _class:'bitmap',clippingMask:'{{0, 0}, {1, 1}}',fillReplacesImage:false,
      image:{_class:'MSJSONFileReference',_ref_class:'MSImageData',_ref:ref},intendedDPI:72,
      userInfo:{'layer-lab':{id:layer.id||'reference',amodal:!!layer.amodal,method:layer.method||'original'}}};
  }
  const artboard=(name,x,layers,width=manifest.width,height=manifest.height)=>({...base(name,x,0,width,height),_class:'artboard',
    hasClickThrough:false,horizontalRulerData:ruler(),verticalRulerData:ruler(),
    backgroundColor:{_class:'color',alpha:1,red:1,green:1,blue:1},hasBackgroundColor:false,
    includeBackgroundColorInExport:false,isFlowHome:false,resizesContent:false,layers});
  async function buildLayers(input){
    const output=[];
    for(const layer of input){
      if(layer.type==='group'){
        const children=await buildLayers(layer.layers);
        output.push({...base(layer.name,layer.x||0,layer.y||0,layer.width||manifest.width,layer.height||manifest.height),_class:'group',isLocked:!!layer.locked,hasClickThrough:false,layers:children});
      }else output.push(layer.type==='text'?nativeText(layer,manifest.figmaFontNames):await bitmap(layer));
    }
    return output;
  }
  const layers=await buildLayers(manifest.exportLayers||manifest.layers);
  const boards=[artboard(manifest.artboardName||'01 · Editable amodal layers',0,layers)];
  const gap=manifest.boardGap||100;
  let nextX=manifest.width+gap;
  if(manifest.additionalBoards)for(const [i,board] of manifest.additionalBoards.entries()){
    const child=await buildLayers(board.layers);
    boards.push(artboard(board.name,nextX,child,board.width,board.height));
    nextX+=(board.width||manifest.width)+gap;
  }
  if(reference&&manifest.source)boards.push(artboard(manifest.referenceName||'Original reference',nextX,[await bitmap({file:manifest.source,name:'Original flat image'})]));
  const page={...base(manifest.title||'Layer Lab',0,0,0,0),_class:'page',hasClickThrough:false,
    horizontalRulerData:ruler(),verticalRulerData:ruler(),layers:boards};
  const document={_class:'document',do_objectID:uuid(),assets:{_class:'assetCollection',do_objectID:uuid(),
    colorAssets:[],gradientAssets:[],images:[],colors:[],gradients:[],exportPresets:[]},colorSpace:1,currentPageIndex:0,
    foreignLayerStyles:[],foreignSymbols:[],foreignTextStyles:[],layerStyles:{_class:'sharedStyleContainer',objects:[]},
    layerTextStyles:{_class:'sharedTextStyleContainer',objects:[]},perDocumentLibraries:[],
    pages:[{_class:'MSJSONFileReference',_ref_class:'MSImmutablePage',_ref:`pages/${page.do_objectID}`}]};
  const created={commit:'layer-lab',appVersion:'99.0',build:1,app:'com.bohemiancoding.sketch3',compatibilityVersion:99,version:121,variant:'NONAPPSTORE'};
  const meta={...created,autosaved:0,created,saveHistory:[],pagesAndArtboards:{[page.do_objectID]:{name:page.name,
    artboards:Object.fromEntries(boards.map(b=>[b.do_objectID,{name:b.name}]))}}};
  const user={document:{pageListHeight:140,pageListCollapsed:0}};
  for(const [type,data] of Object.entries({document,page,meta,user})){
    if(!validators[type](data))throw new Error(`${type} schema: ${JSON.stringify(validators[type].errors.slice(0,8))}`);
    zip.addFile(type==='page'?`pages/${page.do_objectID}.json`:`${type}.json`,Buffer.from(JSON.stringify(data)));
  }
  if(manifest.composite)zip.addFile('previews/preview.png',await sharp(path.resolve(root,manifest.composite)).resize({width:1024,withoutEnlargement:true}).png().toBuffer());
  await writeFile(output,zip.toBuffer());
  return validateSketch(output);
}

export async function validateSketch(file){
  const zip=new AdmZip(await readFile(file));
  const read=name=>{const e=zip.getEntry(name);if(!e)throw new Error(`Missing ${name}`);return JSON.parse(e.getData().toString());};
  let bitmapCount=0,textCount=0;
  const checkLayer=layer=>{
    if(layer._class==='text')textCount++;
    if(layer._class==='bitmap'){
      if(!zip.getEntry(layer.image._ref))throw new Error(`Missing image: ${layer.image._ref}`);
      bitmapCount++;
    }
    for(const child of layer.layers||[])checkLayer(child);
  };
  const document=read('document.json');
  for(const type of ['document','meta','user']){const data=type==='document'?document:read(`${type}.json`);
    if(!validators[type](data))throw new Error(`${type} is invalid`);}
  for(const ref of document.pages){const page=read(`${ref._ref}.json`);
    if(!validators.page(page))throw new Error(`Invalid page: ${JSON.stringify(validators.page.errors.slice(0,3))}`);checkLayer(page);}
  return {schemaValid:true,bitmapCount,textCount,entries:zip.getEntries().length,bytes:(await readFile(file)).length};
}

// Independent archive reader for round-trip verification; only the emitted bitmap subset.
export async function renderSketch(file,artboardIndex=0,{viewport}={}){
  const zip=new AdmZip(await readFile(file));
  const doc=JSON.parse(zip.readAsText('document.json'));
  const page=JSON.parse(zip.readAsText(`${doc.pages[0]._ref}.json`));
  const board=page.layers[artboardIndex];
  const area=viewport||{x:0,y:0,width:board.frame.width,height:board.frame.height};
  const overlays=[];
  async function collect(layers,offsetX=0,offsetY=0){for(const layer of layers){
    if(!layer.isVisible)continue;
    const {x,y,width,height}=layer.frame;
    if(layer._class==='group'){await collect(layer.layers,offsetX+x,offsetY+y);continue;}
    if(layer._class!=='bitmap')throw new Error('Bitmap roundtrip cannot render native text');
    const full=await sharp(zip.readFile(layer.image._ref)).resize(Math.round(width),Math.round(height)).ensureAlpha().raw().toBuffer();
    const opacity=layer.style?.contextSettings?.opacity??1;if(opacity!==1)for(let p=3;p<full.length;p+=4)full[p]=Math.round(full[p]*opacity);
    // Independently clip raw rows to the requested viewport; the archive keeps the complete image.
    const dx=Math.round(x+offsetX-area.x),dy=Math.round(y+offsetY-area.y),w=Math.round(width),h=Math.round(height);
    const left=Math.max(0,dx),top=Math.max(0,dy),right=Math.min(area.width,dx+w),bottom=Math.min(area.height,dy+h);
    if(right<=left||bottom<=top)continue;
    const cw=right-left,ch=bottom-top,cropped=Buffer.alloc(cw*ch*4);
    for(let row=0;row<ch;row++)full.copy(cropped,row*cw*4,((top-dy+row)*w+left-dx)*4,((top-dy+row)*w+right-dx)*4);
    overlays.push({input:await sharp(cropped,{raw:{width:cw,height:ch,channels:4}}).png().toBuffer(),left,top});
  }}
  await collect(board.layers);
  return sharp({create:{width:area.width,height:area.height,channels:4,background:'#00000000'}}).composite(overlays).png().toBuffer();
}
