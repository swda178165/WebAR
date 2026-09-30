// 主程式：狀態、復原/重做、屬性面板、匯入匯出、拖放檔案。
import {
  uid, clone, dist, add, mul, sub, wallFrame, projectOnSegment, areaM2, m2ToPing, polygonCentroid,
  normalizePlan, newPlan, ROOM_KINDS, OPENING_TYPES, DEFAULTS, round1,
} from './model.js';
import { CATALOG, COUNTER_TOPS, itemName } from './catalog.js';
import { builtinPlans } from './plans.js';
import { Editor2D } from './editor2d.js';
import { View3D } from './view3d.js';
import { exportDXF, dxfToPlan, decodeDXF, planFromGeometry } from './dxf.js';
import { saveFile, downloadsCap, readAsText, readAsBuffer, readAsDataURL, imageToUnderlay, openPdf, renderPdfPage, extractPdfVectors } from './files.js';

const STORE_KEY = 'house3d.project.v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TOOL_HINTS = {
  select: '點選牆、門窗、家具或房間後可拖拉；拖曳空白處平移，滾輪縮放。雙擊牆可在該處分割。',
  wall: '點一下開始，再點下一個轉角；雙擊、右鍵或 Esc 結束。按住 Alt 可畫斜牆。',
  door: '點在牆上放一扇門，之後可在右側調整寬度與開門方向。',
  sliding: '點在牆上放推拉門。',
  window: '點在牆上放窗。',
  opening: '點在牆上放一個沒有門的開口。',
  room: '點在牆圍起來的區域內，會自動偵測成房間。',
  item: '在圖上點一下放置家具。',
  measure: '點兩點量距離。',
  calibrate: '底圖校正：在底圖上點一段已知長度的兩端，再輸入實際公分數。',
  underlay: '拖曳底圖對齊牆線，完成後按「完成移動」。',
};

class App {
  constructor() {
    this.settings = { snap: true, snapStep: 5, grid: true, dims: true, labels: true, area: true, itemLabels: true, highlighter: true };
    this.sel = null;
    this.tool = 'select';
    this.placeKind = 'bed';
    this.history = new Map(); // planId → {undo:[], redo:[]}
    this.load();
    this.editor = new Editor2D($('#plan2d'), this);
    this.view = new View3D($('#view3d'), this);
    this.editor.resizeObserve();
    this.bindUI();
    this.renderTabs();
    this.renderProps();
    this.applyTheme();
    requestAnimationFrame(() => { this.editor.fit(); this.view.setView('iso', true); });
    this.snapshotBase();
    downloadsCap(); // 在 Claude 檢視器裡預先取得存檔能力，第一次匯出不必等
  }

  // ---------- 專案 ----------
  get plan() { return this.project.plans.find((p) => p.id === this.project.active) || this.project.plans[0]; }

