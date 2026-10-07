import {settleAll} from '../concurrency.mjs';
import {actionableRepairs} from './review.mjs';
import {speculativeBuild} from './speculative-build.mjs';
import {reconcileReviewedCopy} from './source-copy.mjs';

const local=(s,id,work)=>s.timeline.track(id,'local',work);
export async function reviewAndBuild(s,d,{final=false}={}){
 let snapshot;
 try{
  const [evaluation]=await settleAll([
   d.review(s,{final}),
   local(s,'build:speculative',async()=>snapshot=await (d.speculativeBuild??speculativeBuild)(s,{buildFn:d.build}))
  ],'Review/export failed');
  return{evaluation,snapshot};
 }catch(error){await snapshot?.discard();throw error;}
}

// No assets, corrections or registration may change while a review/build pair
// is running. Both are drained before the next round, avoiding stale publication.
export async function runOverlap(s,{stage,d,generate}={}){
 if(stage==='assets'){await generate(s,{withOutpaint:false,withOCR:false});return null;}
 await generate(s);await local(s,'register',()=>d.register(s));
 if(stage==='build')return local(s,'build:full',()=>d.build(s));
 await local(s,'build:preview',()=>d.build(s,{partial:true}));
 for(let round=0;round<=2;round++){
  const final=round===2,result=await reviewAndBuild(s,d,{final}),snapshot=result.snapshot;
  let evaluation=result.evaluation;
  try{if(!final)evaluation=await reconcileReviewedCopy(s,evaluation);}catch(error){await snapshot.discard();throw error;}
  const repairs=Object.fromEntries(actionableRepairs(evaluation).slice(0,3).map(r=>[r.id,r.prompt]));
  const repaired=Object.keys(repairs).length>0,adjusted=evaluation.adjustments.length>0;
  if(final||(!repaired&&!adjusted))return snapshot.commit();
  await snapshot.discard();
  await d.applyAdjustments(s,evaluation);
  if(repaired){await generate(s,{repairs,repairText:false});await local(s,'register',()=>d.register(s));}
  await local(s,'build:preview',()=>d.build(s,{partial:true}));
  // Includes a full visual recheck after adjustment-only rounds, which allows
  // compact review to skip an expensive high-effort pre-confirmation safely.
 }
}
