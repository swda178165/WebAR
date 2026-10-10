// 主程式：狀態、復原/重做、屬性面板、匯入匯出、拖放檔案。
import {
  uid, clone, dist, add, mul, sub, wallFrame, projectOnSegment, areaM2, m2ToPing, polygonCentroid,
  normalizePlan, newPlan, ROOM_KINDS, OPENING_TYPES, DEFAULTS, round1,
} from './model.js';
import { CATALOG, COUNTER_TOPS, itemName } from './catalog.js';
import { builtinPlans, BUILTIN_VERSION } from './plans.js';
import { STYLES, FURN_VARIANTS, variantOf } from './styles.js';
import { Editor2D } from './editor2d.js';
import { View3D } from './view3d.js';
import { exportDXF, dxfToPlan, decodeDXF, planFromGeometry } from './dxf.js';
import {
  defaultSite, normalizeSite, analyzeDaylight, designWindows, CITIES, DIRS, SIDE_TYPES, SIDE_NAMES, SIDE_HINTS, dirName, bearingOf,
  sideLabel, dfGrade, dfTarget, dfColor, DF_LEGEND, floorLabel, sunVector, planFrame,
} from './site.js';
import { generate, defaultProgram } from './generator.js';
import { normalizeBuilding } from './building.js';
import { BuildingUI } from './building-ui.js';
import { AskUI } from './ask-ui.js';
import { RenderUI } from './render.js';
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

// 外面狀況的小插圖
function sidePic(k) {
  const house = '<rect x="2" y="10" width="22" height="26" fill="var(--accent-soft)" stroke="var(--ink-2)" stroke-width="1.5"/><path d="M2 10 13 3l11 7" fill="none" stroke="var(--ink-2)" stroke-width="1.5"/>';
  const other = (x, h = 26) => `<rect x="${x}" y="${36 - h}" width="22" height="${h}" fill="var(--line)" stroke="var(--ink-3)" stroke-width="1.5"/>`;
  const art = {
    party: `${house}${other(24)}`,
    lane: `${house}${other(36)}<path d="M26 36h8" stroke="var(--ink-3)" stroke-width="1.5"/>`,
    road: `${house}${other(52)}<rect x="26" y="33" width="24" height="3" fill="var(--ink-3)"/><path d="M29 34.5h4M37 34.5h4M45 34.5h3" stroke="var(--panel)" stroke-width="1"/>`,
    building: `${house}${other(42, 20)}`,
    open: `${house}<circle cx="38" cy="26" r="5" fill="#8fbf7a"/><circle cx="50" cy="28" r="4" fill="#8fbf7a"/><path d="M38 31v5M50 32v4" stroke="var(--ink-3)" stroke-width="1.5"/><path d="M26 36h48" stroke="var(--ink-3)" stroke-width="1"/>`,
  }[k];
  return `<svg viewBox="0 0 76 40" aria-hidden="true">${art}</svg>`;
}

// 亮度用太陽數表示（給不熟數字的人看）
const suns = (df) => ['🌑', '☀️', '☀️☀️', '☀️☀️☀️', '☀️☀️☀️☀️'][dfGrade(df)[1]];

// 自動規劃的「情境」：一鍵帶入常見家庭組成
const BASE_PG = { master: true, masterBath: true, kids: 0, elder: false, guest: false, baths: 2, living: true, dining: true, seats: 4, kitchen: 'open', island: false, study: false, tatami: false, altar: false, walkin: false, storage: false, accessible: false };
const PRESETS = [
  ['couple1', '夫妻＋1 個小孩', { ...BASE_PG, kids: 1 }, '主臥套房、小孩房、客餐廚'],
  ['couple2', '夫妻＋2 個小孩', { ...BASE_PG, kids: 2 }, '3 房 2 衛'],
  ['elder', '跟長輩同住', { ...BASE_PG, elder: true, accessible: true }, '長輩房靠浴室、拉門無門檻'],
  ['couple', '夫妻兩人', { ...BASE_PG, study: true, walkin: true }, '主臥、書房、更衣室'],
  ['single', '一個人住', { ...BASE_PG, masterBath: false, baths: 1, study: true, seats: 2 }, '大客廳、書房'],
  ['top', '頂樓：神明廳＋和室', { ...BASE_PG, masterBath: false, baths: 1, altar: true, tatami: true, dining: false, kitchen: 'none' }, '拜拜、泡茶、客人留宿'],
];

// 方案縮圖（SVG）：房間色塊、牆、家具外框
function planThumb(p) {
  const xs = [], ys = [];
  for (const w of p.walls) { xs.push(w.a.x, w.b.x); ys.push(w.a.y, w.b.y); }
  const x0 = Math.min(...xs) - 30, x1 = Math.max(...xs) + 30, y0 = Math.min(...ys) - 30, y1 = Math.max(...ys) + 30;
  const pt = (q) => q.map((v) => `${Math.round(v.x)},${Math.round(v.y)}`).join(' ');
  let s = `<svg viewBox="${x0} ${y0} ${x1 - x0} ${y1 - y0}" class="thumb" role="img" aria-label="${esc(p.name)} 平面縮圖">`;
  for (const r of p.rooms) s += `<polygon points="${pt(r.pts)}" fill="${ROOM_KINDS[r.kind]?.color || '#eee'}" opacity="0.9"/>`;
  for (const it of p.items) {
    if (['ac', 'acout', 'ledge', 'rug'].includes(it.kind)) continue;
    const c = itemCornersOf(it);
    s += `<polygon points="${pt(c)}" fill="none" stroke="#8b9097" stroke-width="2"/>`;
  }
  for (const w of p.walls) {
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1;
    const u = { x: (w.b.x - w.a.x) / L, y: (w.b.y - w.a.y) / L };
    let cur = 0;
    const ops = p.openings.filter((o) => o.wall === w.id).sort((a, b) => a.pos - b.pos);
    const segs = [];
    for (const o of ops) { const a = Math.max(cur, o.pos - o.w / 2); if (a > cur) segs.push([cur, a]); cur = Math.max(cur, o.pos + o.w / 2); }
    if (cur < L) segs.push([cur, L]);
    for (const [a, b] of segs) s += `<line x1="${Math.round(w.a.x + u.x * a)}" y1="${Math.round(w.a.y + u.y * a)}" x2="${Math.round(w.a.x + u.x * b)}" y2="${Math.round(w.a.y + u.y * b)}" stroke="${w.kind === 'parapet' ? '#8a8f96' : '#2a2e33'}" stroke-width="${w.t}"/>`;
    for (const o of ops) if (o.type === 'window' || o.type === 'sliding') s += `<line x1="${Math.round(w.a.x + u.x * (o.pos - o.w / 2))}" y1="${Math.round(w.a.y + u.y * (o.pos - o.w / 2))}" x2="${Math.round(w.a.x + u.x * (o.pos + o.w / 2))}" y2="${Math.round(w.a.y + u.y * (o.pos + o.w / 2))}" stroke="#4a8ad6" stroke-width="5"/>`;
  }
  for (const r of p.rooms) {
    if (['void', 'balcony', 'elevator', 'stair'].includes(r.kind) || !r.name) continue;
    const c = polygonCentroid(r.pts);
    s += `<text x="${Math.round(c.x)}" y="${Math.round(c.y + 14)}" font-size="44" text-anchor="middle" fill="#1f2328" font-weight="700" paint-order="stroke" stroke="#fff" stroke-width="8">${esc(r.name)}</text>`;
  }
  return s + '</svg>';
}

function itemCornersOf(it) {
  const r = (it.rot || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  const hw = it.w / 2, hd = it.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => ({ x: it.x + x * c - y * sn, y: it.y + x * sn + y * c }));
}

class App {
  constructor() {
    this.settings = { snap: true, snapStep: 5, grid: true, dims: true, labels: true, area: true, itemLabels: true, highlighter: true };
    this.sel = null;
    this.tool = 'select';
    this.placeKind = 'bed';
    this.history = new Map(); // planId → {undo:[], redo:[]}
    this.daylight = { show: false, result: null, planId: null };
    this.sideTab = 'props';
    try { this.ui = { simple: true, welcome: true, toured: false, ...JSON.parse(localStorage.getItem('house3d.ui') || '{}') }; } catch { this.ui = { simple: true, welcome: true, toured: false }; }
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
    this.applyMode();
    this.bmode = !!(this.project.bmode && this.project.building);
    if (this.bmode) this.applyBmode();
    if (this.ui.welcome) setTimeout(() => this.showWelcome(), 350);
    downloadsCap(); // 在 Claude 檢視器裡預先取得存檔能力，第一次匯出不必等
  }

  // ---------- 專案 ----------
  get plan() { return this.project.plans.find((p) => p.id === this.project.active) || this.project.plans[0]; }

