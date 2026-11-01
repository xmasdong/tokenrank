import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {beijingDay} from '../../src/lib.js';
export function requestFixture(t,worker,{groups=20,users=6}={}){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../../schema.sql',import.meta.url),'utf8'));t?.after(()=>db.close());
 const statements=[];
 const env={DB:{prepare(sql){let values=[];const stmt=db.prepare(sql),args=()=>Object.fromEntries(values.map((v,i)=>[String(i+1),v]));return{
  bind(...v){values=v;return this;},async first(){statements.push(sql);return stmt.get(args())||null;},async all(){statements.push(sql);return{results:stmt.all(args())};},
  async run(){statements.push(sql);const r=stmt.run(args());return{meta:{last_row_id:Number(r.lastInsertRowid),changes:r.changes}};},_select:stmt.columns().length>0
 };},async batch(stmts){db.exec('BEGIN');try{const out=[];for(const s of stmts)out.push(await(s._select?s.all():s.run()));db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 for(let id=1;id<=users;id++){
  db.prepare('INSERT INTO users(id,openid,nickname,avatar_path,created_at,updated_at) VALUES(?,?,?,?,1,1)').run(id,'private-'+id,'成员'+id,id+'.png');
  db.prepare('INSERT INTO mp_sessions VALUES(?,?,?)').run('session-'+id,id,Date.now()+86400000);
  db.prepare('INSERT INTO usage_sync_state VALUES(?,?,1,1)').run(id,'selected');
 }
 for(let g=1;g<=groups;g++){
  db.prepare('INSERT INTO rank_groups VALUES(?,?,1,?,1)').run('g'+g,'群'+g,'secret-group-'+g);
  for(let id=1;id<=users;id++)db.prepare('INSERT INTO rank_group_members VALUES(?,?,1,0)').run('g'+g,id);
 }
 const seed=(id,day,tokens,{device='selected',tool='Codex',model='Model',cost=null}={})=>db.prepare('INSERT INTO daily_totals(user_id,device_id,day,tokens,input_tokens,output_tokens,cache_read,cache_write,requests,models_json,tools_json,cost_json,source_at,updated_at) VALUES(?,?,?,?,0,0,?,0,1,?,?,?,1,1)')
  .run(id,device,day,tokens,tokens,JSON.stringify([[model,tokens]]),JSON.stringify([[tool,tokens]]),cost&&JSON.stringify(cost));
 for(let id=1;id<=users;id++)seed(id,beijingDay(),id*100);
 async function req(path,uid=1,body=null){const before=statements.length;const r=await worker.fetch(new Request('https://rank.test'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(uid?{authorization:'Bearer session-'+uid}:{})},...(body?{body:JSON.stringify(body)}:{})}),env);return{status:r.status,data:await r.json(),queries:statements.length-before};}
 return{db,env,seed,req,statements,close:()=>db.close()};
}
