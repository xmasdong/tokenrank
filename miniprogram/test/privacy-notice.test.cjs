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
  vm.runInNewContext(fs.readFileSync(path.join(root, 'components/privacy-notice/index.js'), 'utf8'), { wx, Component: d => definition = d, require: () => notice });
  function component() {
    const callbacks = [];
    const c = { ...definition.methods, data: { ...definition.data }, setData(patch, done) { Object.assign(this.data, patch); if (done) callbacks.push(done); } };
    return { c, callbacks, show: () => definition.pageLifetimes.show.call(c), hide: () => definition.pageLifetimes.hide.call(c), detach: () => definition.lifetimes.detached.call(c) };
  }
  return { store, modals, wx, queue, notice, component };
}

test('关闭按钮先收起遮罩，渲染完成后才显示队列里的下一条提示，连续点击只关闭一次', () => {
  const f = fixture(), a = f.component(); f.notice.arm(); a.show(); assert.equal(a.c.data.visible, true);
  f.queue.show(f.wx, { title: '下一条提示' }); assert.equal(f.modals.length, 0);
  a.c.dismissOnce(); a.c.dismissOnce(); assert.equal(a.c.data.visible, false); assert.equal(a.callbacks.length, 1); assert.equal(f.modals.length, 0);
  a.callbacks[0](); assert.equal(f.modals.length, 1); assert.equal(f.modals[0].title, '下一条提示'); assert.equal(f.store.size, 0);
  f.notice.arm(); a.show(); assert.equal(a.c.data.visible, true);
});

test('不再提示保存偏好，知道了仅关闭本次；数字dataset同样兼容', () => {
  const f = fixture(), a = f.component(); f.notice.arm(); a.show();
  a.c.close({ currentTarget: { dataset: { never: 0 } } }); a.callbacks.shift()(); assert.equal(f.store.size, 0);
  f.notice.arm(); a.show(); a.c.dismissForever(); a.callbacks.shift()(); assert.equal(f.store.get(f.notice.KEY), 1);
  f.notice.arm(); a.show(); assert.equal(a.c.data.visible, false);
  const g = fixture(), b = g.component(); g.notice.arm(); b.show(); b.c.close({ currentTarget: { dataset: { never: 1 } } }); b.callbacks.shift()(); assert.equal(g.store.get(g.notice.KEY), 1);
});

test('重复前后台回调及多页面组件只显示一个说明；卸载和迟到的渲染回调不会释放别人的遮罩', () => {
  const f = fixture(), a = f.component(), b = f.component(); f.notice.arm(); a.show();
  f.notice.arm(); b.show(); assert.equal(b.c.data.visible, false);
  a.c.dismissOnce(); const late = a.callbacks[0]; a.detach();
  f.notice.arm(); b.show(); assert.equal(b.c.data.visible, true);
  f.queue.show(f.wx, { title: '等待第二个说明关闭' }); late(); assert.equal(f.modals.length, 0);
  b.c.dismissOnce(); b.callbacks[0](); assert.equal(f.modals.length, 1);
});

test('页面隐藏会关闭并释放说明，本地存储失败也不会卡住页面或后续提示', () => {
  const f = fixture({ storageFails: true }), a = f.component(); f.notice.arm(); a.show();
  f.queue.show(f.wx, { title: '后续提示' }); a.c.dismissForever(); a.hide(); a.callbacks[0]();
  assert.equal(a.c.data.visible, false); assert.equal(f.modals.length, 1);
  const g = fixture(), b = g.component(); g.notice.arm(); b.show(); b.hide(); assert.equal(b.c.data.visible, false); b.callbacks[0]();
  g.notice.arm(); assert.equal(g.notice.claim(g.wx), true);
});

test('可见的残留视图即使丢失实例标记也能关闭，且不能释放另一组件持有的弹窗队列', () => {
  const f = fixture(), owner = f.component(), restored = f.component();
  f.notice.arm(); owner.show();
  f.queue.show(f.wx, { title: '等待真正持有者关闭' });
  restored.c.data.visible = true;
  restored.c.dismissOnce();
  assert.equal(restored.c.data.visible, false);
  restored.callbacks[0]();
  assert.equal(restored.c._closing, false);
  assert.equal(f.modals.length, 0);
  owner.c.dismissOnce(); owner.callbacks[0]();
  assert.equal(f.modals.length, 1);
});

test('真正持有者丢失实例标记后仍能关闭、保存偏好并释放排队提示', () => {
  const f = fixture(), a = f.component(); f.notice.arm(); a.show();
  f.queue.show(f.wx, { title: '后续提示' });
  a.c._noticeHeld = false;
  a.c.dismissForever(); assert.equal(a.c.data.visible, false);
  a.callbacks[0]();
  assert.equal(f.store.get(f.notice.KEY), 1);
  assert.equal(f.modals.length, 1);
  f.notice.arm(); a.show(); assert.equal(a.c.data.visible, false);
});
