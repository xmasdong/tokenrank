import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWxCodeService } from '../src/wx-code.js';
import worker from '../src/worker.js';
// Binary fixture only; this deliberately is not a scannable mini-program code.
const png = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const env = { WX_APPID: 'wx-test', WX_APPSECRET: 'private-test-secret' };
const origin = 'https://rank.test';
const tokenResponse = value => Response.json({ access_token: value, expires_in: 7200 });
function fetchFixture() {
  const calls = [];
  return { calls, fetcher: async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return url.endsWith('/stable_token') ? tokenResponse('private-test-token')
      : new Response(png, { headers: { 'content-type': 'image/png' } });
  } };
}

test('小程序码只指向固定首页，输出不含密钥；内存缓存及并发复用一次生成', async () => {
  const f = fetchFixture(), service = createWxCodeService(f);
  const results = await Promise.all([service(env, origin), service(env, origin), service(env, origin)]);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0].body, { grant_type: 'client_credential', appid: env.WX_APPID, secret: env.WX_APPSECRET, force_refresh: false });
  assert.deepEqual(f.calls[1].body, { scene: 'usage_share', page: 'pages/index/index', env_version: 'release', check_path: true,
    width: 430, auto_color: false, line_color: { r: 0, g: 0, b: 0 }, is_hyaline: false });
  for (const res of results) {
    assert.equal(res.status, 200); assert.match(res.headers.get('cache-control'), /public, max-age=604800/);
    const body = await res.text(); assert.doesNotMatch(body, /private-test/);
    assert.equal(JSON.parse(body).image_base64, Buffer.from(png).toString('base64'));
  }
  assert.equal((await service(env, origin)).status, 200); assert.equal(f.calls.length, 2);
});

test('Cloudflare 缓存可供新实例复用，无须再次调用微信', async () => {
  const records = new Map();
  const cache = { async match(req) { return records.get(req.url)?.clone(); }, async put(req, res) { records.set(req.url, res.clone()); } };
  const f = fetchFixture();
  await createWxCodeService(f)(env, origin, cache);
  const cold = createWxCodeService({ fetcher: async () => { throw new Error('不应请求微信'); } });
  const result = await cold(env, origin, cache);
  assert.equal(result.status, 200); assert.equal(records.size, 1);
});

test('凭证失效仅重新读取稳定凭证后重试一次，不强制废弃其他实例的凭证', async () => {
  let tokens = 0, images = 0;
  const service = createWxCodeService({ fetcher: async (url, options) => {
    if (url.endsWith('/stable_token')) {
      assert.equal(JSON.parse(options.body).force_refresh, false);
      return tokenResponse(`token-${++tokens}`);
    }
    if (++images === 1) return Response.json({ errcode: 40001, errmsg: 'expired' });
    assert.match(url, /token-2$/); return new Response(png);
  } });
  assert.equal((await service(env, origin)).status, 200); assert.equal(tokens, 2); assert.equal(images, 2);
});

test('HTTP 200 的微信错误 JSON 不当作图片缓存，重试能够恢复', async () => {
  let images = 0;
  const service = createWxCodeService({ fetcher: async url => {
    if (url.endsWith('/stable_token')) return tokenResponse('token');
    if (++images === 1) return Response.json({ errcode: 41030, errmsg: 'private error contents' });
    return new Response(png);
  } });
  const bad = await service(env, origin);
  assert.equal(bad.status, 502); assert.match((await bad.json()).error, /先发布小程序对应页面/);
  assert.equal((await service(env, origin)).status, 200); assert.equal(images, 2);
});

test('缺少配置时返回明确错误，公开路由不要求登录且忽略调用者提供的页面参数', async () => {
  const response = await worker.fetch(new Request(`${origin}/api/wx/share-code?page=pages/private/private&env_version=develop`), {});
  assert.equal(response.status, 503); assert.match((await response.json()).error, /AppSecret/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('正式版默认检查已发布页面，体验版仅由服务端配置选择并隔离缓存', async () => {
  const f = fetchFixture(), service = createWxCodeService(f);
  await service(env, origin);
  await service({ ...env, WX_CODE_ENV_VERSION: 'trial' }, origin);
  const calls = f.calls.filter(c => c.url.includes('getwxacodeunlimit'));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body.env_version, 'trial'); assert.equal(calls[1].body.check_path, false);
  assert.equal((await service({ ...env, WX_CODE_ENV_VERSION: 'invalid' }, origin)).status, 503);
});

test('错误、异常内容及超过限额的图片不返回凭证，也不永久缓存失败', async () => {
  const service = createWxCodeService({ fetcher: async url => {
    if (url.endsWith('/stable_token')) return tokenResponse('private-token');
    throw new Error('private-token must never be exposed');
  } });
  const res = await service(env, origin); assert.equal(res.status, 502);
  assert.doesNotMatch(await res.text(), /private-token/);
  const oversized = createWxCodeService({ fetcher: async url => url.endsWith('/stable_token') ? tokenResponse('token')
    : new Response(png, { headers: { 'content-length': 3 * 1024 * 1024 } }) });
  assert.equal((await oversized(env, origin)).status, 502);
  const invalid = createWxCodeService({ fetcher: async url => url.endsWith('/stable_token') ? tokenResponse('token') : new Response('<html>error</html>') });
  assert.equal((await invalid(env, origin)).status, 502);
});

test('记录小程序码按分享 ID 与主题隔离，scene 在微信 32 字符内且只含随机标识与主题', async () => {
  const f=fetchFixture(), service=createWxCodeService(f), id='a'.repeat(24), second='b'.repeat(24);
  await Promise.all([service(env,origin,null,id,'streak'),service(env,origin,null,id,'streak')]);
  await service(env,origin,null,id,'tool'); await service(env,origin,null,second);
  const calls=f.calls.filter(c=>c.url.includes('getwxacodeunlimit'));
  assert.equal(calls.length,3);
  assert.equal(calls[0].body.scene,`s=${id}&m=s`); assert.equal(calls[1].body.scene,`s=${id}&m=t`);
  assert.equal(calls[2].body.scene,`s=${second}&m=a`);
  for(const c of calls){assert.equal(c.body.page,'pages/record/record');assert.ok(c.body.scene.length<=32);assert.doesNotMatch(JSON.stringify(c.body),/private-test/);}
  assert.equal((await service(env,origin,null,'bad')).status,400);
  assert.equal((await service(env,origin,null,id,'bad')).status,400);
});
