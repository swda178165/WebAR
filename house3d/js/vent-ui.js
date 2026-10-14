// 通風的介面：右側「通風」分頁（單層：每個房間；整棟：剖面圖＋各層）、平面上的風路徑開關、設定。
// 以 mixin 方式掛到 App 上（this＝App）。
import {
  analyzeVent, ventOf, windFrom, cityWind, windSide, achGrade, achColor, VENT_LEGEND, TYPE_NAMES, SEASONS, TERRAINS, WINDOW_TYPES,
  DOOR_MODES, ventSummary, fmtAch, CO2, legalShort,
} from './vent.js';
import { DIRS, dirName, CITIES, LW_TOPS, LW_WALLS, floorLabel, buildingTop } from './site.js';
import { useOf, USES } from './building.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r50 = (x) => Math.round(x / 50) * 50;
const opt = (list, val) => list.map(([v, t]) => `<option value="${esc(v)}"${String(v) === String(val ?? '') ? ' selected' : ''}>${esc(t)}</option>`).join('');

export const VentUI = {
  // ---------- 計算 ----------
  scheduleVent(now = false) {
    const need = this.vent.show || this.sideTab === 'vent';
    if (!need) { this.vent.result = null; this.vent.floors = null; return; }
    clearTimeout(this._vT);
    const run = () => {
      this.deriveShafts?.();
      try {
        if (this.bmode && this.building) {
          this.vent.floors = this.floors().map((fl) => {
            const p = this.floorPlan(fl);
            if (!p) return null;
            const r = analyzeVent(p, this.site);
            return { fl, p, r, s: ventSummary(r) };
          }).filter(Boolean);
        } else {
          this.vent.result = analyzeVent(this.plan, this.site);
          this.vent.planId = this.plan.id;
        }
      } catch (e) { console.error(e); this.vent.result = null; this.vent.floors = null; }
      if (this.vent.show) { this.editor.render(); this.view.invalidate(); }
      if (this.sideTab === 'vent') this.renderVentPanel();
    };
    if (now) run(); else this._vT = setTimeout(run, 180);
  },

  setVent(on) {
    this.vent.show = on;
    $('#toggleVent')?.classList.toggle('on', on);
    if (on && this.daylight?.show) this.setDaylight(false);
    if (on) {
      this.scheduleVent(true);
      if (this.bmode) this.setSideTab('vent');
      else this.toast('藍色是風進來、橘色是風出去，虛線會動的是風在屋裡走的路線；房間顏色越深越通風', 5000);
    } else { this.editor.render(); this.view.invalidate(); }
    if (this.sideTab === 'vent') this.renderVentPanel();
  },

  // ---------- 面板 ----------
  renderVentPanel() {
    const el = $('#ventPanel');
    if (!el || el.hidden) return;
    const v = ventOf(this.site);
    let h = this.bmode && this.building ? this.ventBuildingHtml(v) : this.ventPlanHtml(v);
    h += this.ventSettingsHtml(v);
    h += `<p class="note">怎麼算的：外面的風依氣象站風速換算到屋頂高度，配合低層建築的風壓係數；天井、樓梯間以「比室外熱 1～1.5°C」估算煙囪效應；房間之間的門、開口連成網路一起解出每條路的風量，只有一面開窗的房間另用 BS 5925 的單面通風公式。法規依建築技術規則設計施工編第 43 條（居室、浴廁有效通風 ≥ 樓地板 5%，廚房 ≥ 1/10 且 ≥ 0.8㎡，不足要裝機械通風）、建築設備編第 102 條（機械通風量：臥室起居 8、住宅浴廁 20、非營業廚房 35 m³/h·㎡），二氧化碳以室內空氣品質標準 1000 ppm 為上限。這是規劃階段比較用的估算，正式設計請由建築師、空調技師檢討。</p>`;
    el.innerHTML = h;
  },

  windBadge(v) {
    const st = this.site;
    const deg = windFrom(st, v);
    const auto = v.wind == null;
    // 小平面圖：前面在下（跟平面圖一樣），箭頭是風前進的方向
    const a = ((deg - st.front + 180) * Math.PI) / 180;
    const t = { x: -Math.sin(a), y: Math.cos(a) };
    const x1 = 50 - t.x * 40, y1 = 50 - t.y * 40, x2 = 50 - t.x * 14, y2 = 50 - t.y * 14;
    const side = { front: '從前面吹進來', back: '從後面吹進來', side: '沿著街道、從側面吹過' }[windSide(st, v)];
    return `<div class="vent-wind"><svg viewBox="0 0 100 100" aria-hidden="true"><rect x="38" y="22" width="24" height="56" rx="2" fill="var(--accent-soft)" stroke="var(--ink-3)"/><text x="50" y="74" font-size="9" text-anchor="middle" fill="var(--ink-2)">前</text>
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#1f6fb2" stroke-width="5" stroke-linecap="round" marker-end="url(#vwArr)"/>
      <defs><marker id="vwArr" viewBox="0 0 6 6" refX="2" refY="3" markerWidth="3" markerHeight="3" orient="auto"><path d="M0 0 6 3 0 6z" fill="#1f6fb2"/></marker></defs></svg>
      <div><b>${SEASONS[v.season]}・${dirName(deg)}風 ${v.speed} m/s</b><small>${auto ? `${esc(CITIES[st.city]?.[0] || '')}${SEASONS[v.season]}常見的風向（概略）` : '自訂風向'}，${side}</small></div></div>`;
  },

  ventPlanHtml(v) {
    const p = this.plan;
    const r = this.vent.result && this.vent.planId === p.id ? this.vent.result : null;
    let h = `<div class="sec"><h3>通風模擬 <span class="kind-chip">${esc(p.name)} · ${floorLabel(this.site, p.elevation || 0)}</span></h3>
      <p class="note">${SEASONS[v.season]}把窗戶打開時，外面的風和天井、樓梯間的「煙囪效應」讓空氣怎麼走。數字是<b>每小時換氣次數</b>：房間裡的空氣一小時換掉幾次。</p>
      <div class="row"><button class="btn toggle${this.vent.show ? ' on' : ''}" data-va="overlay">平面顯示風的路徑</button><button class="btn" data-va="season">${v.season === 'summer' ? '改看冬天' : '改看夏天'}</button><button class="btn" data-va="doors">${v.doors === 'closed' ? '房門打開看看' : '房門關上看看'}</button></div>
      ${this.windBadge(v)}`;
    if (!r) return h + '<p class="note">計算中…</p></div>';
    const hab = r.rooms.filter((x) => ['living', 'bedroom', 'kitchen'].includes(x.kind));
    const cross = hab.filter((x) => x.type === 'cross').length;
    const co2 = Math.max(0, ...r.rooms.filter((x) => x.iaq).map((x) => x.iaq.co2));
    const bad = legalShort(r.rooms, v);
    const [g] = achGrade(r.avgAch);
    h += `<div class="stat"><div><b>${fmtAch(r.avgAch)}</b><small>居室平均換氣（次／小時・${g}）</small></div><div><b>${cross} / ${hab.length}</b><small>有穿堂風（對流）的居室</small></div>
      ${co2 ? `<div><b>${r50(co2)}</b><small>冷氣房關窗睡一夜，臥室 CO₂ 最高（ppm，上限 1000）</small></div>` : ''}
      <div><b>${bad ? `${bad} 處不足` : '符合'}</b><small>第 43 條有效通風面積（開放式客餐廳算一處）</small></div></div>
      <div class="dl-legend">${VENT_LEGEND.map((x) => `<span style="background:${achColor(x)}"></span>`).join('')}</div>
      <div class="dl-legend-l"><span>不通風</span><span>0.5</span><span>3</span><span>10</span><span>很通風</span></div>
      <div class="dl-table">${r.rooms.filter((x) => !['storage'].includes(x.kind) || x.type === 'none').map((x) => this.ventRowHtml(x, v)).join('')}</div></div>`;
    if (r.tips.length) h += `<div class="sec"><h3>建議</h3><ul class="vent-tips">${r.tips.map((t) => `<li>${esc(t.t)}</li>`).join('')}</ul></div>`;
    return h;
  },

  ventRowHtml(x, v) {
    const [gg, lv] = achGrade(x.ach);
    const notes = [];
    const path = x.ins.length || x.outs.length ? `${x.ins.slice(0, 2).map((i) => i.label).join('、') || '—'} → ${x.outs.slice(0, 2).map((i) => i.label).join('、') || '—'}` : '';
    if (x.legal) {
      const pct = (x.legal.ratio * 100).toFixed(1), need = (x.legal.rule.ratio * 100).toFixed(0);
      const grp = x.legal.with?.length ? `（和${x.legal.with.join('、')}合併算）` : '';
      if (x.legal.ok) notes.push({ lv: 'good', t: `可開窗面積 ${pct}%${grp}，符合第 43 條（≥ ${need}%）` });
      else if (x.kind === 'bath' && v.bathFan) notes.push({ lv: 'info', t: `可開窗面積 ${pct}%，不到 ${need}%：裝排風機 ${x.legal.mech} m³/h 以上就符合` });
      else if (x.kind === 'kitchen') notes.push({ lv: 'warn', t: `可開窗面積 ${pct}%${grp}，廚房要 ≥ 10% 且 ≥ 0.8㎡：加大窗戶，或裝排油煙機＋排風 ${x.legal.mech} m³/h` });
      else notes.push({ lv: 'bad', t: `可開窗面積 ${pct}%${grp}，不到 ${need}%：加大窗戶，或裝機械通風 ${x.legal.mech} m³/h 以上` });
    }
    if (x.type === 'single' && ['living', 'bedroom'].includes(x.kind) && x.depth > 2.5 * x.ceil) notes.push({ lv: 'warn', t: `只有一面開窗，房間深 ${x.depth.toFixed(1)} m，超過天花高的 2.5 倍，裡面的角落吹不到風` });
    if (x.iaq) {
      const c = r50(x.iaq.co2);
      if (v.erv) notes.push({ lv: c <= CO2.limit ? 'good' : 'warn', t: `冷氣房關窗睡 ${x.iaq.people} 人，全熱交換器送 ${x.iaq.erv} m³/h，早上 CO₂ 約 ${c} ppm` });
      else notes.push({ lv: c <= CO2.limit ? 'good' : 'warn', t: `冷氣房關窗睡 ${x.iaq.people} 人，早上 CO₂ 約 ${c} ppm；要保持 1000 以下，每小時需要約 ${x.iaq.need} m³ 新鮮空氣` });
    }
    if (x.type === 'none' && ['living', 'bedroom'].includes(x.kind)) notes.push({ lv: 'bad', t: '沒有對外窗，也沒有風從別的房間經過' });
    const order = { bad: 0, warn: 1, info: 2, good: 3 };
    notes.sort((a, b) => order[a.lv] - order[b.lv]);
    return `<div class="dl-row" data-vroom="${x.id}"><b>${esc(x.name || '房間')}</b><span class="df-badge" style="background:${achColor(x.ach)}${lv >= 3 ? ';color:#fff' : ''}">${fmtAch(x.ach)} 次 ${gg}</span>
      <div class="meta">${TYPE_NAMES[x.type]}${path ? `・${esc(path)}` : ''}${x.fan ? `・排風機 ${Math.round(x.fan)} m³/h` : ''}</div>
      ${notes.length ? `<ul>${notes.map((n) => `<li class="${n.lv}">${esc(n.t)}</li>`).join('')}</ul>` : ''}</div>`;
  },

  ventBuildingHtml(v) {
    const fs = this.vent.floors;
    let h = `<div class="sec"><h3>整棟通風</h3>
      <p class="note">下面是房子的剖面（左邊是前面）。外面的風從窗戶進來，天井和樓梯間像煙囪，熱空氣往上排、把各層的空氣帶走。箭頭旁的數字是每小時往上排的風量（m³）。點一層可以打開看每個房間。</p>
      <div class="row"><button class="btn" data-va="season">${v.season === 'summer' ? '改看冬天' : '改看夏天'}</button><button class="btn" data-va="doors">${v.doors === 'closed' ? '房門打開看看' : '房門關上看看'}</button></div>
      ${this.windBadge(v)}`;
    if (!fs) return h + '<p class="note">計算中…</p></div>';
    h += this.ventSectionSvg(fs, v);
    h += `<div class="dl-table">${fs.slice().reverse().map(({ fl, p, s }) => {
      const [g, lv] = achGrade(s.avgAch);
      const use = useOf(this.building, fl);
      return `<div class="dl-row" data-vfl="${fl.id}"><b>${fl.label} ${USES[use]?.icon || ''} ${esc((p.name || '').replace(/^(\dF|頂樓)\s*/, ''))}</b><span class="df-badge" style="background:${achColor(s.avgAch)}${lv >= 3 ? ';color:#fff' : ''}">${fmtAch(s.avgAch)} 次 ${g}</span>
        <div class="meta">有對流 ${s.cross}/${s.hab} 間${s.co2 ? `・冷氣房一夜臥室 CO₂ ≈ ${r50(s.co2)} ppm` : ''}・${s.legalBad ? `${s.legalBad} 處通風面積不足` : '通風面積符合第 43 條'}</div></div>`;
    }).join('')}</div></div>`;
    // 建議：各層合併，同一類只講一次
    const seen = new Set(), tips = [];
    for (const { fl, r } of fs) for (const t of r.tips) {
      const perFloor = ['single', 'door', 'bath', 'erv'].includes(t.k);
      const key = perFloor ? `${t.k}:${fl.id}` : t.k;
      if (seen.has(key)) continue;
      seen.add(key);
      tips.push(perFloor ? `${fl.label}：${t.t}` : t.t);
    }
    if (tips.length) h += `<div class="sec"><h3>建議</h3><ul class="vent-tips">${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`;
    return h;
  },

  // 剖面示意：左＝前面、右＝後面；各層色塊＝平均換氣，天井、樓梯間的箭頭＝往上拔風
  ventSectionSvg(fs, v) {
    const st = this.site;
    const D = 1550;
    const X = (y) => D - y;
    const top = Math.max(...fs.map(({ fl, p }) => fl.elev + (fl.roof ? (p.wallHeight || 300) + 15 : fl.h)), buildingTop(st));
    const lwTop = Math.max(buildingTop(st), ...Object.values(st.derived?.lwTops || {}));
    const stairTop = st.derived?.stairTop || top;
    const out = [], txt = [];
    const arrow = (x1, y1, x2, y2, w, cls) => {
      const L = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / L, uy = (y2 - y1) / L;
      const hl = Math.min(L * 0.5, 40 + w * 2.2), hw = 22 + w * 1.6;
      const bx = x2 - ux * hl, by = y2 - uy * hl;
      return `<g class="vs-arr ${cls}"><line x1="${x1.toFixed(0)}" y1="${y1.toFixed(0)}" x2="${bx.toFixed(0)}" y2="${by.toFixed(0)}" stroke-width="${w.toFixed(0)}"/><path d="M${x2.toFixed(0)} ${y2.toFixed(0)} L${(bx - uy * hw).toFixed(0)} ${(by + ux * hw).toFixed(0)} L${(bx + uy * hw).toFixed(0)} ${(by - ux * hw).toFixed(0)}Z"/></g>`;
    };
    const wOf = (q) => Math.max(8, Math.min(46, 9 * Math.log2(1 + q / 60)));
    // 地面
    out.push(`<line x1="-300" y1="0" x2="${D + 300}" y2="0" class="vs-ground"/>`);
    // 各層
    for (const { fl, p, r, s } of fs) {
      const h = fl.roof ? (p.wallHeight || 300) : fl.h;
      const y0 = -(fl.elev + h), y1 = -fl.elev;
      const xs = fl.roof ? p.rooms.filter((q) => !['balcony', 'void'].includes(q.kind)).flatMap((q) => q.pts.map((pt) => X(pt.y))) : [0, D];
      const x0 = xs.length ? Math.max(0, Math.min(...xs)) : 0, x1 = xs.length ? Math.min(D, Math.max(...xs)) : D;
      out.push(`<rect x="${x0}" y="${y0}" width="${x1 - x0}" height="${h}" fill="${achColor(s.avgAch)}" class="vs-floor"/>`);
      out.push(`<line x1="-20" y1="${y1}" x2="${D + 20}" y2="${y1}" class="vs-slab"/>`);
      txt.push(`<text x="${x0 + 80}" y="${y0 + 130}" class="vs-t">${esc(fl.label)} ${fmtAch(s.avgAch)} 次/時</text>`);
      // 這層從前、後面進出的風
      const by = { front: 0, back: 0 };
      for (const ed of r.edges) if (ed.kind === 'win' && ed.b < 0 && (ed.side === 'front' || ed.side === 'back')) by[ed.side] += -ed.Q * 3600;
      const ym = y0 + h * 0.6;
      if (Math.abs(by.front) > 20) out.push(by.front > 0 ? arrow(-260, ym, 40, ym, wOf(by.front), 'in') : arrow(40, ym, -260, ym, wOf(-by.front), 'out'));
      if (Math.abs(by.back) > 20 && x1 >= D - 5) out.push(by.back > 0 ? arrow(D + 260, ym, D - 40, ym, wOf(by.back), 'in') : arrow(D - 40, ym, D + 260, ym, wOf(-by.back), 'out'));
    }
    // 天井、樓梯間
    const lwUp = Math.max(0, ...fs.map(({ r }) => r.shafts.find((x) => x.kind === 'lw')?.up || 0));
    const stUp = Math.max(0, ...fs.map(({ r }) => r.shafts.find((x) => x.kind === 'stair')?.up || 0));
    const hasLw = fs.some(({ p }) => p.rooms.some((q) => q.kind === 'void'));
    if (hasLw) {
      const a = X(899), b = X(684);
      out.push(`<rect x="${a}" y="${-lwTop}" width="${b - a}" height="${lwTop}" class="vs-shaft"/>`);
      if (lwUp > 20) out.push(arrow((a + b) / 2, -120, (a + b) / 2, -lwTop - 140, wOf(lwUp), 'up'));
      txt.push(`<text x="${b + 10}" y="${-lwTop - 175}" class="vs-t e">天井${lwUp > 20 ? ` ↑${Math.round(lwUp / 10) * 10}` : ''}</text>`);
    }
    {
      const a = X(483), b = X(0);
      out.push(`<rect x="${a}" y="${-stairTop}" width="${b - a}" height="${stairTop}" class="vs-shaft st"/>`);
      if (stUp > 20) out.push(arrow((a + b) / 2, -150, (a + b) / 2, -stairTop - (v.stairVent ? 140 : 40), wOf(stUp), 'up'));
      txt.push(`<text x="${a + 60}" y="${-stairTop - (v.stairVent ? 175 : 75)}" class="vs-t">樓梯${stUp > 20 ? ` ↑${Math.round(stUp / 10) * 10}` : ''}</text>`);
    }
    // 風
    const side = windSide(st, v);
    const yw = -top - 420;
    if (side === 'front') out.push(arrow(-280, yw, 260, yw, 30, 'wind')), txt.push(`<text x="320" y="${yw + 35}" class="vs-t">${SEASONS[v.season]}${dirName(windFrom(st, v))}風從前面吹來</text>`);
    else if (side === 'back') out.push(arrow(D + 280, yw, D - 260, yw, 30, 'wind')), txt.push(`<text x="${D - 320}" y="${yw + 35}" class="vs-t e">${SEASONS[v.season]}${dirName(windFrom(st, v))}風從後面吹來</text>`);
    else txt.push(`<text x="${D / 2}" y="${yw + 35}" class="vs-t c">${SEASONS[v.season]}${dirName(windFrom(st, v))}風沿著街道吹（從側面）</text>`);
    txt.push(`<text x="-280" y="130" class="vs-t">◀ 前面</text><text x="${D + 280}" y="130" class="vs-t e">後面 ▶</text>`);
    return `<svg class="vent-section" viewBox="-300 ${(-top - 540).toFixed(0)} ${D + 600} ${(top + 700).toFixed(0)}" role="img" aria-label="整棟通風剖面示意">${out.join('')}${txt.join('')}</svg>`;
  },

  ventSettingsHtml(v) {
    const st = this.site;
    const lw = { top: 'open', wall: 'normal', ...(st.lw || {}) };
    const auto = cityWind(st.city, v.season);
    const ck = (k, t) => `<label><input type="checkbox" data-vf="${k}"${v[k] ? ' checked' : ''}> ${t}</label>`;
    return `<div class="sec"><h3>設定</h3>
      <div class="fields">
        <div class="field"><label for="v_season">季節</label><select id="v_season" data-vf="season">${opt(Object.entries(SEASONS), v.season)}</select></div>
        <div class="field"><label for="v_wind">風從哪裡吹來</label><select id="v_wind" data-vf="wind">${opt([['', `${CITIES[st.city]?.[0] || ''}常見（${dirName(auto)}風）`], ...DIRS.map(([n, d]) => [d, `${n}風`])], v.wind ?? '')}</select></div>
        <div class="field"><label for="v_speed">風速（氣象站）</label><div class="unit"><input type="number" id="v_speed" data-vf="speed" value="${v.speed}" step="0.5" min="0" max="12"><span>m/s</span></div></div>
        <div class="field"><label for="v_terrain">周圍</label><select id="v_terrain" data-vf="terrain">${opt(Object.entries(TERRAINS).map(([k, x]) => [k, x.name]), v.terrain)}</select></div>
        <div class="field"><label for="v_doors">房門</label><select id="v_doors" data-vf="doors">${opt(Object.entries(DOOR_MODES), v.doors)}</select></div>
        <div class="field"><label for="v_window">窗型（沒有另外指定的窗）</label><select id="v_window" data-vf="window">${opt(Object.entries(WINDOW_TYPES).filter(([k]) => k !== 'fixed').map(([k, x]) => [k, `${x.name}（可開 ${Math.round(x.open * 100)}%）`]), v.window)}</select></div>
      </div>
      <div class="checks">${ck('screen', '有紗窗')}${ck('stairVent', '樓梯間頂端有可開的高窗／排風')}${ck('bathFan', '無窗浴室裝排風機')}${ck('erv', '裝全熱交換器')}</div>
      <h3>天井</h3>
      <div class="fields">
        <div class="field"><label for="v_lwtop">天井頂部</label><select id="v_lwtop" data-lw="top">${opt(Object.entries(LW_TOPS).map(([k, x]) => [k, x.name]), lw.top)}</select></div>
        <div class="field"><label for="v_lwwall">天井牆面</label><select id="v_lwwall" data-lw="wall">${opt(Object.entries(LW_WALLS).map(([k, x]) => [k, x.name]), lw.wall)}</select></div>
      </div>
      <p class="note">天井的設定也會影響「基地・採光」的亮度模擬。單一扇窗的窗型可以點那扇窗，在「屬性」裡改。</p></div>`;
  },

  onVentField(t) {
    const st = this.site;
    if (t.dataset.vf) {
      const k = t.dataset.vf;
      let val = t.type === 'checkbox' ? t.checked : t.value;
      if (k === 'speed') val = Math.max(0, Math.min(12, +val || 0));
      if (k === 'wind') val = val === '' ? null : +val;
      st.vent = { ...ventOf(st), [k]: val };
    } else if (t.dataset.lw) {
      st.lw = { top: 'open', wall: 'normal', ...(st.lw || {}), [t.dataset.lw]: t.value };
      this.scheduleDaylight?.();
      this.view.invalidate();
    } else return;
    this.save();
    this.scheduleVent(true);
  },

  onVentClick(e) {
    const b = e.target.closest('[data-va]');
    const st = this.site;
    if (b) {
      const a = b.dataset.va;
      if (a === 'overlay') return this.setVent(!this.vent.show);
      if (a === 'season') { const v = ventOf(st); st.vent = { ...v, season: v.season === 'summer' ? 'winter' : 'summer' }; }
      if (a === 'doors') { const v = ventOf(st); st.vent = { ...v, doors: v.doors === 'closed' ? 'open' : 'closed' }; }
      this.save();
      this.scheduleVent(true);
      return;
    }
    const fl = e.target.closest('[data-vfl]');
    if (fl) { this.openFloor(fl.dataset.vfl); this.setVent(true); this.setSideTab('vent'); return; }
    const row = e.target.closest('[data-vroom]');
    if (row) { this.sel = { type: 'room', id: row.dataset.vroom }; this.editor.render(); this.view.invalidate(); }
  },
};
