// 「用講的改」：輸入框＋語音，解析成動作後直接改平面或整棟；每一步都能復原。
// 本機規則聽不懂時，在 Claude 檢視器裡會請 Claude 把話翻成同一套動作（sample 能力）。
import { uid, clone, normalizePlan, polygonCentroid, pointInPolygon, wallFrame, projectOnSegment, dist, add, mul, areaM2, m2ToPing, itemCorners } from './model.js';
import { CATALOG } from './catalog.js';
import { STYLES, FURN_VARIANTS } from './styles.js';
import { generate, defaultProgram } from './generator.js';
import { FACADES, USES, ENTRY, HALL, RENT, ROOF_ROOM, FACADE_WALLS, FACADE_COLORS, FRAMES, RAILS, ROOFS, GRILLES } from './building.js';
import { parse, normalize, matchRoom, ACTION_DOC } from './commands.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const EXAMPLES_PLAN = ['主臥大一點', '多一間小孩房', '廚房改開放式', '主臥加一張書桌', '沙發換成雲朵沙發', '換成北歐風', '做一張效果圖', '360 環景'];
const EXAMPLES_BLD = ['二樓改自住', '機車停 6 台', '頂樓做神明廳', '外牆換清水模', '窗框改白色', '屋頂改斜屋頂', '剖開二樓', '做一張效果圖'];
const MIN_DEPTH = { bedroom: 240, bath: 140, kitchen: 165, hall: 90, living: 250, storage: 80, other: 120, balcony: 100 };
const PATH_NAME = {
  n: '樓層數', hasRoof: '頂樓', 'shop.entry': '一樓出入口', 'shop.scooters': '機車', 'shop.hall': '一樓大空間', 'shop.toilet': '一樓廁所', 'rent.rooms': '出租間數',
  'roof.rooms': '頂樓房間', 'roof.back': '頂樓後面房間', 'roof.front': '頂樓前面房間', 'facade.wall': '外牆', 'facade.color': '外牆顏色', 'facade.frame': '窗框',
  'facade.rail': '欄杆', 'facade.roof': '屋頂', 'facade.grille': '格柵', 'facade.awning': '雨遮',
};

// 設定值說成人話
const VAL = {
  n: (v) => `${v} 層`, hasRoof: (v) => (v ? '要' : '不要'), 'shop.entry': (v) => ENTRY[v]?.name, 'shop.scooters': (v) => `${v} 台`, 'shop.hall': (v) => HALL[v]?.name,
  'shop.toilet': (v) => (v ? '要' : '不要'), 'rent.rooms': (v) => RENT[v]?.name, 'roof.rooms': (v) => (v ? `${v} 間房` : '只要儲藏'), 'roof.back': (v) => ROOF_ROOM[v]?.name,
  'roof.front': (v) => ROOF_ROOM[v]?.name, 'facade.wall': (v) => FACADE_WALLS[v]?.name, 'facade.color': (v) => FACADE_COLORS.find((c) => c[0] === v)?.[1] || v,
  'facade.frame': (v) => FRAMES[v]?.[0], 'facade.rail': (v) => RAILS[v], 'facade.roof': (v) => ROOFS[v], 'facade.grille': (v) => GRILLES[v], 'facade.awning': (v) => (v ? '加上' : '拿掉'),
};

function inferProgram(plan) {
  const names = plan.rooms.map((r) => r.name || '');
  const beds = plan.rooms.filter((r) => r.kind === 'bedroom' && !/書房|和室/.test(r.name || ''));
  const pg = { ...defaultProgram(), elevation: plan.elevation || 465, style: plan.style && plan.style !== 'basic' ? plan.style : 'japandi' };
  pg.master = beds.length > 0;
  pg.elder = beds.some((r) => /長輩/.test(r.name));
  pg.guest = beds.some((r) => /客房/.test(r.name));
  pg.kids = Math.max(0, Math.min(3, beds.length - (pg.master ? 1 : 0) - (pg.elder ? 1 : 0) - (pg.guest ? 1 : 0)));
  pg.baths = Math.min(3, plan.rooms.filter((r) => r.kind === 'bath').length);
  pg.masterBath = names.some((n) => /主浴|主臥.*浴/.test(n)) && pg.baths > 0;
  pg.study = names.some((n) => /書房/.test(n));
  pg.tatami = names.some((n) => /和室/.test(n));
  pg.altar = names.some((n) => /神明/.test(n));
  pg.walkin = names.some((n) => /更衣/.test(n));
  pg.storage = names.some((n) => /儲藏/.test(n));
  pg.island = plan.items.some((i) => i.kind === 'island');
  pg.living = names.some((n) => /客/.test(n)) || true;
  pg.kitchen = plan.rooms.some((r) => r.kind === 'kitchen') ? 'open' : 'none';
  return pg;
}

