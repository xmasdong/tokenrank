const { painter } = require('./social-poster');
const { compact } = require('./usage');
const { drawCodeBadge, loadCodeImage } = require('./share-code');
const {heatmapView,COLORS}=require('./calendar-heatmap');
const {normalizeDisplay}=require('./calendar-display');
const HEIGHT = 1280;
function calendarLayout(report,display){
  const chosen=normalizeDisplay(display),heatmap=report?heatmapView(report):null;
  const chartExtra=heatmap&&!heatmap.extended?Math.max(0,heatmap.weeks.length*112-434):0;
  const detailHeight=!heatmap||heatmap.detailView.supported?(chosen.device?66:0)+(chosen.model?66:0)+(chosen.cost?126:0):(chosen.device||chosen.model||chosen.cost?54:0);
  return {chosen,heatmap,chartExtra,height:HEIGHT+chartExtra+detailHeight-(chosen.tokens?0:82)};
}
function insightPosterHeight({kind,display,report}){return kind==='calendar'?calendarLayout(report,display).height:HEIGHT;}

// Images use only the report already visible on the page; generating one never refetches data.
function drawInsightPoster(ctx, { kind, report, nickname = '', dimension = 'tools', metric = 'tokens', codeImage,display }) {
  if (!report || !codeImage) throw new Error('数据和小程序码尚未就绪');
  const layout=kind==='calendar'?calendarLayout(report,display):null;
  const height=layout?.height||HEIGHT,chosen=layout?.chosen;
  const p = painter(ctx, height), category = dimension === 'models' ? '模型' : '工具', heatmap=layout?.heatmap;
  p.text('Token 群排名', 60, 52, 24, p.soft);
  p.text(kind === 'calendar' ? '使用日历' : kind === 'trends' ? category + '趋势榜' : (report.tool ? report.tool + ' · ' : '') + category + '分析', 60, 130, 46, p.ink, 880);
  p.text(heatmap ? heatmap.from + ' — ' + heatmap.to : report.from + ' — ' + report.to, 60, 182, 27, p.soft);
  p.text(nickname || (kind === 'trends' || report.scope === 'public' ? '公开上报样本' : '我的用量'), 940, 52, 24, p.soft, 500, 'right');
  if (kind === 'trends') p.text('对比 ' + report.previous_from + ' — ' + report.previous_to, 60, 224, 23, p.soft);
  if (kind === 'calendar') {
    const amount=heatmap.amount;
    const shift=chosen.tokens?0:82;
    if(chosen.tokens)p.text(amount ? amount.value + ' ' + amount.unit + ' Tokens' : '本区间暂无同步记录', 60, 270, 52, p.orange);
    p.text(heatmap.periodLabel+' · 活跃 ' + heatmap.summary.active_days + ' 天 · 已同步 ' + heatmap.summary.reported_days + ' 天', 60, 322-shift, 28, p.soft);
    const extra=layout.chartExtra,top=442-shift;
    if(heatmap.extended){
      const step=Math.min(804/heatmap.weeks.length,66),size=step-8,left=136+(804-step*heatmap.weeks.length)/2;
      heatmap.rows.forEach((label,row)=>{if(label)p.text(label,left-52,top+row*step+size*.7,24,p.soft,40);});
      heatmap.weeks.forEach((week,col)=>{
        if(week.label)p.text(week.label,left+col*step,416-shift,24,p.soft,140);
        week.days.forEach((day,row)=>{if(!day.outside&&!day.future)square(ctx,left+col*step,top+row*step,size,day.reported?COLORS[day.level]:'#FFFFFF',day.reported?'#DCE1E4':'#C7CFD4');});
      });
    }else{
      const step=120,size=108,left=80;
      heatmap.weekdays.forEach((label,col)=>p.text(label,left+col*step+size/2,416-shift,26,p.soft,60,'center'));
      heatmap.weeks.forEach((week,row)=>week.days.forEach((day,col)=>{
        if(day.outside)return;
        const x=left+col*step,y=top+row*112;
        square(ctx,x,y,size,day.future?'#F7F8F9':day.reported?COLORS[day.level]:'#FFFFFF',day.future?null:day.reported?'#DCE1E4':'#C7CFD4');
        p.text(String(day.number),x+size/2,y+size/2+10,28,day.future?'#B4BABF':day.level>=3?'#FFFFFF':p.ink,70,'center');
      }));
    }
    square(ctx,60,918+extra-shift,20,'#FFFFFF','#C7CFD4');p.text('未同步',92,938+extra-shift,23,p.soft,130);
    square(ctx,244,918+extra-shift,20,COLORS[0],'#DCE1E4');p.text('零用量',276,938+extra-shift,23,p.soft,150);
    p.text('少',640,938+extra-shift,23,p.soft,50);COLORS.slice(1).forEach((color,i)=>square(ctx,686+i*42,918+extra-shift,24,color));p.text('多',874,938+extra-shift,23,p.soft,60);
    if(chosen.tokens)p.text(heatmap.peak?'区间单日最高 '+heatmap.peak.amount.value+' '+heatmap.peak.amount.unit+' · '+heatmap.peak.day:'本区间暂无正用量记录',60,1000+extra,27,p.soft,880);
    let y=1050+extra-shift;const row=(label,value,color=p.ink)=>{p.text(label,60,y,25,p.soft,300);p.text(value,940,y,29,color,590,'right');y+=66;};
    if(!heatmap.detailView.supported){if(chosen.device||chosen.model||chosen.cost)p.text('暂无详细统计',60,y,25,p.soft,880);}
    else{
      if(chosen.device)row('当前统计设备',heatmap.detailView.device);
      if(chosen.model)row('最常用模型',heatmap.detailView.model);
      if(chosen.cost){row('预计费用',heatmap.detailView.cost,heatmap.detailView.costAvailable?p.orange:p.ink);p.text(heatmap.detailView.costBasis+' · 非实际账单',60,y-28,22,p.soft,880);if(heatmap.detailView.costCoverage)p.text(heatmap.detailView.costCoverage,60,y+4,22,p.soft,880);}
    }
  } else {
    const trends = kind === 'trends', preferred = !trends && report.scope === 'public' && metric === 'people', people = trends && metric === 'users' || preferred;
    const rows = (trends ? report.entries : preferred ? [...report.items].sort((a,b)=>b.preferred_users-a.preferred_users) : report.items).slice(0, 5);
    p.text(trends ? (people ? '使用人数' : '含缓存总量') : preferred ? '按常用人数' : '按 Token 占比', 60, 260, 27, p.soft);
    const value = row => preferred ? row.preferred_users : people ? row.users : row.tokens;
    const max = Math.max(0, ...rows.map(value));
    rows.forEach((row, i) => {
      const y = 340 + i * 126, amount = compact(row.tokens);
      p.text((trends ? String(row.rank) + '  ' : '') + row.name, 60, y, 32, p.ink, 580);
      p.text(people ? value(row) + ' 人' : amount.value + ' ' + amount.unit, 940, y, 35, p.orange, 330, 'right');
      ctx.fillStyle = '#F0F0F0'; ctx.fillRect(60, y + 20, 880, 8);
      ctx.fillStyle = i === 0 ? p.orange : '#9DB7A6'; ctx.fillRect(60, y + 20, max ? 880 * value(row) / max : 0, 8);
      p.text(trends ? row.previous_rank == null ? '上期无记录' : row.rank_change > 0 ? '上升 ' + row.rank_change : row.rank_change < 0 ? '下降 ' + -row.rank_change : '位次不变' : (preferred ? row.preferred_percent : row.percent) + '%', 60, y + 60, 22, p.soft);
    });
    if (!rows.length) p.text('本期暂无分类明细', 60, 340, 30, p.soft);
    p.text('前 ' + rows.length + ' 项' + (trends ? ' · 本期 ' + report.summary.users + ' 位公开用户' : report.has_overlap ? ' · 明细可能重叠' : ''), 60, 1000, 23, p.soft);
  }
  const footer=height-240;p.rule(footer); p.text('扫码进入小程序', 60, footer+80, 28, p.ink, 600);
  p.text('含缓存 · 北京时间 · 生成时的记录', 60, footer+140, 22, p.soft, 600);
  drawCodeBadge(ctx, codeImage, 736, footer+8, 200);
}