  load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
    if (saved?.plans?.length) {
      this.project = { plans: saved.plans.map(normalizePlan), active: saved.active };
      // 內建底圖若遺失 src，從內建資料補回
      const builtin = builtinPlans();
      for (const p of this.project.plans) {
        if (p.underlay && !p.underlay.src && p.underlay.builtin) {
          const b = builtin.find((x) => x.underlay?.src === p.underlay.builtin);
          if (b) p.underlay.src = b.underlay.src;
        }
      }
    } else {
      const plans = builtinPlans();
      this.project = { plans, active: plans[0].id };
    }
  }

  save() {
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(this.project));
      } catch {
        // 底圖太大存不下時，只存不含底圖的版本
        try {
          const lite = { ...this.project, plans: this.project.plans.map((p) => ({ ...p, underlay: p.underlay && p.underlay.src?.startsWith('data:') ? { ...p.underlay, src: null } : p.underlay })) };
          localStorage.setItem(STORE_KEY, JSON.stringify(lite));
          if (!this._warnedQuota) { this._warnedQuota = true; this.toast('瀏覽器空間不足，上傳的底圖不會被記住（其他內容已儲存）'); }
        } catch { /* 無法儲存 */ }
      }
    }, 300);
  }

  hist() {
    const id = this.plan.id;
    if (!this.history.has(id)) this.history.set(id, { undo: [], redo: [], last: null });
    return this.history.get(id);
  }

  snap() {
    const p = this.plan;
    return JSON.stringify({ ...p, underlay: p.underlay ? { ...p.underlay, src: undefined } : null });
  }

  snapshotBase() { const h = this.hist(); if (!h.last) h.last = this.snap(); }

  commit() {
    const h = this.hist();
    const s = this.snap();
    if (h.last && s !== h.last) { h.undo.push(h.last); if (h.undo.length > 150) h.undo.shift(); h.redo = []; }
    h.last = s;
    this.save();
    this.changed(false);
  }

  restore(s) {
    const p = this.plan;
    const data = JSON.parse(s);
    const src = p.underlay?.src;
    Object.assign(p, normalizePlan(data));
    if (p.underlay && src) p.underlay.src = src;
    if (this.sel && !this.findSel(this.sel)) this.sel = null;
    this.hist().last = s;
    this.save();
    this.changed(false);
    this.renderTabs();
  }

  undo() { const h = this.hist(); if (!h.undo.length) return this.toast('沒有可以復原的步驟'); h.redo.push(h.last); this.restore(h.undo.pop()); }
  redo() { const h = this.hist(); if (!h.redo.length) return; h.undo.push(h.last); this.restore(h.redo.pop()); }

  changed(transient, opts = {}) {
    this.editor.render();
    if (!opts.skip3d) this.view.invalidate();
    if (!transient) this.renderProps();
    else this.updatePropsLive();
  }

  setSel(sel) {
    this.sel = sel;
    this.editor.render();
    this.view.invalidate();
    this.renderProps();
    if (sel && matchMedia('(max-width: 900px)').matches) { /* 手機：保持目前頁面 */ }
  }

  findSel(sel) {
    const p = this.plan;
    if (!sel) return null;
    const list = { wall: p.walls, opening: p.openings, item: p.items, room: p.rooms }[sel.type];
    return list?.find((x) => x.id === sel.id) || null;
  }

  setTool(t) {
    if (this.editor.draft) this.editor.finishDraft();
    this.tool = t;
    this.editor.hover = null;
    document.querySelectorAll('.rail [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === t || (t === 'calibrate' && false)));
    $('#pane2d').dataset.tool = t;
    $('#toolHint').textContent = t === 'select' ? '' : (TOOL_HINTS[t] || '');
    $('#catalog').hidden = t !== 'item';
    if (t === 'item') this.renderCatalog();
    this.editor.render();
    if (t === 'underlay' || t === 'calibrate') this.renderProps();
  }

  wallThickness() { return this._wallT || 12; }

  defaultOpening(type) {
    return {
      door: { type: 'door', w: 90, h: DEFAULTS.doorHeight, sill: 0 },
      sliding: { type: 'sliding', w: 160, h: DEFAULTS.slidingHeight, sill: 0 },
      window: { type: 'window', w: 120, h: DEFAULTS.windowHeight, sill: DEFAULTS.windowSill },
      opening: { type: 'opening', w: 90, h: DEFAULTS.doorHeight, sill: 0 },
    }[type];
  }

  addWall(a, b) {
    const t = this.wallThickness();
    this.plan.walls.push({ id: uid('w'), a: { ...a }, b: { ...b }, t, h: this.plan.wallHeight, kind: t >= 16 ? 'ext' : 'int' });
  }

  splitWall(id, p) {
    const plan = this.plan;
    const w = plan.walls.find((x) => x.id === id);
    if (!w) return;
    const pr = projectOnSegment(p, w.a, w.b);
    const L = dist(w.a, w.b);
    const at = Math.round(pr.tc * L);
    if (at < 10 || at > L - 10) return;
    const ops = plan.openings.filter((o) => o.wall === id);
    if (ops.some((o) => Math.abs(o.pos - at) < o.w / 2)) return this.toast('不能在門窗上分割');
    const m = { x: round1(w.a.x + (w.b.x - w.a.x) * at / L), y: round1(w.a.y + (w.b.y - w.a.y) * at / L) };
    const w2 = { ...clone(w), id: uid('w'), a: { ...m } };
    w.b = { ...m };
    plan.walls.push(w2);
    for (const o of ops) if (o.pos > at) { o.wall = w2.id; o.pos -= at; }
    this.setSel({ type: 'wall', id: w2.id });
    this.commit();
    this.toast('已在該點分割牆');
  }

  deleteSel() {
    const p = this.plan, s = this.sel;
    if (!s) return;
    if (s.type === 'wall') { p.walls = p.walls.filter((x) => x.id !== s.id); p.openings = p.openings.filter((o) => o.wall !== s.id); }
    if (s.type === 'opening') p.openings = p.openings.filter((x) => x.id !== s.id);
    if (s.type === 'item') p.items = p.items.filter((x) => x.id !== s.id);
    if (s.type === 'room') p.rooms = p.rooms.filter((x) => x.id !== s.id);
    this.sel = null;
    this.commit();
  }

  duplicateSel() {
    const s = this.sel, p = this.plan;
    if (s?.type !== 'item') return;
    const it = p.items.find((x) => x.id === s.id);
    const c = { ...clone(it), id: uid('i'), x: it.x + 30, y: it.y + 30 };
    p.items.push(c);
    this.setSel({ type: 'item', id: c.id });
    this.commit();
  }

  // ---------- 介面 ----------
  bindUI() {
    document.querySelectorAll('.rail [data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(this.tool === b.dataset.tool && b.dataset.tool === 'item' ? 'select' : b.dataset.tool)));
    document.querySelectorAll('.rail [data-cmd]').forEach((b) => b.addEventListener('click', () => this.cmd(b.dataset.cmd)));
    $('#zoomIn').onclick = () => { const r = $('#plan2d').getBoundingClientRect(); this.editor.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25); };
    $('#zoomOut').onclick = () => { const r = $('#plan2d').getBoundingClientRect(); this.editor.zoomAt(r.left + r.width / 2, r.top + r.height / 2, 0.8); };
    $('#zoomFit').onclick = () => this.editor.fit();
    $('#toggleUnderlay').onclick = () => {
      const u = this.plan.underlay;
      if (!u) { this.toast('這個平面沒有底圖，可把圖片或 PDF 拖進來'); return; }
      u.visible = !u.visible;
      this.commit();
    };
    // 3D
    document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#viewSeg button').forEach((x) => x.classList.toggle('on', x === b));
      this.view.setView(b.dataset.view);
      $('#walkpad').hidden = b.dataset.view !== 'walk';
      if (b.dataset.view === 'walk') this.toast('漫遊：拖曳看四周，W A S D 或方向鍵移動');
    }));
    const cut = $('#cutRange');
    cut.addEventListener('input', () => {
      const v = +cut.value;
      this.view.cutHeight = v >= 300 ? null : v;
      $('#cutOut').textContent = v >= 300 ? '完整' : v + ' cm';
      this.view.invalidate();
    });
    $('#toggleLabels3d').onclick = (e) => { this.view.showLabels = !this.view.showLabels; e.currentTarget.classList.toggle('on', this.view.showLabels); this.view.invalidate(); };
    document.querySelectorAll('#walkpad button').forEach((b) => {
      const k = b.dataset.walk;
      const on = (e) => { e.preventDefault(); this.view.walk.keys.add(k); };
      const off = () => this.view.walk.keys.delete(k);
      b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointerleave', off); b.addEventListener('pointercancel', off);
    });
    // 匯出選單
    const menu = $('#exportMenu');
    $('#btnExport').onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; $('#btnExport').setAttribute('aria-expanded', String(!menu.hidden)); };
    document.addEventListener('click', (e) => { if (!menu.contains(e.target)) { menu.hidden = true; $('#btnExport').setAttribute('aria-expanded', 'false'); } });
    menu.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => { menu.hidden = true; this.exportAs(b.dataset.export); }));
    $('#btnOpen').onclick = () => $('#fileInput').click();
    $('#fileInput').addEventListener('change', (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) this.importFile(f); });
    $('#btnHelp').onclick = () => this.showHelp();
    // 手機切換
    document.querySelectorAll('#mobileSwitch button').forEach((b) => b.addEventListener('click', () => {
      document.querySelectorAll('#mobileSwitch button').forEach((x) => x.classList.toggle('on', x === b));
      const work = $('#work');
      work.classList.toggle('show-3d', b.dataset.show === '3d');
      work.classList.toggle('show-props', b.dataset.show === 'props');
      setTimeout(() => { this.view.resize(); this.editor.render(); }, 30);
    }));
    // 拖放
    let depth = 0;
    const drop = $('#drop');
    window.addEventListener('dragenter', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { depth++; drop.hidden = false; e.preventDefault(); } });
    window.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) drop.hidden = true; });
    window.addEventListener('drop', (e) => {
      e.preventDefault(); depth = 0; drop.hidden = true;
      const f = e.dataTransfer?.files?.[0];
      if (f) this.importFile(f);
    });
    // 鍵盤
    window.addEventListener('keydown', (e) => this.onKey(e));
    matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => this.applyTheme());
    new MutationObserver(() => this.applyTheme()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.setTool('select');
  }

  applyTheme() {
    const t = document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    this.view.setTheme(dark);
  }

  cmd(c) {
    if (c === 'undo') this.undo();
    if (c === 'redo') this.redo();
    if (c === 'delete') { if (this.sel) this.deleteSel(); else this.toast('先選取要刪除的東西'); }
  }

  onKey(e) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); this.redo(); return; }
    if (typing) return;
    if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); this.duplicateSel(); return; }
    if (e.key === 'Escape') {
      if (!$('#modal').hidden) return;
      if (!this.editor.cancel()) { if (this.tool !== 'select') this.setTool('select'); else this.setSel(null); }
      return;
    }
    if (this.view.mode === 'walk') return;
    if (e.key === 'Delete' || e.key === 'Backspace') { if (this.sel) { e.preventDefault(); this.deleteSel(); } return; }
    const sel = this.sel;
    if (sel?.type === 'item' && e.key.startsWith('Arrow')) {
      const it = this.findSel(sel);
      const step = e.shiftKey ? 10 : 1;
      if (e.key === 'ArrowLeft') it.x -= step; if (e.key === 'ArrowRight') it.x += step;
      if (e.key === 'ArrowUp') it.y -= step; if (e.key === 'ArrowDown') it.y += step;
      e.preventDefault();
      clearTimeout(this._nudgeT);
      this.changed(true);
      this._nudgeT = setTimeout(() => this.commit(), 350);
      return;
    }
    if (mod || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === 'r' && sel?.type === 'item') { const it = this.findSel(sel); it.rot = ((it.rot || 0) + 90) % 360; this.commit(); return; }
    const map = { v: 'select', w: 'wall', d: 'door', n: 'window', m: 'measure', f: 'item' };
    if (map[k]) this.setTool(map[k]);
  }

  toast(msg, ms = 3200) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => el.classList.remove('show'), ms);
  }

  modal(html, bind) {
    return new Promise((resolve) => {
      const m = $('#modal'), card = $('#modalCard');
      card.innerHTML = html;
      m.hidden = false;
      const close = (v) => { m.hidden = true; card.innerHTML = ''; document.removeEventListener('keydown', onEsc, true); resolve(v); };
      const onEsc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
      document.addEventListener('keydown', onEsc, true);
      m.onclick = (e) => { if (e.target === m) close(null); };
      bind?.(card, close);
      card.querySelector('[autofocus]')?.focus();
    });
  }

  askNumber(title, def) {
    return this.modal(`<h2>${esc(title)}</h2>
      <div class="field"><div class="unit"><input type="number" id="askNum" value="${def}" autofocus step="0.1"><span>cm</span></div></div>
      <div class="row"><button class="btn" data-x="cancel">取消</button><button class="btn primary" data-x="ok">確定</button></div>`,
    (card, close) => {
      const inp = card.querySelector('#askNum');
      inp.select?.();
      card.querySelector('[data-x=ok]').onclick = () => close(parseFloat(inp.value) || null);
      card.querySelector('[data-x=cancel]').onclick = () => close(null);
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(parseFloat(inp.value) || null); });
    });
  }

  choose(title, text, choices) {
    return this.modal(`<h2>${esc(title)}</h2>${text ? `<p>${text}</p>` : ''}
      <div class="choices">${choices.map((c, i) => `<button data-i="${i}"><b>${esc(c.label)}</b>${c.sub ? `<small>${esc(c.sub)}</small>` : ''}</button>`).join('')}</div>
      <div class="row"><button class="btn" data-x="cancel">取消</button></div>`,
    (card, close) => {
      card.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => close(choices[+b.dataset.i].value)));
      card.querySelector('[data-x=cancel]').onclick = () => close(null);
    });
  }

  showHelp() {
    this.modal(`<h2>怎麼用</h2>
      <ul>
        <li><b>看 3D：</b>右邊模型可拖曳旋轉、滾輪縮放；「牆高」滑桿可把牆降低看室內；「漫遊」用第一人稱走進房子。</li>
        <li><b>拖拉修改：</b>在平面圖上直接拖牆（兩側相連的牆會跟著伸縮）、拖門窗沿牆滑動、拖家具（3D 裡也能拖）。選取後右側可輸入精確尺寸。</li>
        <li><b>畫新東西：</b>左側工具可畫牆、放門窗、放家具；「房間」點在牆圍起的區域內會自動算面積。</li>
        <li><b>丟檔案進來：</b>把 <b>DXF</b>（AutoCAD：另存新檔 → DXF）拖進視窗，自動辨識牆、門、房間產生 3D；由 CAD 直接輸出的向量 <b>PDF</b> 也能自動辨識；掃描圖或照片會變成底圖讓你描。</li>
        <li><b>匯出回 CAD：</b>「匯出 → DXF」產生 AutoCAD 可開的圖檔（單位公分，牆、門窗、家具分圖層）。這個 DXF 再丟回來也能完整還原。</li>
        <li><b>快捷鍵：</b><span class="kbd">V</span> 選取 <span class="kbd">W</span> 牆 <span class="kbd">D</span> 門 <span class="kbd">N</span> 窗 <span class="kbd">F</span> 家具 <span class="kbd">R</span> 旋轉 <span class="kbd">Del</span> 刪除 <span class="kbd">Ctrl+Z</span> 復原 <span class="kbd">Ctrl+D</span> 複製</li>
      </ul>
      <p>內建的方案 A、B、C 是依照媽媽的列印圖（1/100）手工轉錄，按「原圖」可以疊上原圖對照。修改會自動存在這台裝置的瀏覽器裡。</p>
      <div class="row"><button class="btn" data-x="reset">還原成原始三個方案</button><button class="btn primary" data-x="ok" autofocus>知道了</button></div>`,
    (card, close) => {
      card.querySelector('[data-x=ok]').onclick = () => close();
      card.querySelector('[data-x=reset]').onclick = async () => {
        close();
        const ok = await this.choose('還原原始方案？', '目前所有修改與匯入的平面都會被取代。', [{ label: '確定還原', value: true }]);
        if (!ok) return;
        const plans = builtinPlans();
        this.project = { plans, active: plans[0].id };
        this.history.clear();
        this.sel = null;
        this.snapshotBase();
        this.save();
        this.renderTabs();
        this.changed(false);
        this.editor.fit();
        this.view.first = true;
        this.toast('已還原');
      };
    });
  }

  // ---------- 平面分頁 ----------
  renderTabs() {
    const nav = $('#planTabs');
    nav.innerHTML = this.project.plans.map((p) => `<button class="tab${p.id === this.plan.id ? ' on' : ''}" data-id="${p.id}">${esc(p.name)}${p.elevation ? `<small>+${p.elevation}</small>` : ''}</button>`).join('') +
      '<button class="tab add" id="addPlan" title="新增平面" aria-label="新增平面">＋</button>';
    nav.querySelectorAll('.tab[data-id]').forEach((b) => b.addEventListener('click', () => this.switchPlan(b.dataset.id)));
    $('#addPlan').onclick = async () => {
      const v = await this.choose('新增平面', '', [
        { label: '複製目前平面', sub: '以「' + this.plan.name + '」為基礎修改', value: 'dup' },
        { label: '空白平面', sub: '從零開始畫牆，或放底圖描繪', value: 'blank' },
        { label: '開啟檔案…', sub: 'DXF、PDF、圖片或專案 JSON', value: 'open' },
      ]);
      if (v === 'dup') { const c = clone(this.plan); c.id = uid('p'); c.name = this.plan.name + ' 副本'; this.addPlan(normalizePlan(c)); }
      if (v === 'blank') this.addPlan(newPlan('新平面'));
      if (v === 'open') $('#fileInput').click();
    };
  }

  addPlan(p) {
    this.project.plans.push(p);
    this.switchPlan(p.id);
    this.save();
  }

  switchPlan(id) {
    if (this.editor.draft) this.editor.finishDraft();
    this.project.active = id;
    this.sel = null;
    this.snapshotBase();
    this.renderTabs();
    this.changed(false);
    this.editor.fit();
    this.view.first = true;
    this.save();
  }

  // ---------- 家具目錄 ----------
  renderCatalog() {
    const groups = {};
    for (const [k, c] of Object.entries(CATALOG)) (groups[c.group] ||= []).push([k, c]);
    $('#catalog').innerHTML = Object.entries(groups).map(([g, list]) => `<h4>${esc(g)}</h4><div class="grid">${list.map(([k, c]) => `<button data-kind="${k}" class="${k === this.placeKind ? 'on' : ''}">${esc(c.name.replace(/ .*/, ''))}<small>${c.w}×${c.d}</small></button>`).join('')}</div>`).join('');
    $('#catalog').querySelectorAll('[data-kind]').forEach((b) => b.addEventListener('click', () => {
      this.placeKind = b.dataset.kind;
      $('#catalog').querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
      $('#toolHint').textContent = `在圖上點一下放置「${CATALOG[this.placeKind].name}」`;
    }));
  }

  // ---------- 屬性面板 ----------
  num(label, key, val, { step = 1, unit = 'cm', min, full = false } = {}) {
    return `<div class="field${full ? ' full' : ''}"><label for="f_${key}">${label}</label><div class="unit"><input type="number" id="f_${key}" data-k="${key}" value="${Math.round(val * 10) / 10}" step="${step}"${min !== undefined ? ` min="${min}"` : ''}><span>${unit}</span></div></div>`;
  }
  txt(label, key, val, full = true) {
    return `<div class="field${full ? ' full' : ''}"><label for="f_${key}">${label}</label><input type="text" id="f_${key}" data-k="${key}" value="${esc(val)}"></div>`;
  }
  sel_(label, key, val, opts, full = false) {
    return `<div class="field${full ? ' full' : ''}"><label for="f_${key}">${label}</label><select id="f_${key}" data-k="${key}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  renderProps() {
    const el = $('#props');
    const p = this.plan;
    const s = this.sel;
    const obj = this.findSel(s);
    let h = '';
    if (s && obj) {
      if (s.type === 'wall') {
        const L = dist(obj.a, obj.b);
        h += `<div class="sec"><h3>牆 <span class="kind-chip">${{ ext: '外牆', int: '隔間牆', parapet: '矮牆／女兒牆' }[obj.kind] || '牆'}</span></h3>
          <div class="fields">${this.num('長度', 'len', L, { step: 0.5 })}${this.num('厚度', 't', obj.t, { step: 0.5, min: 3 })}${this.num('高度', 'h', obj.h ?? p.wallHeight, { step: 5 })}
          ${this.sel_('類型', 'kind', obj.kind, [['ext', '外牆'], ['int', '隔間牆'], ['parapet', '矮牆／女兒牆']])}</div>
          <p class="note">拖曳牆身會平行移動，相連的牆自動伸縮；拖端點可改變長度與角度。</p>
          <div class="row"><button class="btn" data-a="addDoor">加門</button><button class="btn" data-a="addWindow">加窗</button><button class="btn" data-a="split">從中間分割</button><button class="btn danger" data-a="del">刪除</button></div></div>`;
      } else if (s.type === 'opening') {
        const w = p.walls.find((x) => x.id === obj.wall);
        const L = w ? dist(w.a, w.b) : 0;
        h += `<div class="sec"><h3>門窗 <span class="kind-chip">${OPENING_TYPES[obj.type]}</span></h3>
          <div class="fields">${this.sel_('類型', 'type', obj.type, Object.entries(OPENING_TYPES))}${this.num('寬度', 'w', obj.w, { step: 5, min: 20 })}
          ${this.num('高度', 'h', obj.h, { step: 5 })}${this.num('窗台高', 'sill', obj.sill || 0, { step: 5 })}
          ${this.num('距牆端', 'off', obj.pos - obj.w / 2, { step: 1 })}${this.num('距另一端', 'off2', L - obj.pos - obj.w / 2, { step: 1 })}</div>
          <p class="note">沿著牆拖曳可移動位置，拖到另一面牆上會換牆。</p>
          <div class="row">${obj.type === 'door' ? '<button class="btn" data-a="flipSide">換開門方向</button><button class="btn" data-a="flipHinge">換鉸鏈邊</button>' : ''}<button class="btn danger" data-a="del">刪除</button></div></div>`;
      } else if (s.type === 'item') {
        const kinds = Object.entries(CATALOG).map(([k, c]) => [k, c.name]);
        h += `<div class="sec"><h3>家具／設備 <span class="kind-chip">${esc(CATALOG[obj.kind]?.group || '')}</span></h3><h2>${esc(itemName(obj))}</h2>
          <div class="fields">${this.txt('名稱', 'label', obj.label || '')}${this.sel_('種類', 'kind', obj.kind, kinds, true)}
          ${this.num('寬', 'w', obj.w, { step: 1, min: 5 })}${this.num('深', 'd', obj.d, { step: 1, min: 5 })}
          ${this.num('高', 'h', obj.h ?? CATALOG[obj.kind]?.h ?? 60, { step: 5 })}${this.num('角度', 'rot', obj.rot || 0, { step: 15, unit: '°' })}
          ${this.num('X', 'x', obj.x)}${this.num('Y', 'y', obj.y)}
          ${obj.kind === 'ac' || obj.elev ? this.num('離地高度', 'elev', obj.elev ?? CATALOG[obj.kind]?.elev ?? 0, { step: 5 }) : ''}
          ${obj.kind === 'counter' ? this.sel_('檯面', 'top', obj.top || 'plain', Object.entries(COUNTER_TOPS)) : ''}
          ${obj.kind === 'stair' ? this.num('級數', 'risers', obj.risers || 19, { unit: '級' }) + this.sel_('樣式', 'style', obj.style || 'U', [['U', 'U 型（迴轉）'], ['straight', '直梯']]) : ''}
          </div>
          <div class="row"><button class="btn" data-a="rot90">旋轉 90°</button><button class="btn" data-a="dup">複製</button>${obj.kind === 'stair' ? '<button class="btn" data-a="flipStair">左右鏡像</button>' : ''}<button class="btn danger" data-a="del">刪除</button></div></div>`;
      } else if (s.type === 'room') {
        const a = areaM2(obj.pts);
        h += `<div class="sec"><h3>房間</h3><h2>${esc(obj.name || '未命名')}</h2>
          <div class="stat"><div><b>${a.toFixed(2)}</b><small>平方公尺</small></div><div><b>${m2ToPing(a).toFixed(2)}</b><small>坪</small></div></div>
          <div class="fields">${this.txt('名稱', 'name', obj.name || '')}${this.sel_('用途／地坪', 'kind', obj.kind, Object.entries(ROOM_KINDS).map(([k, v]) => [k, v.name]), true)}</div>
          <p class="note">拖曳角點可修改範圍；用「房間」工具在牆內點一下可重新偵測。</p>
          <div class="row"><button class="btn danger" data-a="del">刪除</button></div></div>`;
      }
    } else {
      const indoor = p.rooms.filter((r) => !['balcony', 'void'].includes(r.kind)).reduce((sum, r) => sum + areaM2(r.pts), 0);
      const balcony = p.rooms.filter((r) => r.kind === 'balcony').reduce((sum, r) => sum + areaM2(r.pts), 0);
      h += `<div class="sec"><h3>平面</h3><h2>${esc(p.name)}</h2>${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
        <div class="stat"><div><b>${indoor.toFixed(1)}</b><small>室內面積 ㎡（牆中心線）（${m2ToPing(indoor).toFixed(1)} 坪）</small></div><div><b>${balcony.toFixed(1)}</b><small>陽台 ㎡</small></div>
        <div><b>${p.walls.length}</b><small>面牆</small></div><div><b>${p.items.length}</b><small>件家具設備</small></div></div>
        <div class="fields">${this.txt('名稱', 'pname', p.name)}${this.num('樓板高程', 'elevation', p.elevation || 0, { step: 5 })}${this.num('樓高', 'floorHeight', p.floorHeight, { step: 5 })}
        ${this.num('牆高', 'wallHeight', p.wallHeight, { step: 5 })}${this.num('新牆厚度', 'newT', this.wallThickness(), { step: 1 })}</div>
        <div class="row"><button class="btn" data-a="applyH">牆高套用到全部</button><button class="btn" data-a="dupPlan">複製此平面</button><button class="btn danger" data-a="delPlan">刪除此平面</button></div></div>`;
      const u = p.underlay;
      h += `<div class="sec"><h3>底圖</h3>${u ? `
        <div class="checks"><label><input type="checkbox" data-u="visible"${u.visible ? ' checked' : ''}> 顯示底圖</label></div>
        <div class="field"><label for="f_uop">透明度</label><input type="range" id="f_uop" data-u="opacity" min="0.1" max="1" step="0.05" value="${u.opacity ?? 0.45}"></div>
        <div class="row">${this.tool === 'underlay' ? '<button class="btn primary" data-a="uDone">完成移動</button>' : '<button class="btn" data-a="uMove">移動底圖</button>'}<button class="btn" data-a="uCal">校正比例</button><button class="btn" data-a="uLoad">換一張</button><button class="btn danger" data-a="uDel">移除</button></div>`
        : '<p class="note">可放一張圖片或 PDF 當底圖描繪（直接拖進視窗也可以）。</p><div class="row"><button class="btn" data-a="uLoad">選擇底圖…</button></div>'}</div>`;
      const st = this.settings;
      const ck = (k, t) => `<label><input type="checkbox" data-s="${k}"${st[k] ? ' checked' : ''}> ${t}</label>`;
      h += `<div class="sec"><h3>顯示</h3><div class="checks">${ck('grid', '格線')}${ck('dims', '尺寸')}${ck('labels', '房間名稱')}${ck('area', '面積')}${ck('itemLabels', '家具名稱')}${ck('highlighter', '螢光筆牆')}${ck('snap', '吸附 5 cm')}</div></div>`;
    }
    el.innerHTML = h;
    this.bindProps(el);
  }

  updatePropsLive() {
    // 拖曳中只更新數值欄位，避免重建 DOM
    const obj = this.findSel(this.sel);
    if (!obj) return;
    const set = (k, v) => { const i = document.querySelector(`#props [data-k="${k}"]`); if (i && document.activeElement !== i) i.value = Math.round(v * 10) / 10; };
    if (this.sel.type === 'item') { set('x', obj.x); set('y', obj.y); set('w', obj.w); set('d', obj.d); set('rot', obj.rot || 0); }
    if (this.sel.type === 'wall') set('len', dist(obj.a, obj.b));
    if (this.sel.type === 'opening') {
      const w = this.plan.walls.find((x) => x.id === obj.wall);
      set('off', obj.pos - obj.w / 2);
      if (w) set('off2', dist(w.a, w.b) - obj.pos - obj.w / 2);
    }
  }

  bindProps(el) {
    const p = this.plan;
    const obj = this.findSel(this.sel);
    el.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => this.onField(inp.dataset.k, inp.type === 'number' ? parseFloat(inp.value) : inp.value, obj)));
    el.querySelectorAll('[data-s]').forEach((inp) => inp.addEventListener('change', () => { this.settings[inp.dataset.s] = inp.checked; this.editor.render(); }));
    el.querySelectorAll('[data-u]').forEach((inp) => inp.addEventListener(inp.type === 'range' ? 'input' : 'change', () => {
      const u = p.underlay;
      if (inp.dataset.u === 'visible') u.visible = inp.checked;
      if (inp.dataset.u === 'opacity') u.opacity = parseFloat(inp.value);
      this.editor.render();
      clearTimeout(this._uT); this._uT = setTimeout(() => this.save(), 400);
      $('#toggleUnderlay').classList.toggle('on', !!u.visible);
    }));
    el.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => this.onAction(b.dataset.a, obj)));
    $('#toggleUnderlay').classList.toggle('on', !!p.underlay?.visible);
  }

  onField(k, v, obj) {
    const p = this.plan;
    if (!obj) {
      if (k === 'pname') { p.name = v || '平面'; this.renderTabs(); }
      else if (k === 'newT') { this._wallT = Math.max(3, v || 12); return; }
      else if (['elevation', 'floorHeight', 'wallHeight'].includes(k)) { if (Number.isFinite(v)) p[k] = v; if (k === 'elevation') this.renderTabs(); }
      this.commit();
      return;
    }
    if (!Number.isFinite(v) && typeof v === 'number') return;
    const t = this.sel.type;
    if (t === 'wall') {
      if (k === 'len' && v > 1) {
        const { u } = wallFrame(obj);
        const nb = { x: round1(obj.a.x + u.x * v), y: round1(obj.a.y + u.y * v) };
        const old = { ...obj.b };
        for (const w of p.walls) for (const e of ['a', 'b']) if (dist(w[e], old) < 1) w[e] = { ...nb };
        for (const r of p.rooms) for (const q of r.pts) if (dist(q, old) < 1) { q.x = nb.x; q.y = nb.y; }
      } else if (k === 'kind') obj.kind = v;
      else obj[k] = v;
    } else if (t === 'opening') {
      const w = p.walls.find((x) => x.id === obj.wall);
      const L = w ? dist(w.a, w.b) : 0;
      if (k === 'type') {
        obj.type = v;
        const d = this.defaultOpening(v === 'elevator' ? 'door' : v);
        obj.h = d.h; obj.sill = d.sill;
      } else if (k === 'off') obj.pos = v + obj.w / 2;
      else if (k === 'off2') obj.pos = L - v - obj.w / 2;
      else if (k === 'w') { const c = obj.pos; obj.w = Math.min(v, L); obj.pos = c; }
      else obj[k] = v;
      obj.pos = Math.max(obj.w / 2, Math.min(L - obj.w / 2, obj.pos));
    } else if (t === 'item') {
      if (k === 'label') obj.label = v || undefined;
      else if (k === 'kind') {
        obj.kind = v;
        const c = CATALOG[v];
        if (c) { obj.h = c.h; if (c.risers) { obj.risers ||= c.risers; obj.style ||= c.style; obj.h = p.floorHeight; } }
      } else if (k === 'top' || k === 'style') obj[k] = v;
      else if (k === 'rot') obj.rot = ((v % 360) + 360) % 360;
      else obj[k] = v;
    } else if (t === 'room') {
      obj[k] = v;
    }
    this.commit();
  }

  async onAction(a, obj) {
    const p = this.plan;
    if (a === 'del') return this.deleteSel();
    if (a === 'addDoor' || a === 'addWindow') {
      const type = a === 'addDoor' ? 'door' : 'window';
      const d = this.defaultOpening(type);
      const L = dist(obj.a, obj.b);
      if (L < d.w + 4) return this.toast('這面牆太短了');
      const o = { id: uid('d'), wall: obj.id, pos: L / 2, hinge: 'a', side: 1, ...d };
      p.openings.push(o);
      this.setSel({ type: 'opening', id: o.id });
      return this.commit();
    }
    if (a === 'split') { const m = { x: (obj.a.x + obj.b.x) / 2, y: (obj.a.y + obj.b.y) / 2 }; return this.splitWall(obj.id, m); }
    if (a === 'flipSide') { obj.side = obj.side >= 0 ? -1 : 1; return this.commit(); }
    if (a === 'flipHinge') { obj.hinge = obj.hinge === 'b' ? 'a' : 'b'; return this.commit(); }
    if (a === 'rot90') { obj.rot = ((obj.rot || 0) + 90) % 360; return this.commit(); }
    if (a === 'dup') return this.duplicateSel();
    if (a === 'flipStair') { obj.flip = !obj.flip; return this.commit(); }
    if (a === 'applyH') { for (const w of p.walls) if (w.kind !== 'parapet') w.h = p.wallHeight; this.toast('已套用到所有牆（矮牆除外）'); return this.commit(); }
    if (a === 'dupPlan') { const c = clone(p); c.id = uid('p'); c.name = p.name + ' 副本'; return this.addPlan(normalizePlan(c)); }
    if (a === 'delPlan') {
      if (this.project.plans.length <= 1) return this.toast('至少要保留一個平面');
      const ok = await this.choose(`刪除「${p.name}」？`, '這個平面的所有內容都會移除。', [{ label: '刪除', value: true }]);
      if (!ok) return;
      this.project.plans = this.project.plans.filter((x) => x.id !== p.id);
      this.switchPlan(this.project.plans[0].id);
      return;
    }
    if (a === 'uMove') { const u = p.underlay; u.visible = true; this.setTool('underlay'); this.renderProps(); return; }
    if (a === 'uDone') { this.setTool('select'); this.commit(); return; }
    if (a === 'uCal') { p.underlay.visible = true; this.setTool('calibrate'); this.toast(TOOL_HINTS.calibrate, 5000); return; }
    if (a === 'uDel') { p.underlay = null; return this.commit(); }
    if (a === 'uLoad') {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = '.pdf,.png,.jpg,.jpeg,.webp';
      inp.onchange = () => { const f = inp.files?.[0]; if (f) this.importFile(f, { underlayOnly: true }); };
      inp.click();
    }
  }

  // ---------- 匯入 ----------
  async importFile(file, { underlayOnly = false } = {}) {
    const name = file.name || 'file';
    const ext = name.split('.').pop().toLowerCase();
    try {
      if (ext === 'dwg') {
        await this.modal(`<h2>DWG 需要先轉成 DXF</h2><p>DWG 是 AutoCAD 的專有格式，瀏覽器沒辦法直接讀。請在 AutoCAD 打開這張圖，選「另存新檔」→ 檔案類型選「AutoCAD DXF（*.dxf）」，存好後把 DXF 拖進來即可。</p><p>也可以用「列印 → DWG To PDF」輸出向量 PDF，一樣能自動辨識。</p><div class="row"><button class="btn primary" data-x="ok" autofocus>好</button></div>`, (c, close) => { c.querySelector('[data-x=ok]').onclick = () => close(); });
        return;
      }
      if (ext === 'dxf' && !underlayOnly) {
        this.toast('讀取 DXF…');
        const text = decodeDXF(await readAsBuffer(file));
        const { plan, report } = dxfToPlan(text, name);
        this.addPlan(plan);
        this.toast(report, 6000);
        return;
      }
      if (ext === 'json' && !underlayOnly) {
        const data = JSON.parse(await readAsText(file));
        const plans = data.plans || (data.plan ? [data.plan] : data.walls ? [data] : null);
        if (!plans) throw new Error('看不懂這個 JSON 檔');
        const added = plans.map((pl) => { const n = normalizePlan(pl); if (this.project.plans.some((x) => x.id === n.id)) n.id = uid('p'); return n; });
        this.project.plans.push(...added);
        this.switchPlan(added[0].id);
        this.toast(`已匯入 ${added.length} 個平面`);
        return;
      }
      if (ext === 'pdf') return this.importPdf(file, underlayOnly);
      if (['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)) {
        const u = await imageToUnderlay(await readAsDataURL(file));
        const target = underlayOnly ? this.plan : await this.pickUnderlayTarget(name);
        if (!target) return;
        const scale = 1000 / u.w; // 先假設圖寬約 10 m，之後校正
        target.underlay = { src: u.src, w: u.w, h: u.h, matrix: [scale, 0, 0, scale, -100, -100], opacity: 0.5, visible: true };
        this.commit();
        this.editor.fit();
        this.setTool('calibrate');
        this.toast('底圖已放上。請在圖上點一段已知長度的兩端（例如標註 600 的那段），輸入實際公分數來校正比例。', 7000);
        return;
      }
      this.toast('不支援這種檔案：' + ext);
    } catch (err) {
      console.error(err);
      this.toast('匯入失敗：' + (err.message || err), 7000);
    }
  }

  async pickUnderlayTarget(name) {
    const v = await this.choose('要把底圖放在哪裡？', esc(name), [
      { label: '新增一個空白平面', sub: '在底圖上重新描繪牆', value: 'new' },
      { label: '放到目前的平面', sub: '「' + this.plan.name + '」', value: 'cur' },
    ]);
    if (!v) return null;
    if (v === 'new') this.addPlan(newPlan(name.replace(/\.[^.]+$/, '')));
    return this.plan;
  }

  async importPdf(file, underlayOnly) {
    this.toast('讀取 PDF…');
    const doc = await openPdf(await readAsBuffer(file));
    let pageNo = 1;
    if (doc.numPages > 1) {
      pageNo = await this.choose('要用哪一頁？', `這份 PDF 有 ${doc.numPages} 頁。`, Array.from({ length: Math.min(doc.numPages, 12) }, (_, i) => ({ label: `第 ${i + 1} 頁`, value: i + 1 })));
      if (!pageNo) return;
    }
    const vec = await extractPdfVectors(doc, pageNo);
    let mode = 'underlay';
    if (!underlayOnly && vec.segs.length > 150) {
      mode = await this.choose('這頁是向量圖', `偵測到 ${vec.segs.length} 條線，可以直接辨識牆體。`, [
        { label: '自動辨識成 3D（試驗性）', sub: '依比例換算建立牆、門、房間；PDF 沒有圖層，結果可能需要手動修整，DXF 會更準', value: 'auto' },
        { label: '只當底圖描繪', value: 'underlay' },
      ]);
      if (!mode) return;
    }
    if (mode === 'auto') {
      const s = await this.askNumber('圖面比例 1 : ?（例如 1/100 就輸入 100）', 100);
      if (!s) return;
      const cmPerPt = (25.4 / 72) / 10 * s;
      const res = planFromGeometry(vec, { name: file.name.replace(/\.[^.]+$/, ''), scale: cmPerPt });
      const r = await renderPdfPage(doc, pageNo);
      this.addPlan(res.plan);
      this.toast(res.report, 6000);
      // 同時放上底圖供對照：PDF pt（y 向上）→ 公分，並套用辨識時的平移
      this.attachPdfUnderlay(this.plan, r, cmPerPt, res.shift);
      return;
    }
    if (vec.segs.length <= 150 && !underlayOnly) this.toast('這頁是掃描影像，無法自動辨識牆線，將作為底圖讓你描繪。', 5000);
    const r = await renderPdfPage(doc, pageNo);
    const target = underlayOnly ? this.plan : await this.pickUnderlayTarget(file.name);
    if (!target) return;
    const k = (25.4 / 72) / 10 * 100 / r.pxPerPt; // 先假設 1/100
    target.underlay = { src: r.src, w: r.w, h: r.h, matrix: [k, 0, 0, k, -150, -150], opacity: 0.5, visible: true };
    this.commit();
    this.editor.fit();
    this.setTool('calibrate');
    this.toast('底圖已放上（先以 1/100 估算）。請點一段已知長度的兩端，輸入實際公分數來校正。', 7000);
  }

  attachPdfUnderlay(plan, r, cmPerPt, shift) {
    // 辨識時的換算：cm = (pt.x·k, −pt.y·k) − shift；影像像素 → pt：x = px / pxPerPt，y = pageH − py / pxPerPt
    const k = cmPerPt / r.pxPerPt;
    plan.underlay = { src: r.src, w: r.w, h: r.h, matrix: [k, 0, 0, k, -shift.x, -r.pageH * cmPerPt - shift.y], opacity: 0.35, visible: false };
    this.save();
  }

  // ---------- 匯出 ----------
  async exportAs(kind) {
    const p = this.plan;
    const base = (p.name || 'plan').replace(/[\\/:*?"<>|]/g, '_');
    let res;
    try {
      if (kind === 'dxf') res = await saveFile(base + '.dxf', exportDXF(p), 'application/dxf');
      if (kind === 'json') res = await saveFile('新家3D專案.json', JSON.stringify({ app: 'house3d', version: 1, ...this.project }, null, 1), 'application/json');
      if (kind === 'png') res = await saveFile(base + '-3D.png', await this.view.snapshotPNG(), 'image/png');
      if (kind === 'glb') res = await saveFile(base + '.glb', new Blob([await this.view.exportGLB()], { type: 'model/gltf-binary' }), 'model/gltf-binary');
    } catch (e) {
      console.error(e);
      return this.toast('匯出失敗：' + (e.message || e));
    }
    if (res?.ok) this.toast(res.zipped ? `已存成 ${res.name}（檢視器只允許 zip，解壓後即是 ${kind.toUpperCase()} 檔）` : `已匯出 ${res.name}`, 5000);
    else if (res?.declined) this.toast('已取消');
    else if (res?.error) this.toast('無法存檔：' + res.error);
  }
}

window.house3d = new App();
