import {Separator} from './separation/core.mjs';
import {parseOptions} from './separation/options.mjs';
import {runBaseline,runFast} from './separation/run.mjs';
const o=parseOptions(process.argv.slice(2));
const s=new Separator(o);let status='complete',error;
try{
 await s.init();await s.preflight();await s.plan();
 if(o.stage!=='plan'){const report=await(o.mode==='baseline'?runBaseline:runFast)(s,{stage:o.stage});if(report)console.log(JSON.stringify(report,null,2));}
}catch(e){status='failed';error=e.message;throw e;}
finally{
 // Every branch has settled by now; record measured timing, then close the shared app-server.
 try{console.error('timing: '+await s.writeTiming({status,stage:o.stage??'full',error,resume:status==='failed'?'Rerun the same command; cached assets, outpaint, OCR entries and reviews are reused.':undefined}));}
 catch(e){console.error('Could not write timing report: '+e.message);}
 s.close();
}
