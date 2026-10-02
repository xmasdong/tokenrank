#!/usr/bin/env node
// Private operations report: uses the operator's Wrangler login, never a public API.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { presentAgent } from '../server/src/sync-health.js';

export const STATUS_NAMES={unknown:'旧版／状态未知',online:'在线',checking:'检查中',error:'检查失败',stopped:'已停止',unreachable:'超过15分钟未联系'};
export function summarize(rows, now=Date.now()) {
  const users=new Map();
  for(const row of rows) {
    if(!users.has(row.user_id)) users.set(row.user_id,{user_id:row.user_id,nickname:row.nickname||'未填写昵称',last_report_at:row.last_report_at,ranked_device_id:row.ranked_device_id||null,state:'unknown',devices:[]});
    const user=users.get(row.user_id);
    if(row.device_id) user.devices.push({...presentAgent(row,now),ranked:row.device_id===row.ranked_device_id});
  }
  for(const user of users.values()) {
    user.devices.sort((a,b)=>Number(b.ranked)-Number(a.ranked)||b.last_seen_at-a.last_seen_at);
    const current=user.ranked_device_id?user.devices.find(d=>d.ranked):user.devices[0];
    if(current) Object.assign(user,{state:current.state,current});
  }
  const list=[...users.values()];
  return {as_of:now,users:list.length,states:Object.fromEntries(Object.keys(STATUS_NAMES).map(s=>[s,list.filter(u=>u.state===s).length])),accounts:list};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const args=process.argv.slice(2);
    if(args.some(a=>!['--json','--local'].includes(a))) throw new Error('用法：node scripts/sync-status.mjs [--json] [--local]');
    const sql=`SELECT u.id AS user_id,u.nickname,c.last_report_at,s.device_id AS ranked_device_id,
      a.device_id,a.platform,a.state,a.client_version,a.collector_version,a.error_code,
      a.last_seen_at,a.checked_at,a.check_started_at,a.source_day
      FROM users u LEFT JOIN connect_tokens c ON c.user_id=u.id
      LEFT JOIN usage_sync_state s ON s.user_id=u.id LEFT JOIN sync_agents a ON a.user_id=u.id
      WHERE c.last_report_at IS NOT NULL OR s.user_id IS NOT NULL OR a.user_id IS NOT NULL
      ORDER BY u.id,a.last_seen_at DESC`;
    const raw=execFileSync('npx',['wrangler','d1','execute','tokenrank',args.includes('--local')?'--local':'--remote','--command',sql,'--json'],
      {cwd:fileURLToPath(new URL('../server/',import.meta.url)),encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
    const result=JSON.parse(raw); if(result.some(r=>r.success===false)) throw new Error('数据库查询失败');
    const report=summarize(result.flatMap(r=>r.results||[]));
    if(args.includes('--json')) console.log(JSON.stringify(report,null,2));
    else {
      const date=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'—';
      console.log('同步状态（北京时间） '+date(report.as_of));
      console.log(Object.entries(report.states).map(([k,v])=>`${STATUS_NAMES[k]} ${v}`).join(' · '));
      console.table(report.accounts.map(u=>({用户:u.nickname,ID:u.user_id,状态:STATUS_NAMES[u.state],
        平台:u.current?.platform||'—',版本:u.current?.client_version||'—',最近联系:date(u.current?.last_seen_at),
        最近检查:date(u.current?.last_check_at),最近上传:date(u.last_report_at),错误:u.current?.error_code||'—',设备数:u.devices.length})));
      console.log('状态按当前榜单来源设备展示；--json 可查看其他设备。未联系不能区分休眠、断网和程序退出；旧版没有心跳。');
    }
  } catch(error) { console.error('查询同步状态失败：'+error.message);process.exitCode=1; }
}
