// "我每月的 AI 订阅清单" poster, drawn on the phone from the private subscription list. Nothing is uploaded:
// the image only leaves the device when the user shares or saves it.
const { drawCodeBadge } = require('./share-code');
const S = require('./subscriptions');

const WIDTH = 1000;
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';
const ROW = 118;
const C = { ink: '#191919', soft: '#888888', faint: '#B2B2B2', rule: '#EDEDED', amount: '#D88A2D', green: '#07C160', greenBg: '#E9F8F0', muted: '#F7F7F7' };

/** Rows and totals for the poster, in the display currency for totals and the original currency per row. */
function posterModel(data, display = 'CNY', { hideAmounts = false, nickname = '', day = '' } = {}) {
  const fx = data?.fx, ctx = { display, fx };
  const active = (data?.items || []).filter(i => i.status === 'active');
  // Identical plans merge into one row with a count, like "ChatGPT Pro ×2".
  const groups = new Map();
  for (const item of active) {
    const key = [item.name, item.plan, item.price_minor, item.currency, item.cycle, item.custom_days].join('|');
    const g = groups.get(key) || { item, count: 0, monthly: 0, value: 0, ratio: null };
    // A monthly plan shows its real price; other cycles show the monthly equivalent.
    g.count++; g.monthly += item.cycle === 'month' ? item.price_minor : item.monthly_minor;
    if (item.period) { g.value += item.period.value_usd_micros; g.ratio = item.period.ratio; }
    groups.set(key, g);
  }
  const list = [...groups.values()];
  // The main plan is the one whose vendor carried the most usage value this period, else the most expensive.
  const main = list.slice().sort((a, b) => b.value - a.value || S.convert(b.monthly, b.item.currency, 'USD', fx) - S.convert(a.monthly, a.item.currency, 'USD', fx))[0];
  const hide = text => hideAmounts ? '•••' : text;
  const rows = list.map(g => {
    const it = g.item, unit = it.cycle === 'month' ? '' : it.cycle === 'year' ? '年付折合' : it.cycle === 'quarter' ? '季付折合' : '折合';
    return { name: it.name, plan: [it.plan, unit].filter(Boolean).join(' · '), icon: S.iconFor(it.name), initial: [...it.name][0] || '?',
      count: g.count, main: g === main && list.length > 1, price: hide(`${S.money(g.monthly, it.currency, it.monthly_minor % 100 ? 2 : 0)}/月`),
      payback: g.ratio == null ? '' : g.ratio >= 1 ? `本期回本 ${g.ratio} 倍` : `本期回本 ${Math.round(g.ratio * 100)}%` };
  });
  let totalUsd = list.reduce((a, g) => a + S.convert(g.monthly, g.item.currency, 'USD', fx), 0);
  for (const t of data?.topups || []) {
    if (!(t.avg_daily_minor > 0)) continue;
    const monthly = t.avg_daily_minor * 30;
    totalUsd += S.convert(monthly, t.currency, 'USD', fx);
    const preset = S.TOPUP_PRESETS.find(p => p.key === t.vendor);
    rows.push({ name: (preset ? preset.name : t.vendor) + ' API', plan: '按量充值', icon: preset ? preset.icon : '', initial: 'D', count: 1, main: false,
      price: hide(`约 ${S.money(monthly, t.currency, 0)}/月`), payback: '' });
  }
  const v = data?.value;
  const hook = v && v.ratio != null ? { api: S.money(S.convert(v.api_usd_micros / 10000, 'USD', display, fx), display, 0), ratio: v.ratio } : null;
  return { rows, nickname, day, hook, hideAmounts,
    total: hide(`合计约 ${S.money(S.convert(totalUsd, 'USD', display, fx), display, 0)} / 月`),
    rate: fx && fx.source !== 'none' && display !== 'USD' && fx.rates && fx.rates[display] ? `汇率 1 美元 = ${fx.rates[display]} ${S.CURRENCIES.find(c => c.key === display).label}` : '' };
}

const posterHeight = model => 360 + model.rows.length * ROW + 330;

function iconKeys(model) { return [...new Set(model.rows.map(r => r.icon).filter(Boolean))]; }

