// 整棟規劃的介面：上方「整棟」分頁、樓層表（2D 區）、設定面板（右側）、一步一步問的精靈。
// 以 mixin 方式掛到 App 上（this＝App）。
import { clone, normalizePlan, polygonCentroid } from './model.js';
import { STYLES } from './styles.js';
import { SIDE_TYPES } from './site.js';
import {
  USES, ENTRY, HALL, RENT, ROOF_ROOM, FACADES, FACADE_WALLS, FACADE_COLORS, FRAMES, RAILS, ROOFS, GRILLES,
  defaultBuilding, normalizeBuilding, floorList, useOf, usesFor, makeFloorPlan, buildingChecks, floorSummary, homeSources,
} from './building.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 橫躺的平面縮圖：前面在左、後面在右（跟樓層表的「前／後」對齊）
function floorThumb(p) {
  if (!p) return '';
  const xs = [], ys = [];
  for (const w of p.walls) { xs.push(w.a.x, w.b.x); ys.push(w.a.y, w.b.y); }
  for (const r of p.rooms) for (const q of r.pts) { xs.push(q.x); ys.push(q.y); }
  if (!xs.length) return '';
  const x0 = Math.min(...xs) - 20, x1 = Math.max(...xs) + 20, y0 = Math.min(...ys) - 20, y1 = Math.max(...ys) + 20;
  const pt = (q) => q.map((v) => `${Math.round(v.x)},${Math.round(v.y)}`).join(' ');
  const COL = { living: '#e9d9bf', bedroom: '#efe3cd', hall: '#ece2d0', kitchen: '#dfe3e3', bath: '#d5e2e8', balcony: '#e6d3c6', stair: '#dcdad4', elevator: '#cfd3d6', storage: '#e2dfd8', void: '#b9c3c9', other: '#e8e4dc' };
  let s = `<svg viewBox="${-y1} ${x0} ${y1 - y0} ${x1 - x0}" class="bld-thumb" role="img" aria-label="${esc(p.name)} 平面"><g transform="rotate(90)">`;
  for (const r of p.rooms) s += `<polygon points="${pt(r.pts)}" fill="${COL[r.kind] || '#eee'}"/>`;
  for (const it of p.items) {
    if (!['scooter', 'bed', 'bed_single', 'sofa', 'table', 'altar', 'tatami'].includes(it.kind)) continue;
    const a = (it.rot || 0) * Math.PI / 180, c = Math.cos(a), sn = Math.sin(a);
    const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => ({ x: it.x + (u * it.w / 2) * c - (v * it.d / 2) * sn, y: it.y + (u * it.w / 2) * sn + (v * it.d / 2) * c }));
    s += `<polygon points="${pt(q)}" fill="${it.kind === 'scooter' ? '#c9a227' : '#fff'}" stroke="#8b9097" stroke-width="3"/>`;
  }
  for (const w of p.walls) s += `<line x1="${Math.round(w.a.x)}" y1="${Math.round(w.a.y)}" x2="${Math.round(w.b.x)}" y2="${Math.round(w.b.y)}" stroke="${w.kind === 'parapet' ? '#8a8f96' : '#2a2e33'}" stroke-width="${w.t}"/>`;
  for (const r of p.rooms) {
    if (['void', 'balcony', 'elevator'].includes(r.kind) || !r.name) continue;
    const c = polygonCentroid(r.pts);
    s += `<text transform="translate(${Math.round(c.x)} ${Math.round(c.y)}) rotate(-90)" font-size="46" text-anchor="middle" dominant-baseline="middle" fill="#1f2328" font-weight="700" paint-order="stroke" stroke="#fff" stroke-width="9">${esc(r.name.replace(/（.*）/, ''))}</text>`;
  }
  return s + '</g></svg>';
}

// 外觀色票的小立面
function facadeSwatch(f) {
  const wall = f.color;
  const frame = FRAMES[f.frame]?.[1] || '#222';
  const roof = f.roof === 'pitched' ? `<path d="M6 16 30 4l24 12z" fill="${f.wall === 'tile' ? '#7a3b2a' : '#3e4247'}"/>` : `<rect x="8" y="12" width="44" height="4" fill="${wall}" stroke="#0002"/>`;
  const grille = f.grille && f.grille !== 'none' ? Array.from({ length: 6 }, (_, i) => `<rect x="${36 + i * 3}" y="18" width="1.4" height="34" fill="${f.grille === 'alu' ? '#5a5e63' : '#9a6e45'}"/>`).join('') : '';
  const win = (x, y) => `<rect x="${x}" y="${y}" width="12" height="9" fill="#9fb5bf" stroke="${frame}" stroke-width="1.4"/>`;
  return `<svg viewBox="0 0 60 64" aria-hidden="true">${roof}<rect x="8" y="16" width="44" height="46" fill="${wall}" stroke="#0002"/>${win(14, 22)}${win(34, 22)}${win(14, 36)}${win(34, 36)}<rect x="14" y="50" width="32" height="12" fill="#6d7074"/>${grille}</svg>`;
}

