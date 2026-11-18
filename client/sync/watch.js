import { fork } from 'node:child_process';
import { readConfig, SYNC_DIR } from './config.js';
import { sendHeartbeat, sameConnection, canContact, INTERVAL_MS, CHECK_TIMEOUT_MS } from './health.js';
const SLOW_CHECK_MS = 60_000;
const MAX_KEEP_ALIVE_MS = 3600_000;

/** One isolated check, with bounded execution and no credentials in argv/logs. */
export function startCheck({ dir=SYNC_DIR, timeoutMs=CHECK_TIMEOUT_MS, spawn=fork, onProgress=()=>{},
  worker=new URL('./check-worker.js',import.meta.url) }={}) {
  let child, timer, forceTimer, settled=false, reply=null, timedOut=false, cancelled=false;
  let stop=()=>{};
  const done=new Promise(resolve=>{
    const finish=value=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(forceTimer);resolve(value);};
    try {
      child=spawn(worker,[],{stdio:['ignore','ignore','ignore','ipc'],execArgv:['--no-warnings']});
      stop=()=>{
        if(settled)return;
        child.kill('SIGTERM');
        forceTimer=setTimeout(()=>child.kill('SIGKILL'),2000);forceTimer.unref?.();
      };
      child.on('message',message=>{
        if(message?.type==='progress')onProgress(message);
        else if(['result','failure'].includes(message?.type))reply=message;
      });
      child.once('error',()=>finish({type:'failure',error_code:'PROCESS_EXIT'}));
      child.once('exit',()=>finish(cancelled?{type:'result',result:{skipped:'cancelled'}}:
        timedOut?{type:'failure',error_code:'CHECK_TIMEOUT'}:reply||{type:'failure',error_code:'PROCESS_EXIT'}));
      timer=setTimeout(()=>{timedOut=true;stop();},timeoutMs);
      child.send({dir});
    } catch { finish({type:'failure',error_code:'PROCESS_EXIT'}); }
  });
  return {done,cancel(){cancelled=true;stop();}};
}

/** Independent liveness loop. A stuck reader cannot block heartbeat or recovery.
 * Heartbeats go out on a state change, on a check still running after slowMs, and otherwise once per keep-alive
 * period (default two check intervals; the server may set another one). The server marks a device unreachable after
 * 15 minutes, so an unchanged result does not need a request every cycle. */
export function startWatch({dir=SYNC_DIR,intervalMs=INTERVAL_MS,timeoutMs=CHECK_TIMEOUT_MS,slowMs=SLOW_CHECK_MS,
  keepAliveMs=2*intervalMs,check=startCheck,heartbeat=sendHeartbeat,log=()=>{},now=Date.now,onIdle=()=>{}}={}) {
  let stopped=false, running=null, cycleTask=null, beatTask=null, connection=null, slowTimer=null;
  let status={state:'starting'}, sent=null, keepAlive=keepAliveMs;
  const current=()=>{try{return readConfig(dir);}catch{return null;}};
  const key=s=>JSON.stringify([s.state,s.error_code||null,s.source_day||null]);
  const onAck=ack=>{
    const ms=Number(ack?.heartbeat_ms);
    if(Number.isSafeInteger(ms) && ms>0)keepAlive=Math.min(Math.max(ms,intervalMs),MAX_KEEP_ALIVE_MS);
  };
  // Due from half a cycle before the keep-alive, so a timer firing a few ms late cannot make it fire every cycle;
  // the gap stays at most one keep-alive period.
  const due=()=>!sent || sent.key!==key(status) || now()-sent.at>=keepAlive-intervalMs/2;
  const beat=(force=false)=>{
    if(stopped || beatTask || !connection || !canContact(connection) || !sameConnection(connection,current()))return beatTask || Promise.resolve(false);
    if(!force && !due())return Promise.resolve(false);
    const snapshot={...status},at=now();
    beatTask=Promise.resolve(heartbeat({dir,config:connection,status:snapshot,now:at,onAck}))
      .then(ok=>{if(ok)sent={key:key(snapshot),at};return ok;}).catch(()=>false)
      .finally(()=>{beatTask=null;});
    return beatTask;
  };
  const tick=()=>{
    if(stopped)return Promise.resolve();
    if(cycleTask)return cycleTask;
    cycleTask=(async()=>{
      const config=current();
      if(!canContact(config))return;
      const changed=!sameConnection(connection,config);
      connection=config;
      const started=now(), checking=()=>{status={...status,state:'checking',error_code:null,check_started_at:started};};
      if(changed){status={};checking();sent=null;await beat();if(stopped || !sameConnection(config,current()))return;}
      else slowTimer=setTimeout(()=>{if(stopped || !running)return;checking();beat();},slowMs);
      // A reader resets source_day to null while it starts; publishing that would send a heartbeat every check.
      running=check({dir,timeoutMs,onProgress:p=>{if(p.source_day)status.source_day=p.source_day;}});
      const message=await running.done;running=null;clearTimeout(slowTimer);
      if(stopped || !sameConnection(config,current()))return;
      if(message.result?.skipped==='sync-running') {
        checking();
      } else if(message.result?.skipped && message.result.skipped!=='collector-outdated') {
        return;
      } else {
        const failure=message.error_code || (message.result?.skipped==='collector-outdated'?'COLLECTOR_OUTDATED':null);
        status={...status,state:failure?'error':message.result?.accepted>0?'uploaded':'idle',
          error_code:failure,check_started_at:started,checked_at:now(),source_day:'source_day' in message?message.source_day:status.source_day||null};
        log(failure?`同步检查失败：${failure}`:message.result?.accepted>0?`已同步 ${message.result.accepted} 天用量`:'检查完成，无新增用量');
      }
      // Wait for an older in-flight heartbeat before publishing the outcome.
      if(beatTask)await beatTask;
      await beat();
      await onIdle();
    })().catch(()=>{status={...status,state:'error',error_code:'PROCESS_EXIT',checked_at:now()};return beat();})
      .finally(()=>{clearTimeout(slowTimer);cycleTask=null;});
    return cycleTask;
  };
  const checkTimer=setInterval(tick,intervalMs);
  const heartbeatTimer=setInterval(()=>beat(),intervalMs);
  const first=tick();
  return {first,tick,beat,getStatus:()=>({...status}),async stop(){
    stopped=true;clearInterval(checkTimer);clearInterval(heartbeatTimer);clearTimeout(slowTimer);running?.cancel();
    await cycleTask;await beatTask;
  }};
}