function square(ctx,x,y,size,color,stroke){
  const r=Math.min(6,size/4);ctx.beginPath();ctx.moveTo(x+r,y);ctx.lineTo(x+size-r,y);ctx.quadraticCurveTo(x+size,y,x+size,y+r);ctx.lineTo(x+size,y+size-r);ctx.quadraticCurveTo(x+size,y+size,x+size-r,y+size);ctx.lineTo(x+r,y+size);ctx.quadraticCurveTo(x,y+size,x,y+size-r);ctx.lineTo(x,y+r);ctx.quadraticCurveTo(x,y,x+r,y);ctx.closePath();ctx.fillStyle=color;ctx.fill();
  if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=1;ctx.stroke();}
}

function insightImages(wx, api) {
  return {
    async shareInsightImage() {
      if (this.data.insightImageBusy || !this.data.report) return;
      const report = this.data.report, epoch = api.accountEpoch(),presentation=this.insightImageOptions(),signature=JSON.stringify(presentation);
      const privateReport = presentation.kind === 'calendar' || this.data.scope === 'mine';
      const current = () => this._visible && report === this.data.report && epoch === api.accountEpoch() && signature===JSON.stringify(this.insightImageOptions()) && !(privateReport && api.accountState?.());
      if (!current()) return;
      this.setData({ insightImageBusy: true });
      try {
        const cached = this._insightImage;
        let path = cached?.report === report && cached.epoch === epoch && cached.signature===signature ? cached.path : '';
        if (!path) {
          const canvas = await new Promise(resolve => wx.createSelectorQuery().in(this).select('#insightCanvas').fields({ node: true }).exec(rows => resolve(rows?.[0]?.node)));
          if (!canvas) throw new Error('画布不可用');
          const codeImage = await loadCodeImage(canvas);
          if (!current()) return;
          const height=insightPosterHeight({...presentation,report});canvas.width = 1000; canvas.height = height;
          drawInsightPoster(canvas.getContext('2d'), { ...presentation, report, codeImage });
          path = await new Promise((resolve, reject) => wx.canvasToTempFilePath({canvas, destWidth:1000, destHeight:height, fileType:'png', success:r=>resolve(r.tempFilePath), fail:reject}));
          if (!current()) return;
          this._insightImage = { report, epoch, signature, path };
        }
        const preview = () => { if (current()) wx.previewImage({urls:[path]}); };
        if (typeof wx.showShareImageMenu !== 'function') preview();
        else wx.showShareImageMenu({path, fail:error=>{if(!/cancel/i.test(error.errMsg || '')) preview();}});
      } catch (error) { if (current()) wx.showToast({title:error.message || '图片生成失败，请重试',icon:'none'}); }
      finally { this.setData({insightImageBusy:false}); }
    },
  };
}
module.exports = { HEIGHT, insightPosterHeight,drawInsightPoster, insightImages };
