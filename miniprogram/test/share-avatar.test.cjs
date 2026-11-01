const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const bytes=new Uint8Array([255,216,255,224]).buffer;
function fixture(){let epoch=0;const requests=[],images=[],module={exports:{}};
 const api={BASE_URL:'https://rank.test',accountEpoch:()=>epoch,accountState:()=>''};
 const wx={request:o=>requests.push(o),arrayBufferToBase64:b=>Buffer.from(b).toString('base64'),getFileSystemManager:()=>{throw Error('头像不应写入临时文件');}};
 const canvas={createImage:()=>{const image={set src(p){this.path=p;images.push(this);queueMicrotask(()=>this.onload());}};return image;}};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../utils/share-avatar.js'),'utf8'),{module,require:()=>api,wx,setTimeout,clearTimeout});
 return{load:module.exports.loadAvatarImage,canvas,requests,images,changeAccount:()=>epoch++};}
test('真实图片字节直接解码为画布头像，不依赖本地文件URL或新增下载域名',async()=>{
 const f=fixture();const pending=f.load(f.canvas,'https://rank.test/avatars/a.jpg');f.requests[0].success({statusCode:200,data:bytes});const image=await pending;assert.ok(image);assert.match(image.path,/^data:image\/jpeg;base64,/);assert.equal(await f.load(f.canvas,'https://other.test/avatar.jpg'),null);assert.equal(f.requests.length,1);
});
test('注销/切账号后的迟到头像不进入画布；非图片及解码失败安全回退',async()=>{
 const f=fixture();const late=f.load(f.canvas,'https://rank.test/avatars/a.jpg');f.changeAccount();f.requests[0].success({statusCode:200,data:bytes});assert.equal(await late,null);assert.equal(f.images.length,0);
 for(const valid of [true,false]){const g=fixture();g.canvas.createImage=()=>({set src(p){queueMicrotask(()=>this.onerror());}});const pending=g.load(g.canvas,'https://rank.test/avatars/a.jpg');g.requests[0].success({statusCode:200,data:valid?bytes:new ArrayBuffer(4)});assert.equal(await pending,null);}
});
test('分享封面和海报并发或反复打开共用头像字节，换账号重新读取，失败不污染缓存',async()=>{
 const f=fixture(),url='https://rank.test/avatars/a.jpg';const a=f.load(f.canvas,url),b=f.load(f.canvas,url);assert.equal(f.requests.length,1);f.requests[0].success({statusCode:200,data:bytes});assert.ok(await a);assert.ok(await b);assert.equal(f.images.length,2);
 for(let i=0;i<10;i++)assert.ok(await f.load(f.canvas,url));assert.equal(f.requests.length,1);
 f.changeAccount();const fresh=f.load(f.canvas,url);assert.equal(f.requests.length,2);f.requests[1].fail({errMsg:'offline'});assert.equal(await fresh,null);
 const retry=f.load(f.canvas,url);assert.equal(f.requests.length,3);f.requests[2].success({statusCode:200,data:bytes});assert.ok(await retry);
});
