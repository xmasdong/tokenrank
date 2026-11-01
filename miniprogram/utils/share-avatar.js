const api = require('./api');
const cache=new Map(),pending=new Map(),TTL=5*60000,MAX_CHARS=3*1024*1024;
let cacheEpoch=null,chars=0;
function remove(url){const item=cache.get(url);if(item){chars-=item.source.length;cache.delete(url);}}
function sourceFor(url,epoch,active){
  const old=cache.get(url);if(old && Date.now()-old.at<TTL)return Promise.resolve(old.source);
  if(old)remove(url);if(pending.has(url))return pending.get(url);
  const task=(async()=>{
    const bytes=await new Promise((resolve,reject)=>wx.request({url,responseType:'arraybuffer',timeout:10000,
      success:r=>r.statusCode===200?resolve(r.data):reject(new Error('avatar')),fail:reject}));
    if(!active())return null;
    const data=new Uint8Array(bytes),starts=signature=>signature.every((value,index)=>data[index]===value);
    const type=starts([137,80,78,71,13,10,26,10])?'image/png':starts([255,216,255])?'image/jpeg'
      :starts([82,73,70,70])&&String.fromCharCode(...data.slice(8,12))==='WEBP'?'image/webp':'';
    if(!type)return null;
    const source='data:'+type+';base64,'+wx.arrayBufferToBase64(bytes);
    if(source.length<=MAX_CHARS && cacheEpoch===epoch){
      while(chars+source.length>MAX_CHARS && cache.size)remove(cache.keys().next().value);
      cache.set(url,{source,at:Date.now()});chars+=source.length;
    }
    return source;
  })().finally(()=>{if(pending.get(url)===task)pending.delete(url);});
  pending.set(url,task);return task;
}
// Reuse public image bytes in memory; each canvas still creates its own decoded image.
async function loadAvatarImage(canvas,url){
  if(!url || !url.startsWith(api.BASE_URL+'/avatars/'))return null;
  const epoch=api.accountEpoch();if(cacheEpoch!==epoch){cache.clear();pending.clear();chars=0;cacheEpoch=epoch;}
  const active=()=>!api.accountState()&&api.accountEpoch()===epoch;
  if(!active())return null;
  let source;
  try{
    source=await sourceFor(url,epoch,active);if(!source||!active())return null;
    const image=await new Promise((resolve,reject)=>{
      const img=canvas.createImage(),timer=setTimeout(()=>reject(new Error('timeout')),10000);
      img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(new Error('avatar'));};
      // Canvas Image.src supports Data URI from WeChat base library 2.11.0.
      img.src=source;
    });
    return active()?image:null;
  }catch{if(cacheEpoch===epoch && cache.get(url)?.source===source)remove(url);return null;}
}
module.exports={loadAvatarImage};
