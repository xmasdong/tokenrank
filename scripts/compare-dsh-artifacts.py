"""Count exact repeated usage events across DSH old/v3 artifacts, read-only."""
import json,subprocess,collections,hashlib
from pathlib import Path
root=Path.home()/'.dsh/sessions'
paths=sorted(p for p in root.rglob('*') if p.is_file() and p.suffix in ['.zst','.zstd'])
sessions={};total=0;records=0;request_groups={}
for p in paths:
    events=collections.Counter();amounts={};types=collections.Counter();n=0;t=0
    proc=subprocess.Popen(['/opt/homebrew/bin/zstd','-dc',str(p)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    for line in proc.stdout:
        if b'"usage"' not in line:continue
        try:r=json.loads(line)
        except:continue
        d=r.get('data') or {};u=d.get('usage') if r.get('type')=='assistant/message' else ((d.get('chunk') or {}).get('usage') if r.get('type')=='assistant/chunk' and (d.get('chunk') or {}).get('type')=='usage' else None)
        if not isinstance(u,dict):continue
        count=sum(u.get(k,0) or 0 for k in ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens'])
        if count<=0:continue
        vals=tuple(u.get(k,0) or 0 for k in ['inputTokens','cacheReadTokens','cacheWriteTokens','outputTokens','reasoningTokens'])
        key=(r.get('time'),*vals);events[key]+=1;amounts[key]=count;n+=1;t+=count;types[r['type']]+=1
        request_key=(str(p.parent),d.get('turn'),d.get('step')) if d.get('turn') is not None and d.get('step') is not None else (str(p.parent),p.name,r.get('seq'))
        request_groups.setdefault(request_key,[]).append({'type':r['type'],'tokens':count,'values':vals,'time':r.get('time'),'declared_total':u.get('totalTokens')})
    proc.stdout.close();err=proc.stderr.read();rc=proc.wait()
    if rc:raise RuntimeError('zstd failed: '+str(rc))
    total+=t;records+=n;sessions.setdefault(str(p.parent),[]).append({'name':p.name,'tokens':t,'records':n,'events':events,'amounts':amounts,'types':dict(types)})
pairs=[];duplicate_tokens=0;duplicate_events=0;within_tokens=0;within_events=0;union_tokens=0;union_events=0
for directory,items in sessions.items():
    union={}
    for item in items:
        within_tokens+=sum(item['amounts'][k]*(n-1) for k,n in item['events'].items())
        within_events+=sum(n-1 for n in item['events'].values())
        union.update(item['amounts'])
    union_tokens+=sum(union.values());union_events+=len(union)
    if len(items)<2:continue
    a,b=items[:2];intersection=a['events'] & b['events'];dt=sum(a['amounts'][k]*n for k,n in intersection.items());de=sum(intersection.values());duplicate_tokens+=dt;duplicate_events+=de
    pairs.append({'session_hash':hashlib.sha256(directory.encode()).hexdigest()[:12],'files':[{k:v for k,v in x.items() if k not in ['events','amounts']} for x in items],'exact_duplicate_tokens':dt,'exact_duplicate_events':de})
matched_groups=[g for g in request_groups.values() if len({x['values'] for x in g})==1]
conflict_groups=[g for g in request_groups.values() if len({x['values'] for x in g})>1]
result={'unique_reasoning_tokens':sum(g[0]['values'][-1] for g in matched_groups),'declared_totals_mismatch':sum(x['declared_total'] is not None and x['declared_total']!=x['tokens'] for g in request_groups.values() for x in g),'same_request_duplicate_tokens':sum(sum(x['tokens'] for x in g)-g[0]['tokens'] for g in matched_groups),'same_request_duplicate_events':sum(len(g)-1 for g in matched_groups),'same_request_unique_tokens':sum(g[0]['tokens'] for g in matched_groups),'request_groups':len(request_groups),'conflict_groups':len(conflict_groups),'files':len(paths),'sessions':len(sessions),'all_artifact_tokens':total,'all_artifact_events':records,'paired_sessions':len(pairs),'exact_duplicate_tokens':duplicate_tokens,'exact_duplicate_events':duplicate_events,'after_exact_cross_artifact_dedup':total-duplicate_tokens,'within_artifact_duplicate_tokens':within_tokens,'within_artifact_duplicate_events':within_events,'unique_session_time_usage_tokens':union_tokens,'unique_session_time_usage_events':union_events,'pairs':pairs}
Path('/tmp/tokenrank-stat-audit-20260928/dsh-comparison.json').write_text(json.dumps(result,indent=2))
print(json.dumps({k:v for k,v in result.items() if k!='pairs'},indent=2))
