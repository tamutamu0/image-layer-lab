import Ajv from 'ajv';
const box={type:'array',items:{type:'number'},minItems:4,maxItems:4};
export const planSchema={type:'object',additionalProperties:false,required:['title','assessment','boxFormat','groups','jobs'],properties:{boxFormat:{type:'string',enum:['xywh','xyxy']},title:{type:'string'},assessment:{type:'string'},groups:{type:'array',minItems:1,maxItems:20,items:{type:'object',additionalProperties:false,required:['id','name','parent','role','purpose'],properties:{id:{type:'string'},name:{type:'string'},parent:{type:'string',pattern:'^[a-z][a-z0-9_-]*$',description:'Literal root for top-level groups; otherwise an existing group ID. Never empty.'},role:{type:'string',enum:['background','brand','headline','product','subject','benefits','offer','cta','footer','decoration']},purpose:{type:'string'}}}},jobs:{type:'array',minItems:5,maxItems:40,items:{type:'object',additionalProperties:false,required:['id','name','group','kind','bbox','visibleBbox','z','text','textMode','occluded','prompt','risk'],properties:{id:{type:'string'},name:{type:'string'},group:{type:'string'},kind:{type:'string',enum:['background','product','subject','text','surface','effect','decoration']},bbox:box,visibleBbox:box,z:{type:'integer'},text:{type:'string'},textMode:{type:'string',enum:['native','raster','none']},occluded:{type:'boolean'},prompt:{type:'string'},risk:{type:'string'}}}}}};
const check=new Ajv({strict:false}).compile(planSchema);
export function validatePlan(p){
 if(!check(p))throw Error('Invalid plan: '+JSON.stringify(check.errors));
 if(p.boxFormat==='xyxy'){p={...p,boxFormat:'xywh',jobs:p.jobs.map(j=>({...j,bbox:[j.bbox[0],j.bbox[1],j.bbox[2]-j.bbox[0],j.bbox[3]-j.bbox[1]],visibleBbox:[j.visibleBbox[0],j.visibleBbox[1],j.visibleBbox[2]-j.visibleBbox[0],j.visibleBbox[3]-j.visibleBbox[1]]}))};}
 const ids=new Set(),groups=new Map(p.groups.map(g=>[g.id,g]));
 for(const n of [...p.groups,...p.jobs]){if(!/^[a-z][a-z0-9_-]*$/.test(n.id)||ids.has(n.id))throw Error('Invalid/duplicate ID '+n.id);ids.add(n.id);}
 for(const g of p.groups){const seen=new Set([g.id]);let parent=g.parent;while(parent!=='root'){if(seen.has(parent)||!groups.has(parent))throw Error('Invalid group tree');seen.add(parent);parent=groups.get(parent).parent;}}
 for(const j of p.jobs){if(!groups.has(j.group))throw Error('Ungrouped '+j.id);for(const b of[j.bbox,j.visibleBbox])if(b.some(v=>!Number.isFinite(v))||b[2]<=0||b[3]<=0||b[0]<-250||b[1]<-250||b[0]+b[2]>1250||b[1]+b[3]>1250)throw Error('Invalid bounds '+j.id);if(j.kind==='text'&&!j.text.trim())throw Error('Missing text '+j.id);}
 if(p.jobs.filter(j=>j.kind==='background').length!==1)throw Error('Need exactly one clean background plate');
 return p;
}
