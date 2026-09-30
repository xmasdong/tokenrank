const api = require('./api');
// Same request domain as the API. No new downloadFile domain is needed.
async function loadAvatarImage(canvas, url) {
  if (!url || !url.startsWith(api.BASE_URL + '/avatars/')) return null;
  try {
    const bytes = await new Promise((resolve, reject) => wx.request({url, responseType:'arraybuffer', timeout:10000,
      success:r=>r.statusCode===200?resolve(r.data):reject(new Error('avatar')),fail:reject}));
    const path=wx.env.USER_DATA_PATH+'/tokenrank-card-avatar-'+url.split('/').pop();
    await new Promise((resolve,reject)=>wx.getFileSystemManager().writeFile({filePath:path,data:bytes,success:resolve,fail:reject}));
    return await new Promise((resolve,reject)=>{const img=canvas.createImage();const timer=setTimeout(()=>reject(new Error('timeout')),10000);
      img.onload=()=>{clearTimeout(timer);resolve(img);};img.onerror=()=>{clearTimeout(timer);reject(new Error('avatar'));};img.src=path;});
  } catch { return null; }
}
module.exports={loadAvatarImage};
