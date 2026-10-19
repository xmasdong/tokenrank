const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {normalizeEmail}=require('../utils/email');
function fixture(){
  let definition,epoch=0,state='',cached=null;
  const calls=[],modals=[],navigation=[];
  const initial={phase:'registration',delivery_enabled:false,verified:false,registered:false,email:null,masked_email:null,revision:null,consent_version:'email-daily-registration-v1'};
  const api={accountEpoch:()=>epoch,accountState:()=>state,ensureSession:async()=>{},peekEmailRegistration:()=>cached,
    emailRegistration:async()=>{calls.push(['get']);return initial;},
    saveEmailRegistration:async body=>{calls.push(['save',body]);return {...initial,registered:true,email:body.email,masked_email:'u***@example.com',revision:'a'.repeat(32)};},
    removeEmailRegistration:async revision=>{calls.push(['remove',revision]);return {...initial,revision:'b'.repeat(32)};}};
  const wx={navigateTo:o=>navigation.push(o.url),showModal:o=>modals.push(o),stopPullDownRefresh(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../pages/email/email.js'),'utf8'),{require:id=>id.endsWith('/api')?api:{normalizeEmail},wx,Page:o=>definition=o});
  const p={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(value){Object.assign(this.data,value);}};
  return {p,api,calls,modals,navigation,initial,setCached:value=>cached=value,delete:()=>{epoch++;state='deleted';},input:value=>p.inputEmail({detail:{value}}),consent:()=>p.changeConsent({detail:{value:['email']}})};
}
test('进入邮箱页只读正式状态，未主动填写和勾选不能登记，不调用微信授权或发信',async()=>{
  const f=fixture();await f.p.onShow();assert.deepEqual(f.calls,[['get']]);assert.equal(f.p.data.consent,false);
  await f.p.save();assert.match(f.p.data.error,/有效/);f.input('u@example.com');await f.p.save();assert.match(f.p.data.error,/同意/);assert.equal(f.calls.length,1);
  f.consent();await f.p.save();assert.equal(f.calls[1][0],'save');assert.equal(f.calls[1][1].consent,true);assert.equal(f.calls[1][1].expected_revision,null);
  assert.equal(f.p.data.status.registered,true);assert.equal(f.p.data.status.delivery_enabled,false);assert.equal(f.p.data.status.verified,false);assert.match(f.p.data.notice,/推送尚未开放/);
});
test('保存失败保留输入，不显示成功；修改现有邮箱需再次同意登记说明',async()=>{
  const f=fixture();await f.p.onShow();f.input('u@example.com');f.consent();f.api.saveEmailRegistration=async()=>{throw Error('网络失败');};
  await f.p.save();assert.equal(f.p.data.status.registered,false);assert.equal(f.p.data.email,'u@example.com');assert.match(f.p.data.error,/网络失败/);assert.equal(f.p.data.notice,'');assert.equal(f.p.data.busy,false);
  f.p.showStatus({...f.initial,email:'old@example.com',registered:true,revision:'a'.repeat(32)});f.p.editEmail();assert.equal(f.p.data.email,'old@example.com');assert.equal(f.p.data.consent,false);f.p.cancelEdit();assert.equal(f.p.data.email,'');
});
test('撤销需要本人确认；取消不写，确认删除后清空邮箱，注销后迟到保存不能恢复状态',async()=>{
  const f=fixture();await f.p.onShow();f.input('u@example.com');f.consent();await f.p.save();
  f.p.remove();await f.modals.at(-1).success({confirm:false});assert.equal(f.calls.filter(x=>x[0]==='remove').length,0);
  f.p.remove();await f.modals.at(-1).success({confirm:true});assert.equal(f.calls.at(-1)[0],'remove');assert.equal(f.p.data.status.email,null);assert.equal(f.p.data.email,'');assert.equal(f.p.data.status.registered,false);
  let finish;f.api.saveEmailRegistration=()=>new Promise(resolve=>finish=resolve);f.input('u@example.com');f.consent();const save=f.p.save();f.delete();finish({...f.initial,email:'u@example.com',registered:true});await save;
  assert.equal(f.p.data.status.email,null);await f.p.onShow();assert.equal(f.p.data.email,'');assert.equal(f.p.data.status,null);assert.equal(f.navigation.at(-1),'/pages/account/account');
});
test('返回复用缓存并保留正在编辑的草稿；手动刷新才重新请求',async()=>{
  const f=fixture();f.setCached({...f.initial,email:'u@example.com',registered:true,masked_email:'u***@example.com',revision:'a'.repeat(32)});
  await f.p.onShow();assert.equal(f.calls.length,0);f.p.editEmail();f.input('new@example.com');f.p.onHide();await f.p.onShow();assert.equal(f.p.data.email,'new@example.com');assert.equal(f.calls.length,0);
  await f.p.onPullDownRefresh();assert.equal(f.calls.length,1);assert.equal(f.p.data.status.registered,false);
});
test('保存期间迟到的旧读取不能覆盖新登记，页面离开或账号变化后不恢复私有邮箱',async()=>{
  const f=fixture();await f.p.onShow();let finish;f.api.emailRegistration=()=>new Promise(resolve=>finish=resolve);
  const read=f.p.load({force:true});await new Promise(setImmediate);f.input('u@example.com');f.consent();await f.p.save();finish(f.initial);await read;
  assert.equal(f.p.data.status.registered,true);assert.equal(f.p.data.status.email,'u@example.com');
  const g=fixture();g.api.emailRegistration=()=>new Promise(resolve=>finish=resolve);const opening=g.p.onShow();await new Promise(setImmediate);g.delete();finish({...g.initial,email:'private@example.com',registered:true});await opening;assert.equal(g.p.data.status,null);
});
test('入口和页面文案区分微信一次摘要、邮箱完整日报和登记阶段',()=>{
  const form=fs.readFileSync(path.join(__dirname,'../pages/email/email.wxml'),'utf8');
  assert.match(form,/尚未开放/);assert.match(form,/现阶段不发送邮件/);assert.match(form,/邮箱尚未验证/);assert.match(form,/登记不等于开启推送/);assert.match(form,/工具／模型/);
  const entry=fs.readFileSync(path.join(__dirname,'../pages/reminders/reminders.wxml'),'utf8');assert.match(entry,/goEmail/);assert.match(entry,/完整邮箱日报/);assert.match(entry,/每次授权预约一条/);
});