// 一樓入口示意圖（從上面看）
function entryPic(k) {
  const scooter = (x, y, r = 0) => `<rect x="${x}" y="${y}" width="5" height="13" rx="2" fill="#c9a227" transform="rotate(${r} ${x + 2.5} ${y + 6.5})"/>`;
  const base = '<rect x="10" y="4" width="40" height="70" fill="var(--accent-soft)" stroke="var(--ink-2)" stroke-width="1.5"/><rect x="34" y="4" width="16" height="22" fill="var(--line)"/><text x="42" y="17" font-size="6" text-anchor="middle" fill="var(--ink-2)">梯</text>';
  if (k === 'side') return `<svg viewBox="0 0 60 84" aria-hidden="true">${base}<rect x="38" y="26" width="12" height="48" fill="var(--panel)" stroke="var(--ink-3)"/>${scooter(42, 36)}${scooter(42, 54)}<path d="M44 82 V30" stroke="var(--sel)" stroke-width="2" marker-end="url(#ah)"/><text x="30" y="82" font-size="7" text-anchor="middle" fill="var(--ink-2)">前</text><defs><marker id="ah" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 6 3 0 6z" fill="var(--sel)"/></marker></defs></svg>`;
  return `<svg viewBox="0 0 60 84" aria-hidden="true">${base}<rect x="10" y="4" width="24" height="26" fill="var(--panel)" stroke="var(--ink-3)"/>${scooter(13, 8, 90)}${scooter(13, 16, 90)}${scooter(13, 24, 90)}<path d="M28 1 V20" stroke="var(--sel)" stroke-width="2" marker-end="url(#ah2)"/><text x="30" y="82" font-size="7" text-anchor="middle" fill="var(--ink-2)">前</text><defs><marker id="ah2" viewBox="0 0 6 6" refX="3" refY="3" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0 6 3 0 6z" fill="var(--sel)"/></marker></defs></svg>`;
}

const COMBOS = [
  { k: 'rent-home', t: '1F 大空間｜2F 出租｜3F 和頂樓自住', uses: { '1F': 'shop', '2F': 'rent', '3F': 'home', RF: 'roof' }, n: 3, hasRoof: true },
  { k: 'home-home', t: '1F 大空間｜2F、3F 自住｜頂樓神明廳', uses: { '1F': 'shop', '2F': 'home', '3F': 'home', RF: 'roof' }, n: 3, hasRoof: true },
  { k: 'rent-rent', t: '1F 大空間｜2F、3F 出租｜頂樓自住', uses: { '1F': 'shop', '2F': 'rent', '3F': 'rent', RF: 'roof' }, n: 3, hasRoof: true },
];

