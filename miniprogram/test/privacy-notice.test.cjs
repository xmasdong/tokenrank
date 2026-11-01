const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const root = path.resolve(__dirname, '..');
function fixture({ storageFails = false } = {}) {
  const store = new Map(), modals = [];
  const wx = { getStorageSync: k => store.get(k), setStorageSync(k, v) { if (storageFails) throw Error('storage unavailable'); store.set(k, v); }, showModal: o => modals.push(o) };
  const load = (file, require) => { const module = { exports: {} }; vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), { module, require }); return module.exports; };
  const queue = load('utils/modal-queue.js', () => {});
  const notice = load('utils/privacy-notice.js', () => queue);
  let definition;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/privacy-notice/index.js'), 'utf8'), { wx, Component: d => definition = d, require: id => id.endsWith('/privacy-notice') ? notice : queue });
  function component() {
    const callbacks = [];
    const c = { ...definition.methods, data: { ...definition.data }, setData(patch, done) { Object.assign(this.data, patch); if (done) callbacks.push(done); } };
    return { c, callbacks, show: () => definition.pageLifetimes.show.call(c), detach: () => definition.lifetimes.detached.call(c) };
  }
  function choose(index, never = false) { modals[index].success({ confirm: !never, cancel: never }); modals[index].complete({}); }
  return { store, modals, wx, queue, notice, component, choose };
}

test('首次说明使用原生按钮，API完成前不弹下一条提示，正文保留上传范围、退出排名和开源地址', () => {
  const f = fixture(), a = f.component(); f.notice.arm(); a.show();
  assert.equal(f.modals.length, 1); const native = f.modals[0];
  assert.equal(native.confirmText, '知道了'); assert.equal(native.cancelText, '不再提示');
  assert.match(native.content, /不会收集上传代码、对话、项目名和文件路径/);
  assert.match(native.content, /「我的」关闭排名/); assert.match(native.content, /github.com\/xmasdong\/tokenrank/);
  f.queue.show(f.wx, { title: '下一条提示' }); assert.equal(f.modals.length, 1);
  native.success({ confirm: true, cancel: false }); assert.equal(f.modals.length, 1);
  native.complete({}); assert.equal(f.modals.length, 2); assert.equal(f.modals[1].title, '下一条提示');
  assert.equal(a.c.data.visible, false); assert.equal(f.store.size, 0);
});

test('知道了只关闭本次，不再提示保存偏好；重新打开与多页面显示不重复弹出', () => {
  const f = fixture(), a = f.component(), b = f.component(); f.notice.arm(); a.show(); a.show(); b.show();
  assert.equal(f.modals.length, 1); f.choose(0); assert.equal(f.store.size, 0);
  f.notice.arm(); b.show(); assert.equal(f.modals.length, 2); f.choose(1, true);
  assert.equal(f.store.get(f.notice.KEY), 1);
  f.notice.arm(); a.show(); b.show(); assert.equal(f.modals.length, 2);
});

test('原生弹窗期间页面卸载不提前释放队列，迟到的重复完成回调不能释放新弹窗', () => {
  const f = fixture(), a = f.component(), b = f.component(); f.notice.arm(); a.show();
  const old = f.modals[0]; a.detach(); f.notice.arm(); b.show(); assert.equal(f.modals.length, 1);
  f.choose(0); f.notice.arm(); b.show(); assert.equal(f.modals.length, 2);
  f.queue.show(f.wx, { title: '等待第二个说明关闭' }); old.complete({}); assert.equal(f.modals.length, 2);
  f.choose(1); assert.equal(f.modals.length, 3); assert.equal(f.modals[2].title, '等待第二个说明关闭');
});

test('保存偏好失败不影响关闭和后续提示，失败也不会伪装成已保存', () => {
  const f = fixture({ storageFails: true }), a = f.component(); f.notice.arm(); a.show();
  f.queue.show(f.wx, { title: '后续提示' }); f.choose(0, true);
  assert.equal(a.c.data.visible, false); assert.equal(f.store.size, 0); assert.equal(f.modals.length, 2);
});

test('原生API失败和同步异常均释放占用，不误存不再提示', () => {
  const f = fixture(), a = f.component(); f.notice.arm(); a.show();
  f.queue.show(f.wx, { title: 'API失败后的提示' }); f.modals[0].complete({ errMsg: 'showModal:fail' });
  assert.equal(f.store.size, 0); assert.equal(f.modals.length, 2); assert.equal(a.c.data.visible, false);
  const g = fixture(), b = g.component(); g.wx.showModal = () => { throw Error('native unavailable'); };
  g.notice.arm(); b.show(); assert.equal(b.c.data.visible, false);
  g.wx.showModal = o => g.modals.push(o); g.queue.show(g.wx, { title: '同步异常后的提示' }); assert.equal(g.modals.length, 1);
});

test('已有原生提示时说明按序等待；等待期间离开的页面不再弹出说明', () => {
  const f = fixture(), a = f.component();
  f.queue.show(f.wx, { title: '已有提示' }); f.notice.arm(); a.show(); assert.equal(f.modals.length, 1);
  f.modals[0].complete({}); assert.equal(f.modals.length, 2); assert.equal(f.modals[1].title, '关于隐私和开源'); f.choose(1);
  const g = fixture(), b = g.component();
  g.queue.show(g.wx, { title: '等待期间离开' }); g.notice.arm(); b.show(); b.detach();
  g.modals[0].complete({}); assert.equal(g.modals.length, 1); assert.equal(g.store.size, 0);
});
