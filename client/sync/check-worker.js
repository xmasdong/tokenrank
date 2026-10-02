import { sync } from './report.js';
import { acquireLock } from './lock.js';
import { errorCode } from './health.js';

// The supervisor remains responsive even if a synchronous SQLite read hangs.
if (process.send) {
  process.on('disconnect',()=>process.exit(0));
  process.once('message',async ({dir})=>{
    let release, stage='source', sourceDay=null;
    let result;
    try {
      release=acquireLock(dir,'sync');
      if (!release) result={skipped:'sync-running'};
      else {
        process.on('exit',release);
        result=await sync({dir,onProgress:progress=>{
          stage=progress.stage;sourceDay=progress.source_day;
          process.send?.({type:'progress',stage,source_day:sourceDay});
        }});
      }
      process.send?.({type:'result',result,source_day:sourceDay},()=>process.exit(0));
    } catch(err) {
      process.send?.({type:'failure',error_code:errorCode(err,stage),source_day:sourceDay},()=>process.exit(1));
    } finally { release?.(); }
  });
}