export const BuildingUI = {
  // ---------- 資料 ----------
  get building() { return this.project.building || null; },

  floors() { return this.building ? floorList(this.building, this.site) : []; },

  floorPlan(fl) {
    const b = this.building;
    if (!b) return null;
    const id = b.plans[fl.id];
    return this.project.plans.find((p) => p.id === id) || null;
  },

  // 建立或補齊每一層的平面；被拿掉的樓層刪除其平面
  syncBuilding({ regen = [] } = {}) {
    const b = this.building;
    if (!b) return;
    this.site.floors = b.n;
    const floors = this.floors();
    const ids = new Set(floors.map((f) => f.id));
    for (const [fid, pid] of Object.entries(b.plans)) {
      if (ids.has(fid)) continue;
      this.project.plans = this.project.plans.filter((p) => p.id !== pid);
      delete b.plans[fid];
    }
    for (const fl of floors) {
      const p = this.floorPlan(fl);
      if (!p || regen.includes(fl.id) || regen === 'all') this.regenFloor(fl);
      else if (Math.abs((p.elevation || 0) - fl.elev) > 0.5) {
        if (useOf(b, fl) === 'home') { p.elevation = fl.elev; p.floorHeight = fl.h; }
        else this.regenFloor(fl);
      }
    }
    if (!this.project.plans.some((p) => p.id === this.project.active)) this.project.active = this.project.plans[0]?.id;
  },

  regenFloor(fl) {
    const b = this.building;
    const old = this.floorPlan(fl);
    // 自住層用「用講的改」重排過（__keep）：保留目前內容，只更新高程
    if (old && useOf(b, fl) === 'home' && b.home[fl.id] === '__keep' && old.floor === fl.id && !old.rooms.some((r) => /出租|套房|露台/.test(r.name || ''))) {
      old.elevation = fl.elev; old.floorHeight = fl.h;
      return;
    }
    const np = makeFloorPlan(b, fl, this.site, this.project);
    if (old) {
      const id = old.id;
      for (const k of Object.keys(old)) delete old[k];
      Object.assign(old, np, { id });
      this.history.delete(id);
    } else {
      // 樓層平面排在其他方案前面
      const firstOther = this.project.plans.findIndex((p) => !p.floor);
      if (firstOther < 0) this.project.plans.push(np); else this.project.plans.splice(firstOther, 0, np);
      b.plans[fl.id] = np.id;
    }
  },

  createBuilding(over = {}) {
    const b = normalizeBuilding({ ...defaultBuilding(), ...over });
    this.project.building = b;
    this.syncBuilding({ regen: 'all' });
    this.save();
    return b;
  },

  // 整棟的復原／重做
  bSnap() {
    const b = this.building;
    return JSON.stringify({ b, plans: this.project.plans.filter((p) => p.floor).map((p) => ({ ...p, underlay: null })), site: this.site });
  },
  bCommit(before) {
    this.bhist ||= { undo: [], redo: [] };
    if (before && before !== this.bSnap()) { this.bhist.undo.push(before); if (this.bhist.undo.length > 40) this.bhist.undo.shift(); this.bhist.redo = []; }
    this.save();
    this.renderTabs();
    this.renderBuilding();
    this.view.invalidate();
  },
  bRestore(s) {
    const d = JSON.parse(s);
    this.project.plans = this.project.plans.filter((p) => !p.floor);
    const firstOther = 0;
    this.project.plans.splice(firstOther, 0, ...d.plans.map(normalizePlan));
    this.project.building = d.b;
    Object.assign(this.site, d.site);
    for (const p of d.plans) this.history.delete(p.id);
    if (!this.project.plans.some((p) => p.id === this.project.active)) this.project.active = this.project.plans[0]?.id;
    this.save();
    this.renderTabs();
    this.renderBuilding();
    this.view.invalidate();
  },
  bUndo() {
    const h = this.bhist;
    if (!h?.undo.length) return this.toast('沒有可以復原的步驟');
    h.redo.push(this.bSnap());
    this.bRestore(h.undo.pop());
    this.toast('已復原');
  },
  bRedo() {
    const h = this.bhist;
    if (!h?.redo.length) return;
    h.undo.push(this.bSnap());
    this.bRestore(h.redo.pop());
  },

  // 改設定：fn 改 building，regen 指定要重排的樓層（'all' 或 id 陣列）
  bChange(fn, regen = []) {
    const before = this.bSnap();
    const b = this.building;
    const res = fn(b);
    let ids = regen;
    if (typeof regen === 'function') ids = regen(b, res);
    this.syncBuilding({ regen: ids });
    this.bCommit(before);
    return res;
  },

  floorsUsing(use) { return this.floors().filter((f) => useOf(this.building, f) === use).map((f) => f.id); },

  // ---------- 模式 ----------
  enterBuilding() {
    if (!this.building) return this.openBuildingWizard();
    if (this.editor.draft) this.editor.finishDraft();
    this.bmode = true;
    this.project.bmode = true;
    this.sel = null;
    this.applyBmode();
    this.view.first = true;
    this.view.invalidate();
    this.save();
  },

  applyBmode() {
    const on = !!(this.bmode && this.building);
    document.body.classList.toggle('bmode', on);
    $('#bldStack').hidden = !on;
    $('#pane2dTitle').textContent = on ? '整棟' : '平面';
    if (on) { this.setTool('select'); $('#catalog').hidden = true; }
    this.renderTabs();
    this.renderBuilding();
    if (!on) this.renderProps();
  },

  focusFloor(id) {
    const b = this.building;
    if (!b) return;
    const next = !id || b.focus === id ? 'all' : id;
    b.focus = next;
    this.save();
    this.view.first = true;
    this.view.invalidate();
    this.renderBuilding();
    const fl = this.floors().find((f) => f.id === next);
    if (fl) this.toast(`${fl.label}：剖開來看裡面（再點一次回到整棟外觀，點兩下打開平面）`, 3500);
  },

  openFloor(id) {
    const fl = this.floors().find((f) => f.id === id);
    const p = fl && this.floorPlan(fl);
    if (!p) return;
    this.switchPlan(p.id);
    if (matchMedia('(max-width: 900px)').matches) document.querySelector('#mobileSwitch [data-show="2d"]')?.click();
  },

  // ---------- 畫面 ----------
  renderBuilding() {
    const on = !!(this.bmode && this.building);
    const sel = $('#floorSel');
    if (sel && this.building) {
      const b = this.building;
      sel.innerHTML = `<option value="all">整棟外觀</option>` + this.floors().map((f) => `<option value="${f.id}"${b.focus === f.id ? ' selected' : ''}>剖開 ${f.label}</option>`).join('');
      sel.value = this.floors().some((f) => f.id === b.focus) ? b.focus : 'all';
    }
    if (!on) return;
    this.renderBldStack();
    this.renderBldPanel();
  },

  renderBldStack() {
    const b = this.building;
    const box = $('#bldStack');
    const floors = this.floors();
    const st = this.site;
    const sideName = (k) => SIDE_TYPES[st.sides[k].type]?.name.replace(/（.*）/, '') || '';
    const rows = floors.slice().reverse().map((fl) => {
      const p = this.floorPlan(fl);
      const use = useOf(b, fl);
      return `<li class="bld-fl${b.focus === fl.id ? ' on' : ''}" data-fl="${fl.id}">
        <div class="bld-lv"><b>${fl.label}</b><small>+${Math.round(fl.elev)}</small></div>
        <button class="bld-th" data-open="${fl.id}" title="打開 ${fl.label} 平面">${floorThumb(p)}</button>
        <div class="bld-info"><b>${USES[use].icon} ${esc((p?.name || '').replace(/^(\dF|頂樓)\s*/, ''))}</b><small>${esc(floorSummary(p))}</small>
          <div class="seg mini" data-use="${fl.id}" role="group" aria-label="${fl.label} 用途">${usesFor(fl).map((u) => `<button type="button" data-v="${u}" class="${u === use ? 'on' : ''}">${USES[u].name}</button>`).join('')}</div></div>
        <div class="bld-act"><button class="btn" data-open="${fl.id}">打開平面</button><button class="btn" data-focus="${fl.id}">${b.focus === fl.id ? '回到外觀' : '3D 剖開'}</button></div>
      </li>`;
    }).join('');
    box.innerHTML = `<div class="bld">
      <header class="bld-h"><div><h2>整棟 · ${b.n} 層${b.hasRoof ? '＋頂樓' : ''}</h2><p>每一層做什麼、外觀，都可以在這裡改；點縮圖打開那一層的平面圖繼續拖拉修改。</p></div>
        <button class="btn accent" data-b="wizard">一步一步問我</button></header>
      <ol class="bld-floors">${rows}</ol>
      <div class="bld-ground"><span>◀ 前面：${esc(sideName('front'))}</span><span>後面：${esc(sideName('back'))} ▶</span></div>
    </div>`;
    box.querySelectorAll('[data-open]').forEach((el) => el.addEventListener('click', () => this.openFloor(el.dataset.open)));
    box.querySelectorAll('[data-focus]').forEach((el) => el.addEventListener('click', () => this.focusFloor(el.dataset.focus)));
    box.querySelector('[data-b=wizard]').onclick = () => this.openBuildingWizard();
    box.querySelectorAll('[data-use]').forEach((g) => g.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => this.setFloorUse(g.dataset.use, btn.dataset.v))));
  },

  setFloorUse(fid, use) {
    const b = this.building;
    if (b.uses[fid] === use) return;
    this.bChange((bb) => { bb.uses[fid] = use; }, [fid]);
    const fl = this.floors().find((f) => f.id === fid);
    this.toast(`${fl?.label || fid} 改成「${USES[use].name}」，已重新排好（可以按復原）`, 3500);
  },

  renderBldPanel() {
    const b = this.building;
    const el = $('#props');
    const floors = this.floors();
    const has = (u) => floors.some((f) => useOf(b, f) === u);
    const seg = (path, opts, val) => `<div class="seg mini" data-bseg="${path}">${opts.map(([v, t]) => `<button type="button" data-v="${v}" class="${String(v) === String(val) ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>`;
    const row = (label, inner) => `<div class="row-l"><span>${label}</span>${inner}</div>`;
    const styleSel = (path, val) => `<select class="bsel" data-bsel="${path}">${Object.entries(STYLES).filter(([k]) => k !== 'basic').map(([k, v]) => `<option value="${k}"${k === val ? ' selected' : ''}>${esc(v.name)}</option>`).join('')}</select>`;
    const step = (path, val, min, max, unit) => `<div class="stepper"><button type="button" data-bstep="${path}" data-d="-1" data-min="${min}" data-max="${max}" aria-label="減少">−</button><output>${val}</output><button type="button" data-bstep="${path}" data-d="1" data-min="${min}" data-max="${max}" aria-label="增加">＋</button><span>${unit}</span></div>`;
    let h = `<div class="sec quick simple-only"><h3>整棟</h3><p class="note">左邊（手機在「平面」）是每一層，右邊是 3D。改了設定，那幾層會自動重新排；改壞了按「復原」。</p>
      <div class="quick-btns"><button class="btn" data-b="wizard">🧭 一步一步問我</button><button class="btn" data-b="ask">💬 用講的改</button></div></div>`;
    h += `<div class="sec"><h3>樓層</h3>
      ${row('蓋幾層', step('n', b.n, 1, 5, '層'))}
      <div class="checks"><label><input type="checkbox" data-bchk="hasRoof"${b.hasRoof ? ' checked' : ''}> 頂樓有屋突、房間和露台</label></div>
      <div class="presets">${COMBOS.map((c) => `<button type="button" class="preset" data-combo="${c.k}"><b>${esc(c.t)}</b></button>`).join('')}</div></div>`;
    h += `<div class="sec"><h3>每一層做什麼</h3>${floors.slice().reverse().map((f) => row(f.label, seg(`uses.${f.id}`, usesFor(f).map((u) => [u, USES[u].name]), useOf(b, f)))).join('')}</div>`;
    if (has('shop')) {
      const max = b.shop.entry === 'side' ? 4 : 7;
      h += `<div class="sec"><h3>一樓</h3>
        <div class="pic-grid two">${Object.entries(ENTRY).map(([k, v]) => `<button type="button" class="pic-opt${b.shop.entry === k ? ' on' : ''}" data-bpick="shop.entry" data-v="${k}">${entryPic(k)}<b>${esc(v.name)}</b><small>${esc(v.desc)}</small></button>`).join('')}</div>
        ${row('機車', step('shop.scooters', b.shop.scooters, 0, max, `台（最多 ${max}）`))}
        ${row('大空間', seg('shop.hall', Object.entries(HALL).map(([k, v]) => [k, v.name]), b.shop.hall))}
        <div class="checks"><label><input type="checkbox" data-bchk="shop.toilet"${b.shop.toilet !== false ? ' checked' : ''}> 一樓有廁所</label></div>
        ${row('風格', styleSel('shop.style', b.shop.style))}</div>`;
    }
    if (has('rent')) {
      h += `<div class="sec"><h3>出租</h3>${row('間數', seg('rent.rooms', Object.entries(RENT).map(([k, v]) => [k, v.name]), b.rent.rooms))}
        <p class="note">${esc(RENT[b.rent.rooms]?.desc || '')}。這一層能開窗的地方只有後面一間、前面兩間，所以最多 3 間有窗的套房。</p>
        ${row('風格', styleSel('rent.style', b.rent.style))}</div>`;
    }
    if (has('home')) {
      const src = homeSources(this.project);
      h += `<div class="sec"><h3>自住</h3>${floors.filter((f) => useOf(b, f) === 'home').map((f) => row(f.label, `<select class="bsel" data-bsel="home.${f.id}">${b.home[f.id] === '__keep' ? '<option value="__keep" selected>目前這份（改過的）</option>' : ''}${src.map((x) => `<option value="${esc(x.id)}"${x.id === (b.home[f.id] || 'd') ? ' selected' : ''}>${esc(x.name)}</option>`).join('')}</select>`)).join('')}
        <p class="note">用上方「自動規劃」產生的方案，也會出現在這個清單。選好後打開那一層，可以再拖拉修改。</p></div>`;
    }
    if (has('roof')) {
      h += `<div class="sec"><h3>頂樓</h3>${row('房間', seg('roof.rooms', [[0, '只要儲藏'], [1, '1 間'], [2, '2 間']], b.roof.rooms))}
        ${b.roof.rooms >= 1 ? row('後面', seg('roof.back', ['tatami', 'bedroom', 'study', 'storage'].map((k) => [k, ROOF_ROOM[k].name]), b.roof.back)) : ''}
        ${b.roof.rooms >= 2 ? row('前面', seg('roof.front', ['altar', 'family', 'tatami'].map((k) => [k, ROOF_ROOM[k].name]), b.roof.front)) : ''}
        ${row('風格', styleSel('roof.style', b.roof.style))}</div>`;
    }
    const f = b.facade;
    h += `<div class="sec"><h3>外觀</h3>
      <div class="facade-sw">${Object.entries(FACADES).map(([k, v]) => `<button type="button" class="fsw${f.preset === k ? ' on' : ''}" data-fac="${k}">${facadeSwatch(v)}<span>${esc(v.name)}</span></button>`).join('')}</div>
      <details class="gen-more"${this.ui.simple ? '' : ' open'}><summary>細節</summary>
        ${row('外牆', seg('facade.wall', Object.entries(FACADE_WALLS).map(([k, v]) => [k, v.name]), f.wall))}
        ${row('顏色', `<div class="colors">${FACADE_COLORS.map(([c, n]) => `<button type="button" class="cdot${f.color === c ? ' on' : ''}" data-color="${c}" title="${n}" aria-label="${n}" style="background:${c}"></button>`).join('')}</div>`)}
        ${row('窗框', seg('facade.frame', Object.entries(FRAMES).map(([k, v]) => [k, v[0]]), f.frame))}
        ${row('欄杆', seg('facade.rail', Object.entries(RAILS), f.rail))}
        ${row('屋頂', seg('facade.roof', Object.entries(ROOFS), f.roof))}
        ${row('格柵', seg('facade.grille', Object.entries(GRILLES), f.grille))}
        <div class="checks"><label><input type="checkbox" data-bchk="facade.awning"${f.awning ? ' checked' : ''}> 窗戶加雨遮</label></div>
      </details></div>`;
    const checks = buildingChecks(b, floors, (fl) => this.floorPlan(fl), this.site);
    h += `<div class="sec"><h3>法規提醒</h3><div class="dl-table">${checks.map((c) => `<div class="dl-row chk-${c.lvl}"><b>${c.lvl === 'ok' ? '✅' : '⚠️'} ${esc(c.t)}</b><span></span><div class="meta">${esc(c.d)}</div></div>`).join('')}</div>
      <p class="note">這是規劃階段的提醒，實際要以建築師和當地建管單位的審查為準。</p></div>`;
    el.innerHTML = h;
    this.bindBldPanel(el);
  },

  bindBldPanel(el) {
    const setPath = (b, path, v) => { const ks = path.split('.'); let o = b; for (const k of ks.slice(0, -1)) o = o[k] ||= {}; o[ks[ks.length - 1]] = v; };
    const regenFor = (path) => {
      const [a, k] = path.split('.');
      if (a === 'uses') return [k];
      if (a === 'home') return [k];
      if (a === 'shop') return this.floorsUsing('shop');
      if (a === 'rent') return this.floorsUsing('rent');
      if (a === 'roof') return this.floorsUsing('roof');
      if (a === 'n' || a === 'hasRoof') return 'all';
      return [];
    };
    const apply = (path, v) => {
      if (path.startsWith('facade.')) {
        this.bChange((b) => { setPath(b, path, v); b.facade.preset = null; });
        return;
      }
      this.bChange((b) => setPath(b, path, v), (b) => (path === 'n' || path === 'hasRoof' ? 'all' : regenFor(path)));
    };
    el.querySelectorAll('[data-bseg]').forEach((g) => g.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
      const path = g.dataset.bseg;
      let v = btn.dataset.v;
      if (/rooms$/.test(path)) v = +v;
      if (path.startsWith('uses.')) return this.setFloorUse(path.slice(5), v);
      apply(path, v);
    })));
    el.querySelectorAll('[data-bpick]').forEach((btn) => btn.addEventListener('click', () => {
      const path = btn.dataset.bpick;
      apply(path, btn.dataset.v);
      if (path === 'shop.entry') { const max = btn.dataset.v === 'side' ? 4 : 7; if (this.building.shop.scooters > max) this.bChange((b) => { b.shop.scooters = max; }, this.floorsUsing('shop')); }
    }));
    el.querySelectorAll('[data-bstep]').forEach((btn) => btn.addEventListener('click', () => {
      const path = btn.dataset.bstep;
      const cur = path.split('.').reduce((o, k) => o?.[k], this.building);
      const v = Math.max(+btn.dataset.min, Math.min(+btn.dataset.max, (cur || 0) + +btn.dataset.d));
      if (v === cur) return;
      apply(path, v);
    }));
    el.querySelectorAll('[data-bchk]').forEach((inp) => inp.addEventListener('change', () => apply(inp.dataset.bchk, inp.checked)));
    el.querySelectorAll('[data-bsel]').forEach((s) => s.addEventListener('change', () => apply(s.dataset.bsel, s.value)));
    el.querySelectorAll('[data-combo]').forEach((btn) => btn.addEventListener('click', () => {
      const c = COMBOS.find((x) => x.k === btn.dataset.combo);
      this.bChange((b) => { b.n = c.n; b.hasRoof = c.hasRoof; b.uses = { ...b.uses, ...c.uses }; }, 'all');
      this.toast(`已套用：${c.t}`);
    }));
    el.querySelectorAll('[data-fac]').forEach((btn) => btn.addEventListener('click', () => {
      const k = btn.dataset.fac;
      this.bChange((b) => { b.facade = { preset: k, ...FACADES[k] }; });
      this.toast(`外觀：${FACADES[k].name}`);
    }));
    el.querySelectorAll('[data-color]').forEach((btn) => btn.addEventListener('click', () => apply('facade.color', btn.dataset.color)));
    el.querySelectorAll('[data-b]').forEach((btn) => btn.addEventListener('click', () => {
      if (btn.dataset.b === 'wizard') this.openBuildingWizard();
      if (btn.dataset.b === 'ask') this.openAsk?.();
    }));
  },

  // ---------- 一步一步問 ----------
  openBuildingWizard() {
    const fresh = !this.building;
    const b = fresh ? normalizeBuilding(defaultBuilding()) : clone(this.building);
    const steps = ['floors', 'uses', 'entry', 'scooter', 'hall', 'rent', 'roof', 'facade', 'done'];
    const active = () => steps.filter((k) => {
      const fls = floorList(b, this.site);
      const has = (u) => fls.some((f) => useOf(b, f) === u);
      if (['entry', 'scooter', 'hall'].includes(k)) return has('shop');
      if (k === 'rent') return has('rent');
      if (k === 'roof') return has('roof');
      return true;
    });
    let i = 0;
    const big = (attr, v, on, label, sub = '') => `<button type="button" class="big-opt${on ? ' on' : ''}" data-${attr}="${v}">${label}${sub ? `<small>${sub}</small>` : ''}</button>`;
    this.modal('<div class="wiz" id="bwiz"></div>', (card, close) => {
      card.classList.add('wide');
      const box = card.querySelector('#bwiz');
      const render = () => {
        const list = active();
        if (i >= list.length) i = list.length - 1;
        const key = list[i];
        const fls = floorList(b, this.site);
        let body = '';
        if (key === 'floors') {
          body = `<h2>房子要蓋幾層？</h2><p>一樓算第一層。頂樓的屋突（樓梯電梯升上屋頂的部分）和房間另外問。</p>
            <div class="big-grid">${[2, 3, 4, 5].map((n) => big('n', n, b.n === n, `${n} 層`)).join('')}</div>
            <h2 class="sub">頂樓要不要做房間和露台？</h2>
            <div class="big-grid two">${big('roof', 1, b.hasRoof, '要，頂樓有房間', '神明廳、和室、曬衣露台')}${big('roof', 0, !b.hasRoof, '不用，平屋頂就好')}</div>`;
        } else if (key === 'uses') {
          body = `<h2>每一層要做什麼？</h2><p>先挑一個最接近的，下面可以再一層一層改。</p>
            <div class="pic-grid">${COMBOS.map((c) => `<button type="button" class="pic-opt${JSON.stringify(Object.fromEntries(fls.map((f) => [f.id, useOf(b, f)]))) === JSON.stringify(Object.fromEntries(fls.map((f) => [f.id, useOf({ ...b, uses: c.uses }, f)]))) ? ' on' : ''}" data-combo="${c.k}"><b>${esc(c.t)}</b></button>`).join('')}</div>
            <div class="wiz-floors">${fls.slice().reverse().map((f) => `<div class="row-l"><span>${f.label}</span><div class="seg mini">${usesFor(f).map((u) => `<button type="button" data-fuse="${f.id}" data-v="${u}" class="${useOf(b, f) === u ? 'on' : ''}">${USES[u].icon} ${USES[u].name}</button>`).join('')}</div></div>`).join('')}</div>`;
        } else if (key === 'entry') {
          body = `<h2>樓梯和電梯要從哪裡進出？</h2><p>這樣樓上的人（房客、家人）上下樓都<b class="hl">不用經過一樓大空間</b>，電梯在一樓也可以直接從外面搭。</p>
            <div class="pic-grid two">${Object.entries(ENTRY).map(([k, v]) => `<button type="button" class="pic-opt big-pic${b.shop.entry === k ? ' on' : ''}" data-entry="${k}">${entryPic(k)}<b>${esc(v.name)}</b><small>${esc(v.desc)}</small></button>`).join('')}</div>`;
        } else if (key === 'scooter') {
          const max = b.shop.entry === 'side' ? 4 : 7;
          body = `<h2>機車要停幾台？</h2><p>${b.shop.entry === 'side' ? '停在右側通道旁，最多 4 台。' : '從後巷騎進來，停在一樓後段靠左牆，最多 7 台。'}</p>
            <div class="ask">${this.bigStepper('sc', Math.min(b.shop.scooters, max), 0, max, '台')}</div>`;
        } else if (key === 'hall') {
          body = `<h2>一樓的大空間要做什麼？</h2>
            <div class="big-grid two">${Object.entries(HALL).map(([k, v]) => big('hall', k, b.shop.hall === k, v.name, v.desc)).join('')}</div>`;
        } else if (key === 'rent') {
          body = `<h2>出租的樓層要隔幾間？</h2><p>每一間都要有對外窗。這一層能開窗的地方只有後面一間、前面兩間，所以最多 3 間有窗的套房。</p>
            <div class="big-grid two">${Object.entries(RENT).map(([k, v]) => big('rent', k, +b.rent.rooms === +k, v.name, v.desc)).join('')}</div>
            <p class="note">提醒：住宅同一層隔 6 間以上（或 10 張床以上）會被當成「供公眾使用」，要申請室內裝修審查；整棟同一個所有人時可能各層加總。</p>`;
        } else if (key === 'roof') {
          body = `<h2>頂樓要放什麼？</h2>
            <div class="big-grid three">${[[0, '只要儲藏', '其他都是露台'], [1, '1 間房', '後面一間＋露台'], [2, '2 間房', '前面一間、後面一間＋露台']].map(([v, t, s]) => big('rr', v, +b.roof.rooms === v, t, s)).join('')}</div>
            ${b.roof.rooms >= 1 ? `<h2 class="sub">後面那間做什麼？</h2><div class="big-grid">${['tatami', 'bedroom', 'study', 'storage'].map((k) => big('rback', k, b.roof.back === k, ROOF_ROOM[k].name)).join('')}</div>` : ''}
            ${b.roof.rooms >= 2 ? `<h2 class="sub">前面那間（面對露台）做什麼？</h2><div class="big-grid">${['altar', 'family', 'tatami'].map((k) => big('rfront', k, b.roof.front === k, ROOF_ROOM[k].name)).join('')}</div>` : ''}
            <p class="note">提醒：屋突只能放樓梯、電梯、水塔；頂樓的房間要在建照裡申請成一層樓，不然是違建。</p>`;
        } else if (key === 'facade') {
          body = `<h2>外觀想要什麼感覺？</h2><p>之後可以在右側「外觀」調整外牆材質、顏色、窗框、欄杆和屋頂。</p>
            <div class="facade-sw big">${Object.entries(FACADES).map(([k, v]) => `<button type="button" class="fsw${b.facade.preset === k ? ' on' : ''}" data-fac="${k}">${facadeSwatch(v)}<span>${esc(v.name)}</span></button>`).join('')}</div>`;
        } else {
          const lines = fls.slice().reverse().map((f) => `<li><b>${f.label}</b>：${USES[useOf(b, f)].icon} ${USES[useOf(b, f)].name}${useOf(b, f) === 'shop' ? `（${ENTRY[b.shop.entry].name}，機車 ${b.shop.scooters} 台，${HALL[b.shop.hall].name}）` : useOf(b, f) === 'rent' ? `（${RENT[b.rent.rooms]?.name}）` : useOf(b, f) === 'roof' ? `（${b.roof.rooms ? `${b.roof.rooms} 間房` : '儲藏'}＋露台）` : ''}</li>`).join('');
          body = `<h2>好了！</h2><p>按「完成」就會把每一層排好，接著可以看整棟 3D、打開任何一層拖拉修改。</p><ul class="done-list">${lines}</ul><p class="note">外觀：${esc(FACADES[b.facade.preset]?.name || '自訂')}</p>`;
        }
        box.innerHTML = `<div class="wiz-top"><div class="dots">${list.map((_, k) => `<i class="${k === i ? 'on' : k < i ? 'past' : ''}"></i>`).join('')}</div><button class="linkish" data-x="close">關閉</button></div>
          <div class="wiz-body">${body}</div>
          <div class="wiz-nav"><button class="btn" data-x="prev"${i === 0 ? ' disabled' : ''}>上一步</button><span class="note">${i + 1} / ${list.length}</span><button class="btn primary big" data-x="next">${i === list.length - 1 ? '完成' : '下一題'}</button></div>`;
        bind(key);
      };
      const bind = (key) => {
        const q = (s) => box.querySelectorAll(s);
        box.querySelector('[data-x=close]').onclick = () => close();
        box.querySelector('[data-x=prev]').onclick = () => { i = Math.max(0, i - 1); render(); };
        box.querySelector('[data-x=next]').onclick = () => {
          if (i < active().length - 1) { i++; render(); return; }
          close();
          this.finishBuildingWizard(b, fresh);
        };
        q('[data-n]').forEach((x) => x.onclick = () => { b.n = +x.dataset.n; render(); });
        q('[data-roof]').forEach((x) => x.onclick = () => { b.hasRoof = x.dataset.roof === '1'; render(); });
        q('[data-combo]').forEach((x) => x.onclick = () => { const c = COMBOS.find((y) => y.k === x.dataset.combo); b.uses = { ...b.uses, ...c.uses }; render(); });
        q('[data-fuse]').forEach((x) => x.onclick = () => { b.uses[x.dataset.fuse] = x.dataset.v; render(); });
        q('[data-entry]').forEach((x) => x.onclick = () => { b.shop.entry = x.dataset.entry; b.shop.scooters = Math.min(b.shop.scooters, x.dataset.entry === 'side' ? 4 : 7); render(); });
        this.bindBigStepper(box, 'sc', (v) => { b.shop.scooters = v; });
        q('[data-hall]').forEach((x) => x.onclick = () => { b.shop.hall = x.dataset.hall; render(); });
        q('[data-rent]').forEach((x) => x.onclick = () => { b.rent.rooms = +x.dataset.rent; render(); });
        q('[data-rr]').forEach((x) => x.onclick = () => { b.roof.rooms = +x.dataset.rr; render(); });
        q('[data-rback]').forEach((x) => x.onclick = () => { b.roof.back = x.dataset.rback; render(); });
        q('[data-rfront]').forEach((x) => x.onclick = () => { b.roof.front = x.dataset.rfront; render(); });
        q('[data-fac]').forEach((x) => x.onclick = () => { b.facade = { preset: x.dataset.fac, ...FACADES[x.dataset.fac] }; render(); });
        void key;
      };
      render();
    });
  },

  finishBuildingWizard(b, fresh) {
    const before = fresh ? null : this.bSnap();
    if (fresh) this.project.building = normalizeBuilding(b);
    else Object.assign(this.project.building, normalizeBuilding(b));
    this.syncBuilding({ regen: 'all' });
    if (before) this.bCommit(before); else this.save();
    this.bmode = false;
    this.enterBuilding();
    if (matchMedia('(max-width: 900px)').matches) document.querySelector('#mobileSwitch [data-show="3d"]')?.click();
    this.toast('整棟排好了：左邊是每一層，右邊是 3D 外觀。點一層可以剖開來看，點兩下打開平面。', 6000);
  },
};
