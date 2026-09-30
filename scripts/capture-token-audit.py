"""Read-only local comparison snapshot. Retains token metadata, never prompts/tool arguments."""
import json, os, sys, time, sqlite3, hashlib, datetime
from pathlib import Path
out=Path(sys.argv[1]); out.mkdir(parents=True,exist_ok=True); os.chmod(out,0o700)
cutoff=int(time.time()*1000)
roots=[Path.home()/'.codex/sessions',Path.home()/'.codex/archived_sessions']
files=[(p,p.stat().st_size) for root in roots for p in sorted(root.rglob('*.jsonl'))]
manifest={'cutoff':cutoff,'files':[],'malformed':0,'bytes_read':0}
markers=[b'"token_count"',b'"session_meta"',b'"turn_context"',b'"function_call"',b'"thread_settings_applied"',b'"token_usage_record"',b'"compacted"',b'"model/rerouted"',b'"model_rerouted"']
keys=['input_tokens','cached_input_tokens','cache_write_input_tokens','cache_creation_input_tokens','output_tokens','reasoning_output_tokens','total_tokens']
def usage(v):return {k:v[k] for k in keys if k in v} if isinstance(v,dict) else None
for idx,(p,size) in enumerate(files):
    dst=out/'codex'/str(idx)/p.name;dst.parent.mkdir(parents=True,exist_ok=True)
    kept=0; prior_record=False; meta={}
    with p.open('rb') as src,dst.open('w') as target:
        consumed=0
        while consumed<size:
            line=src.readline(size-consumed);consumed+=len(line)
            if not line or not line.endswith(b'\n'):break
            rec=None
            if any(m in line for m in markers):
                try: rec=json.loads(line)
                except (ValueError,UnicodeError):manifest['malformed']+=1
            if not isinstance(rec,dict):
                if prior_record:target.write('{"type":"audit_omitted"}\n');prior_record=False
                continue
            typ=rec.get('type');pl=rec.get('payload') or {};ts=rec.get('timestamp');r=None
            try:
                if ts and datetime.datetime.fromisoformat(ts.replace('Z','+00:00')).timestamp()*1000>cutoff: continue
            except (ValueError,TypeError):pass
            if typ=='session_meta':
                q={k:pl[k] for k in ['id','parent_thread_id','forked_from_id','model'] if k in pl};meta={k:bool(q.get(k)) for k in ['parent_thread_id','forked_from_id']};r=q
            elif typ=='turn_context':r={k:pl[k] for k in ['model','current_date','service_tier'] if k in pl}
            elif pl.get('type')=='token_count':
                info=pl.get('info');r={'type':'token_count','info':None if not isinstance(info,dict) else {k:usage(info[k]) for k in ['total_token_usage','last_token_usage'] if k in info}}
            elif pl.get('type')=='thread_settings_applied':r={'type':pl['type'],'thread_settings':{k:v for k,v in (pl.get('thread_settings') or {}).items() if k in ['model','service_tier']}}
            elif typ=='response_item' and pl.get('type')=='function_call':r={k:pl[k] for k in ['type','name','call_id'] if k in pl}
            elif typ=='token_usage_record':r={k:pl[k] for k in ['response_id','session_id'] if k in pl};r['usage']=usage(pl.get('usage'))
            elif typ=='compacted':r={}
            elif pl.get('type') in ['model/rerouted','model_rerouted']:r={k:v for k,v in pl.items() if k in ['type','model','from_model','to_model','reason']}
            if r is not None:
                target.write(json.dumps({'type':typ,'timestamp':ts,'payload':r},separators=(',',':'))+'\n');kept+=1
            elif prior_record:target.write('{"type":"audit_omitted"}\n')
            prior_record=typ=='token_usage_record' and r is not None
        manifest['bytes_read']+=consumed
    manifest['files'].append({'path':str(dst),'stem':p.stem,'source_size':size,'kept':kept,**meta})
    if (idx+1)%250==0:print(json.dumps({'captured':idx+1,'total':len(files),'source_GB':round(manifest['bytes_read']/1e9,2)}),flush=True)
(out/'manifest.json').write_text(json.dumps(manifest))
print(json.dumps({'done':True,'files':len(files),'malformed':manifest['malformed'],'cutoff':cutoff}),flush=True)
