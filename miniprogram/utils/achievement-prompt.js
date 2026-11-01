const queue=require('./modal-queue');
const pending=new Set(),checked=new Set(),failedAt=new Map(),tickets=new Map();
let cycle=0,sequence=0;
function arm(){cycle++;checked.clear();}
function finish(ticket){const item=tickets.get(ticket);if(item){tickets.delete(ticket);item.done();}}
function validTicket(ticket,api){const item=tickets.get(ticket);return !!item&&item.epoch===api.accountEpoch()&&!api.accountState();}
function maybePrompt(api,wx,user,isVisible,present,onPending=()=>{}){
 const id=user?.user_id;
 if(!id||!user.last_report_at||pending.has(id)||checked.has(id)||Date.now()-(failedAt.get(id)||0)<60000)return false;
 const epoch=api.accountEpoch(),generation=cycle;
 const current=()=>isVisible()&&epoch===api.accountEpoch()&&!api.accountState()&&generation===cycle;
 if(!current())return false;pending.add(id);
 api.achievements().then(data=>{
  if(!current()){pending.delete(id);return;}
  if(!data.pending.length){checked.add(id);pending.delete(id);return;}
  let ticket;
  queue.showCustom({shouldShow:current,onSkip:()=>pending.delete(id),
   present:done=>{
    if(!current()){done();return;}
    // The native page prepares and confirms its own display. Navigation consumes no badge.
    ticket='unlock-'+(++sequence);tickets.set(ticket,{done,epoch});checked.add(id);
    try{onPending(done);present({ticket},()=>finish(ticket));}catch{finish(ticket);}
   },complete:()=>{pending.delete(id);if(ticket)tickets.delete(ticket);}});
 }).catch(()=>{pending.delete(id);failedAt.set(id,Date.now());});
 return true;
}
module.exports={arm,maybePrompt,finish,validTicket,_reset(){pending.clear();checked.clear();failedAt.clear();tickets.clear();cycle=0;sequence=0;}};