export const AskUI = {
  // ---------- 面板 ----------
  openAsk(prefill = '') {
    let p = $('#askPanel');
    if (!p) {
      p = document.createElement('section');
      p.id = 'askPanel';
      p.className = 'ask-panel';
      p.setAttribute('aria-label', '用講的改');
      p.innerHTML = `<header><b>💬 用講的改</b><span class="note">打字或按 🎤 用說的，例如「主臥大一點」</span><button class="btn icon" data-ask="close" aria-label="關閉">✕</button></header>
        <div class="ask-log" id="askLog" aria-live="polite"></div>
        <div class="ask-chips" id="askChips"></div>
        <form class="ask-row" id="askForm"><input id="askInput" type="text" autocomplete="off" enterkeyhint="send" placeholder="想怎麼改？" aria-label="想怎麼改">
          <button type="button" class="btn icon" id="askMic" title="用說的（語音輸入）" aria-label="語音輸入">🎤</button>
          <button type="submit" class="btn primary">送出</button></form>`;
      document.body.appendChild(p);
      p.querySelector('[data-ask=close]').onclick = () => { p.hidden = true; };
      p.querySelector('#askForm').addEventListener('submit', (e) => { e.preventDefault(); const v = $('#askInput').value.trim(); if (v) this.askSubmit(v); });
      const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
      const mic = p.querySelector('#askMic');
      if (!SR) mic.hidden = true;
      else mic.onclick = () => this.askListen(SR, mic);
      this.askSay('你好！跟我說想怎麼改就好，例如下面這些。改錯了按「復原」或說「復原」。', 'bot');
      this.sampleCap();
    }
    p.hidden = false;
    this.renderAskChips();
    const inp = $('#askInput');
    if (prefill) inp.value = prefill;
    if (!matchMedia('(pointer: coarse)').matches) inp.focus();
  },

  renderAskChips(extra) {
    const box = $('#askChips');
    if (!box) return;
    const list = extra || (this.bmode ? EXAMPLES_BLD : EXAMPLES_PLAN);
    box.innerHTML = list.map((t) => `<button type="button" class="chip">${esc(t)}</button>`).join('');
    box.querySelectorAll('button').forEach((b) => b.onclick = () => this.askSubmit(b.textContent));
  },

  askSay(html, who = 'bot', { undo = false } = {}) {
    const log = $('#askLog');
    if (!log) return null;
    const el = document.createElement('div');
    el.className = `ask-msg ${who}`;
    el.innerHTML = html + (undo ? ' <button type="button" class="linkish" data-undo>復原</button>' : '');
    el.querySelector('[data-undo]')?.addEventListener('click', () => { this.undo(); this.askSay('已經復原。', 'bot'); });
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  },

  askListen(SR, mic) {
    if (this._rec) { this._rec.stop(); return; }
    const rec = new SR();
    this._rec = rec;
    rec.lang = 'zh-TW';
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    const inp = $('#askInput');
    mic.classList.add('on');
    let finalText = '';
    rec.onresult = (e) => {
      const txt = [...e.results].map((r) => r[0].transcript).join('');
      inp.value = txt;
      if (e.results[e.results.length - 1].isFinal) finalText = txt;
    };
    rec.onerror = (e) => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture'].includes(e.error)) this.askSay('這個畫面不能直接用麥克風。可以點輸入框，再按手機鍵盤上的 🎤 用說的。', 'bot');
    };
    rec.onend = () => { mic.classList.remove('on'); this._rec = null; if (finalText.trim()) this.askSubmit(finalText.trim()); };
    try { rec.start(); } catch { mic.classList.remove('on'); this._rec = null; }
  },

  async sampleCap() {
    if (this._sample !== undefined) return this._sample;
    if (this._sampleP) return this._sampleP;
    this._sampleP = (async () => {
      try { this._sample = window.claude?.use ? await window.claude.use('sample') : null; } catch { this._sample = null; }
      return this._sample;
    })();
    return this._sampleP;
  },

  // ---------- 送出 ----------
  async askSubmit(text) {
    const inp = $('#askInput');
    if (inp) inp.value = '';
    this.askSay(esc(text), 'me');
    const ctx = this.askContext();
    const { actions, unknown } = parse(text, ctx);
    if (actions.length) await this.runActions(actions, text);
    if (unknown.length) {
      const sample = await this.sampleCap();
      if (sample) await this.askClaude(sample, unknown.join('，'), ctx);
      else this.askSay(`「${esc(unknown.join('，'))}」我還聽不懂。可以換個說法，例如：「主臥大一點」「二樓改自住」「沙發換成雲朵沙發」「外牆換清水模」。`, 'bot');
    }
  },

  askContext() {
    const plan = this.plan;
    return {
      bmode: !!this.bmode,
      rooms: (this.bmode ? [] : plan.rooms).map((r) => ({ id: r.id, name: r.name })),
      floors: this.building ? this.floors().map((f) => f.id) : [],
    };
  },

  askState() {
    const b = this.building;
    const plan = this.plan;
    return {
      模式: this.bmode ? '整棟' : '單層平面',
      整棟: b ? { 層數: b.n, 頂樓: b.hasRoof, 各層: Object.fromEntries(this.floors().map((f) => [f.id, this.floorPlan(f)?.name])), 一樓: b.shop, 出租: b.rent, 頂樓設定: b.roof, 外觀: b.facade, 剖開: b.focus } : null,
      目前平面: this.bmode ? null : { 名稱: plan.name, 風格: plan.style, 房間: plan.rooms.filter((r) => r.name).map((r) => `${r.name}（${areaM2(r.pts).toFixed(1)}㎡）`), 家具: [...new Set(plan.items.map((i) => i.kind))] },
      家具款式代碼: Object.fromEntries(Object.entries(FURN_VARIANTS).map(([k, v]) => [k, Object.keys(v)])),
    };
  },

  async askClaude(sample, text, ctx) {
    const wait = this.askSay('想一下…', 'bot');
    const prompt = `你在幫一個「房屋 3D 規劃」網頁，把使用者的一句中文要求轉成網頁可以執行的動作。
${ACTION_DOC}

目前狀態（JSON）：${JSON.stringify(this.askState()).slice(0, 6000)}

使用者說：「${text}」

只回一個 JSON 物件：{"actions":[...],"reply":"..."}。reply 用一句簡單、親切的繁體中文（使用者可能是長輩），說你要做什麼。
做不到或不確定時 actions 給 []，reply 說明原因並建議一種可以直接說的講法。不要發明清單以外的動作。`;
    let res;
    try {
      res = await sample.json(prompt, { modelTier: 'quick' });
    } catch (e) {
      wait.remove();
      if (e?.code === 'not_granted' || e?.code === 'sampling_disabled') { this._sample = null; this.askSay(`「${esc(text)}」我還聽不懂，換個說法試試，例如「主臥大一點」。`, 'bot'); return; }
      this.askSay(e?.code === 'rate_limited' ? 'Claude 現在比較忙，等一下再試。' : `「${esc(text)}」我還聽不懂，換個說法試試。`, 'bot');
      return;
    }
    wait.remove();
    const acts = Array.isArray(res?.actions) ? res.actions.filter((a) => a && typeof a.type === 'string') : [];
    if (res?.reply) this.askSay(esc(String(res.reply)), 'bot');
    if (acts.length) await this.runActions(acts, text, { quiet: !!res?.reply });
    void ctx;
  },

  // ---------- 執行 ----------
  async runActions(actions, text = '', { quiet = false } = {}) {
    const floorHint = (() => { const m = normalize(text).match(/(\d)\s*(?:樓|F)/); return /頂樓/.test(text) ? 'RF' : m ? `${m[1]}F` : null; })();
    for (const a of actions) {
      try {
        const msg = await this.runAction(a, floorHint);
        if (msg && !(quiet && msg.ok)) this.askSay(msg.html, 'bot', { undo: !!msg.undo });
      } catch (e) {
        console.error(e);
        this.askSay(`這一步沒做成功：${esc(e.message || e)}`, 'bot');
      }
    }
    this.renderAskChips();
  },

  ensureBuilding() {
    if (!this.building) { this.createBuilding(); this.enterBuilding(); return true; }
    if (!this.bmode) this.enterBuilding();
    return false;
  },

  // 單層的動作要知道是哪一層：整棟模式時用句子裡說的樓層或目前剖開的那層
  planTarget(floorHint) {
    if (!this.bmode) return this.plan;
    const b = this.building;
    const id = floorHint || (b?.focus !== 'all' ? b?.focus : null);
    const fl = id && this.floors().find((f) => f.id === id);
    if (!fl) return null;
    this.openFloor(fl.id);
    return this.plan;
  },

  async runAction(a, floorHint) {
    const ok = (html, undo = true) => ({ ok: true, html, undo });
    switch (a.type) {
      case 'say': return { html: esc(a.text) };
      case 'undo': this.undo(); return { html: '好，回到上一步。' };
      case 'view': return this.askView(String(a.what || ''));
      case 'floorUse': {
        const made = this.ensureBuilding();
        const fl = this.floors().find((f) => f.id === a.floor);
        if (!fl) return { html: `沒有 ${esc(a.floor)}，這棟目前是 ${this.building.n} 層${this.building.hasRoof ? '＋頂樓' : ''}。` };
        const use = fl.roof ? (a.use === 'empty' ? 'empty' : 'roof') : fl.level === 1 ? a.use : (a.use === 'shop' ? 'home' : a.use);
        this.setFloorUse(fl.id, use);
        return ok(`${made ? '先幫你建立整棟規劃，' : ''}${fl.label} 改成「${USES[use].name}」，已經重新排好。`);
      }
      case 'building': {
        this.ensureBuilding();
        const b = this.building;
        const set = { ...(a.set || {}) };
        for (const [k, d] of Object.entries(a.inc || {})) set[k] = (k.split('.').reduce((o, x) => o?.[x], b) || 0) + d;
        let extra = '';
        if ('rent.rooms' in set) { const n = +set['rent.rooms']; if (n > 3) extra = `這一層能開窗的地方只有後面一間、前面兩間，最多 3 間有窗的套房，所以先排 3 間。`; set['rent.rooms'] = n <= 2 ? 2 : 3; }
        if ('shop.scooters' in set) { const max = (set['shop.entry'] || b.shop.entry) === 'side' ? 4 : 7; if (set['shop.scooters'] > max) extra = `${(set['shop.entry'] || b.shop.entry) === 'side' ? '側邊通道' : '一樓後段'}最多停 ${max} 台。`; set['shop.scooters'] = Math.max(0, Math.min(max, +set['shop.scooters'])); }
        if ('n' in set) set.n = Math.max(1, Math.min(5, +set.n));
        const keys = Object.keys(set);
        if (!keys.length) return null;
        const regen = (bb) => {
          if (keys.some((k) => k === 'n' || k === 'hasRoof')) return 'all';
          const ids = new Set();
          for (const k of keys) {
            const [g] = k.split('.');
            if (g === 'shop') this.floorsUsing('shop').forEach((x) => ids.add(x));
            if (g === 'rent') this.floorsUsing('rent').forEach((x) => ids.add(x));
            if (g === 'roof') this.floorsUsing('roof').forEach((x) => ids.add(x));
          }
          void bb;
          return [...ids];
        };
        this.bChange((bb) => {
          for (const [k, v] of Object.entries(set)) { const ks = k.split('.'); let o = bb; for (const x of ks.slice(0, -1)) o = o[x] ||= {}; o[ks[ks.length - 1]] = v; }
          if (keys.some((k) => k.startsWith('facade.'))) bb.facade.preset = null;
          if (keys.some((k) => k.startsWith('roof.')) && !bb.hasRoof) bb.hasRoof = true;
        }, regen);
        const shown = keys.filter((k) => !(k === 'hasRoof' && set[k] === true && keys.length > 1) && !(k === 'roof.rooms' && keys.includes('roof.front')));
        const desc = shown.map((k) => `${PATH_NAME[k] || k}：${VAL[k]?.(set[k]) ?? set[k]}`).join('，');
        return ok(`${extra}好，${desc}。`);
      }
      case 'facadePreset': {
        this.ensureBuilding();
        const f = FACADES[a.preset];
        if (!f) return null;
        this.bChange((b) => { b.facade = { preset: a.preset, ...f }; });
        if (this.building.focus !== 'all') this.focusFloor(null);
        return ok(`外觀換成「${f.name}」。`);
      }
      case 'style': {
        const st = STYLES[a.style] ? a.style : null;
        if (!st) return null;
        if (this.bmode || a.all) {
          if (!this.building) { this.plan.style = st; this.commit(); return ok(`換成「${STYLES[st].name}」。`); }
          this.bChange((b) => {
            b.shop.style = b.rent.style = b.roof.style = st;
            for (const fl of this.floors()) { const p = this.floorPlan(fl); if (p) p.style = st; }
          });
          return ok(`每一層都換成「${STYLES[st].name}」，牆面、地板和家具款式一起換。`);
        }
        this.plan.style = st;
        this.commit();
        return ok(`換成「${STYLES[st].name}」，牆面、地板和家具款式一起換了。`);
      }
      case 'program': {
        const plan = this.planTarget(a.floor || floorHint);
        if (!plan) return { html: '要改哪一層？說「三樓多一間小孩房」，或先在整棟裡點一層。' };
        return this.regenProgram(plan, a.set || {}, a.inc || {});
      }
      case 'resizeRoom': {
        const plan = this.planTarget(floorHint);
        if (!plan) return { html: '要改哪一層的房間？例如「三樓的主臥大一點」。' };
        return this.resizeRoom(plan, a.room, +a.delta || 30);
      }
      case 'variant': {
        const plan = this.planTarget(floorHint);
        if (!plan) return { html: '要改哪一層？例如「三樓的沙發換成雲朵沙發」。' };
        const items = this.itemsIn(plan, a.kind, a.room);
        if (!items.length) return { html: `這一層找不到${esc(CATALOG[a.kind]?.name || a.kind)}。` };
        if (!FURN_VARIANTS[a.kind]?.[a.variant]) return this.runAction({ type: 'listVariants', kind: a.kind }, floorHint);
        for (const it of items) it.variant = a.variant;
        this.commit();
        return ok(`${items.length} 件${esc(CATALOG[a.kind]?.name.replace(/ .*/, '') || '')}換成「${esc(FURN_VARIANTS[a.kind][a.variant])}」。`);
      }
      case 'listVariants': {
        const v = FURN_VARIANTS[a.kind];
        if (!v) return { html: '這種家具目前只有一種款式。' };
        this.renderAskChips(Object.values(v).map((n) => `${CATALOG[a.kind]?.name.replace(/ .*/, '') || ''}換成${n.replace(/（.*）/, '')}`));
        return { html: `${esc(CATALOG[a.kind]?.name.replace(/ .*/, '') || '')}有這些款式，點一個就換：` };
      }
      case 'addItem': {
        const plan = this.planTarget(floorHint);
        if (!plan) return { html: '要加在哪一層？例如「三樓主臥加一張書桌」。' };
        const kind = CATALOG[a.kind] ? a.kind : null;
        if (!kind) return null;
        const room = this.findRoom(plan, a.room) || this.bestRoomFor(plan, kind);
        if (!room) return { html: '找不到要放的房間，說一下房間名稱，例如「主臥加一張書桌」。' };
        let n = 0;
        for (let i = 0; i < Math.max(1, Math.min(4, a.n || 1)); i++) if (this.placeItem(plan, room, kind)) n++;
        if (!n) return { html: `${esc(room.name)}裡沒有空位放${esc(CATALOG[kind].name)}了。可以先拿掉一些東西，或說「${esc(room.name)}大一點」。` };
        this.commit();
        return ok(`在${esc(room.name)}放了 ${n} ${['plant'].includes(kind) ? '盆' : '件'}${esc(CATALOG[kind].name.replace(/ .*/, ''))}，可以直接拖動調整。`);
      }
      case 'removeItem': {
        const plan = this.planTarget(floorHint);
        if (!plan) return { html: '要改哪一層？例如「三樓拿掉電視」。' };
        const items = this.itemsIn(plan, a.kind, a.room);
        if (!items.length) return { html: `找不到${esc(CATALOG[a.kind]?.name || a.kind)}。` };
        const ids = new Set(items.map((i) => i.id));
        plan.items = plan.items.filter((i) => !ids.has(i.id));
        this.sel = null;
        this.commit();
        return ok(`拿掉了 ${items.length} 件${esc(CATALOG[a.kind]?.name.replace(/ .*/, '') || '')}。`);
      }
      case 'autoWindows': {
        if (this.bmode) { const p = this.planTarget(floorHint); if (!p) return { html: '要幫哪一層開窗？例如「二樓自動開窗」。' }; }
        this.autoWindows();
        return ok('依外面的狀況重新開好窗了（右側「基地・採光」可以看每間亮度）。');
      }
      case 'windows': {
        const plan = this.planTarget(floorHint);
        if (!plan) return { html: '要改哪一層？' };
        return this.scaleWindows(plan, a.room, +a.scale || 1.25);
      }
      default: return null;
    }
  },

  askView(w) {
    if (w === 'building') { if (!this.building) { this.openBuildingWizard(); return { html: '還沒有整棟規劃，先回答幾個問題。' }; } if (this.building.focus !== 'all') this.focusFloor(null); this.enterBuilding(); return { html: '這是整棟外觀。' }; }
    if (w.startsWith('floor:')) { const id = w.slice(6); if (!this.building) return { html: '還沒有整棟規劃。' }; const fl = this.floors().find((f) => f.id === id); if (!fl) return { html: `沒有 ${esc(id)}。` }; this.openFloor(id); return { html: `打開 ${fl.label}。` }; }
    if (w.startsWith('focus:')) { const id = w.slice(6); this.ensureBuilding(); this.building.focus = 'all'; this.focusFloor(id); return { html: `把 ${esc(id)} 剖開來看。` }; }
    const mobile3d = () => { if (matchMedia('(max-width: 900px)').matches) document.querySelector('#mobileSwitch [data-show="3d"]')?.click(); };
    if (['walk', 'iso', 'front', 'top'].includes(w)) { mobile3d(); document.querySelector(`#viewSeg [data-view="${w}"]`)?.click(); return { html: { walk: '走進去看：拖曳看四周，用畫面上的箭頭走動。', iso: '鳥瞰。', front: '從正面看。', top: '從上面看。' }[w] }; }
    if (w === 'sun') { if (this.bmode) return { html: '日照要在單層平面看：先打開一層，再說「看日照」。' }; mobile3d(); this.setSun(true); return { html: '開啟日照：下面可以選月份和時間。' }; }
    if (w === 'daylight') { if (this.bmode) return { html: '採光要在單層平面看：先打開一層。' }; this.setDaylight(true); return { html: '平面圖上顯示各處亮度，越黃越亮。' }; }
    if (w === 'render') { this.openRender?.(); return { html: '開始做效果圖。' }; }
    if (w === 'pano') { this.openPano?.(); return { html: '開始做 360° 環景。' }; }
    return null;
  },

  // ---------- 格局重排 ----------
  async regenProgram(plan, set, inc) {
    const base = plan.generated?.program ? { ...plan.generated.program } : inferProgram(plan);
    const pg = { ...base };
    for (const [k, d] of Object.entries(inc)) pg[k] = (pg[k] || 0) + d;
    for (const [k, v] of Object.entries(set)) if (k !== 'bedrooms') pg[k] = v;
    if (set.bedrooms !== undefined) pg.kids = set.bedrooms - (pg.master ? 1 : 0) - (pg.elder ? 1 : 0) - (pg.guest ? 1 : 0);
    if (pg.kids < 0) { pg.kids = 0; if (set.bedrooms === 1) { pg.elder = false; pg.guest = false; } }
    pg.kids = Math.min(3, pg.kids);
    pg.baths = Math.max(0, Math.min(3, pg.baths));
    if (pg.masterBath && pg.baths < 1) pg.baths = 1;
    pg.elevation = plan.elevation || pg.elevation;
    if (plan.style && plan.style !== 'basic') pg.style = plan.style;
    const wait = this.askSay('重新排這一層的格局，大約幾秒…', 'bot');
    const res = await generate(pg, this.site, { top: 1 });
    wait?.remove();
    if (!res.results.length) return { html: esc(res.msgs.join(' ') || '這一層放不下這些需求。') };
    // 放不下而被程式拿掉某一項時，不要直接換掉原本的平面
    if (JSON.stringify(res.program) !== JSON.stringify(res.program && { ...pg, ...res.program }) || ['kids', 'baths', 'study', 'tatami', 'altar', 'walkin', 'storage', 'guest', 'dining'].some((k) => res.program[k] !== pg[k])) {
      return { html: `${esc(res.msgs.join(' ') || '這一層放不下這些需求。')} 平面沒有改；可以把多的房間放到別層，例如說「三樓多一間小孩房」。` };
    }
    const np = normalizePlan(clone(res.results[0].built.plan));
    const id = plan.id, floor = plan.floor;
    const fl = floor && this.floors().find((f) => f.id === floor);
    for (const k of Object.keys(plan)) if (k !== 'underlay') delete plan[k];
    Object.assign(plan, np, { id });
    if (floor) { plan.floor = floor; plan.name = `${fl?.label || floor} 自住 · ${np.name.replace(/^自動 \d+ · /, '')}`; if (this.building) this.building.home[floor] = '__keep'; }
    this.sel = null;
    this.commit();
    this.renderTabs();
    this.editor.fit();
    const extra = res.msgs.length ? ` ${esc(res.msgs.join(' '))}` : '';
    return { ok: true, undo: true, html: `排好了：${esc(res.results[0].label)}，${esc(res.results[0].summary)}。${extra}` };
  },

  // ---------- 房間加大／縮小：推動一面隔間牆，旁邊房間跟著變 ----------
  findRoom(plan, name) {
    if (!name) return null;
    return matchRoom(normalize(name), plan.rooms) ? plan.rooms.find((r) => r.id === matchRoom(normalize(name), plan.rooms).id) : null;
  },

  resizeRoom(plan, name, delta) {
    const room = this.findRoom(plan, name);
    if (!room) return { html: `這一層找不到「${esc(name)}」。` };
    const c = polygonCentroid(room.pts);
    const onEdge = (p) => room.pts.some((q, i) => { const n = room.pts[(i + 1) % room.pts.length]; return projectOnSegment(p, q, n).dist < 2; });
    const roomAt = (p, not) => plan.rooms.find((r) => r !== not && r.pts.length > 2 && pointInPolygon(p, r.pts));
    let best = null;
    for (const w of plan.walls) {
      if (w.kind === 'ext' || w.kind === 'parapet') continue;
      const { L, n } = wallFrame(w);
      if (L < 60) continue;
      const mid = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
      if (!onEdge(mid) || !onEdge(w.a) && !onEdge(w.b)) continue;
      const s = Math.sign((mid.x - c.x) * n.x + (mid.y - c.y) * n.y) || 1;
      const out = { x: n.x * s, y: n.y * s };
      const nb = roomAt(add(mid, mul(out, w.t / 2 + 15)), room);
      if (!nb || ['stair', 'elevator', 'void'].includes(nb.kind)) continue;
      const proj = (p) => (p.x - mid.x) * out.x + (p.y - mid.y) * out.y;
      const depthNb = Math.max(...nb.pts.map(proj));
      const depthMe = -Math.min(...room.pts.map(proj));
      const left = delta > 0 ? depthNb - delta : depthMe + delta;
      const need = delta > 0 ? (MIN_DEPTH[nb.kind] ?? 120) : (MIN_DEPTH[room.kind] ?? 120);
      if (left < need) continue;
      // 連到這面牆的其他牆不能是外牆或核心（不然外牆會被拉歪）
      const linked = plan.walls.filter((o) => o !== w && ['a', 'b'].some((e) => { const pr = projectOnSegment(o[e], w.a, w.b); return pr.t > -0.001 && pr.t < 1.001 && pr.dist < 1; }));
      if (linked.some((o) => { const f = wallFrame(o); return Math.abs(f.u.x * out.x + f.u.y * out.y) < 0.99; })) continue;
      let sc = L / 100 + (left - need) / 100;
      if (['hall', 'storage', 'other', 'living'].includes(nb.kind)) sc += 1.5;
      if (nb.kind === 'bath') sc -= 2;
      if (!best || sc > best.sc) best = { w, out, nb, sc, L };
    }
    if (!best) return { html: `${esc(room.name)}旁邊沒有可以推的牆（都是外牆、樓梯電梯，或旁邊的房間已經太小了）。` };
    const a0 = areaM2(room.pts);
    this.moveWall(plan, best.w, mul(best.out, delta));
    const a1 = areaM2(room.pts);
    this.commit();
    const dir = Math.abs(best.out.x) > 0.5 ? (best.out.x > 0 ? '右' : '左') : (best.out.y > 0 ? '前' : '後');
    return { ok: true, undo: true, html: `${esc(room.name)}往${dir}${delta > 0 ? '加大' : '縮小'} ${Math.abs(delta)} 公分（${a0.toFixed(1)} → ${a1.toFixed(1)}㎡，約 ${m2ToPing(a1).toFixed(1)} 坪），旁邊的「${esc(best.nb.name || '空間')}」跟著${delta > 0 ? '變小' : '變大'}。` };
  },

  moveWall(plan, wall, mv) {
    const linked = [];
    for (const o of plan.walls) {
      if (o === wall) continue;
      for (const e of ['a', 'b']) { const pr = projectOnSegment(o[e], wall.a, wall.b); if (pr.t > -0.001 && pr.t < 1.001 && pr.dist < 1) linked.push({ wall: o, end: e }); }
    }
    const roomPts = [];
    for (const r of plan.rooms) for (const p of r.pts) { const pr = projectOnSegment(p, wall.a, wall.b); if (pr.t > -0.001 && pr.t < 1.001 && pr.dist < 1) roomPts.push(p); }
    const walls = [wall, ...linked.map((l) => l.wall)];
    const ops = plan.openings.filter((o) => walls.some((w) => w.id === o.wall)).map((o) => { const w = walls.find((x) => x.id === o.wall); const { u } = wallFrame(w); return { o, w, c: add(w.a, mul(u, o.pos)), own: w === wall }; });
    const r1 = (v) => Math.round(v * 10) / 10;
    // 牆兩側的家具：被新牆位置壓到的往外推
    const band = { a: { ...wall.a }, b: { ...wall.b } };
    wall.a = { x: r1(wall.a.x + mv.x), y: r1(wall.a.y + mv.y) };
    wall.b = { x: r1(wall.b.x + mv.x), y: r1(wall.b.y + mv.y) };
    for (const l of linked) l.wall[l.end] = { x: r1(l.wall[l.end].x + mv.x), y: r1(l.wall[l.end].y + mv.y) };
    for (const p of roomPts) { p.x = r1(p.x + mv.x); p.y = r1(p.y + mv.y); }
    for (const { o, w, c, own } of ops) {
      const cc = own ? add(c, mv) : c;
      const pr = projectOnSegment(cc, w.a, w.b);
      const L = dist(w.a, w.b);
      o.pos = Math.max(o.w / 2, Math.min(L - o.w / 2, pr.t * L));
    }
    const len = Math.hypot(mv.x, mv.y) || 1;
    const dir = { x: mv.x / len, y: mv.y / len };
    const half = wall.t / 2 + 2;
    for (const it of plan.items) {
      if (['rug', 'ac', 'ledge', 'duct', 'stair', 'elevator'].includes(it.kind)) continue;
      const cs = itemCorners(it);
      // 家具在牆的哪一側、離新牆面多遠
      const sd = (p) => (p.x - wall.a.x) * dir.x + (p.y - wall.a.y) * dir.y;
      const s0 = (p) => (p.x - band.a.x) * dir.x + (p.y - band.a.y) * dir.y;
      const along = (p) => { const pr = projectOnSegment(p, wall.a, wall.b); return pr.t > -0.02 && pr.t < 1.02; };
      if (!cs.some(along)) continue;
      const ahead = cs.map(sd);
      const was = cs.map(s0);
      // 原本在牆前方（被推的那一側）且現在跟牆重疊 → 往前推
      if (Math.min(...was) > -half && Math.min(...ahead) < half) {
        const push = half - Math.min(...ahead);
        it.x = r1(it.x + dir.x * push); it.y = r1(it.y + dir.y * push);
      }
    }
  },

  // ---------- 家具 ----------
  itemsIn(plan, kind, roomName) {
    const room = this.findRoom(plan, roomName);
    return plan.items.filter((i) => (i.kind === kind || (kind === 'bed' && i.kind === 'bed_single')) && (!room || pointInPolygon({ x: i.x, y: i.y }, room.pts)));
  },

  bestRoomFor(plan, kind) {
    const pref = { desk: /書房|小孩|臥/, wardrobe: /臥|小孩/, bed: /臥|客房/, bed_single: /小孩|客房/, sofa: /客/, armchair: /客|臥/, coffee: /客/, tv: /客/, table: /餐|客/, chair: /餐/, plant: /客|陽台|露台/, shelf: /客|書/, lamp: /客|臥/, rack: /陽台|露台/, scooter: /機車|通道/, altar: /神明|客/, fridge: /廚/, washer: /洗衣|陽台/ }[kind];
    const rooms = plan.rooms.filter((r) => r.pts.length > 2 && !['stair', 'elevator', 'void'].includes(r.kind));
    return (pref && rooms.find((r) => pref.test(r.name || ''))) || rooms.sort((a, b) => areaM2(b.pts) - areaM2(a.pts))[0] || null;
  },

  // 在房間裡找一個空位：靠牆、不擋門、不壓到其他家具
  placeItem(plan, room, kind) {
    const c = CATALOG[kind];
    const xs = room.pts.map((p) => p.x), ys = room.pts.map((p) => p.y);
    const bx = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    const others = plan.items.filter((i) => !['rug', 'ac', 'ledge'].includes(i.kind)).map((i) => { const cs = itemCorners(i); return { x0: Math.min(...cs.map((p) => p.x)), x1: Math.max(...cs.map((p) => p.x)), y0: Math.min(...cs.map((p) => p.y)), y1: Math.max(...cs.map((p) => p.y)) }; });
    const walls = plan.walls.filter((w) => w.kind !== 'parapet' || room.kind === 'balcony');
    const doors = plan.openings.filter((o) => o.type !== 'window').map((o) => { const w = plan.walls.find((x) => x.id === o.wall); if (!w) return null; const { u } = wallFrame(w); return { c: add(w.a, mul(u, o.pos)), r: o.w * 0.75 + 20 }; }).filter(Boolean);
    const center = kind === 'table' || kind === 'coffee' || kind === 'island';
    const cc = polygonCentroid(room.pts);
    let best = null;
    for (const rot of [0, 90, 180, 270]) {
      const side = rot % 180 !== 0;
      const W = side ? c.d : c.w, D = side ? c.w : c.d;
      for (let x = bx.x0 + W / 2 + 6; x <= bx.x1 - W / 2 - 6; x += 10) for (let y = bx.y0 + D / 2 + 6; y <= bx.y1 - D / 2 - 6; y += 10) {
        const r = { x0: x - W / 2, x1: x + W / 2, y0: y - D / 2, y1: y + D / 2 };
        const corners = [{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }];
        if (!corners.every((p) => pointInPolygon(p, room.pts))) continue;
        let clash = false;
        for (const w of walls) { for (const p of [...corners, { x, y }]) if (projectOnSegment(p, w.a, w.b).dist < w.t / 2 + 2) { clash = true; break; } if (clash) break; const pr = projectOnSegment({ x, y }, w.a, w.b); if (pr.t > 0 && pr.t < 1 && Math.abs(((w.b.x - w.a.x) * (y - w.a.y) - (w.b.y - w.a.y) * (x - w.a.x)) / (Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y) || 1)) < Math.min(W, D) / 2) { clash = true; break; } }
        if (clash) continue;
        if (others.some((o) => Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 2 && Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) > 2)) continue;
        if (doors.some((d) => Math.max(r.x0 - d.c.x, 0, d.c.x - r.x1) ** 2 + Math.max(r.y0 - d.c.y, 0, d.c.y - r.y1) ** 2 < d.r * d.r)) continue;
        // 背面靠牆的程度
        const back = rot === 0 ? { x, y: r.y0 - 8 } : rot === 180 ? { x, y: r.y1 + 8 } : rot === 90 ? { x: r.x1 + 8, y } : { x: r.x0 - 8, y };
        let wallD = Infinity;
        for (const w of walls) wallD = Math.min(wallD, projectOnSegment(back, w.a, w.b).dist - w.t / 2);
        let sc = center ? -Math.hypot(x - cc.x, y - cc.y) / 60 : -Math.max(0, wallD) / 10;
        for (const o of others) sc -= Math.max(0, 1 - (Math.hypot((o.x0 + o.x1) / 2 - x, (o.y0 + o.y1) / 2 - y) / 150)) * 0.5;
        if (!best || sc > best.sc) best = { x, y, rot, sc };
      }
    }
    if (!best) return null;
    const it = { id: uid('i'), kind, x: Math.round(best.x), y: Math.round(best.y), w: c.w, d: c.d, rot: best.rot, h: c.h };
    if (c.risers) { it.risers = c.risers; it.style = c.style; }
    plan.items.push(it);
    return it;
  },

  scaleWindows(plan, roomName, k) {
    const room = this.findRoom(plan, roomName);
    const kinds = (o) => o.type === 'window' || (o.type === 'sliding' && plan.walls.find((x) => x.id === o.wall)?.kind === 'ext');
    const wins = plan.openings.filter(kinds).filter((o) => {
      if (!room) return true;
      const w = plan.walls.find((x) => x.id === o.wall);
      if (!w) return false;
      const { u } = wallFrame(w);
      const c = add(w.a, mul(u, o.pos));
      return room.pts.some((q, i) => projectOnSegment(c, q, room.pts[(i + 1) % room.pts.length]).dist < 12);
    });
    if (!wins.length) return { html: room ? `${esc(room.name)}沒有窗。可以說「幫我開窗」。` : '這一層沒有窗。' };
    for (const o of wins) {
      const w = plan.walls.find((x) => x.id === o.wall);
      const L = dist(w.a, w.b);
      const nw = Math.max(45, Math.min(L - 20, Math.round(o.w * k / 5) * 5));
      o.w = nw;
      o.pos = Math.max(nw / 2 + 5, Math.min(L - nw / 2 - 5, o.pos));
    }
    this.commit();
    return { ok: true, undo: true, html: `${room ? esc(room.name) + '的' : ''}${wins.length} 扇窗（含落地門）${k > 1 ? '加寬' : '縮小'}了。` };
  },
};

