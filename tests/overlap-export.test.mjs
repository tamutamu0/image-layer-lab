import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {setupFake,delay} from './helpers/fake-ai.mjs';
import {runOverlap,reviewAndBuild} from '../src/separation/run-overlap.mjs';
import {speculativeBuild} from '../src/separation/speculative-build.mjs';
const jobs=[['bg','background'],['h','text','見出し'],['p1','product'],['p2','product'],['p3','product']];
test('speculative export remains private until commit; rejected snapshot never replaces accepted artifact',async t=>{
 const {s}=await setupFake(t,{jobs});await s.ensureDirs();await fs.writeFile(path.join(s.dir,'layers.sketch'),'accepted');
 const buildFn=async snap=>{await fs.writeFile(path.join(snap.dir,'layers.sketch'),'candidate');return{ok:true};};
 const rejected=await speculativeBuild(s,{buildFn});assert.equal(await fs.readFile(path.join(s.dir,'layers.sketch'),'utf8'),'accepted');await rejected.discard();assert.equal(await fs.readFile(path.join(s.dir,'layers.sketch'),'utf8'),'accepted');
 const accepted=await speculativeBuild(s,{buildFn});await accepted.commit();assert.equal(await fs.readFile(path.join(s.dir,'layers.sketch'),'utf8'),'candidate');
});
test('review and export overlap, but all work drains before mutation and adjustment is visually rechecked',async t=>{
 const {s}=await setupFake(t,{jobs});let active=0,peak=0,reviews=0,commits=0,discards=0,adjusted=false;
 const job=async()=>{active++;peak=Math.max(active,peak);await delay(20);active--;};
 const d={register:async()=>{},build:async()=>{},review:async()=>{await job();reviews++;return{verdict:'usable',repairs:[],adjustments:reviews===1?[{id:'p1'}]:[]};},
 speculativeBuild:async()=>{await job();return{commit:async()=>{commits++;return{ok:true}},discard:async()=>{discards++}}},
 applyAdjustments:async()=>{assert.equal(active,0);adjusted=true;}};
 const r=await runOverlap(s,{d,generate:async()=>{assert.equal(active,0)}});assert.equal(r.ok,true);assert.equal(peak,2);assert.equal(reviews,2);assert.equal(commits,1);assert.equal(discards,1);assert.equal(adjusted,true);
});
test('failed review drains and discards concurrently successful export',async t=>{
 const {s}=await setupFake(t,{jobs});let done=false,discarded=false;
 await assert.rejects(reviewAndBuild(s,{review:async()=>{throw Error('review unavailable')},speculativeBuild:async()=>{await delay(20);done=true;return{discard:async()=>discarded=true}}}),/review unavailable/);
 assert.equal(done,true);assert.equal(discarded,true);
});

test('speculative promotion supports nested outputs and records a hash for the self-contained Sketch',async t=>{
 const {s}=await setupFake(t,{jobs});await s.ensureDirs();
 const snap=await speculativeBuild(s,{buildFn:async copy=>{assert.equal(typeof copy.plan,'function');await fs.mkdir(path.join(copy.dir,'native','nested'),{recursive:true});await fs.writeFile(path.join(copy.dir,'native','nested','image.png'),'pixels');await fs.writeFile(path.join(copy.dir,'layers.sketch'),'zip');return{ok:true};}});
 await snap.commit();assert.equal(await fs.readFile(path.join(s.dir,'native','nested','image.png'),'utf8'),'pixels');
 const receipt=JSON.parse(await fs.readFile(path.join(s.dir,'export-commit.json')));assert.match(receipt.files['layers.sketch'],/^[0-9a-f]{64}$/);assert.ok(receipt.files['native/nested/image.png']);
});
