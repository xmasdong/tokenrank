import { fork } from 'node:child_process';
import { readConfig, SYNC_DIR } from './config.js';
import { sendHeartbeat, sameConnection, canContact, INTERVAL_MS, CHECK_TIMEOUT_MS } from './health.js';

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

/** Independent liveness loop. A stuck reader cannot block heartbeat or recovery. */
export function startWatch({dir=SYNC_DIR,intervalMs=INTERVAL_MS,timeoutMs=CHECK_TIMEOUT_MS,
  check=startCheck,heartbeat=sendHeartbeat,log=()=>{},now=Date.now,onIdle=()=>{}}={}) {
  let stopped=false, running=null, cycleTask=null, beatTask=null, connection=null;
  let status={state:'starting'};
  const current=()=>{try{return readConfig(dir);}catch{return null;}};
  const beat=()=>{
    if(stopped || beatTask || !connection || !canContact(connection) || !sameConnection(connection,current()))return beatTask || Promise.resolve(false);
    const snapshot={...status};
    beatTask=Promise.resolve(heartbeat({dir,config:connection,status:snapshot,now:now()})).catch(()=>false)
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
      status={...(changed?{}:status),state:'checking',error_code:null,check_started_at:now()};
      await beat(); if(stopped || !sameConnection(config,current()))return;
      running=check({dir,timeoutMs,onProgress:p=>{if('source_day' in p)status.source_day=p.source_day;}});
      const message=await running.done;running=null;
      if(stopped || !sameConnection(config,current()))return;
      if(message.result?.skipped==='sync-running') {
        status={...status,state:'checking'};
      } else if(message.result?.skipped && message.result.skipped!=='collector-outdated') {
        return;
      } else {
        const failure=message.error_code || (message.result?.skipped==='collector-outdated'?'COLLECTOR_OUTDATED':null);
        status={...status,state:failure?'error':message.result?.accepted>0?'uploaded':'idle',
          error_code:failure,checked_at:now(),source_day:'source_day' in message?message.source_day:status.source_day||null};
        log(failure?`同步检查失败：${failure}`:message.result?.accepted>0?`已同步 ${message.result.accepted} 天用量`:'检查完成，无新增用量');
      }
      // Wait for an older in-flight heartbeat before publishing the outcome.
      if(beatTask)await beatTask;
      await beat();
      await onIdle();
    })().catch(()=>{status={...status,state:'error',error_code:'PROCESS_EXIT',checked_at:now()};return beat();})
      .finally(()=>{cycleTask=null;});
    return cycleTask;
  };
  const checkTimer=setInterval(tick,intervalMs);
  const heartbeatTimer=setInterval(beat,intervalMs);
  const first=tick();
  return {first,tick,beat,getStatus:()=>({...status}),async stop(){
    stopped=true;clearInterval(checkTimer);clearInterval(heartbeatTimer);running?.cancel();
    await cycleTask;await beatTask;
  }};
}