  load() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { saved = null; }
    if (saved?.plans?.length) {
      this.project = { plans: saved.plans.map(normalizePlan), active: saved.active, builtinVersion: saved.builtinVersion || 1, site: normalizeSite(saved.site), building: normalizeBuilding(saved.building), bmode: !!saved.bmode };
      // 舊存檔沒有後來新增的提案：補上，不動使用者原本的平面
      if (this.project.builtinVersion < BUILTIN_VERSION) {
        const have = new Set(this.project.plans.map((p) => p.key).filter(Boolean));
        const names = new Set(this.project.plans.map((p) => p.name));
        for (const bp of builtinPlans()) if (!have.has(bp.key) && !names.has(bp.name) && !['a', 'b', 'c'].includes(bp.key)) this.project.plans.push(bp);
        this.project.builtinVersion = BUILTIN_VERSION;
      }
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
      this.project = { plans, active: plans[0].id, builtinVersion: BUILTIN_VERSION, site: defaultSite(), building: null, bmode: false };
    }
  }

  get site() { return (this.project.site ||= defaultSite()); }

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

  undo() { if (this.bmode) return this.bUndo(); const h = this.hist(); if (!h.undo.length) return this.toast('沒有可以復原的步驟'); h.redo.push(h.last); this.restore(h.undo.pop()); }
  redo() { if (this.bmode) return this.bRedo(); const h = this.hist(); if (!h.redo.length) return; h.undo.push(h.last); this.restore(h.redo.pop()); }

  changed(transient, opts = {}) {
    this.editor.render();
    const ss = document.getElementById('styleSel');
    if (ss && ss.value !== (this.plan.style || 'basic')) ss.value = this.plan.style || 'basic';
    if (!opts.skip3d) this.view.invalidate();
    if (!transient) { this.renderProps(); this.scheduleDaylight(); }
    else this.updatePropsLive();
  }

  // ---------- 採光模擬 ----------
  scheduleDaylight(now = false) {
    const need = this.daylight.show || this.sideTab === 'site';
    if (!need) { this.daylight.result = null; return; }
    clearTimeout(this._dlT);
    const run = () => {
      try {
        this.daylight.result = analyzeDaylight(this.plan, this.site);
        this.daylight.planId = this.plan.id;
      } catch (e) { console.error(e); this.daylight.result = null; }
      if (this.daylight.show) this.editor.render();
      if (this.sideTab === 'site') this.renderSitePanel();
    };
    if (now) run(); else this._dlT = setTimeout(run, 160);
  }

  setSideTab(t) {
    this.sideTab = t;
    document.querySelectorAll('#sideTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
    $('#props').hidden = t !== 'props';
    $('#sitePanel').hidden = t !== 'site';
    if (t === 'site') { this.renderSitePanel(); this.scheduleDaylight(true); }
  }

  setDaylight(on) {
    this.daylight.show = on;
    $('#toggleDaylight').classList.toggle('on', on);
    if (on) this.scheduleDaylight(true); else this.editor.render();
    if (this.sideTab === 'site') this.renderSitePanel();
  }

  setSun(on) {
    this.view.setSunSim({ on });
    $('#toggleSun').classList.toggle('on', on);
    $('#sunBar').hidden = !on;
    if (!on) this.stopSunPlay();
    if (on) this.toast('日照模擬：依基地座向與四周建物計算陰影；拖曳時間看陽光怎麼照進屋內', 4500);
    if (this.daylight.show) setTimeout(() => this.editor.render(), 60);
    if (this.sideTab === 'site') this.renderSitePanel();
  }

  onSunUpdate(info) {
    const el = $('#sunInfo');
    if (el) {
      const alt = info.alt * 180 / Math.PI;
      el.textContent = alt <= 0 ? '太陽已在地平線以下' : `太陽高度 ${alt.toFixed(0)}°，從${dirName(info.az * 180 / Math.PI)}方照來（太陽時，約等於台灣時間）`;
    }
    if (this.daylight.show) { cancelAnimationFrame(this._sunRaf); this._sunRaf = requestAnimationFrame(() => this.editor.render()); }
  }

  stopSunPlay() { clearInterval(this._sunPlay); this._sunPlay = null; const b = $('#sunPlay'); if (b) b.textContent = '▶'; }

  siteChanged() {
    // 外面狀況問答改了「這棟幾層」：同步到整棟規劃
    const b = this.project.building;
    if (b && this.site.floors !== b.n && this.site.floors >= 1 && this.site.floors <= 5) { this.bChange((bb) => { bb.n = this.site.floors; }, 'all'); this.toast(`整棟規劃改成 ${b.n} 層`); }
    this.save();
    this.view.setSunSim({ rebuild: true });
    this.scheduleDaylight();
    if (this.daylight.show) this.editor.render();
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
    $('#floorSel').addEventListener('change', (e) => { const v = e.target.value; const b = this.project.building; if (!b) return; b.focus = 'all'; this.focusFloor(v === 'all' ? null : v); });
    document.querySelectorAll('#viewSeg button').forEach((b) => b.addEventListener('click', () => {
      if (this.bmode && b.dataset.view === 'walk') {
        const f = this.project.building?.focus;
        if (!f || f === 'all') { this.toast('先在左邊選一層（或在 3D 點一層），再按漫遊走進去'); return; }
        this.openFloor(f);
      }
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
    const styleSel = $('#styleSel');
    styleSel.innerHTML = Object.entries(STYLES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
    styleSel.addEventListener('change', () => { this.plan.style = styleSel.value; this.commit(); this.toast(`風格：${STYLES[styleSel.value].name}`); });
    document.querySelectorAll('#sideTabs button').forEach((b) => b.addEventListener('click', () => this.setSideTab(b.dataset.tab)));
    $('#toggleDaylight').onclick = () => this.setDaylight(!this.daylight.show);
    $('#toggleSun').onclick = () => this.setSun(!this.view.sunSim.on);
    const sm = $('#sunMonth');
    sm.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1).map((m) => `<option value="${m}"${m === 12 ? ' selected' : ''}>${m} 月${{ 12: '（冬至）', 6: '（夏至）', 3: '（春分）', 9: '（秋分）' }[m] || ''}</option>`).join('');
    sm.addEventListener('change', () => this.view.setSunSim({ month: +sm.value }));
    const sh = $('#sunHour');
    const fmtH = (v) => `${Math.floor(v)}:${String(Math.round((v % 1) * 60)).padStart(2, '0')}`;
    sh.addEventListener('input', () => { $('#sunOut').textContent = fmtH(+sh.value); this.view.setSunSim({ hour: +sh.value }); });
    $('#sunPlay').onclick = () => {
      if (this._sunPlay) return this.stopSunPlay();
      $('#sunPlay').textContent = '❚❚';
      if (+sh.value >= 17.9) sh.value = 6;
      this._sunPlay = setInterval(() => {
        let v = +sh.value + 0.05;
        if (v > 18) { v = 18; this.stopSunPlay(); }
        sh.value = v; $('#sunOut').textContent = fmtH(v); this.view.setSunSim({ hour: v });
      }, 70);
    };
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
    $('#btnGen').onclick = () => this.openGenerator();
    $('#btnAsk').onclick = () => this.openAsk();
    $('#btnRender').onclick = () => this.openRender();
    $('#btnPano').onclick = () => this.openPano();
    $('#btnSite').onclick = () => this.openSiteWizard();
    $('#brand').onclick = () => this.showWelcome();
    $('#brand').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); this.showWelcome(); } };
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
    $('#sitePanel').addEventListener('change', (e) => this.onSiteField(e.target));
    $('#sitePanel').addEventListener('click', (e) => this.onSiteClick(e));
  }

  applyTheme() {
    const t = document.documentElement.dataset.theme;
    const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    this.view.setTheme(dark);
  }

  cmd(c) {
    if (c === 'mode') return this.setMode(!this.ui.simple);
    if (c === 'undo') this.undo();
    if (c === 'redo') this.redo();
    if (c === 'delete') { if (this.bmode) return; if (this.sel) this.deleteSel(); else this.toast('先選取要刪除的東西'); }
  }

  onKey(e) {
    const t = e.target;
    const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { if (typing) return; e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { if (typing) return; e.preventDefault(); this.redo(); return; }
    if (typing) return;
    if (this.bmode) return;
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
      <p>不知道從哪開始？按下面的「開始導覽」，或「回首頁」選想做的事。</p>
      <ul>
        <li><b>看 3D：</b>右邊模型可拖曳旋轉、滾輪縮放；「牆高」滑桿可把牆降低看室內；「漫遊」用第一人稱走進房子。</li>
        <li><b>拖拉修改：</b>在平面圖上直接拖牆（兩側相連的牆會跟著伸縮）、拖門窗沿牆滑動、拖家具（3D 裡也能拖）。選取後右側可輸入精確尺寸。</li>
        <li><b>畫新東西：</b>左側工具可畫牆、放門窗、放家具；「房間」點在牆圍起的區域內會自動算面積。</li>
        <li><b>丟檔案進來：</b>把 <b>DXF</b>（AutoCAD：另存新檔 → DXF）拖進視窗，自動辨識牆、門、房間產生 3D；由 CAD 直接輸出的向量 <b>PDF</b> 也能自動辨識；掃描圖或照片會變成底圖讓你描。</li>
        <li><b>整棟：</b>上方「🏢 整棟」設定蓋幾層、每層做什麼（一樓大空間＋機車、出租套房、自住、頂樓屋突＋房間），程式會把每一層排好；右側可改一樓出入口、機車台數、出租間數、頂樓房間，以及外牆材質、顏色、窗框、欄杆、屋頂。3D 會疊出整棟外觀，點一層可以剖開看裡面，點兩下打開那層的平面。</li>
        <li><b>用講的改：</b>按「用講的改」，打字或按 🎤 說「主臥大一點」「多一間小孩房」「二樓改自住」「機車停 6 台」「外牆換清水模」「沙發換成雲朵沙發」，程式會直接改；每一步都能按「復原」。在 Claude 裡開啟時，聽不懂的話會請 Claude 幫忙翻成動作。</li>
        <li><b>擬真效果圖、360°：</b>3D 下方「📷 效果圖」用光線追蹤算出光從窗戶照進來、在牆面反彈的樣子（先按「漫遊」走進房間，就是室內照）；「🌐 360°」站在房間中間轉一圈，可以拖著看、手機轉著看，也能下載成 Facebook 認得的 360 照片。</li>
        <li><b>自動規劃：</b>按上方「自動規劃」，選幾房、幾衛、要不要書房／和室／神明廳等，程式會試過上百種配置、實際排家具並模擬採光，挑出幾種給你比較，喜歡的可以加入成新平面再拖拉修改。</li>
        <li><b>基地・採光：</b>右側「基地・採光」設定座向、隔壁、馬路與對面樓高，程式會算出每個房間的採光與冬至日照，「依基地條件自動開窗」會把窗開在光線最好的位置；平面圖下方「採光」顯示亮暗分布，3D 的「日照」可以看某月某時陽光照進屋內的樣子。</li>
        <li><b>風格與款式：</b>3D 下方「風格」會整套換材質與家具款式（日式低床、北歐錐腳沙發、侘寂雲朵沙發、工業皮沙發、輕奢弧形沙發…）；單件家具也能在右側「款式」個別指定。</li>
        <li><b>匯出回 CAD：</b>「匯出 → DXF」產生 AutoCAD 可開的圖檔（單位公分，牆、門窗、家具分圖層）。這個 DXF 再丟回來也能完整還原。</li>
        <li><b>快捷鍵：</b><span class="kbd">V</span> 選取 <span class="kbd">W</span> 牆 <span class="kbd">D</span> 門 <span class="kbd">N</span> 窗 <span class="kbd">F</span> 家具 <span class="kbd">R</span> 旋轉 <span class="kbd">Del</span> 刪除 <span class="kbd">Ctrl+Z</span> 復原 <span class="kbd">Ctrl+D</span> 複製</li>
      </ul>
      <p>內建的方案 A、B、C 是依照媽媽的列印圖（1/100）手工轉錄，按「原圖」可以疊上原圖對照。修改會自動存在這台裝置的瀏覽器裡。</p>
      <div class="row"><button class="btn" data-x="reset">還原成原始方案</button><button class="btn" data-x="mode">${this.ui.simple ? '切換到進階模式' : '切換到簡單模式'}</button><button class="btn" data-x="home">回首頁</button><button class="btn" data-x="tour">開始導覽</button><button class="btn primary" data-x="ok" autofocus>知道了</button></div>`,
    (card, close) => {
      card.querySelector('[data-x=ok]').onclick = () => close();
      card.querySelector('[data-x=tour]').onclick = () => { close(); setTimeout(() => this.startTour(), 150); };
      card.querySelector('[data-x=home]').onclick = () => { close(); setTimeout(() => this.showWelcome(), 150); };
      card.querySelector('[data-x=mode]').onclick = () => { close(); this.setMode(!this.ui.simple); };
      card.querySelector('[data-x=reset]').onclick = async () => {
        close();
        const ok = await this.choose('還原原始方案？', '目前所有修改與匯入的平面都會被取代。', [{ label: '確定還原', value: true }]);
        if (!ok) return;
        const plans = builtinPlans();
        this.project = { plans, active: plans[0].id, builtinVersion: BUILTIN_VERSION, site: this.site, building: null, bmode: false };
        this.bmode = false;
        this.bhist = null;
        this.applyBmode();
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

  // ---------- 基地・採光面板 ----------
  renderSitePanel() {
    const el = $('#sitePanel');
    if (!el || el.hidden) return;
    const st = this.site, p = this.plan;
    const opt = (list, val) => list.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(t)}</option>`).join('');
    const nb = (side, f, val, unit, step = 1) => `<div class="unit"><input type="number" data-side="${side}" data-f="${f}" value="${val}" step="${step}" min="0" aria-label="${SIDE_NAMES[side]}${f === 'dist' ? '距離' : '樓層'}"><span>${unit}</span></div>`;
    const sides = ['front', 'back', 'left', 'right'].map((side) => {
      const sd = st.sides[side];
      const n = { front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] }[side];
      const dir = dirName(bearingOf(st, n[0], n[1]));
      const showD = !['party', 'open'].includes(sd.type);
      return `<div class="site-side"><div class="head"><b>${SIDE_NAMES[side]}・朝${dir}</b><small>${esc(SIDE_HINTS[side])}</small></div>
        <select data-side="${side}" data-f="type" aria-label="${SIDE_NAMES[side]}的狀況">${opt(Object.entries(SIDE_TYPES).map(([k, v]) => [k, v.name]), sd.type)}</select>
        ${showD ? nb(side, 'dist', sd.dist, 'm', 0.5) + nb(side, 'floors', sd.floors, '層') : sd.type === 'party' ? `<div class="note" style="grid-column:1/-1">隔壁 ${nb(side, 'floors', sd.floors, '層')}</div>` : ''}</div>`;
    }).join('');
    let h = `<div class="sec"><h3>基地與座向</h3>
      <p class="note">告訴程式房子外面的狀況，它會模擬每個房間的採光、冬天與夏天的日照，並依此建議窗戶開在哪裡。</p>
      <div class="row"><button class="btn primary" data-sa="wizard">用問答設定（約 1 分鐘）</button></div>
      ${this.siteDiagram()}
      <details class="site-form"${this.ui.simple ? '' : ' open'}><summary>直接修改每一項</summary>
      <div class="fields">
        <div class="field"><label for="s_city">城市（決定太陽角度）</label><select id="s_city" data-site="city">${opt(Object.entries(CITIES).map(([k, v]) => [k, v[0]]), st.city)}</select></div>
        <div class="field"><label for="s_front">正面（前陽台）朝向</label><select id="s_front" data-site="front">${opt(DIRS.map(([n, d]) => [d, '朝' + n]), st.front)}</select></div>
        <div class="field"><label for="s_floors">這棟總共幾層</label><div class="unit"><input type="number" id="s_floors" data-site="floors" value="${st.floors}" min="1" max="30"><span>層</span></div></div>
        <div class="field"><label for="s_gh">一樓樓高</label><div class="unit"><input type="number" id="s_gh" data-site="groundH" value="${st.groundH}" step="5" min="250"><span>cm</span></div></div>
      </div>
      <div class="site-sides">${sides}</div></details></div>`;
    const r = this.daylight.result && this.daylight.planId === p.id ? this.daylight.result : null;
    h += `<div class="sec"><h3>採光分析 <span class="kind-chip">${esc(p.name)} · ${floorLabel(st, p.elevation || 0)}</span></h3>
      <div class="row"><button class="btn primary" data-sa="autoWin">依基地條件自動開窗</button>
      <button class="btn toggle${this.daylight.show ? ' on' : ''}" data-sa="heat">平面顯示採光</button>
      <button class="btn toggle${this.view.sunSim.on ? ' on' : ''}" data-sa="sun">3D 日照模擬</button></div>`;
    if (this.lastWin && this.lastWin.planId === p.id) h += this.winReportHtml(this.lastWin);
    if (!r) h += '<p class="note">計算中…</p>';
    else {
      const hab = r.rooms.filter((x) => ['living', 'bedroom', 'kitchen'].includes(x.kind));
      const avg = hab.length ? hab.reduce((a, x) => a + x.df * x.area, 0) / hab.reduce((a, x) => a + x.area, 0) : 0;
      const [g] = dfGrade(avg);
      h += `<div class="stat"><div><b>${this.ui.simple ? suns(avg) : avg.toFixed(1) + '%'}</b><small>${this.ui.simple ? `房間平均亮度：${g}` : `居室平均採光係數（${g}）`}</small></div>
        <div><b>${r.cross ? '可以' : '不行'}</b><small>${r.cross ? '前後（或左右）都有窗，能對流通風' : '只有單面開窗，通風較差'}</small></div></div>
        <div class="dl-legend adv">${DF_LEGEND.map((v) => `<span style="background:${dfColor(v)}"></span>`).join('')}</div>
        <div class="dl-legend-l adv"><span>暗 0%</span><span>1%</span><span>2%</span><span>亮 5%+</span></div>
        <div class="dl-table">${r.rooms.filter((x) => x.kind !== 'stair' && (x.windows.length || ['living', 'bedroom', 'kitchen'].includes(x.kind))).map((x) => {
          const [gg] = dfGrade(x.df);
          const tgt = dfTarget(x.kind);
          const notes = x.notes.slice().sort((a, b) => ({ bad: 0, warn: 1, info: 2, good: 3 }[a.lv] - { bad: 0, warn: 1, info: 2, good: 3 }[b.lv]));
          return `<div class="dl-row" data-room="${x.id}"><b>${esc(x.name || '房間')}</b><span class="df-badge" style="background:${dfColor(x.df)}">${this.ui.simple ? `${gg} ${suns(x.df)}` : `${x.df.toFixed(1)}% ${gg}`}</span>
            <div class="meta simple-only">${x.sunWinter >= 0.5 ? `冬天有 ${x.sunWinter.toFixed(1)} 小時太陽` : '冬天曬不到太陽'}${x.windows.length ? '' : '・沒有窗'}</div>
            <div class="meta adv">${x.area.toFixed(1)}㎡ · 窗 ${(x.ratio * 100).toFixed(0)}%（有效 ${(x.effRatio * 100).toFixed(0)}%）· 冬至日照 ${x.sunWinter.toFixed(1)} h${tgt ? ` · 建議 ≥${tgt}%` : ''}</div>
            ${notes.length ? `<ul>${notes.map((n) => `<li class="${n.lv}">${esc(n.t)}</li>`).join('')}</ul>` : ''}</div>`;
        }).join('')}</div>
        <p class="note simple-only">太陽越多代表越亮。🌑 很暗、☀️ 偏暗、☀️☀️ 普通、☀️☀️☀️ 明亮。平面圖下方按「採光」可以看到每個角落的亮暗。</p>
        <p class="note adv">採光係數 DF＝室內照度／室外照度（陰天）。一般建議客廳、廚房 2% 以上、臥室 1.5% 以上。窗面積參考建築技術規則（居室採光 ≥ 樓地板 1/8、通風 ≥ 1/20），有效採光以「窗前距離／上方遮擋高度 ≥ 1/4」粗估。這是配置比較用的模擬，正式設計請由建築師檢討。</p>`;
    }
    h += '</div>';
    el.innerHTML = h;
  }

  winReportHtml(rep) {
    const rows = rep.report.filter((x) => x.added.length || x.notes.length);
    if (!rows.length) return '';
    return `<details class="brief" open><summary>剛才的開窗建議（${rep.added} 扇新窗${rep.removed ? `，取代 ${rep.removed} 扇舊窗` : ''}，可復原）</summary><ul>${rows.map((x) => {
      const ws = x.added.map((a) => `${sideLabel(this.site, a.side)} 寬 ${a.w}${a.sill ? `、窗台 ${a.sill}` : ''}${a.frosted ? '、霧面' : ''}${a.shade ? '、加遮陽' : ''}`).join('；');
      return `<li><b>${esc(x.name || '房間')}</b>：${ws || '不開窗'}${x.notes.length ? `（${esc(x.notes.join('；'))}）` : ''}</li>`;
    }).join('')}</ul></details>`;
  }

  // 基地示意圖：房子外框、四周狀況、指北
  siteDiagram() {
    const st = this.site, fr = planFrame(this.plan);
    const W = fr.maxX - fr.minX, H = fr.maxY - fr.minY;
    const M = 520;
    const vb = [fr.minX - M, fr.minY - M + 120, W + 2 * M, H + 2 * M - 120];
    const band = (side) => {
      const sd = st.sides[side];
      const k = sd.type;
      const far = k === 'party' ? 0 : Math.min(380, 60 + (sd.dist || 0) * 22);
      const thick = 110;
      const fill = k === 'open' ? 'none' : 'currentColor';
      let r;
      if (side === 'front') r = [fr.minX - 300, fr.maxY + far, W + 600, thick];
      else if (side === 'back') r = [fr.minX - 300, fr.minY - far - thick, W + 600, thick];
      else if (side === 'left') r = [fr.minX - far - thick, fr.minY - 60, thick, H + 120];
      else r = [fr.maxX + far, fr.minY - 60, thick, H + 120];
      const lbl = { party: '鄰房', building: '鄰房', lane: '巷', road: '馬路', open: '空地' }[k];
      const tx = r[0] + r[2] / 2, ty = r[1] + r[3] / 2;
      const rot = side === 'left' || side === 'right' ? ` transform="rotate(-90 ${tx} ${ty})"` : '';
      const road = k === 'road' || k === 'lane' ? (side === 'front' ? `<rect x="${fr.minX - 300}" y="${fr.maxY + 40}" width="${W + 600}" height="${Math.max(10, far - 50)}" fill="currentColor" opacity="0.07"/>` : side === 'back' ? `<rect x="${fr.minX - 300}" y="${fr.minY - far + 10}" width="${W + 600}" height="${Math.max(10, far - 50)}" fill="currentColor" opacity="0.07"/>` : '') : '';
      return `${road}<rect x="${r[0]}" y="${r[1]}" width="${r[2]}" height="${r[3]}" fill="${fill}" opacity="${k === 'open' ? 1 : 0.22}" stroke="currentColor" stroke-opacity="0.35" stroke-dasharray="${k === 'open' ? '30 20' : 'none'}" stroke-width="6"/>
        <text x="${tx}" y="${ty + 30}" font-size="84" text-anchor="middle"${rot}>${lbl}${k === 'party' || k === 'open' ? '' : ` ${sd.dist}m`}</text>`;
    };
    const nv = sunVector(st, 0, 0);
    const nl = Math.hypot(nv.x, nv.y) || 1;
    const ang = Math.atan2(nv.y / nl, nv.x / nl) * 180 / Math.PI + 90;
    const cx = fr.maxX + 330, cy = fr.minY - 230;
    return `<svg class="site-diagram" viewBox="${vb.join(' ')}" role="img" aria-label="基地示意圖" style="color:var(--ink-2);max-height:300px">
      ${['front', 'back', 'left', 'right'].map(band).join('')}
      <rect x="${fr.minX}" y="${fr.minY}" width="${W}" height="${H}" fill="var(--accent-soft)" stroke="currentColor" stroke-width="10"/>
      <text x="${(fr.minX + fr.maxX) / 2}" y="${fr.maxY - 60}" font-size="90" text-anchor="middle" fill="currentColor">前</text>
      <text x="${(fr.minX + fr.maxX) / 2}" y="${fr.minY + 140}" font-size="90" text-anchor="middle" fill="currentColor">後</text>
      <g transform="translate(${cx} ${cy})"><circle r="95" fill="var(--panel)" stroke="currentColor" stroke-width="6"/><path transform="rotate(${ang.toFixed(1)})" d="M0 -82 L28 30 L0 12 L-28 30Z" fill="#d94a2b"/></g>
    </svg>`;
  }

  onSiteField(t) {
    const st = this.site;
    if (t.dataset.site) {
      const k = t.dataset.site;
      st[k] = k === 'city' ? t.value : +t.value;
      if (k === 'floors') st.floors = Math.max(1, Math.round(st.floors || 1));
    } else if (t.dataset.side) {
      const sd = st.sides[t.dataset.side];
      const f = t.dataset.f;
      sd[f] = f === 'type' ? t.value : Math.max(0, +t.value || 0);
      if (f === 'type' && !['party', 'open'].includes(sd.type) && !sd.dist) sd.dist = 4;
    } else return;
    this.lastWin = null;
    this.siteChanged();
    this.renderSitePanel();
  }

  onSiteClick(e) {
    const b = e.target.closest('[data-sa]');
    if (b) {
      const a = b.dataset.sa;
      if (a === 'autoWin') return this.autoWindows();
      if (a === 'wizard') return this.openSiteWizard();
      if (a === 'heat') return this.setDaylight(!this.daylight.show);
      if (a === 'sun') return this.setSun(!this.view.sunSim.on);
    }
    const row = e.target.closest('[data-room]');
    if (row) { this.sel = { type: 'room', id: row.dataset.room }; this.editor.render(); this.view.invalidate(); }
  }

  autoWindows() {
    const p = this.plan;
    const res = designWindows(p, this.site);
    this.lastWin = { planId: p.id, report: res.report, added: res.added.length, removed: res.removed.length };
    this.commit();
    this.scheduleDaylight(true);
    if (!this.daylight.show) this.setDaylight(true);
    this.toast(res.added.length ? `已依基地條件配置 ${res.added.length} 扇窗${res.removed.length ? `（取代 ${res.removed.length} 扇舊窗）` : ''}，不滿意可以按復原` : '沒有找到可以開窗的外牆（可能都是共同壁），請先到「基地・採光」設定四周狀況', 5000);
  }

  // ---------- 自動規劃 ----------
  genProgram() {
    if (!this._gen) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem('house3d.gen') || 'null'); } catch { saved = null; }
      this._gen = { ...defaultProgram(), preset: 'couple1', ...(saved || {}) };
      this._gen.elevation = this.plan.elevation || this._gen.elevation;
      this._gen.style = this.plan.style && this.plan.style !== 'basic' ? this.plan.style : this._gen.style;
    }
    return this._gen;
  }

  openGenerator() {
    const pg = this.genProgram();
    const st = this.site;
    const sideTxt = ['front', 'back', 'left', 'right'].map((k) => `${SIDE_NAMES[k]}${SIDE_TYPES[st.sides[k].type].name.replace(/（.*）/, '')}${['party', 'open'].includes(st.sides[k].type) ? '' : ` ${st.sides[k].dist}m`}`).join('・');
    const html = `<h2>幫我排格局</h2>
      <p>選一個最像你們家的情況，按「產生方案」就好。程式會在固定的外牆、樓梯、電梯、天井和管道間之間試過上百種排法，實際擺好家具、模擬採光，挑出幾種給你比。</p>
      <div class="gen">
        <div class="gen-form" id="genForm"></div>
        <div class="gen-results" id="genResults"><div class="gen-empty"><b>還沒有結果</b><span>左邊選好後按「產生方案」。</span></div></div>
      </div>
      <p class="note gen-site">外面狀況：${esc(CITIES[st.city]?.[0] || '')}・正面朝${dirName(st.front)}・${esc(sideTxt)}　<button type="button" class="linkish" data-x="site">改外面狀況</button></p>`;
    this.modal(html, (card, close) => {
      card.classList.add('wide');
      this.renderGenForm(card, pg, close);
      card.querySelector('[data-x=site]').onclick = () => { close(); this.openSiteWizard(); };
    });
  }

  renderGenForm(card, pg, close) {
    const st = this.site;
    const box = card.querySelector('#genForm');
    const floors = [];
    for (let k = 2; k <= Math.max(2, st.floors); k++) floors.push([st.groundH + (k - 2) * st.floorH, `${k} 樓`]);
    if (!floors.some(([e]) => e === pg.elevation)) pg.elevation = floors[0][0];
    const chip = (k, label, sub = '') => `<button type="button" class="chip${pg[k] ? ' on' : ''}" data-chip="${k}" aria-pressed="${!!pg[k]}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
    const step = (k, label, sub = '') => `<div class="stepper"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><button type="button" data-step="${k}" data-d="-1" aria-label="減少">−</button><output data-out="${k}">${pg[k]}</output><button type="button" data-step="${k}" data-d="1" aria-label="增加">＋</button></div>`;
    const seg = (k, opts) => `<div class="seg mini" data-seg="${k}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(pg[k]) === String(v) ? 'on' : ''}">${t}</button>`).join('')}</div>`;
    const swatch = ([k, v]) => `<button type="button" class="swatch${k === pg.style ? ' on' : ''}" data-style="${k}" title="${esc(v.desc || '')}"><span class="dots">${[v.walls, v.floor.living.base, v.sofa, v.wood, v.fabric3].map((c) => `<i style="background:${c}"></i>`).join('')}</span>${esc(v.name.replace(/（.*）/, ''))}</button>`;
    const preset = PRESETS.find((x) => x[0] === pg.preset);
    box.innerHTML = `
      <fieldset><legend>1　這一層給誰住？</legend>
        <div class="presets">${PRESETS.map(([k, label, , sub]) => `<button type="button" class="preset${k === pg.preset ? ' on' : ''}" data-preset="${k}"><b>${label}</b><small>${sub}</small></button>`).join('')}</div>
      </fieldset>
      <fieldset><legend>2　哪一層、什麼風格？</legend>
        <div class="row-l"><span>樓層</span>${seg('elevation', floors)}</div>
        <div class="swatches">${Object.entries(STYLES).filter(([k]) => k !== 'basic').map(swatch).join('')}</div>
      </fieldset>
      <details class="gen-more"${this.ui.simple && preset ? '' : ' open'}><summary>3　細節調整（可以不用動）</summary>
        <fieldset><legend>臥室</legend>
          <div class="chips">${chip('master', '主臥')}${chip('masterBath', '主臥有自己的浴室')}${chip('elder', '長輩房')}${chip('guest', '客房')}</div>
          ${step('kids', '小孩房')}
        </fieldset>
        <fieldset><legend>衛浴、客餐廚</legend>
          ${step('baths', '浴室總共幾間', '含主臥的浴室')}
          <div class="chips">${chip('living', '客廳')}${chip('dining', '餐廳')}${chip('island', '廚房中島')}</div>
          <div class="row-l"><span>廚房</span>${seg('kitchen', [['open', '開放式'], ['closed', '有拉門'], ['none', '這層不要']])}</div>
          <div class="row-l"><span>餐桌</span>${seg('seats', [[2, '2 人'], [4, '4 人'], [6, '6 人']])}</div>
        </fieldset>
        <fieldset><legend>其他空間</legend>
          <div class="chips">${chip('study', '書房')}${chip('tatami', '和室')}${chip('altar', '神明廳')}${chip('walkin', '更衣室')}${chip('storage', '儲藏室')}</div>
        </fieldset>
        <fieldset><legend>偏好</legend>
          <div class="chips">${chip('accessible', '長輩友善', '拉門、無障礙')}${chip('fengshui', '考慮風水')}</div>
          <div class="row-l"><span>臥室</span>${seg('priority', [['balance', '平衡'], ['quiet', '要安靜'], ['light', '要明亮']])}</div>
        </fieldset>
      </details>
      <div class="row gen-go"><button class="btn" data-x="cancel">關閉</button><button class="btn primary big" data-x="run">產生方案</button></div>`;
    const save = () => { try { localStorage.setItem('house3d.gen', JSON.stringify(pg)); } catch { /* 無法儲存 */ } };
    const custom = () => { if (pg.preset) { pg.preset = null; box.querySelectorAll('[data-preset]').forEach((x) => x.classList.remove('on')); } };
    box.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
      const p = PRESETS.find((x) => x[0] === b.dataset.preset);
      Object.assign(pg, p[2], { preset: p[0] });
      save();
      this.renderGenForm(card, pg, close);
    }));
    box.querySelectorAll('[data-style]').forEach((b) => b.addEventListener('click', () => {
      pg.style = b.dataset.style; save();
      box.querySelectorAll('[data-style]').forEach((x) => x.classList.toggle('on', x === b));
    }));
    box.querySelectorAll('[data-chip]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.chip; pg[k] = !pg[k];
      b.classList.toggle('on', pg[k]); b.setAttribute('aria-pressed', String(pg[k]));
      if (k === 'masterBath' && pg[k] && pg.baths < 1) { pg.baths = 1; box.querySelector('[data-out=baths]').textContent = 1; }
      custom(); save();
    }));
    box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.step;
      const lim = { kids: [0, 3], baths: [0, 3] }[k];
      pg[k] = Math.max(lim[0], Math.min(lim[1], (pg[k] || 0) + +b.dataset.d));
      box.querySelector(`[data-out=${k}]`).textContent = pg[k];
      custom(); save();
    }));
    box.querySelectorAll('[data-seg]').forEach((g) => g.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const k = g.dataset.seg;
      pg[k] = k === 'seats' || k === 'elevation' ? +b.dataset.v : b.dataset.v;
      g.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      if (k !== 'elevation') custom();
      save();
    })));
    box.querySelector('[data-x=cancel]').onclick = () => close();
    box.querySelector('[data-x=run]').onclick = () => this.runGenerator(card, pg);
  }

  async runGenerator(card, pg) {
    const box = card.querySelector('#genResults');
    const btn = card.querySelector('[data-x=run]');
    btn.disabled = true;
    box.innerHTML = '<div class="gen-progress"><b>模擬中…</b><div class="bar"><span style="width:2%"></span></div><small>列舉格局組合…</small></div>';
    let res;
    try {
      res = await generate({ ...pg }, this.site, {
        onProgress: (f, msg) => {
          const bar = box.querySelector('.bar span'); if (bar) bar.style.width = Math.round(f * 100) + '%';
          const sm = box.querySelector('.gen-progress small'); if (sm) sm.textContent = msg;
        },
      });
    } catch (e) {
      console.error(e);
      box.innerHTML = `<div class="gen-empty"><b>產生失敗</b><span>${esc(e.message || e)}</span></div>`;
      btn.disabled = false;
      return;
    }
    btn.disabled = false;
    this._genRes = res;
    const msgs = res.msgs.map((m) => `<p class="gen-msg">${esc(m)}</p>`).join('');
    if (!res.results.length) { box.innerHTML = msgs || '<div class="gen-empty"><b>找不到可行的格局</b></div>'; return; }
    box.innerHTML = `<div class="gen-head"><span>試了 ${res.tried} 種配置、詳細模擬 ${res.built || ''} 種，${(res.ms / 1000).toFixed(1)} 秒。點縮圖可以放大看。</span><button class="btn" data-addall>全部加入</button></div>${msgs}
      <div class="gen-cards">${res.results.map((r, i) => this.genCard(r, i)).join('')}</div>`;
    if (matchMedia('(max-width: 900px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    box.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', () => this.addGenerated([+b.dataset.add], card)));
    box.querySelector('[data-addall]').onclick = () => this.addGenerated(res.results.map((_, i) => i), card);
    box.querySelectorAll('.gen-thumb').forEach((t) => t.addEventListener('click', () => t.closest('.gen-card').classList.toggle('big')));
  }

  genCard(r, i) {
    const p = r.built.plan;
    const m = r.metrics;
    const [g] = dfGrade(m.light);
    const fsOk = r.ev.fs.filter((f) => f.ok).length, fsN = r.ev.fs.length;
    const bullets = (p.brief || []).slice(0, 7);
    return `<article class="gen-card">
      <button class="gen-thumb" aria-label="放大縮圖">${planThumb(p)}</button>
      <div class="gen-body">
        <h3>方案 ${i + 1}<span>${esc(r.label)}</span></h3>
        <p class="note">${esc(r.summary)}</p>
        <div class="gen-metrics">
          <span class="df-badge" style="background:${dfColor(m.light)}">${this.ui.simple ? `亮度 ${g} ${suns(m.light)}` : `採光 ${m.light.toFixed(1)}% ${g}`}</span>
          ${this.genProgram().fengshui ? `<span class="pill ${fsOk === fsN ? 'ok' : ''}">風水 ${fsOk}/${fsN}</span>` : ''}
          <span class="pill ${m.cross ? 'ok' : 'no'}">${m.cross ? '可對流' : '單面通風'}</span>
          <span class="pill">室內 ${m2ToPing(r.indoor).toFixed(1)} 坪</span>
        </div>
        <ul>${bullets.slice(1).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        <div class="row"><button class="btn primary" data-add="${i}">加入成新平面</button></div>
      </div></article>`;
  }

  addGenerated(idxs, card) {
    const res = this._genRes;
    if (!res) return;
    let last = null;
    for (const i of idxs) {
      const r = res.results[i];
      if (!r || r.added) continue;
      const p = normalizePlan(clone(r.built.plan));
      p.id = uid('p');
      this.project.plans.push(p);
      r.added = true;
      last = p;
      card?.querySelector(`[data-add="${i}"]`)?.replaceWith(Object.assign(document.createElement('span'), { className: 'pill ok', textContent: '已加入' }));
    }
    if (!last) return;
    this.save();
    this.switchPlan(last.id);
    this.toast(idxs.length > 1 ? `已加入 ${idxs.length} 個方案（上方分頁）` : `已加入「${last.name}」，可以直接拖拉修改`, 4000);
  }

  // ---------- 新手模式、首頁、導覽 ----------
  saveUI() { try { localStorage.setItem('house3d.ui', JSON.stringify(this.ui)); } catch { /* 無法儲存 */ } }

  applyMode() {
    document.body.classList.toggle('simple', !!this.ui.simple);
    $('#btnModeLabel').textContent = this.ui.simple ? '更多工具' : '簡單模式';
    if (this.ui.simple && !['select', 'item'].includes(this.tool)) this.setTool('select');
    this.renderProps();
    if (this.sideTab === 'site') this.renderSitePanel();
    if (!$('#catalog').hidden) this.renderCatalog();
  }

  setMode(simple) {
    this.ui.simple = simple;
    this.saveUI();
    this.applyMode();
    this.toast(simple ? '已切換到簡單模式：只留下最常用的工具' : '已切換到進階模式：可以畫牆、門窗、量尺寸、放底圖', 3500);
  }

  showWelcome() {
    const html = `<div class="welcome"><h2>想做什麼？</h2>
      <p>不用會 CAD，點一個開始就好。之後點左上角的房子圖示，可以回到這裡。</p>
      <div class="welcome-cards">
        <button data-w="look"><span class="emo" aria-hidden="true">🏠</span><b>看看平面圖的 3D</b><small>媽媽畫的方案和建議方案，轉一轉、走進去看、拖家具</small></button>
        <button data-w="bld"><span class="emo" aria-hidden="true">🏢</span><b>整棟怎麼分</b><small>蓋幾層、每層做什麼（一樓大空間、出租、自住、頂樓），連外觀一起排</small></button>
        <button data-w="gen"><span class="emo" aria-hidden="true">✨</span><b>幫我排格局</b><small>選家裡有誰住、要幾房，程式排出幾種給你比</small></button>
        <button data-w="site"><span class="emo" aria-hidden="true">☀️</span><b>告訴程式外面的狀況</b><small>房子朝哪邊、隔壁和馬路是什麼，算出哪間最亮、窗開哪裡</small></button>
        <button data-w="file"><span class="emo" aria-hidden="true">📂</span><b>我有 CAD 圖或照片</b><small>把 DXF、PDF 或照片丟進來，自動變成 3D</small></button>
      </div>
      <div class="welcome-foot"><label class="check"><input type="checkbox" id="wNo"${this.ui.welcome ? '' : ' checked'}> 下次打開不要再問</label>
      <button class="linkish" data-w="mode">${this.ui.simple ? '我會用 CAD，給我進階工具' : '切回簡單模式'}</button></div></div>`;
    this.modal(html, (card, close) => {
      card.classList.add('wide');
      card.querySelector('#wNo').onchange = (e) => { this.ui.welcome = !e.target.checked; this.saveUI(); };
      card.querySelectorAll('[data-w]').forEach((b) => b.addEventListener('click', () => {
        const w = b.dataset.w;
        close();
        if (w === 'look') { if (!this.ui.toured) setTimeout(() => this.startTour(), 250); }
        if (w === 'gen') this.openGenerator();
        if (w === 'bld') { if (this.project.building) this.enterBuilding(); else this.openBuildingWizard(); }
        if (w === 'site') this.openSiteWizard();
        if (w === 'file') $('#fileInput').click();
        if (w === 'mode') this.setMode(!this.ui.simple);
      }));
    });
  }

  quick(k) {
    if (k === 'gen') return this.openGenerator();
    if (k === 'ask') return this.openAsk();
    if (k === 'bld') return this.enterBuilding();
    if (k === 'site') return this.openSiteWizard();
    if (k === 'tour') return this.startTour();
    if (k === 'furn') {
      if (matchMedia('(max-width: 900px)').matches) document.querySelector('#mobileSwitch [data-show="2d"]')?.click();
      this.setTool('item');
    }
  }

  startTour() {
    const mobile = matchMedia('(max-width: 900px)').matches;
    const show = (v) => { if (mobile) document.querySelector(`#mobileSwitch [data-show="${v}"]`)?.click(); };
    const steps = [
      { el: '#pane2d', view: '2d', t: '這是平面圖', d: '家具、牆、門窗都可以直接用手指或滑鼠拖。點一下東西，右邊（手機在「屬性」）會出現可以改的尺寸和款式。' },
      { el: '#pane3d', view: '3d', t: '這是 3D', d: '拖曳可以轉來轉去，兩指或滾輪放大。下面的「漫遊」可以走進房子裡看。' },
      { el: '#styleSel', view: '3d', t: '換裝潢風格', d: '日式、北歐、侘寂、工業、輕奢，牆面地板和家具款式會整套換。' },
      { el: '#planTabs', t: '不同的方案', d: '上面一排是不同的平面方案，點一下就切換；右邊的「＋」可以複製一份來改。' },
      { el: '#tabBuilding', t: '整棟', d: '蓋幾層、每層做什麼（一樓大空間、出租、自住、頂樓），外觀要什麼樣子，都在這裡。' },
      { el: '#btnAsk', t: '用講的改', d: '打字或用說的：「主臥大一點」「二樓改自住」「外牆換清水模」，程式直接幫你改。' },
      { el: '#btnGen', t: '幫我排格局', d: '選家裡有誰住、要幾房，程式會排出幾種格局，連家具都擺好。' },
      { el: '#btnRender', view: '3d', t: '擬真效果圖、360°', d: '算出像照片的效果圖；360° 可以站在房間裡轉一圈看，還能下載成 360 照片。' },
      { el: '#btnSite', t: '外面的狀況', d: '回答房子朝哪邊、隔壁是什麼，程式會算出每間房的亮度，還能自動決定窗戶開在哪。' },
      { el: '[data-cmd=undo]', view: '2d', t: '改壞了不用怕', d: '按「復原」就回到上一步，可以一直按。所有修改都會自動存在這台裝置上。' },
    ];
    let i = 0;
    const root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML = '<div class="tour-hole"></div><div class="tour-bubble" role="dialog" aria-live="polite"><b></b><p></p><div class="row"><span class="tour-n"></span><button class="btn" data-t="skip">結束導覽</button><button class="btn" data-t="prev">上一步</button><button class="btn primary" data-t="next">下一步</button></div></div>';
    document.body.appendChild(root);
    const hole = root.querySelector('.tour-hole'), bub = root.querySelector('.tour-bubble');
    const end = () => { root.remove(); window.removeEventListener('resize', place); document.removeEventListener('keydown', key, true); this.ui.toured = true; this.saveUI(); if (mobile) show('2d'); };
    const place = () => {
      const st = steps[i];
      const el = document.querySelector(st.el);
      bub.querySelector('b').textContent = st.t;
      bub.querySelector('p').textContent = st.d;
      bub.querySelector('.tour-n').textContent = `${i + 1} / ${steps.length}`;
      bub.querySelector('[data-t=prev]').disabled = i === 0;
      bub.querySelector('[data-t=next]').textContent = i === steps.length - 1 ? '開始使用' : '下一步';
      if (!el || !el.offsetParent) { hole.style.cssText = 'left:50%;top:50%;width:0;height:0'; bub.style.cssText = 'left:50%;top:50%;transform:translate(-50%,-50%)'; return; }
      const r = el.getBoundingClientRect();
      const pad = 6, vw = innerWidth, vh = innerHeight;
      hole.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;
      const bw = Math.min(340, vw - 24);
      bub.style.width = bw + 'px';
      const bh = bub.offsetHeight || 150;
      let x = Math.min(Math.max(12, r.left + r.width / 2 - bw / 2), vw - bw - 12), y;
      if (r.height > vh * 0.5) y = Math.min(vh - bh - 16, r.top + r.height * 0.55);
      else if (r.bottom + bh + 18 < vh) y = r.bottom + 14;
      else y = Math.max(12, r.top - bh - 14);
      bub.style.left = x + 'px'; bub.style.top = y + 'px'; bub.style.transform = '';
    };
    const go = (d) => {
      i += d;
      if (i < 0) i = 0;
      if (i >= steps.length) return end();
      if (steps[i].view) show(steps[i].view);
      setTimeout(place, mobile ? 120 : 10);
    };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); end(); } if (e.key === 'ArrowRight' || e.key === 'Enter') go(1); if (e.key === 'ArrowLeft') go(-1); };
    root.querySelector('[data-t=skip]').onclick = end;
    root.querySelector('[data-t=prev]').onclick = () => go(-1);
    root.querySelector('[data-t=next]').onclick = () => go(1);
    window.addEventListener('resize', place);
    document.addEventListener('keydown', key, true);
    go(0);
    root.querySelector('[data-t=next]').focus();
  }

  // ---------- 外面狀況：一題一題問 ----------
  openSiteWizard() {
    const st = this.site;
    const steps = ['city', 'front', 'side:front', 'side:back', 'side:left', 'side:right', 'floors', 'done'];
    let i = 0;
    const DIST = [2, 3, 4, 6, 8, 10, 12, 15, 20, 30];
    const SIDE_PICS = {
      party: ['緊貼隔壁房子', '牆和隔壁黏在一起，這面不能開窗'],
      lane: ['小巷子／防火巷', '中間隔一條窄巷'],
      road: ['馬路', '車子會經過的路'],
      building: ['隔壁房子，中間有空隙', '有一點距離，但不是路'],
      open: ['空地、公園、田', '前面沒有東西擋'],
    };
    const html = '<div class="wiz" id="wiz"></div>';
    this.modal(html, (card, close) => {
      card.classList.add('wide');
      const box = card.querySelector('#wiz');
      const changed = () => { this.lastWin = null; this.siteChanged(); };
      const render = () => {
        const key = steps[i];
        let body = '';
        if (key === 'city') {
          body = `<h2>房子在哪個城市？</h2><p>用來算太陽的角度。</p>
            <div class="big-grid">${Object.entries(CITIES).map(([k, [n]]) => `<button class="big-opt${st.city === k ? ' on' : ''}" data-city="${k}">${n}</button>`).join('')}</div>
            ${navigator.geolocation ? '<div class="row-c"><button class="btn" data-geo>📍 用我現在的位置</button><span class="note" id="geoMsg"></span></div>' : ''}`;
        } else if (key === 'front') {
          const dirs = DIRS.map(([n, d]) => { const a = (d - 90) * Math.PI / 180; return `<button class="compass-b${Math.round(st.front) % 360 === d ? ' on' : ''}" data-dir="${d}" style="left:${50 + Math.cos(a) * 40}%;top:${50 + Math.sin(a) * 40}%">${n}</button>`; }).join('');
          body = `<h2>站在前陽台、臉朝外面，你面對哪個方向？</h2>
            <p>前陽台就是靠馬路、平面圖最下面那一邊。不確定的話：中午太陽在南邊；或打開 Google 地圖看房子朝哪。</p>
            <div class="compass-wrap"><div class="compass-big">${dirs}<div class="compass-c"><b>朝${dirName(st.front)}</b><small>${Math.round(st.front)}°</small></div></div>
            <div class="compass-side"><button class="btn" data-compass>📱 用手機指南針量</button><p class="note" id="cmpMsg">拿著手機站在前陽台，螢幕朝上、手機頭朝外面，再按這個鈕。</p></div></div>`;
        } else if (key.startsWith('side:')) {
          const side = key.slice(5);
          const sd = st.sides[side];
          const need = !['party', 'open'].includes(sd.type);
          body = `<h2>房子<b class="hl">${SIDE_NAMES[side]}</b>是什麼？</h2>
            <p>${esc(SIDE_HINTS[side])}。${side === 'left' || side === 'right' ? '從前面馬路看著房子分左右。' : ''}</p>
            <div class="side-wiz">${this.sideDiagramMini(side)}
            <div class="pic-grid">${Object.entries(SIDE_PICS).map(([k, [t, sub]]) => `<button class="pic-opt${sd.type === k ? ' on' : ''}" data-type="${k}">${sidePic(k)}<b>${t}</b><small>${sub}</small></button>`).join('')}</div></div>
            ${sd.type === 'party' ? `<div class="ask"><span>隔壁大約幾層樓？</span>${this.bigStepper('floors', sd.floors, 1, 30, '層')}</div>` : ''}
            ${need ? `<div class="ask"><span>對面房子大約幾層樓？</span>${this.bigStepper('floors', sd.floors, 0, 30, '層')}</div>
              <div class="ask"><span>從我家外牆到對面房子大約多遠？</span><div class="chips">${DIST.map((d) => `<button class="chip${sd.dist === d ? ' on' : ''}" data-dist="${d}">${d} m</button>`).join('')}</div>
              <p class="note">參考：一般防火巷 2–4 m、巷子 4–8 m、馬路 8–20 m；人張開雙手大約 1.5 m。</p></div>` : ''}`;
        } else if (key === 'floors') {
          body = `<h2>這棟房子總共幾層樓？</h2><p>算上一樓。天井和樓上陽台會擋光，所以要知道。</p>
            <div class="ask"><span>總共</span>${this.bigStepper('bfloors', st.floors, 1, 30, '層樓')}</div>
            <h2 class="sub">一樓比較高嗎？</h2><p>一樓是店面或車庫的話通常比較高（媽媽的圖是 4.65 m）。</p>
            <div class="big-grid two"><button class="big-opt${st.groundH <= 360 ? ' on' : ''}" data-gh="350">一般高度（約 3.5 m）</button><button class="big-opt${st.groundH > 360 ? ' on' : ''}" data-gh="465">比較高（約 4.65 m）</button></div>`;
        } else {
          const r = analyzeDaylight(this.plan, st, { step: 40 });
          const rooms = r.rooms.filter((x) => ['living', 'bedroom', 'kitchen'].includes(x.kind));
          const sorted = rooms.slice().sort((a, b) => b.df - a.df);
          const line = (x) => `<li><b>${esc(x.name)}</b>：${dfGrade(x.df)[0]} ${suns(x.df)}${x.sunWinter >= 0.5 ? `，冬天有 ${x.sunWinter.toFixed(1)} 小時太陽` : '，冬天曬不到太陽'}</li>`;
          body = `<h2>設定好了！</h2><p>以「${esc(this.plan.name)}」為例，這一層各房間的亮度：</p>
            <div class="done-wrap">${this.siteDiagram()}<ul class="done-list">${sorted.map(line).join('') || '<li>這個平面沒有房間資料</li>'}</ul></div>
            <div class="big-grid three"><button class="big-opt" data-done="win">🪟 幫我依這些條件開窗</button><button class="big-opt" data-done="sun">🌞 看太陽怎麼照進來</button><button class="big-opt" data-done="gen">✨ 用這些條件排格局</button></div>`;
        }
        box.innerHTML = `<div class="wiz-top"><div class="dots">${steps.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}"></i>`).join('')}</div><button class="linkish" data-x="close">關閉</button></div>
          <div class="wiz-body">${body}</div>
          <div class="wiz-nav"><button class="btn" data-x="prev"${i === 0 ? ' disabled' : ''}>上一步</button><span class="note">${i + 1} / ${steps.length}</span><button class="btn primary big" data-x="next">${i === steps.length - 1 ? '完成' : '下一題'}</button></div>`;
        bind(key);
      };
      const bind = (key) => {
        box.querySelector('[data-x=close]').onclick = () => close();
        box.querySelector('[data-x=prev]').onclick = () => { i = Math.max(0, i - 1); render(); };
        box.querySelector('[data-x=next]').onclick = () => { if (i === steps.length - 1) { close(); this.renderSitePanel(); this.toast('外面狀況已儲存，之後可以在右側「基地・採光」或上方「外面狀況」修改', 4500); } else { i++; render(); } };
        box.querySelectorAll('[data-city]').forEach((b) => b.onclick = () => { st.city = b.dataset.city; changed(); i++; render(); });
        box.querySelector('[data-geo]')?.addEventListener('click', () => this.locateCity(st, box, () => { changed(); render(); }));
        box.querySelectorAll('[data-dir]').forEach((b) => b.onclick = () => { st.front = +b.dataset.dir; changed(); render(); });
        box.querySelector('[data-compass]')?.addEventListener('click', () => this.readCompass(box, (deg) => { st.front = Math.round(deg / 5) * 5 % 360; changed(); render(); }));
        if (key.startsWith('side:')) {
          const side = key.slice(5);
          const sd = st.sides[side];
          box.querySelectorAll('[data-type]').forEach((b) => b.onclick = () => {
            sd.type = b.dataset.type;
            if (sd.type === 'lane' && (!sd.dist || sd.dist > 8)) sd.dist = 4;
            if (sd.type === 'road' && (!sd.dist || sd.dist < 6)) sd.dist = 12;
            if (sd.type === 'building' && !sd.dist) sd.dist = 3;
            if (!sd.floors) sd.floors = 4;
            changed(); render();
          });
          box.querySelectorAll('[data-dist]').forEach((b) => b.onclick = () => { sd.dist = +b.dataset.dist; changed(); render(); });
          this.bindBigStepper(box, 'floors', (v) => { sd.floors = v; changed(); });
        }
        this.bindBigStepper(box, 'bfloors', (v) => { st.floors = v; changed(); });
        box.querySelectorAll('[data-gh]').forEach((b) => b.onclick = () => { st.groundH = +b.dataset.gh; changed(); render(); });
        box.querySelectorAll('[data-done]').forEach((b) => b.onclick = () => {
          const d = b.dataset.done;
          close();
          if (d === 'win') this.autoWindows();
          if (d === 'sun') { if (matchMedia('(max-width: 900px)').matches) document.querySelector('#mobileSwitch [data-show="3d"]')?.click(); this.setSun(true); }
          if (d === 'gen') this.openGenerator();
        });
      };
      render();
    });
  }

  bigStepper(k, v, min, max, unit) {
    return `<div class="big-step" data-bs="${k}" data-min="${min}" data-max="${max}"><button type="button" data-d="-1" aria-label="減少">−</button><output>${v}</output><span>${unit}</span><button type="button" data-d="1" aria-label="增加">＋</button></div>`;
  }

  bindBigStepper(box, k, set) {
    const el = box.querySelector(`[data-bs="${k}"]`);
    if (!el) return;
    el.querySelectorAll('button').forEach((b) => b.onclick = () => {
      const out = el.querySelector('output');
      const v = Math.max(+el.dataset.min, Math.min(+el.dataset.max, +out.textContent + +b.dataset.d));
      out.textContent = v;
      set(v);
    });
  }

  // 房子外框小圖，標出問到的那一面
  sideDiagramMini(side) {
    const hl = 'var(--accent)';
    const bar = { front: 'M8 92 H52', back: 'M8 8 H52', left: 'M8 8 V92', right: 'M52 8 V92' }[side];
    return `<svg class="mini-house" viewBox="-14 -6 88 112" aria-hidden="true">
      <rect x="8" y="8" width="44" height="84" fill="var(--paper)" stroke="var(--ink-3)" stroke-width="2"/>
      <rect x="40" y="10" width="10" height="22" fill="var(--line)"/><rect x="10" y="44" width="12" height="14" fill="var(--line)"/>
      <path d="${bar}" stroke="${hl}" stroke-width="7" stroke-linecap="round"/>
      <text x="30" y="88" text-anchor="middle" font-size="8" fill="var(--ink-2)">前陽台</text>
      <text x="30" y="104" text-anchor="middle" font-size="8" fill="var(--ink-3)">馬路方向</text>
    </svg>`;
  }

  locateCity(st, box, done) {
    const msg = box.querySelector('#geoMsg');
    if (msg) msg.textContent = '定位中…';
    navigator.geolocation.getCurrentPosition((pos) => {
      const { latitude: la, longitude: lo } = pos.coords;
      let best = null;
      for (const [k, [, lat, lon]] of Object.entries(CITIES)) { const d = Math.hypot(lat - la, (lon - lo) * Math.cos(la * Math.PI / 180)); if (!best || d < best.d) best = { k, d }; }
      if (best && best.d < 1.2) { st.city = best.k; this.toast(`定位到 ${CITIES[best.k][0]}`); done(); }
      else if (msg) msg.textContent = '看起來不在台灣，請直接點城市';
    }, () => { if (msg) msg.textContent = '這裡拿不到位置，請直接點城市'; }, { timeout: 8000, maximumAge: 600000 });
  }

  async readCompass(box, use) {
    const msg = box.querySelector('#cmpMsg');
    const say = (t) => { if (msg) msg.textContent = t; };
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const r = await DeviceOrientationEvent.requestPermission();
        if (r !== 'granted') return say('沒有取得指南針權限，請直接點方向');
      }
    } catch { /* 不支援 */ }
    let heading = null;
    const on = (e) => {
      if (typeof e.webkitCompassHeading === 'number') heading = e.webkitCompassHeading;
      else if (e.absolute && typeof e.alpha === 'number') heading = (360 - e.alpha) % 360;
      if (heading !== null) say(`現在朝 ${dirName(heading)}（${Math.round(heading)}°）…`);
    };
    window.addEventListener('deviceorientationabsolute', on);
    window.addEventListener('deviceorientation', on);
    say('讀取中，手機請放平、手機頭朝外…');
    setTimeout(() => {
      window.removeEventListener('deviceorientationabsolute', on);
      window.removeEventListener('deviceorientation', on);
      if (heading === null) say('這台裝置或瀏覽器拿不到指南針，請用手機內建的指南針 App 看，再點上面的方向。');
      else { use(heading); this.toast(`已設定：正面朝${dirName(heading)}（${Math.round(heading)}°）`); }
    }, 2500);
  }

  // ---------- 平面分頁 ----------
  renderTabs() {
    const nav = $('#planTabs');
    const b = this.project.building;
    const order = b ? this.floors().map((f) => b.plans[f.id]) : [];
    const floorPlans = order.map((id) => this.project.plans.find((p) => p.id === id)).filter(Boolean);
    const others = this.project.plans.filter((p) => !floorPlans.includes(p));
    const tab = (p, fl) => `<button class="tab${fl ? ' fl' : ''}${!this.bmode && p.id === this.plan.id ? ' on' : ''}" data-id="${p.id}">${esc(p.name)}${!fl && p.elevation ? `<small>+${p.elevation}</small>` : ''}</button>`;
    nav.innerHTML = `<button class="tab bld${this.bmode ? ' on' : ''}" id="tabBuilding" title="整棟：每層做什麼、外觀">🏢 整棟</button>` +
      floorPlans.map((p) => tab(p, true)).join('') + (floorPlans.length && others.length ? '<span class="tab-sep" aria-hidden="true"></span>' : '') + others.map((p) => tab(p, false)).join('') +
      '<button class="tab add" id="addPlan" title="新增平面" aria-label="新增平面">＋</button>';
    $('#tabBuilding').onclick = () => this.enterBuilding();
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
    if (this.bmode) { this.bmode = false; this.project.bmode = false; this.applyBmode(); }
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
    const HIDE_SIMPLE = ['duct', 'column', 'stair', 'elevator', 'ledge', 'box', 'acout'];
    const groups = {};
    for (const [k, c] of Object.entries(CATALOG)) {
      if (this.ui.simple && HIDE_SIMPLE.includes(k)) continue;
      (groups[c.group] ||= []).push([k, c]);
    }
    const icon = (k, c) => {
      const it = { id: '_ico', kind: k, x: 0, y: 0, w: c.w, d: c.d, rot: 0, h: c.h, risers: c.risers, style: c.style, top: k === 'counter' ? 'stove' : undefined };
      const m = Math.max(c.w, c.d) * 0.08 + 4;
      return `<svg class="ico" viewBox="${-c.w / 2 - m} ${-c.d / 2 - m} ${c.w + 2 * m} ${c.d + 2 * m}" aria-hidden="true">${this.editor.itemSvg(it, false).replace(/ data-hit="item" data-id="_ico"/, '')}</svg>`;
    };
    $('#catalog').innerHTML = `<p class="cat-tip">點一下再點平面圖放置，或直接把圖示<b>拖到平面圖上</b>。</p>` + Object.entries(groups).map(([g, list]) => `<h4>${esc(g)}</h4><div class="grid">${list.map(([k, c]) => `<button data-kind="${k}" class="${k === this.placeKind ? 'on' : ''}">${icon(k, c)}<span>${esc(c.name.replace(/ .*/, ''))}</span><small>${c.w}×${c.d}</small></button>`).join('')}</div>`).join('');
    $('#catalog').querySelectorAll('[data-kind]').forEach((b) => {
      b.addEventListener('click', () => {
        if (this._dragged) { this._dragged = false; return; }
        this.placeKind = b.dataset.kind;
        $('#catalog').querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b));
        $('#toolHint').textContent = `在平面圖上點一下放「${CATALOG[this.placeKind].name}」（也可以直接拖過去）`;
      });
      b.addEventListener('pointerdown', (e) => this.catalogDrag(e, b.dataset.kind));
    });
  }

  // 從目錄把家具拖到平面圖上
  catalogDrag(e, kind) {
    if (e.button > 0) return;
    const sx = e.clientX, sy = e.clientY;
    let drag = false;
    const svg = $('#plan2d');
    const over = (ev) => {
      const r = svg.getBoundingClientRect();
      if (ev.clientX < r.left || ev.clientX > r.right || ev.clientY < r.top || ev.clientY > r.bottom) return null;
      const top = document.elementFromPoint(ev.clientX, ev.clientY);
      if (top && top.closest('#catalog') && !document.body.classList.contains('dragging-item')) return null;
      return this.editor.toWorld(ev.clientX, ev.clientY);
    };
    const move = (ev) => {
      if (!drag && Math.hypot(ev.clientX - sx, ev.clientY - sy) > 8) {
        drag = true;
        this.placeKind = kind;
        document.body.classList.add('dragging-item');
      }
      if (!drag) return;
      ev.preventDefault?.();
      const w = over(ev);
      const c = CATALOG[kind];
      this.editor.hover = w ? { type: 'place-item', item: { id: '_ghost', kind, x: w.x, y: w.y, w: c.w, d: c.d, rot: 0, risers: c.risers, style: c.style, h: c.h } } : null;
      this.editor.render();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      const w = drag && ev.type === 'pointerup' ? over(ev) : null;
      document.body.classList.remove('dragging-item');
      if (!drag) return;
      this._dragged = true;
      setTimeout(() => { this._dragged = false; }, 50);
      if (w) { this.placeKind = kind; this.editor.placeItem(w); this.toast(`已放上「${CATALOG[kind].name}」，可以直接拖動調整`); }
      else { this.editor.hover = null; this.editor.render(); }
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  }

  // ---------- 屬性面板 ----------
  num(label, key, val, { step = 1, unit = 'cm', min, full = false, adv = false } = {}) {
    return `<div class="field${full ? ' full' : ''}${adv ? ' adv' : ''}"><label for="f_${key}">${label}</label><div class="unit"><input type="number" id="f_${key}" data-k="${key}" value="${Math.round(val * 10) / 10}" step="${step}"${min !== undefined ? ` min="${min}"` : ''}><span>${unit}</span></div></div>`;
  }
  txt(label, key, val, full = true) {
    return `<div class="field${full ? ' full' : ''}"><label for="f_${key}">${label}</label><input type="text" id="f_${key}" data-k="${key}" value="${esc(val)}"></div>`;
  }
  sel_(label, key, val, opts, full = false, adv = false) {
    return `<div class="field${full ? ' full' : ''}${adv ? ' adv' : ''}"><label for="f_${key}">${label}</label><select id="f_${key}" data-k="${key}">${opts.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val) ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select></div>`;
  }

  renderProps() {
    if (this.bmode && this.building) return this.renderBldPanel();
    const el = $('#props');
    const p = this.plan;
    const s = this.sel;
    const obj = this.findSel(s);
    let h = '';
    if (s && obj) {
      if (s.type === 'wall') {
        const L = dist(obj.a, obj.b);
        h += `<div class="sec"><h3>牆 <span class="kind-chip">${{ ext: '外牆', int: '隔間牆', parapet: '矮牆／女兒牆' }[obj.kind] || '牆'}</span></h3>
          <div class="fields">${this.num('長度', 'len', L, { step: 0.5 })}${this.num('厚度', 't', obj.t, { step: 0.5, min: 3, adv: true })}${this.num('高度', 'h', obj.h ?? p.wallHeight, { step: 5, adv: true })}
          ${this.sel_('類型', 'kind', obj.kind, [['ext', '外牆'], ['int', '隔間牆'], ['parapet', '矮牆／女兒牆']], false, true)}</div>
          <p class="note">用手指或滑鼠拖住牆，就能整面平移，旁邊的牆會跟著伸縮。</p>
          <div class="row"><button class="btn" data-a="addDoor">加門</button><button class="btn" data-a="addWindow">加窗</button><button class="btn adv" data-a="split">從中間分割</button><button class="btn danger" data-a="del">刪除</button></div></div>`;
      } else if (s.type === 'opening') {
        const w = p.walls.find((x) => x.id === obj.wall);
        const L = w ? dist(w.a, w.b) : 0;
        h += `<div class="sec"><h3>門窗 <span class="kind-chip">${OPENING_TYPES[obj.type]}</span></h3>
          <div class="fields">${this.sel_('類型', 'type', obj.type, Object.entries(OPENING_TYPES))}${this.num('寬度', 'w', obj.w, { step: 5, min: 20 })}
          ${this.num('高度', 'h', obj.h, { step: 5, adv: true })}${this.num('窗台高', 'sill', obj.sill || 0, { step: 5, adv: true })}
          ${this.num('距牆端', 'off', obj.pos - obj.w / 2, { step: 1, adv: true })}${this.num('距另一端', 'off2', L - obj.pos - obj.w / 2, { step: 1, adv: true })}</div>
          ${obj.type === 'window' ? `<div class="checks"><label><input type="checkbox" data-k="frosted"${obj.frosted ? ' checked' : ''}> 霧面玻璃</label><label><input type="checkbox" data-k="shade"${obj.shade ? ' checked' : ''}> 外遮陽板</label></div>` : ''}
          <p class="note">沿著牆拖曳可移動位置，拖到另一面牆上會換牆。</p>
          <div class="row">${obj.type === 'door' ? '<button class="btn" data-a="flipSide">換開門方向</button><button class="btn adv" data-a="flipHinge">換鉸鏈邊</button>' : ''}<button class="btn danger" data-a="del">刪除</button></div></div>`;
      } else if (s.type === 'item') {
        const kinds = Object.entries(CATALOG).map(([k, c]) => [k, c.name]);
        h += `<div class="sec"><h3>家具／設備 <span class="kind-chip">${esc(CATALOG[obj.kind]?.group || '')}</span></h3><h2>${esc(itemName(obj))}</h2>
          <div class="fields">${this.txt('名稱', 'label', obj.label || '')}${this.sel_('種類', 'kind', obj.kind, kinds, true, true)}
          ${FURN_VARIANTS[obj.kind] ? this.sel_('款式', 'variant', obj.variant || '', [['', `依風格（${FURN_VARIANTS[obj.kind][variantOf({ kind: obj.kind }, p.style)]}）`], ...Object.entries(FURN_VARIANTS[obj.kind])], true) : ''}
          ${this.num('寬', 'w', obj.w, { step: 1, min: 5 })}${this.num('深', 'd', obj.d, { step: 1, min: 5 })}
          ${this.num('高', 'h', obj.h ?? CATALOG[obj.kind]?.h ?? 60, { step: 5, adv: true })}${this.num('角度', 'rot', obj.rot || 0, { step: 15, unit: '°', adv: true })}
          ${this.num('X', 'x', obj.x, { adv: true })}${this.num('Y', 'y', obj.y, { adv: true })}
          ${obj.kind === 'ac' || obj.elev ? this.num('離地高度', 'elev', obj.elev ?? CATALOG[obj.kind]?.elev ?? 0, { step: 5, adv: true }) : ''}
          ${obj.kind === 'counter' ? this.sel_('檯面', 'top', obj.top || 'plain', Object.entries(COUNTER_TOPS)) : ''}
          ${obj.kind === 'stair' ? this.num('級數', 'risers', obj.risers || 19, { unit: '級' }) + this.sel_('樣式', 'style', obj.style || 'U', [['U', 'U 型（迴轉）'], ['straight', '直梯']]) : ''}
          </div>
          <p class="note simple-only">直接拖動就能移動；藍色圓點可以轉方向、方形點可以拉大小。</p>
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
      h += `<div class="sec simple-only quick"><h3>怎麼開始</h3>
        <div class="quick-btns"><button class="btn" data-qa="gen">✨ 幫我排格局</button><button class="btn" data-qa="ask">💬 用講的改</button><button class="btn" data-qa="bld">🏢 整棟</button><button class="btn" data-qa="site">☀️ 外面狀況</button><button class="btn" data-qa="furn">🛋️ 加家具</button><button class="btn" data-qa="tour">👆 教我用</button></div>
        <p class="note">點平面圖上的家具、牆或房間，這裡就會出現可以改的項目。改壞了按左邊「復原」。</p></div>`;
      h += `<div class="sec"><h3>平面</h3><h2>${esc(p.name)}</h2>${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
        ${p.brief?.length ? `<details class="brief" open><summary>設計重點</summary><ul>${p.brief.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}
        <div class="stat"><div><b>${indoor.toFixed(1)}</b><small>室內面積 ㎡（牆中心線）（${m2ToPing(indoor).toFixed(1)} 坪）</small></div><div><b>${balcony.toFixed(1)}</b><small>陽台 ㎡</small></div>
        <div class="adv"><b>${p.walls.length}</b><small>面牆</small></div><div class="adv"><b>${p.items.length}</b><small>件家具設備</small></div></div>
        <div class="fields">${this.txt('名稱', 'pname', p.name)}${this.num('樓板高程', 'elevation', p.elevation || 0, { step: 5, adv: true })}${this.num('樓高', 'floorHeight', p.floorHeight, { step: 5, adv: true })}
        ${this.num('牆高', 'wallHeight', p.wallHeight, { step: 5, adv: true })}${this.num('新牆厚度', 'newT', this.wallThickness(), { step: 1, adv: true })}</div>
        <div class="row"><button class="btn adv" data-a="applyH">牆高套用到全部</button><button class="btn" data-a="dupPlan">複製此平面</button><button class="btn danger" data-a="delPlan">刪除此平面</button></div></div>`;
      const u = p.underlay;
      h += `<div class="sec adv"><h3>底圖</h3>${u ? `
        <div class="checks"><label><input type="checkbox" data-u="visible"${u.visible ? ' checked' : ''}> 顯示底圖</label></div>
        <div class="field"><label for="f_uop">透明度</label><input type="range" id="f_uop" data-u="opacity" min="0.1" max="1" step="0.05" value="${u.opacity ?? 0.45}"></div>
        <div class="row">${this.tool === 'underlay' ? '<button class="btn primary" data-a="uDone">完成移動</button>' : '<button class="btn" data-a="uMove">移動底圖</button>'}<button class="btn" data-a="uCal">校正比例</button><button class="btn" data-a="uLoad">換一張</button><button class="btn danger" data-a="uDel">移除</button></div>`
        : '<p class="note">可放一張圖片或 PDF 當底圖描繪（直接拖進視窗也可以）。</p><div class="row"><button class="btn" data-a="uLoad">選擇底圖…</button></div>'}</div>`;
      const st = this.settings;
      const ck = (k, t) => `<label><input type="checkbox" data-s="${k}"${st[k] ? ' checked' : ''}> ${t}</label>`;
      h += `<div class="sec adv"><h3>顯示</h3><div class="checks">${ck('grid', '格線')}${ck('dims', '尺寸')}${ck('labels', '房間名稱')}${ck('area', '面積')}${ck('itemLabels', '家具名稱')}${ck('highlighter', '螢光筆牆')}${ck('snap', '吸附 5 cm')}</div></div>`;
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
    el.querySelectorAll('[data-k]').forEach((inp) => inp.addEventListener('change', () => this.onField(inp.dataset.k, inp.type === 'number' ? parseFloat(inp.value) : inp.type === 'checkbox' ? inp.checked : inp.value, obj)));
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
    el.querySelectorAll('[data-qa]').forEach((b) => b.addEventListener('click', () => this.quick(b.dataset.qa)));
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
    if (typeof v === 'number' && !Number.isFinite(v)) return;
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
      } else if (k === 'frosted' || k === 'shade') { obj[k] = v || undefined; }
      else if (k === 'off') obj.pos = v + obj.w / 2;
      else if (k === 'off2') obj.pos = L - v - obj.w / 2;
      else if (k === 'w') { const c = obj.pos; obj.w = Math.min(v, L); obj.pos = c; }
      else obj[k] = v;
      obj.pos = Math.max(obj.w / 2, Math.min(L - obj.w / 2, obj.pos));
    } else if (t === 'item') {
      if (k === 'label') obj.label = v || undefined;
      else if (k === 'variant') obj.variant = v || undefined;
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

Object.defineProperties(App.prototype, Object.getOwnPropertyDescriptors(BuildingUI));
Object.defineProperties(App.prototype, Object.getOwnPropertyDescriptors(AskUI));
Object.defineProperties(App.prototype, Object.getOwnPropertyDescriptors(RenderUI));
window.house3d = new App();
