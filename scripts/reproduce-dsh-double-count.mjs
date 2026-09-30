// Isolated regression reproducer for upstream 1.8.1; never reads/writes a live DB.
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
import {collectDshFile} from '../token-watcher/src/collectors/dsh.js';
const root=mkdtempSync(join(tmpdir(),'tokenrank-dsh-repro-'));
const usage={inputTokens:100,cacheReadTokens:900,outputTokens:100,reasoningTokens:20,totalTokens:1100};
const chunk={type:'assistant/chunk',seq:1,time:1700000000000,data:{turn:1,step:1,chunk:{type:'usage',usage}}};
const message={type:'assistant/message',seq:2,time:1700000000001,data:{turn:1,step:1,message:{source:{model:'test-model'}},usage}};
const events=new Map();const store={insertEvent(e){if(events.has(e.dedup_key))return 0;events.set(e.dedup_key,e);return 1;}};
try {
 for(const [name,lines] of [['session.jsonl.zstd',[chunk,message]],['session.v3.jsonl.zstd',[{...message,seq:1}]]]){
  const input=join(root,name+'.txt'),output=join(root,name);writeFileSync(input,lines.map(x=>JSON.stringify(x)).join('\n')+'\n');
  execFileSync('/opt/homebrew/bin/zstd',['-q',input,'-o',output]);
  await collectDshFile(store,{path:output,fileId:'same-session'});
 }
 const actual=[...events.values()].reduce((n,e)=>n+e.total_tokens,0);
 assert.equal(actual,3300,'Upstream behavior changed; re-evaluate the reproducer');
 console.log(JSON.stringify({upstream:'1.8.1',requests_in_fixture:1,expected_tokens:1100,counted_events:events.size,actual_tokens:actual,bug_reproduced:true},null,2));
} finally {rmSync(root,{recursive:true,force:true});}
