const { drawDonut, drawTrend, chartPointIndex } = require('../../utils/analytics-chart');
Component({
  properties: { mode: { type: String, value: 'donut' }, segments: { type: Array, value: [] }, daily: { type: Array, value: [] },
    centerValue: { type: String, value: '' }, centerLabel: { type: String, value: 'Tokens' } },
  data: { failed: false },
  observers: { 'mode,segments,daily,centerValue,centerLabel'() { if (this._ready) this.draw(); } },
  lifetimes: { ready() { this._ready = true; this.draw(); }, detached() { this._ready = false; this._drawVersion = (this._drawVersion || 0) + 1; } },
  pageLifetimes: {
    show() { this._shown = true; if (this._ready) this.draw(); },
    hide() { this._shown = false; this._drawVersion = (this._drawVersion || 0) + 1; },
    resize() { this.draw(); },
  },
  methods: {
    draw() {
      if (!this._ready || this._shown === false) return;
      const version = this._drawVersion = (this._drawVersion || 0) + 1;
      wx.createSelectorQuery().in(this).select('#chart').fields({ node: true, size: true, rect: true }).exec(res => {
        if (!this._ready || version !== this._drawVersion || this._shown === false) return;
        try {
          const rect = res?.[0], canvas = rect?.node; if (!canvas || !rect.width) throw new Error('canvas');
          const ratio = wx.getWindowInfo ? wx.getWindowInfo().pixelRatio : wx.getSystemInfoSync().pixelRatio;
          canvas.width = rect.width * ratio; canvas.height = rect.height * ratio;
          const ctx = canvas.getContext('2d'); ctx.scale(ratio, ratio); this._rect = rect;
          const render = () => {
            if (!this._ready || this._shown === false || version !== this._drawVersion) return;
            (this.data.mode === 'trend' ? drawTrend : drawDonut)(ctx, rect.width, rect.height,
              this.data.mode === 'trend' ? this.data.daily : this.data.segments, this.data.centerValue, this.data.centerLabel);
            this.setData({ failed: false });
          };
          // Tab pages can acquire a canvas before their native surface is
          // visible. Render on its next frame, and redraw when the page returns.
          if (canvas.requestAnimationFrame) canvas.requestAnimationFrame(render); else render();
        } catch { this.setData({ failed: true }); }
      });
    },
    touch(e) {
      const touch = e.changedTouches?.[0], rect = this._rect; if (!touch || !rect) return;
      const x = touch.x ?? touch.clientX - rect.left, y = touch.y ?? touch.clientY - rect.top;
      if (this.data.mode === 'trend') {
        const index = chartPointIndex(x, rect.width, this.data.daily.length);
        if (this.data.daily[index]) this.triggerEvent('point', { index });
      } else {
        const radius = Math.hypot(x - rect.width / 2, y - rect.height / 2);
        if (radius < 45 || radius > 110) return;
        const angle = (Math.atan2(y - rect.height / 2, x - rect.width / 2) + Math.PI * 2.5) % (Math.PI * 2);
        const total = this.data.segments.reduce((sum, item) => sum + item.value, 0); let edge = 0;
        for (const segment of this.data.segments) { edge += segment.value / total * Math.PI * 2; if (angle <= edge) { this.triggerEvent('select', segment); break; } }
      }
    },
  },
});
