// Run the installed and upstream collectors plus TokenTracker on one frozen,
// content-free usage snapshot. Every database/queue written is inside auditDir.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const auditDir=resolve(process.argv[2]);
const manifest=JSON.parse(readFileSync(join(auditDir,'manifest.json'),'utf8'));
const trackerRoot='/Applications/TokenTracker.app/Contents/Resources/EmbeddedServer/tokentracker';
const require=createRequire(join(trackerRoot,'package.json'));
const {parseRolloutIncremental}=require(join(trackerRoot,'src/lib/rollout.js'));
const output={cutoff:manifest.cutoff,files:manifest.files.length,source_bytes:manifest.bytes_read,malformed:manifest.malformed,versions:{watcher_installed:'1.8.0',watcher_latest:'1.8.1',tracker:'0.97.2'}};
const sql=`SELECT COUNT(*) requests,SUM(total_tokens) total,SUM(input_tokens) input,SUM(cached_input) cache_read,SUM(cache_write) cache_write,SUM(output_tokens) output FROM events`;
for (const [label,root,version] of [['installed','/opt/homebrew/lib/node_modules/token-watcher',3],['latest',resolve('token-watcher'),4]]) {
  const dbPath=join(auditDir,`${label}.db`);
  if(existsSync(dbPath))throw Error('Refusing to mix with previous audit: '+dbPath);
  const {Store}=await import(pathToFileURL(join(root,'src/store.js')));
  const {collectCodexFile}=await import(pathToFileURL(join(root,'src/collectors/codex.js')));
  const store=new Store(dbPath);store.insertToolCall=()=>0;store.saveQuota=()=>{};
  const states=[];
  for(let i=0;i<manifest.files.length;i++){
    const f=manifest.files[i];store.db.exec('BEGIN');
    try{
      const r=await collectCodexFile(store,{path:f.path,fileId:f.stem,offset:0,state:undefined,version});
      store.saveFile({path:f.path,tool:'codex',session_id:f.stem,size:r.newOffset,mtime_ms:0,offset:r.newOffset,state_json:JSON.stringify(r.state)});
      states.push(r);store.db.exec('COMMIT');
    }catch(e){store.db.exec('ROLLBACK');throw e;}
    if((i+1)%500===0) console.log(JSON.stringify({label,processed:i+1,total:manifest.files.length}));
  }
  output[label]={...store.db.prepare(sql).get(),days:store.db.prepare(`SELECT date(ts/1000,'unixepoch','+8 hours') day,COUNT(*) requests,SUM(total_tokens) total FROM events GROUP BY day`).all()};
  writeFileSync(join(auditDir,`${label}-sessions.json`),JSON.stringify(store.db.prepare('SELECT session_id,COUNT(*) requests,SUM(total_tokens) total FROM events GROUP BY session_id').all()));
  let added=0;
  for(let i=0;i<manifest.files.length;i++){
    const f=manifest.files[i],s=states[i];
    const r=await collectCodexFile(store,{path:f.path,fileId:f.stem,offset:s.newOffset,state:s.state,version});added+=r.inserted;
  }
  output[label].second_scan_added=added;store.close();
  console.log(JSON.stringify({label,...output[label],days:output[label].days.length}));
}
const queuePath=join(auditDir,'tracker-queue.jsonl'),cursors={};
if(existsSync(queuePath))throw Error('Tracker audit queue already exists');
const r=await parseRolloutIncremental({rolloutFiles:manifest.files.map(f=>f.path),cursors,queuePath,source:'codex',onProgress:p=>{if(p.index%500===0)console.log(JSON.stringify({label:'tracker',processed:p.index,total:p.total}));}});
let total=0,requests=0,input=0,cache_read=0,cache_write=0,output_tokens=0;const days=new Map();
for(const line of readFileSync(queuePath,'utf8').trim().split('\n')){
 const x=JSON.parse(line);total+=x.total_tokens;requests+=x.conversation_count||0;input+=x.input_tokens||0;cache_read+=x.cached_input_tokens||0;cache_write+=x.cache_creation_input_tokens||0;output_tokens+=x.output_tokens||0;
 const day=new Date(Date.parse(x.hour_start)+28800000).toISOString().slice(0,10);const d=days.get(day)||{day,requests:0,total:0};d.total+=x.total_tokens;d.requests+=x.conversation_count||0;days.set(day,d);
}
output.tracker={total,requests,input,cache_read,cache_write,output:output_tokens,days:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)),...r};
output.tracker.second_scan=await parseRolloutIncremental({rolloutFiles:manifest.files.map(f=>f.path),cursors,queuePath,source:'codex'});
writeFileSync(join(auditDir,'comparison.json'),JSON.stringify(output,null,2));
console.log(JSON.stringify({...output,installed:{...output.installed,days:output.installed.days.length},latest:{...output.latest,days:output.latest.days.length},tracker:{...output.tracker,days:output.tracker.days.length}},null,2));
