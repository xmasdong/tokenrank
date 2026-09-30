const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { drawUsagePoster } = require('../utils/usage-poster');
function fixture() {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../utils/share-code.js'), 'utf8'), {
    module, setTimeout, clearTimeout,
    require: () => { throw new Error('固定码不应依赖网络接口'); },
    wx: { request() { throw new Error('固定码不应请求网络'); } },
  });
  return module.exports;
}
test('小程序码使用包内固定资源，不依赖网络或本地写文件', async () => {
  const f = fixture();
  assert.equal(await f.getCodePath(), '/assets/mini-program-code.jpg');
  assert.equal(f.CODE_PATH, await f.getCodePath());
  const bytes = fs.readFileSync(path.join(__dirname, '..', f.CODE_PATH));
  assert.equal(bytes[0], 0xff); assert.equal(bytes[1], 0xd8);
});
test('固定码图片解码失败后可重试，新画布仍加载同一资源', async () => {
  const f = fixture(), sources = []; let image;
  const failed = { createImage: () => ({ set src(value) { sources.push(value); queueMicrotask(() => this.onerror()); } }) };
  await assert.rejects(f.loadCodeImage(failed), /加载失败/);
  const loaded = await f.loadCodeImage({ createImage: () => image = { set src(value) { sources.push(value); queueMicrotask(() => this.onload()); } } });
  assert.equal(loaded, image);
  assert.deepEqual(sources, [f.CODE_PATH, f.CODE_PATH]);
});
test('保存用的海报必须带白底完整小程序码；聊天转发封面不画小程序码', () => {
  const usage = { period: 'day', from: '2026-09-28', to: '2026-09-28', summary: { tokens: 100, requests: 1, active_days: 1 },
    tools: [], models: [], daily: [{ day: '2026-09-28', tokens: 100 }], trend_days: 1 };
  assert.throws(() => drawUsagePoster({}, { user: {}, usage }), /小程序码尚未就绪/);
  for (const cover of [false, true]) {
    const draws = [], fills = [];
    const ctx = { save() {}, restore() {}, arc() {}, clip() {}, fill() {}, measureText: value => ({ width: value.length * 12 }), fillRect(...args) { fills.push({ color: this.fillStyle, args }); },
      drawImage(...args) { draws.push(args); }, strokeRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, fillText() {} };
    const codeImage = { kind: 'official-image-fixture' };
    drawUsagePoster(ctx, { user: {}, usage, cover, theme: 'ink', codeImage });
    if (cover) { assert.equal(draws.length, 0); drawUsagePoster(ctx, { user: {}, usage, cover, theme: 'ink' }); assert.equal(draws.length, 0); continue; }
    assert.equal(draws.length, 1); assert.equal(draws[0][0], codeImage);
    const [, x, y, w, h] = draws[0];
    assert.equal(w, h); assert.ok(x > 0 && x + w < 1000); assert.ok(y > 0 && y + h < (cover ? 800 : 1400));
    assert.ok(fills.some(f => f.color === '#FFFFFF' && f.args[0] < x && f.args[1] < y && f.args[2] > w));
  }
});

test('用户、周期或旧主题参数变化都复用相同的固定码图',async()=>{
  const f=fixture(),a='a'.repeat(24),b='b'.repeat(24);
  const paths=await Promise.all([f.getCodePath(a,'achievement'),f.getCodePath(a,'streak'),f.getCodePath(b,'achievement'),f.getCodePath()]);
  assert.equal(new Set(paths).size,1);assert.equal(paths[0],f.CODE_PATH);
});

test('群海报带完整小程序码并说明入群走群卡片；转发封面不画小程序码',()=>{
  const {drawGroupPoster}=require('../utils/group-poster');
  const data={name:'群榜',members:138,total:123,period:'day',entries:Array.from({length:50},(_,i)=>({rank:i+1,nickname:`成员${i+1}`,tokens_fmt:'2.58 亿',requests:10})),me:{rank:123,tokens_fmt:'1 万'}};
  assert.throws(()=>drawGroupPoster({}, {data}),/小程序码/);
  for(const cover of [true,false]){
    const text=[],draws=[],fills=[];
    const ctx={save() {}, restore() {}, beginPath() {}, arc() {}, clip() {}, measureText:t=>({width:t.length*10}),fillText:t=>text.push(t),fillRect(...args){fills.push({color:this.fillStyle,args});},drawImage:(...args)=>draws.push(args)};
    const image={code:true};drawGroupPoster(ctx,{data,cover,codeImage:image});
    assert.ok(text.includes('138 人已加入 · 今日'));
    assert.ok(text.includes(`本周期 123 人上榜 · 展示前 ${cover?4:5} 名`));
    assert.ok(text.includes('我的群内排名 #123'));
    assert.ok(text.includes(`成员${cover?4:5}`));assert.ok(!text.includes(`成员${cover?5:6}`));
    assert.ok(text.every(t=>!t.includes('人同榜')));
    if(cover){assert.equal(draws.length,0);assert.ok(!text.includes('扫码进入小程序'));assert.ok(text.includes('1 万 Tokens'));
      drawGroupPoster(ctx,{data,cover});assert.equal(draws.length,0);continue;}
    assert.ok(text.includes('入群请点击群内卡片'));assert.equal(draws[0][0],image);
    const [,x,y,w,h]=draws[0];assert.equal(w,h);assert.ok(x+w<750&&y+h<(cover?600:1150));
    assert.ok(fills.some(f=>f.color==='#FFFFFF'&&f.args[0]<x&&f.args[1]<y&&f.args[2]>w));
  }
});
