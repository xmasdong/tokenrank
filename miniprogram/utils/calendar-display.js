const {presentCost}=require('./cost');
const KEY='calendar_display_fields_v1';
const DEFAULTS={tokens:true,device:false,model:false,cost:false};
const OPTIONS=[{key:'tokens',label:'Token 总量',note:'含缓存的完整用量'},
 {key:'device',label:'使用设备',note:'当前统计设备的系统'},
 {key:'model',label:'最常用模型',note:'按已记录的模型用量'},
 {key:'cost',label:'预计费用',note:'API 等值估算 · USD'}];
function normalizeDisplay(value){return Object.fromEntries(Object.entries(DEFAULTS).map(([key,fallback])=>[key,typeof value?.[key]==='boolean'?value[key]:fallback]));}
function readDisplay(wx){try{return normalizeDisplay(wx.getStorageSync?.(KEY));}catch{return {...DEFAULTS};}}
function saveDisplay(wx,value){const result=normalizeDisplay(value);try{wx.setStorageSync?.(KEY,result);}catch{}return result;}
const displayOptions=display=>OPTIONS.map(option=>({...option,checked:display[option.key]}));
function detailsView(details){
 const supported=!!details&&typeof details==='object'&&Object.prototype.hasOwnProperty.call(details,'cost');
 const c=presentCost(details?.cost);
 return {supported,costAvailable:c.available,device:details?.device?.label||'暂无设备记录',model:details?.top_model?.name||'暂无模型记录',
   cost:c.available?'$'+c.amount:c.unpricedCount?'暂无可用价格':'暂无费用记录',
   costBasis:c.available&&details.cost.status==='partial'?'已计价部分 · API 等值估算 · USD':'API 等值估算 · USD',costCoverage:c.note,
   costNote:supported?[c.available&&details.cost.status==='partial'?'已计价部分 · API 等值估算 · USD':'API 等值估算 · USD',c.note,'非实际账单'].filter(Boolean).join(' · '):''};
}
module.exports={KEY,DEFAULTS,OPTIONS,normalizeDisplay,readDisplay,saveDisplay,displayOptions,detailsView};
