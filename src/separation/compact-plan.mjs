import Ajv from 'ajv';
import {validatePlan} from './schema.mjs';

export const COMPACT_PLAN_VERSION='semantic-plan-v9-compact-2';
const box={type:'array',items:{type:'number'},minItems:4,maxItems:4};
const kinds=['background','product','subject','text','surface','effect','decoration'];
const roles=['background','brand','headline','product','subject','benefits','offer','cta','footer','decoration'];
export const compactPlanSchema={type:'object',additionalProperties:false,required:['title','groups','jobs'],properties:{
 title:{type:'string',maxLength:60},
 groups:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['n','r','p'],properties:{n:{type:'string',maxLength:30},r:{type:'string',enum:roles},p:{type:'integer',minimum:-1,maximum:19}}}},
 jobs:{type:'array',minItems:5,maxItems:40,items:{type:'object',additionalProperties:false,required:['n','k','g','b','v','t','h','o','r'],properties:{
  n:{type:'string',maxLength:40},k:{type:'string',enum:kinds},g:{type:'integer',minimum:0,maximum:19},b:box,v:{anyOf:[box,{type:'null'}]},t:{type:'string'},h:{type:'string',maxLength:180},o:{type:'boolean'},r:{type:'boolean'}
 }}}
}};
const check=new Ajv({strict:false}).compile(compactPlanSchema);
const instructions={
 background:'One complete clean background photograph/plate. Remove every independently planned subject, product, typography, panel and graphic effect; reconstruct what they occluded. Preserve visible scenery and photographic lighting.',
 subject:'One coherent complete person/subject, including their connected hair, hands and clothing. Reconstruct only plausible occluded/cropped portions. Exclude independently planned products, typography, surfaces and effects.',
 product:'One complete product including its packaging lettering. Reconstruct the concealed bottom, thin edges and transparent holes. Preserve packaging identity and proportions; exclude separate glows, reflections, price panels and text overlays.',
 text:'Only this whole typography unit. Match visible glyphs, baseline, mixed sizes, colors and original styling. Remove unrelated letters and backing. Preserve every requested character and complete hidden strokes.',
 surface:'Only the complete empty backing/panel/badge/button, retaining its shape, border and material. Remove all lettering, arrows and separately planned glints. Reconstruct beneath them.',
 effect:'Only this practical translucent effect as native RGBA. Preserve subtle opacity, soft edges and appearance. No opaque white matte, photographic objects, lettering or duplicate effects.',
 decoration:'Only this complete decorative element. Preserve its shape, color and material; remove surrounding lettering, backing and other objects.'
};

// The model still decides EVERY semantic boundary, ordering, box, copy and hint.
// Code expands repeated instructions; it never invents segmentation or changes copy.
export function expandCompactPlan(data){
 if(!check(data))throw Error('Invalid compact plan: '+JSON.stringify(check.errors));
 const groups=data.groups.map((g,i)=>({id:`g_${i}`,name:g.n,parent:g.p===-1?'root':`g_${g.p}`,role:g.r,purpose:g.n+'を独立して編集する。'}));
 const jobs=data.jobs.map((j,i)=>({id:`j_${String(i).padStart(2,'0')}`,name:j.n,group:`g_${j.g}`,kind:j.k,bbox:j.b,visibleBbox:j.v??[...j.b],z:i,text:j.t,textMode:j.k==='text'?(j.r?'raster':'native'):'none',occluded:j.o,
  prompt:`Target: ${j.n}. ${j.h} ${instructions[j.k]}`,
  risk:j.o?'隠れた部分を補完する。':'',
 }));
 return validatePlan({title:data.title,assessment:'AIが編集単位・重なり・座標・文字を判断し、共通の生成指示をプログラムで展開。',boxFormat:'xywh',groups,jobs});
}

export const compactInstructions=`OUTPUT CONTRACT: Return only the COMPACT schema, no prose or full image-generation prompts. All boxes use xywh. groups are indexed from 0: n=short Japanese name, r=role, p=parent group INDEX (-1 for root). jobs array order is BACK-TO-FRONT z: n=short Japanese name, k=kind, g=group INDEX, b=complete/amodal bbox, v=visible bbox (null when exactly the same as b; hidden/cropped objects still need their distinct visible box), t=exact text (empty for non-text), h=ONLY unique visual identity, styling, occluders and hidden-content hints in concise English, max 180 characters, o=occluded, r=ornate raster-preferred lettering. Use h="" for ordinary text: the reference crop supplies its typography; only annotate genuinely ambiguous style details. Common remove-background/complete-hidden-parts/keep-original-placement instructions are supplied by code; NEVER repeat them in h. Do not omit practical effect layers, duplicate a person's face and hair, merge unrelated text or reduce edit granularity to shorten output. Attached glints that move together with one product/component should normally be ONE effect asset, not a separate job for each tiny sparkle. Preserve independently useful haze/reflection separately. No full unseen body. Every visible copy unit must be represented, packaging text stays on its product. Keep all precision in boxes and exact copy.`;
