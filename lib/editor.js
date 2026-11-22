// lib/editor.js — 修圖畫布：顯示照片、手指塗抹遮罩、雙指縮放平移
//
// 座標系統：
//   影像座標（工作影像像素）→ 螢幕座標： screen = image * scale + (tx, ty)   （CSS 像素）
// 畫布（記憶體）：
//   view    顯示照片（螢幕大小 × devicePixelRatio，最多 2 倍）
//   overlay 顯示紅色筆跡（CSS opacity .5 → 半透明紅）
//   mask    與工作影像同尺寸：黑底、白色＝要移除（交給 AI 引擎）
//   離開編輯器時 release() 會把以上全部歸零。
// 操作：
//   一根手指 → 塗抹（或橡皮擦）；兩根手指 → 縮放與平移（若剛開始塗就放第二指，會取消那一筆）
//   電腦：滑鼠左鍵塗抹、滾輪縮放
// 不會自動開始移除：由 app.js 的「✨ 移除」按鈕觸發。

import { createCanvas, releaseCanvas, getCtx, fitSize } from './image.js';

const STROKE_COLOR = '#ff2d2d';

export class Editor {
  /**
   * @param {HTMLElement} stage
   * @param {HTMLCanvasElement} view
   * @param {HTMLCanvasElement} overlay
   */
  constructor(stage, view, overlay) {
    this.stage = stage;
    this.view = view;
    this.overlay = overlay;
    this.vctx = null;
    this.octx = null;

    /** 目前的工作影像（canvas） */
    this.image = null;
    /** 遮罩（與工作影像同尺寸，黑底白字） */
    this.mask = null;
    this.mctx = null;
    /** 按住「原圖」時顯示的影像 */
    this.compare = null;

    this.strokes = [];   // 已完成的筆跡 {size, erase, points:[{x,y}]}（影像座標）
    this.current = null; // 正在畫的筆跡

    this.scale = 1; this.tx = 0; this.ty = 0;
    this.fitScale = 1; this.atFit = true;
    this.cssW = 0; this.cssH = 0; this.dpr = 1;

    /** 筆刷大小（螢幕 CSS 像素；換算成影像像素時除以 scale） */
    this.brush = 44;
    /** 'paint' 塗抹 | 'erase' 橡皮擦 */
    this.tool = 'paint';
    this.showBrushPreview = false;
    /** false 時不能塗抹（處理中、看原圖時） */
    this.enabled = true;

    this.pointers = new Map();
    this.mode = 'idle'; // 'idle' | 'paint' | 'gesture'
    this.paintId = null;
    this.paintStart = 0;
    this.pinch = null;
    this.rect = null;

    // 事件回呼（由 app.js 設定）
    this.onStrokeStart = () => {};
    this.onStrokeEnd = () => {};
    this.onMaskChange = () => {};
    this.onViewChange = () => {};

    this._raf = 0;
    this._bind();
  }

  // ---------------- 公開方法 ----------------

  /** 設定工作影像。keepView=true 時保留目前縮放位置（例如移除完成後）。記憶體不足會丟出錯誤。 */
  setImage(canvas, { keepView = false } = {}) {
    const sameSize = this.image && this.image.width === canvas.width && this.image.height === canvas.height;
    if (!sameSize || !this.mask) {
      releaseCanvas(this.mask);
      this.mask = null; this.mctx = null;
      const m = createCanvas(canvas.width, canvas.height);
      try { this.mctx = getCtx(m); } catch (e) { releaseCanvas(m); throw e; }
      this.mask = m;
    }
    this.image = canvas;
    this.clearMask();
    this._measure();
    if (!keepView || !sameSize) this.fit(); else this._clamp();
    this._req();
  }

  /** 是否有塗抹（要移除的區域） */
  hasMask() { return this.strokes.some((s) => !s.erase); }