function drawSubscriptionPoster(ctx, model, { codeImage, icons = {} } = {}) {
  const W = WIDTH, H = posterHeight(model), L = 60, R = W - 60;
  const text = (value, x, y, size, color = C.ink, weight = 400, align = 'left', max = R - L) => {
    ctx.font = `${weight} ${size}px ${FONT}`; ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'alphabetic';
    let s = String(value ?? '');
    while (s.length > 1 && ctx.measureText(s).width > max) s = s.slice(0, -2) + '…';
    ctx.fillText(s, x, y);
    return ctx.measureText(s).width;
  };
  const round = (x, y, w, h, r, fill) => {
    ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, W, H);
  text('Token 群排名', L, 76, 26, C.soft);
  text(model.day, R, 76, 26, C.soft, 400, 'right', 300);
  text('我每月的 AI 订阅清单', L, 166, 64, C.ink, 600);
  if (model.hook) {
    const a = text('近 30 天 API 等值 ', L, 232, 30, C.soft);
    const b = text(model.hook.api, L + a, 232, 30, C.amount, 600);
    const c = text('，订阅回本 ', L + a + b, 232, 30, C.soft);
    text(`${model.hook.ratio} 倍`, L + a + b + c, 232, 30, C.amount, 600);
  } else if (model.nickname) text(model.nickname, L, 232, 30, C.soft);
  let y = 300;
  ctx.fillStyle = C.ink; ctx.fillRect(L, y - 2, R - L, 3);
  for (const row of model.rows) {
    const mid = y + ROW / 2;
    ctx.fillStyle = row.main ? C.amount : C.faint; ctx.beginPath(); ctx.arc(L + 8, mid, 7, 0, Math.PI * 2); ctx.fill();
    const iconX = L + 34, size = 60;
    const image = icons[row.icon];
    if (image) {
      ctx.save(); round(iconX, mid - size / 2, size, size, 14, '#FFFFFF'); ctx.clip(); ctx.drawImage(image, iconX, mid - size / 2, size, size); ctx.restore();
    } else { round(iconX, mid - size / 2, size, size, 14, C.muted); text(row.initial, iconX + size / 2, mid + 11, 30, C.soft, 500, 'center', size); }
    const nameX = iconX + size + 24;
    const priceW = Math.min(300, (ctx.font = `600 36px ${FONT}`, ctx.measureText(row.price).width));
    const nameMax = R - priceW - 40 - nameX;
    const nw = text(row.name + (row.count > 1 ? ` ×${row.count}` : ''), nameX, mid - 4, 36, row.main ? C.amount : C.ink, row.main ? 600 : 500, 'left', nameMax - (row.main ? 90 : 0));
    if (row.main) { round(nameX + nw + 14, mid - 38, 76, 40, 20, '#FBEEDD'); text('主力', nameX + nw + 52, mid - 9, 24, C.amount, 500, 'center', 70); }
    const sub = [row.plan, row.payback].filter(Boolean).join('  ·  ');
    if (sub) text(sub, nameX, mid + 38, 24, row.payback && /回本 \d+(\.\d)? 倍/.test(row.payback) ? C.green : C.soft, 400, 'left', nameMax);
    text(row.price, R, mid + 12, 36, row.main ? C.amount : C.ink, 600, 'right', 300);
    y += ROW;
    ctx.fillStyle = C.rule; ctx.fillRect(L, y - 1, R - L, 2);
  }
  ctx.fillStyle = C.ink; ctx.fillRect(L, y + 1, R - L, 3);
  text(model.total, R, y + 92, 52, C.amount, 700, 'right', R - L);
  if (model.rate) text(model.rate, R, y + 138, 22, C.soft, 400, 'right', 600);
  const codeSize = 150, codeY = H - codeSize - 48;
  drawCodeBadge(ctx, codeImage, L, codeY, codeSize);
  text('长按识别，记下你的 AI 订阅', L + codeSize + 28, codeY + 66, 28, C.ink, 500, 'left', 600);
  text('看每份订阅用 Token 回本了多少', L + codeSize + 28, codeY + 110, 24, C.soft, 400, 'left', 600);
  text('API 等值按电脑端上报的模型价格估算，不代表实际账单', L, H - 18, 20, C.faint, 400, 'left', R - L);
}

module.exports = { WIDTH, ROW, posterModel, posterHeight, iconKeys, drawSubscriptionPoster };
