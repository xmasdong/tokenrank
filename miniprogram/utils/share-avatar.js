const api = require('./api');
// Request uses the existing API domain. Decode in memory, without runtime-specific file URLs.
async function loadAvatarImage(canvas, url) {
  if (!url || !url.startsWith(api.BASE_URL + '/avatars/')) return null;
  const epoch = api.accountEpoch();
  const active = () => !api.accountState() && api.accountEpoch() === epoch;
  if (!active()) return null;
  try {
    const bytes = await new Promise((resolve, reject) => wx.request({url, responseType:'arraybuffer', timeout:10000,
      success:r=>r.statusCode===200?resolve(r.data):reject(new Error('avatar')),fail:reject}));
    if (!active()) return null;
    const data=new Uint8Array(bytes), starts=signature=>signature.every((value,index)=>data[index]===value);
    const type=starts([137,80,78,71,13,10,26,10]) ? 'image/png' : starts([255,216,255]) ? 'image/jpeg'
      : starts([82,73,70,70]) && String.fromCharCode(...data.slice(8,12))==='WEBP' ? 'image/webp' : '';
    if(!type)return null;
    const image = await new Promise((resolve,reject)=>{
      const img=canvas.createImage(),timer=setTimeout(()=>reject(new Error('timeout')),10000);
      img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(new Error('avatar'));};
      // Canvas Image.src supports Data URI from WeChat base library 2.11.0.
      img.src='data:'+type+';base64,'+wx.arrayBufferToBase64(bytes);
    });
    return active() ? image : null;
  } catch { return null; }
}
module.exports={loadAvatarImage};