  /** 精確檢查遮罩是不是全黑（塗了又全部擦掉的情況） */
  maskIsEmpty() {
    if (!this.mask || !this.hasMask()) return true;
    const w = Math.min(256, this.mask.width);
    const h = Math.max(1, Math.round(this.mask.height * w / this.mask.width));
    const c = createCanvas(w, h);
    try {
      const x = c.getContext('2d');
      if (!x) return false;
      x.drawImage(this.mask, 0, 0, w, h);
      const d = x.getImageData(0, 0, w, h).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 8) return false;
      return true;
    } catch { return false; } finally { releaseCanvas(c); }
  }

  /** 取得遮罩 canvas（尺寸＝工作影像；黑底、白色＝要移除） */
  getMask() { return this.mask; }

  /** 清除遮罩與紅色筆跡 */
  clearMask() {
    this.strokes = [];
    this.current = null;
    this._fillMaskBlack();
    this._req();
    this.onMaskChange();
  }

  /** 復原最後一筆塗抹／擦除。有東西可以復原就回傳 true */
  undoStroke() {
    if (!this.strokes.length) return false;
    this.strokes.pop();
    this._fillMaskBlack();
    if (this.mctx) for (const st of this.strokes) this._drawToMask(st);
    this._req();
    this.onMaskChange();
    return true;
  }

  /** 'paint' | 'erase' */
  setTool(t) { this.tool = t === 'erase' ? 'erase' : 'paint'; }

  /** 顯示原圖比較（傳 null 結束） */
  setCompare(source) {
    this.compare = source || null;
    this._req();
  }

  setBrush(px) {
    this.brush = px;
    this._req();
  }

  setBrushPreview(on) {
    this.showBrushPreview = on;
    this._req();
  }

  /**
   * 記憶體不足時：把工作影像與遮罩縮小到長邊 maxSide（保留塗抹）。
   * 有縮小就回傳 true。
   */
  downscaleTo(maxSide) {
    if (!this.image) return false;
    const { w, h, s } = fitSize(this.image.width, this.image.height, maxSide);
    if (s >= 1) return false;
    const img2 = createCanvas(w, h);
    const mask2 = createCanvas(w, h);
    try {
      const ic = getCtx(img2);
      ic.imageSmoothingEnabled = true;
      ic.imageSmoothingQuality = 'high';
      ic.drawImage(this.image, 0, 0, w, h);
      const mc = getCtx(mask2);
      mc.fillStyle = '#000';
      mc.fillRect(0, 0, w, h);
      const old = { image: this.image, mask: this.mask };
      this.image = img2; this.mask = mask2; this.mctx = mc;
      this.strokes = this.strokes.map((st) => ({
        ...st, size: st.size * s, points: st.points.map((p) => ({ x: p.x * s, y: p.y * s })),
      }));
      for (const st of this.strokes) this._drawToMask(st);
      releaseCanvas(old.image);
      releaseCanvas(old.mask);
    } catch (e) {
      if (this.image !== img2) { releaseCanvas(img2); releaseCanvas(mask2); }
      throw e;
    }
    // 保持畫面上看到的位置不變
    this.scale /= s; this.fitScale /= s;
    this._clamp();
    this._req();
    this.onMaskChange();
    return true;
  }

  /** 縮放到剛好看到整張 */
  fit() {
    if (!this.image || !this.cssW) return;
    const iw = this.image.width, ih = this.image.height;
    this.fitScale = Math.min(this.cssW / iw, this.cssH / ih);
    this.scale = this.fitScale;
    this.tx = (this.cssW - iw * this.scale) / 2;
    this.ty = (this.cssH - ih * this.scale) / 2;
    this.atFit = true;
    this.onViewChange(true);
    this._req();
  }

  /** 畫面大小改變時呼叫 */
  resize() {
    if (!this.image) return; // 沒有照片時不配置畫布記憶體
    const wasFit = this.atFit;
    this._measure();
    const iw = this.image.width, ih = this.image.height;
    this.fitScale = Math.min(this.cssW / iw, this.cssH / ih) || 1;
    if (wasFit) this.fit(); else { this._clamp(); this._req(); }
  }

  /** 離開編輯器時釋放記憶體（工作影像由呼叫端釋放） */
  release() {
    releaseCanvas(this.mask);
    this.mask = null; this.mctx = null;
    this.image = null; this.compare = null;
    this.strokes = []; this.current = null;
    this.pointers.clear(); this.mode = 'idle'; this.pinch = null;
    if (this._raf) { cancelAnimationFrame(this._raf); this._raf = 0; }
    // 顯示用畫布也歸零（下次 setImage 會重新配置）
    releaseCanvas(this.view);
    releaseCanvas(this.overlay);
  }

  // ---------------- 內部：尺寸與繪製 ----------------

  _fillMaskBlack() {
    if (!this.mctx) return;
    this.mctx.globalCompositeOperation = 'source-over';
    this.mctx.fillStyle = '#000';
    this.mctx.fillRect(0, 0, this.mask.width, this.mask.height);
  }

  _measure() {
    const r = this.stage.getBoundingClientRect();
    this.cssW = r.width; this.cssH = r.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(r.width * this.dpr));
    const h = Math.max(1, Math.round(r.height * this.dpr));
    for (const c of [this.view, this.overlay]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    }
  }

  _req() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this._draw(); });
  }

  _draw() {
    if (!this.vctx) this.vctx = this.view.getContext('2d');
    if (!this.octx) this.octx = this.overlay.getContext('2d');
    const { vctx, octx, dpr } = this;
    if (!vctx || !octx) return; // 記憶體不足時拿不到，略過這一格
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.clearRect(0, 0, this.view.width, this.view.height);
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    if (!this.image) return;

    const s = this.scale;
    const m = [dpr * s, 0, 0, dpr * s, dpr * this.tx, dpr * this.ty];
    vctx.setTransform(...m);
    vctx.imageSmoothingEnabled = true;
    vctx.imageSmoothingQuality = this.mode === 'gesture' ? 'low' : 'high';
    const src = this.compare || this.image;
    vctx.drawImage(src, 0, 0, this.image.width, this.image.height);

    if (!this.compare) {
      // 紅色筆跡（不透明畫在 overlay，overlay 本身半透明 → 重疊處不會變深）
      // 橡皮擦用 destination-out 把紅色挖掉
      octx.setTransform(...m);
      octx.lineCap = 'round';
      octx.lineJoin = 'round';
      octx.strokeStyle = STROKE_COLOR;
      octx.fillStyle = STROKE_COLOR;
      for (const st of this.strokes) this._drawOverlayStroke(octx, st);
      if (this.current) this._drawOverlayStroke(octx, this.current);
      octx.globalCompositeOperation = 'source-over';
    }

    if (this.showBrushPreview) {
      // 調整筆刷時在畫面中央顯示實際大小
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.globalCompositeOperation = 'source-over';
      octx.beginPath();
      octx.arc(this.cssW / 2, this.cssH / 2, this.brush / 2, 0, Math.PI * 2);
      octx.fillStyle = STROKE_COLOR;
      octx.fill();
    }
  }

  _drawOverlayStroke(ctx, st) {
    ctx.globalCompositeOperation = st.erase ? 'destination-out' : 'source-over';
    drawStroke(ctx, st);
  }

  // ---------------- 內部：座標 ----------------

  _toImage(clientX, clientY) {
    const r = this.rect || this.stage.getBoundingClientRect();
    return {
      x: (clientX - r.left - this.tx) / this.scale,
      y: (clientY - r.top - this.ty) / this.scale,
    };
  }

  _clamp() {
    if (!this.image) return;
    const w = this.image.width * this.scale, h = this.image.height * this.scale;
    this.tx = w <= this.cssW ? (this.cssW - w) / 2 : Math.min(0, Math.max(this.cssW - w, this.tx));
    this.ty = h <= this.cssH ? (this.cssH - h) / 2 : Math.min(0, Math.max(this.cssH - h, this.ty));
    const fit = Math.abs(this.scale - this.fitScale) < this.fitScale * 0.01;
    if (fit !== this.atFit) { this.atFit = fit; this.onViewChange(fit); }
  }

  _zoomAt(newScale, sx, sy) {
    const min = this.fitScale, max = Math.max(this.fitScale * 8, 3);
    const s = Math.min(max, Math.max(min, newScale));
    const ix = (sx - this.tx) / this.scale, iy = (sy - this.ty) / this.scale;
    this.scale = s;
    this.tx = sx - ix * s;
    this.ty = sy - iy * s;
    this._clamp();
    this._req();
  }

  // ---------------- 內部：觸控 ----------------

  _bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this._down(e));
    st.addEventListener('pointermove', (e) => this._move(e));
    st.addEventListener('pointerup', (e) => this._up(e, false));
    st.addEventListener('pointercancel', (e) => this._up(e, true));
    st.addEventListener('lostpointercapture', (e) => { if (this.pointers.has(e.pointerId)) this._up(e, false); });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    st.addEventListener('dblclick', (e) => e.preventDefault());
    st.addEventListener('selectstart', (e) => e.preventDefault());
    st.addEventListener('wheel', (e) => {
      if (!this.image) return;
      e.preventDefault();
      const r = this.stage.getBoundingClientRect();
      this._zoomAt(this.scale * Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    // iOS Safari 的手勢事件（避免整頁被縮放）
    st.addEventListener('gesturestart', (e) => e.preventDefault());
    st.addEventListener('gesturechange', (e) => e.preventDefault());
    // 避免 iOS 長按選取／放大鏡
    st.addEventListener('touchstart', (e) => { if (e.target === st || e.target.classList.contains('stage-canvas')) e.preventDefault(); }, { passive: false });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => this.resize()).observe(st);
    } else {
      window.addEventListener('resize', () => this.resize());
    }
  }

  _down(e) {
    if (!this.image) return;
    if (e.target !== this.stage && !e.target.classList.contains('stage-canvas')) return; // 按到畫面上的按鈕
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    try { this.stage.setPointerCapture(e.pointerId); } catch { /* 忽略 */ }
    this.rect = this.stage.getBoundingClientRect();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this.pointers.size === 1) {
      if (!this.enabled) { this.mode = 'gesture'; this.pinch = null; return; }
      this.mode = 'paint';
      this.paintId = e.pointerId;
      this.paintStart = performance.now();
      this.current = {
        size: this.brush / this.scale,
        erase: this.tool === 'erase',
        points: [this._toImage(e.clientX, e.clientY)],
      };
      this.onStrokeStart();
      this._req();
    } else if (this.pointers.size === 2) {
      if (this.mode === 'paint' && this.current) {
        // 剛下筆就放第二指 → 視為要縮放，取消這一筆；畫了一陣子才碰到 → 保留這一筆
        const st = this.current;
        const long = performance.now() - this.paintStart > 350 && st.points.length > 6;
        this.current = null;
        this.paintId = null;
        if (long) { this._commit(st); this.mode = 'gesture'; this._startPinch(); this.onStrokeEnd(); return; }
      }
      this.mode = 'gesture';
      this._startPinch();
      this._req();
    }
  }

  _move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) return;
    if (this.mode === 'paint' && e.pointerId === this.paintId && this.current) {
      const evs = (e.getCoalescedEvents && e.getCoalescedEvents()) || [];
      const list = evs.length ? evs : [e];
      const pts = this.current.points;
      const minStep = 1 / this.scale; // 至少移動 1 螢幕像素才記錄
      for (const ev of list) {
        const pt = this._toImage(ev.clientX, ev.clientY);
        const last = pts[pts.length - 1];
        if (Math.hypot(pt.x - last.x, pt.y - last.y) >= minStep) pts.push(pt);
      }
      this._req();
    }
    p.x = e.clientX; p.y = e.clientY;
    if (this.mode === 'gesture' && this.pointers.size >= 2 && this.pinch) this._updatePinch();
  }

  _up(e, cancelled) {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.delete(e.pointerId);

    if (this.mode === 'paint' && e.pointerId === this.paintId) {
      const st = this.current;
      this.current = null;
      this.paintId = null;
      this.mode = 'idle';
      if (st && !cancelled) {
        this._commit(st);
        this._req();
        this.onStrokeEnd();
      } else {
        this._req();
      }
      return;
    }
    if (this.mode === 'gesture') {
      if (this.pointers.size >= 2) this._startPinch();
      else if (this.pointers.size === 0) { this.mode = 'idle'; this.pinch = null; this._req(); }
      else this.pinch = null; // 剩一指：不做事，直到全部放開
    }
  }

  _startPinch() {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) { this.pinch = null; return; }
    const r = this.rect;
    this.pinch = {
      d: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2 - r.left,
      my: (a.y + b.y) / 2 - r.top,
      s: this.scale, tx: this.tx, ty: this.ty,
    };
  }

  _updatePinch() {
    const [a, b] = [...this.pointers.values()];
    const P = this.pinch, r = this.rect;
    const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top;
    const min = this.fitScale, max = Math.max(this.fitScale * 8, 3);
    const s = Math.min(max, Math.max(min, P.s * d / P.d));
    // 開始時兩指中點下的影像點，維持在目前兩指中點下（同時達成縮放與平移）
    const ix = (P.mx - P.tx) / P.s, iy = (P.my - P.ty) / P.s;
    this.scale = s;
    this.tx = mx - ix * s;
    this.ty = my - iy * s;
    this._clamp();
    this._req();
  }

  /** 完成一筆：記錄並畫進遮罩 */
  _commit(st) {
    this.strokes.push(st);
    this._drawToMask(st);
    this.onMaskChange();
  }

  _drawToMask(st) {
    const c = this.mctx;
    if (!c) return;
    c.save();
    c.globalCompositeOperation = 'source-over';
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const color = st.erase ? '#000' : '#fff';
    c.strokeStyle = color;
    c.fillStyle = color;
    drawStroke(c, st);
    c.restore();
  }
}

function drawStroke(ctx, st) {
  const p = st.points;
  if (!p.length) return;
  if (p.length === 1) {
    ctx.beginPath();
    ctx.arc(p[0].x, p[0].y, st.size / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.lineWidth = st.size;
  ctx.beginPath();
  ctx.moveTo(p[0].x, p[0].y);
  for (let i = 1; i < p.length; i++) ctx.lineTo(p[i].x, p[i].y);
  ctx.stroke();
}
