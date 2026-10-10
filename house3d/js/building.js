// 整棟規劃：幾層樓、每層做什麼（一樓大空間＋機車、出租套房、自住、頂樓屋突＋房間），
// 依用途自動產生每一層的平面，並檢查屋突面積、分間數量等常見法規重點。
// 平面座標沿用 plans.js：寬 600、深 1550，樓梯電梯在右後方，天井在左側中段。
import { clone, normalizePlan, polygonArea, DEFAULTS, m2ToPing, openingEnds } from './model.js';
import { builder, core, DUCTS, DUCT_RECTS, builtinPlans } from './plans.js';
import { RoomLayout, furnish } from './layout.js';
import { designWindows } from './site.js';

// ---------- 用途與選項 ----------
export const USES = {
  shop: { name: '大空間', icon: '🏪', desc: '一樓：客廳、店面或工作室，加機車停車與上樓的獨立出入口' },
  rent: { name: '出租', icon: '🎓', desc: '學生套房，每間有自己的浴室，另有共用茶水洗衣間' },
  home: { name: '自住', icon: '🏠', desc: '自己住，可以挑一個方案或用自動規劃' },
  roof: { name: '頂樓', icon: '🌿', desc: '樓梯電梯的屋突、房間、露台和曬衣區' },
  empty: { name: '先空著', icon: '⬜', desc: '只畫外牆、樓梯和電梯，之後再決定' },
};
export const ENTRY = {
  back: { name: '從後面巷子進', desc: '機車從後巷騎進一樓後段停，旁邊就是樓梯和電梯；前面整個是大空間' },
  side: { name: '前面留側邊通道', desc: '沿右側留一條通道從前面進，機車停通道旁，電梯一樓開後門' },
};
export const HALL = {
  living: { name: '家庭客廳', desc: '大客廳、餐桌和廚房' },
  shop: { name: '店面', desc: '櫃台、展示架、展示桌' },
  office: { name: '工作室', desc: '辦公桌、會議桌、檔案櫃' },
  empty: { name: '先空著', desc: '不放家具' },
};
export const RENT = {
  2: { name: '2 間大套房', desc: '後面一間、前面一間大套房（約 5–7 坪）' },
  3: { name: '3 間套房', desc: '後面一間、前面兩間，每間約 5 坪含浴室' },
};
export const ROOF_ROOM = {
  tatami: { name: '和室', use: 'tatami', kind: 'bedroom' },
  bedroom: { name: '臥室', use: 'guest', kind: 'bedroom' },
  study: { name: '書房', use: 'study', kind: 'bedroom' },
  storage: { name: '儲藏室', use: 'storage', kind: 'storage' },
  altar: { name: '神明廳', use: 'altar', kind: 'living' },
  family: { name: '起居室', use: 'family', kind: 'living' },
};

// 外觀：外牆材質、窗框、欄杆、屋頂、格柵
export const FACADE_WALLS = {
  paint: { name: '塗料', color: '#efece6' },
  tile: { name: '二丁掛磁磚', color: '#a8644a' },
  stone: { name: '石材', color: '#d9cfbf' },
  concrete: { name: '清水模', color: '#b9b6b0' },
  terrazzo: { name: '洗石子', color: '#c9c3b7' },
};
export const FACADE_COLORS = [['#efece6', '暖白'], ['#d8d4cc', '淺灰'], ['#7c7f83', '深灰'], ['#d9c7a8', '米色'], ['#2f3236', '黑']];
export const FRAMES = { black: ['黑', '#26292d'], white: ['白', '#eceae6'], champagne: ['香檳金', '#b9a37a'], wood: ['木紋', '#8a6440'] };
export const RAILS = { solid: '實牆女兒牆', glass: '玻璃欄杆', iron: '鐵件直條' };
export const ROOFS = { flat: '平屋頂', pitched: '斜屋頂', pergola: '露台花架' };
export const GRILLES = { none: '不要', wood: '木紋格柵', alu: '金屬格柵' };
export const FACADES = {
  modern: { name: '現代白', wall: 'paint', color: '#efece6', frame: 'black', rail: 'glass', roof: 'flat', grille: 'wood', awning: false },
  concrete: { name: '清水模', wall: 'concrete', color: '#b9b6b0', frame: 'black', rail: 'iron', roof: 'flat', grille: 'none', awning: false },
  brick: { name: '經典磚', wall: 'tile', color: '#a8644a', frame: 'white', rail: 'solid', roof: 'pitched', grille: 'none', awning: true },
  japan: { name: '日式木', wall: 'paint', color: '#e9e3d6', frame: 'wood', rail: 'iron', roof: 'pitched', grille: 'wood', awning: true },
  stone: { name: '石材輕奢', wall: 'stone', color: '#d9cfbf', frame: 'champagne', rail: 'glass', roof: 'flat', grille: 'alu', awning: false },
};

export function defaultBuilding() {
  return {
    n: 3, hasRoof: true,
    uses: { '1F': 'shop', '2F': 'rent', '3F': 'home', RF: 'roof' },
    plans: {},
    shop: { entry: 'back', scooters: 5, hall: 'living', toilet: true, style: 'nordic' },
    rent: { rooms: 3, style: 'nordic' },
    roof: { rooms: 2, back: 'tatami', front: 'altar', style: 'japandi' },
    home: { '2F': 'e', '3F': 'd', '4F': 'd', '5F': 'd' },
    facade: { preset: 'modern', ...FACADES.modern },
    focus: 'all',
  };
}

export function normalizeBuilding(b) {
  const d = defaultBuilding();
  if (!b) return null;
  const out = { ...d, ...b };
  // 舊資料：roof 曾經是「有沒有頂樓」的布林值
  if (typeof b.roof === 'boolean') { out.hasRoof = b.roof; delete out.roof; }
  if (typeof out.hasRoof !== 'boolean') out.hasRoof = true;
  for (const k of ['uses', 'plans', 'shop', 'rent', 'roof', 'home', 'facade']) out[k] = { ...d[k], ...(typeof b[k] === 'object' && b[k] ? b[k] : {}) };
  out.n = Math.max(1, Math.min(5, out.n | 0 || 3));
  return out;
}

// 樓層清單（含高程）。頂樓的樓板＝最上面一層的天花板。
export function floorList(b, site) {
  const out = [];
  const gH = site.groundH || 465, fH = site.floorH || 350;
  for (let i = 0; i < b.n; i++) {
    const id = `${i + 1}F`;
    out.push({ id, label: id, level: i + 1, elev: i === 0 ? 0 : gH + (i - 1) * fH, h: i === 0 ? gH : fH });
  }
  if (b.hasRoof) out.push({ id: 'RF', label: '頂樓', level: b.n + 1, elev: gH + (b.n - 1) * fH, h: fH, roof: true });
  return out;
}

export function useOf(b, fl) {
  const u = b.uses[fl.id];
  if (fl.roof) return u === 'empty' ? 'empty' : 'roof';
  if (u && u !== 'roof' && (u !== 'shop' || fl.level === 1)) return u;
  return fl.level === 1 ? 'shop' : fl.level === 2 ? 'rent' : 'home';
}

// 每層可以選的用途
export function usesFor(fl) {
  if (fl.roof) return ['roof', 'empty'];
  if (fl.level === 1) return ['shop', 'rent', 'home', 'empty'];
  return ['rent', 'home', 'empty'];
}

// ---------- 方塊合併成外框 ----------
// rects：[[x0,y0,x1,y1],…]，回傳外框多邊形（點序列，已合併共線點）
export function unionOutline(rects) {
  const xs = [...new Set(rects.flatMap((r) => [r[0], r[2]]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap((r) => [r[1], r[3]]))].sort((a, b) => a - b);
  const nx = xs.length - 1, ny = ys.length - 1;
  const cov = new Uint8Array(Math.max(0, nx * ny));
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (rects.some((r) => cx > r[0] && cx < r[2] && cy > r[1] && cy < r[3])) cov[j * nx + i] = 1;
  }
  const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && cov[j * nx + i] === 1;
  const edges = new Map();
  const add = (x0, y0, x1, y1) => { const k = `${x0},${y0}`; if (!edges.has(k)) edges.set(k, []); edges.get(k).push([x1, y1]); };
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    if (!on(i, j)) continue;
    if (!on(i, j - 1)) add(xs[i], ys[j], xs[i + 1], ys[j]);
    if (!on(i + 1, j)) add(xs[i + 1], ys[j], xs[i + 1], ys[j + 1]);
    if (!on(i, j + 1)) add(xs[i + 1], ys[j + 1], xs[i], ys[j + 1]);
    if (!on(i - 1, j)) add(xs[i], ys[j + 1], xs[i], ys[j]);
  }
  let best = [];
  while (edges.size) {
    const [k0] = edges.keys();
    const loop = [];
    let k = k0;
    for (let guard = 0; guard < 10000; guard++) {
      const list = edges.get(k);
      if (!list) break;
      const [x, y] = k.split(',').map(Number);
      loop.push({ x, y });
      const nxt = list.shift();
      if (!list.length) edges.delete(k);
      k = `${nxt[0]},${nxt[1]}`;
      if (k === k0) break;
    }
    if (loop.length > best.length) best = loop;
  }
  // 合併共線點
  const out = [];
  for (let i = 0; i < best.length; i++) {
    const p = best[(i + best.length - 1) % best.length], q = best[i], r = best[(i + 1) % best.length];
    if ((Math.abs(p.x - q.x) < 1e-6 && Math.abs(q.x - r.x) < 1e-6) || (Math.abs(p.y - q.y) < 1e-6 && Math.abs(q.y - r.y) < 1e-6)) continue;
    out.push(q);
  }
  return out;
}

function sharedSegs(A, B) {
  const out = [];
  const sides = (r) => [['h', r[1], r[0], r[2]], ['h', r[3], r[0], r[2]], ['v', r[0], r[1], r[3]], ['v', r[2], r[1], r[3]]];
  for (const [o1, c1, a1, b1] of sides(A)) for (const [o2, c2, a2, b2] of sides(B)) {
    if (o1 !== o2 || Math.abs(c1 - c2) > 0.5) continue;
    const a = Math.max(a1, a2), b = Math.min(b1, b2);
    if (b - a > 1) out.push({ o: o1, c: c1, a, b });
  }
  return out;
}

function subtractIv(iv, cuts) {
  let parts = [iv];
  for (const [c0, c1] of cuts) {
    const nx = [];
    for (const [a, b] of parts) { if (c1 <= a || c0 >= b) nx.push([a, b]); else { if (c0 > a) nx.push([a, c0]); if (c1 < b) nx.push([c1, b]); } }
    parts = nx;
  }
  return parts;
}

const wallIv = (w, o, c, tol = 1) => {
  if (o === 'h' && Math.abs(w.a.y - c) < tol && Math.abs(w.b.y - c) < tol) return [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)];
  if (o === 'v' && Math.abs(w.a.x - c) < tol && Math.abs(w.b.x - c) < tol) return [Math.min(w.a.y, w.b.y), Math.max(w.a.y, w.b.y)];
  return null;
};

// ---------- 由「區塊」組出平面 ----------
// zones：[{ key, rects, name, kind, room?, core?, outdoor?, fur?:[[rectIndex, use, opt]] }]
// links：[{ a, b, type:'door'|'sliding'|'opening'|'open', w, at?, near? }]（a＝被進入的房間，b＝從哪裡進）
function assemble(bb, zones, links, opt = {}) {
  const { W, O, R } = bb;
  const plan = bb.plan;
  const Z = Object.fromEntries(zones.map((z) => [z.key, z]));
  const group = (z) => z.room || z.key;
  const linkOf = (a, b) => links.find((l) => (l.a === a && l.b === b) || (l.a === b && l.b === a));
  // 牆
  const segs = [];
  for (let i = 0; i < zones.length; i++) for (let j = i + 1; j < zones.length; j++) {
    const A = zones[i], B = zones[j];
    if (group(A) === group(B)) continue;
    if (A.core && B.core) continue;
    if (A.outdoor && B.outdoor) continue;
    if (linkOf(A.key, B.key)?.type === 'open') continue;
    for (const ra of A.rects) for (const rb of B.rects) for (const g of sharedSegs(ra, rb)) segs.push({ ...g, pair: [A.key, B.key], ext: !!(A.outdoor || B.outdoor) });
  }
  const pieces = [];
  for (const g of segs) {
    const cuts = plan.walls.map((w) => wallIv(w, g.o, g.c)).filter(Boolean);
    for (const [a, b] of subtractIv([g.a, g.b], cuts)) if (b - a >= 15) pieces.push({ ...g, a, b });
  }
  pieces.sort((p, q) => p.o.localeCompare(q.o) || p.c - q.c || p.a - q.a);
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.o === p.o && Math.abs(last.c - p.c) < 0.5 && p.a - last.b < 1 && last.ext === p.ext) { last.b = Math.max(last.b, p.b); last.parts.push(p); }
    else merged.push({ o: p.o, c: p.c, a: p.a, b: p.b, ext: p.ext, parts: [p] });
  }
  const wallOf = new Map();
  for (const m of merged) {
    const t = m.ext ? 18 : 12;
    const kind = m.ext ? { kind: 'ext' } : {};
    const w = m.o === 'h' ? W(m.a, m.c, m.b, m.c, t, kind) : W(m.c, m.a, m.c, m.b, t, kind);
    for (const p of m.parts) wallOf.set(p, w);
  }
  // 房間
  const roomOf = {};
  const groups = new Map();
  for (const z of zones) {
    if (z.core || z.noRoom) continue;
    const k = group(z);
    if (!groups.has(k)) groups.set(k, { name: z.name, kind: z.kind, rects: [] });
    groups.get(k).rects.push(...z.rects);
  }
  for (const [k, g] of groups) {
    const pts = unionOutline(g.rects);
    R(g.name, g.kind, pts.flatMap((p) => [p.x, p.y]));
    roomOf[k] = plan.rooms[plan.rooms.length - 1];
  }
  // 門
  for (const l of links) {
    if (l.type === 'open') continue;
    const cand = pieces.filter((p) => (p.pair[0] === l.a && p.pair[1] === l.b) || (p.pair[0] === l.b && p.pair[1] === l.a)).sort((x, y) => (y.b - y.a) - (x.b - x.a));
    let p = cand[0];
    if (l.at !== undefined) p = cand.find((q) => l.at > q.a && l.at < q.b) || p;
    if (!p) continue;
    const len = p.b - p.a;
    let dw = l.w || 85;
    if (len < dw + 16) dw = Math.max(65, Math.floor((len - 16) / 5) * 5);
    if (len < dw + 12) continue;
    let ctr;
    if (l.at !== undefined) ctr = Math.max(p.a + 8 + dw / 2, Math.min(p.b - 8 - dw / 2, l.at));
    else if (l.near) {
      const t = p.o === 'h' ? l.near.x : l.near.y;
      ctr = Math.max(p.a + 10 + dw / 2, Math.min(p.b - 10 - dw / 2, t));
    } else if (l.type === 'door') {
      // 靠牆角開（門片打開貼著牆），選離房間中心較遠、離來的方向較近的一端
      const za = Z[l.b];
      const c = za ? rectsCenter(za.rects) : null;
      const e0 = p.a + 10 + dw / 2, e1 = p.b - 10 - dw / 2;
      if (c) { const t = p.o === 'h' ? c.x : c.y; ctr = Math.abs(t - e0) <= Math.abs(t - e1) ? e0 : e1; } else ctr = e0;
    } else ctr = (p.a + p.b) / 2;
    const w = wallOf.get(p);
    const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
    const nrm = { x: -(w.b.y - w.a.y) / L, y: (w.b.x - w.a.x) / L };
    const into = rectsCenter(Z[l.a].rects);
    const pt = p.o === 'h' ? { x: ctr, y: p.c } : { x: p.c, y: ctr };
    const side = (into.x - pt.x) * nrm.x + (into.y - pt.y) * nrm.y >= 0 ? 1 : -1;
    const nearStart = ctr - dw / 2 - p.a < p.b - (ctr + dw / 2);
    const o = l.type === 'door' ? { hinge: nearStart ? 'a' : 'b', side } : { h: l.h || DEFAULTS.doorHeight };
    if (l.shutter) o.shutter = true;
    O(w, ctr, dw, l.type, o);
  }
  return { roomOf, Z };
}

function rectsCenter(rects) {
  let A = 0, x = 0, y = 0;
  for (const r of rects) { const a = (r[2] - r[0]) * (r[3] - r[1]); A += a; x += (r[0] + r[2]) / 2 * a; y += (r[1] + r[3]) / 2 * a; }
  return { x: x / (A || 1), y: y / (A || 1) };
}

// 一個方塊四周的牆、門窗、開放邊（給自動擺家具）
function rectSpec(plan, r, zones, selfKey) {
  const [x0, y0, x1, y1] = r;
  const sides = { N: ['h', y0, x0, x1, -1], S: ['h', y1, x0, x1, 1], W: ['v', x0, y0, y1, -1], E: ['v', x1, y0, y1, 1] };
  const edges = {}, doors = [], windows = [];
  const useAt = (o, c, t, dir) => {
    const p = o === 'h' ? { x: t, y: c + dir * 5 } : { x: c + dir * 5, y: t };
    for (const z of zones) {
      if (z.key === selfKey) continue;
      for (const q of z.rects) if (p.x > q[0] && p.x < q[2] && p.y > q[1] && p.y < q[3]) return z.use || z.kind;
    }
    return null;
  };
  for (const [k, [o, c, lo, hi, dir]] of Object.entries(sides)) {
    const walls = [];
    let t = 12;
    for (const w of plan.walls) {
      // 牆中心線和方塊邊差幾公分（例如電梯牆在 677、隔壁方塊從 684 開始）也算同一面牆
      const iv = wallIv(w, o, c, 9);
      if (!iv) continue;
      const a = Math.max(iv[0], lo), b = Math.min(iv[1], hi);
      if (b - a < 1) continue;
      walls.push([a, b]);
      t = Math.max(t, w.t);
      for (const op of plan.openings) {
        if (op.wall !== w.id) continue;
        const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
        const s = o === 'h' ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y);
        const rev = o === 'h' ? w.b.x < w.a.x : w.b.y < w.a.y;
        const cpos = rev ? s + L - op.pos : s + op.pos;
        const oa = cpos - op.w / 2, ob = cpos + op.w / 2;
        if (ob < lo + 1 || oa > hi - 1) continue;
        if (op.type === 'window') windows.push({ edge: k, a: oa, b: ob, sill: op.sill || 0, h: op.h });
        else doors.push({ edge: k, a: oa, b: ob, kind: op.type === 'elevator' ? 'door' : op.type, nb: useAt(o, c, (oa + ob) / 2, dir) });
      }
    }
    edges[k] = { t, walls, nbs: [] };
    for (const [a, b] of subtractIv([lo, hi], walls)) {
      if (b - a < 50) continue;
      const m = (a + b) / 2, half = Math.min(b - a, 110) / 2;
      doors.push({ edge: k, a: m - half, b: m + half, kind: 'open', nb: useAt(o, c, m, dir) });
    }
  }
  const obstacles = [];
  for (const [ox0, oy0, ox1, oy1] of DUCT_RECTS) if (Math.min(ox1, x1) - Math.max(ox0, x0) > 1 && Math.min(oy1, y1) - Math.max(oy0, y0) > 1) obstacles.push({ x0: ox0, y0: oy0, x1: ox1, y1: oy1 });
  for (const it of plan.items) {
    if (!['scooter', 'tank'].includes(it.kind)) continue;
    const side = it.rot === 90 || it.rot === 270;
    const w = side ? it.d : it.w, d = side ? it.w : it.d;
    obstacles.push({ x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - d / 2, y1: it.y + d / 2 });
  }
  return { rect: { x0, y0, x1, y1 }, edges, doors, windows, obstacles };
}

const DUCT_PTS = DUCT_RECTS.map(([x0, y0, x1, y1]) => ({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }));

function furnishZones(plan, zones, style, extra = {}) {
  const notes = [];
  for (const z of zones) {
    for (const [ri, use, o] of z.fur || []) {
      const r = Array.isArray(ri) ? ri : z.rects[ri];
      const L = new RoomLayout(rectSpec(plan, r, zones, z.key));
      const opt = { style, seats: 4, ducts: DUCT_PTS, backEdge: 'N', ...extra, ...(o || {}) };
      for (const u of String(use).split('+')) furnish(L, u, opt);
      for (const it of L.items) plan.items.push(it);
      for (const n of L.notes) notes.push(`${z.name}：${n}`);
    }
  }
  return notes;
}

const CORE_ZONES = () => [
  { key: 'STAIR', rects: [[361, 0, 600, 483]], core: true, use: 'stair' },
  { key: 'ELEV', rects: [[382, 483, 600, 677]], core: true, use: 'elevator' },
  { key: 'LW', rects: [[0, 684, 178, 899]], core: true, outdoor: true, use: 'void' },
];

// ---------- 一樓 ----------
function core1F(bb, o, H) {
  const { W, O, I, R } = bb;
  const ext = { kind: 'ext' };
  const back = W(0, 0, 600, 0, 18, ext);
  W(0, 0, 0, 1550, 18, ext);
  W(600, 0, 600, 1550, 18, ext);
  const front = W(0, 1550, 600, 1550, 18, ext);
  W(361, 0, 361, 350, 12);
  I('stair', 368, 9, 592, 352, 'S', { risers: Math.round(H / 17.5), style: 'U', h: H, label: '樓梯' });
  R('樓梯間', 'stair', [361, 0, 600, 483]);
  W(382, 483, 382, 677, 15);
  const eTop = W(382, 483, 600, 483, 15);
  const eBot = W(382, 677, 600, 677, 15);
  // 從側邊通道進：電梯一樓開後門（貫通型），面向通道；其他樓層照原本朝樓梯間開
  if (o.entry === 'side') O(eBot, 468, 100, 'elevator'); else O(eTop, 468, 100, 'elevator');
  I('elevator', 398, 492, 583, 662, o.entry === 'side' ? 'S' : 'N', { label: '電梯' });
  R('電梯', 'elevator', [382, 483, 600, 677]);
  W(0, 684, 178, 684, 12);
  const lw = W(178, 684, 178, 899, 12);
  W(0, 899, 178, 899, 12);
  O(lw, 791, 160, 'window', { sill: 100, h: 120 });
  R('天井', 'void', [0, 684, 178, 899]);
  return { back, front };
}

function scooterRow(I, n, { x0, x1, y0, y1, along, avoid = [] }) {
  // along='y'：機車長邊沿 y（靠 x 牆停）；'x'：長邊沿 x（車頭朝左牆）
  let placed = 0;
  const L = 190, Wd = 70, gap = 6;
  let t = along === 'y' ? y0 : y0;
  const hit = (r) => avoid.some((a) => Math.min(a[2], r[2]) - Math.max(a[0], r[0]) > 0 && Math.min(a[3], r[3]) - Math.max(a[1], r[1]) > 0);
  while (placed < n) {
    const r = along === 'y' ? [x1 - Wd, t, x1, t + L] : [x0, t, x0 + L, t + Wd];
    if (r[3] > y1) break;
    if (hit(r)) { t += 2; continue; }
    if (along === 'y') I('scooter', r[0], r[1], r[2], r[3], 'S', { label: '機車' });
    else I('scooter', r[0], r[1], r[2], r[3], 'W', { label: '機車' });
    placed++;
    t += (along === 'y' ? L : Wd) + gap;
  }
  return placed;
}

function planShop(fl, o, style) {
  const H = fl.h;
  const meta = { name: '', style, elevation: fl.elev, floorHeight: H, wallHeight: Math.min(H - 45, 420) };
  const bb = builder(meta);
  const { O, I } = bb;
  const { back, front } = core1F(bb, o, H);
  DUCTS(I);
  const hallName = { living: '一樓大空間', shop: '店面', office: '工作室', empty: '一樓大空間' }[o.hall] || '一樓大空間';
  const zones = CORE_ZONES();
  const links = [];
  let parked = 0, maxPark = 0;
  const toilet = o.toilet !== false;
  if (o.entry === 'side') {
    zones.push(
      { key: 'P', name: '側邊通道・機車', kind: 'hall', use: 'hall', rects: [[382, 677, 600, 1550], [272, 483, 382, 790], [272, 350, 361, 483]] },
      { key: 'K', name: o.hall === 'living' ? '廚房／餐廳' : '後段空間', kind: o.hall === 'living' ? 'kitchen' : 'other', use: o.hall === 'living' ? 'kitchen' : 'storage', rects: [[0, 0, 361, 350], [0, 350, 272, 684]],
        fur: o.hall === 'empty' ? [] : [[1, o.hall === 'living' ? 'kitchen+dining' : 'pantry', { seats: 6, ventEdges: ['N'] }]] },
      { key: 'H', name: hallName, kind: 'living', use: 'living', rects: [[0, 1110, 382, 1550], [178, 790, 382, 1110], [178, 684, 272, 790], ...(toilet ? [] : [[0, 899, 178, 1110]])],
        fur: o.hall === 'empty' ? [] : [[0, { living: 'living', shop: 'shop', office: 'office' }[o.hall], { entrance: { x: 190, y: 1550 } }], [1, o.hall === 'living' ? 'nook' : 'storage']] },
    );
    links.push({ a: 'P', b: 'STAIR', type: 'open' }, { a: 'K', b: 'H', type: 'door', w: 80 }, { a: 'H', b: 'P', type: 'door', w: 90 });
    O(front, 191, 300, 'sliding', { h: 260, shutter: true });
    O(front, 491, 190, 'opening', { h: 250, shutter: true });
    maxPark = 4;
    parked = scooterRow(I, Math.min(o.scooters, maxPark), { x0: 391, x1: 600 - 9 - 3, y0: 686, y1: 1546, along: 'y', avoid: [[543, 897, 591, 955]] });
  } else {
    zones.push(
      { key: 'P', name: '機車停車・梯廳', kind: 'hall', use: 'hall', rects: [[0, 0, 361, 580], [361, 483, 382, 580]] },
      { key: 'H', name: hallName, kind: 'living', use: 'living', rects: [[0, 1110, 600, 1550], [382, 677, 600, 1110], [178, 684, 382, 1110], [0, 580, 382, 684], ...(toilet ? [] : [[0, 899, 178, 1110]])],
        fur: o.hall === 'empty' ? [] : [
          [0, { living: 'living', shop: 'shop', office: 'office' }[o.hall], { entrance: { x: 300, y: 1550 } }],
          [1, o.hall === 'living' ? 'kitchen' : 'pantry'],
          [2, o.hall === 'living' ? 'dining' : o.hall === 'office' ? 'storage' : 'nook', { seats: 6 }],
          [3, 'storage'],
        ] },
    );
    links.push({ a: 'P', b: 'STAIR', type: 'open' }, { a: 'H', b: 'P', type: 'door', w: 90, at: 300 });
    // 鐵捲門（附小門）靠樓梯那一側，左邊整排停機車
    O(back, 282, 150, 'opening', { h: 240, shutter: true });
    O(front, 300, 360, 'sliding', { h: 260, shutter: true });
    maxPark = 7;
    parked = scooterRow(I, Math.min(o.scooters, maxPark), { x0: 9 + 3, x1: 361, y0: 14, y1: 572, along: 'x' });
  }
  if (toilet) {
    zones.push({ key: 'T', name: '廁所', kind: 'bath', use: 'bath', rects: [[0, 899, 178, 1110]], fur: [[0, 'bath', { tub: false }]] });
    links.push({ a: 'T', b: 'H', type: 'door', w: 75 });
  }
  assemble(bb, zones, links);
  const plan = bb.plan;
  return { plan, zones, extra: { parked, maxPark } };
}

// ---------- 出租層 ----------
function planRent(fl, o, style) {
  const meta = { name: '', style, elevation: fl.elev, floorHeight: fl.h, wallHeight: 300 };
  const bb = builder(meta);
  const n = +o.rooms === 2 ? 2 : 3;
  core(bb, { ...meta, lightwell: { right: { w: 160, sill: 100, h: 120 } } });
  DUCTS(bb.I);
  const zones = CORE_ZONES();
  const F = { key: 'F', name: '公共走廊', kind: 'hall', use: 'hall', rects: [[178, 350, 361, 684], [361, 483, 382, 684], [178, 684, 300, 1060], [178, 1060, 420, 1152]], fur: [[0, 'lobby', { entrance: { x: 361, y: 416 } }]] };
  zones.push(F);
  const links = [{ a: 'F', b: 'STAIR', type: 'door', w: 100, at: 416 }];
  const suite = (key, name, rect) => ({ key, name, kind: 'bedroom', use: 'tenant', rects: [rect], fur: [[0, 'tenant']] });
  const bath = (key, name, rect) => ({ key, name, kind: 'bath', use: 'bath', rects: [rect], fur: [[0, 'bath', { tub: false }]] });
  zones.push(suite('R1', '套房 A', [0, 0, 361, 350]), bath('B1', '套房 A 浴室', [0, 350, 178, 684]));
  links.push({ a: 'R1', b: 'F', type: 'door', w: 85 }, { a: 'B1', b: 'R1', type: 'door', w: 75 });
  if (n === 2) {
    zones.push(suite('R2', '套房 B（大）', [0, 1152, 600, 1550]), bath('B3', '套房 B 浴室', [420, 897, 600, 1152]),
      { key: 'B2', name: '套房 B 更衣洗衣', kind: 'storage', use: 'laundry', rects: [[0, 899, 178, 1152]], fur: [[0, 'laundry']] });
    links.push({ a: 'R2', b: 'F', type: 'door', w: 90 }, { a: 'B3', b: 'R2', type: 'door', w: 75 }, { a: 'B2', b: 'R2', type: 'door', w: 75 });
  } else {
    const nm = ['套房 B', '套房 C'];
    zones.push(suite('R2', nm[0], [0, 1152, 300, 1550]), bath('B2', nm[0] + ' 浴室', [0, 899, 178, 1152]),
      suite('R3', nm[1], [300, 1152, 600, 1550]), bath('B3', nm[1] + ' 浴室', [420, 897, 600, 1152]));
    links.push({ a: 'R2', b: 'F', type: 'door', w: 85 }, { a: 'B2', b: 'R2', type: 'door', w: 75 }, { a: 'R3', b: 'F', type: 'door', w: 85 }, { a: 'B3', b: 'R3', type: 'door', w: 75 });
  }
  zones.push(
    { key: 'K', name: '共用茶水洗衣', kind: 'kitchen', use: 'pantry', rects: [[382, 677, 600, 897], [300, 684, 382, 897]], fur: [[[300, 684, 600, 897], 'pantry']] },
    { key: 'S', name: '儲藏', kind: 'storage', use: 'storage', rects: [[300, 897, 420, 1060]], fur: [[0, 'storage']] },
  );
  links.push({ a: 'K', b: 'F', type: 'sliding', w: 100 }, { a: 'S', b: 'F', type: 'door', w: 70 });
  assemble(bb, zones, links);
  return { plan: bb.plan, zones, extra: { rooms: n } };
}

// ---------- 頂樓 ----------
function coreRoof(bb, two) {
  const { W, O, I, R } = bb;
  const ext = { kind: 'ext' }, par = { kind: 'parapet', h: DEFAULTS.parapet };
  W(0, 0, 600, 0, 18, ext);
  W(0, 0, 0, 684, 18, ext);
  W(0, 684, 0, 1550, 18, par);
  const yR = two ? 1100 : 684;
  W(600, 0, 600, yR, 18, ext);
  W(600, yR, 600, 1550, 18, par);
  W(0, 1550, 600, 1550, 18, par);
  W(361, 0, 361, 350, 12);
  W(382, 483, 382, 677, 15);
  const eTop = W(382, 483, 600, 483, 15);
  W(382, 677, 600, 677, 15, two ? {} : ext);
  O(eTop, 468, 100, 'elevator');
  I('elevator', 398, 492, 583, 662, 'N', { label: '電梯' });
  R('樓梯間（屋突）', 'stair', [361, 0, 600, 483]);
  R('電梯（屋突）', 'elevator', [382, 483, 600, 677]);
  W(0, 684, 178, 684, 12);
  W(178, 684, 178, 899, 12, two ? {} : par);
  W(0, 899, 178, 899, 12, par);
  R('天井', 'void', [0, 684, 178, 899]);
}

function planRoof(fl, o, style) {
  const meta = { name: '', style, elevation: fl.elev, floorHeight: fl.h, wallHeight: 300 };
  const bb = builder(meta);
  const two = (+o.rooms || 0) >= 2;
  const none = (+o.rooms || 0) === 0;
  coreRoof(bb, two);
  DUCTS(bb.I);
  const zones = CORE_ZONES();
  const links = [{ a: 'L', b: 'STAIR', type: 'open' }];
  const backR = ROOF_ROOM[o.back] || ROOF_ROOM.tatami;
  const frontR = ROOF_ROOM[o.front] || ROOF_ROOM.altar;
  zones.push({ key: 'L', name: '梯廳', kind: 'hall', use: 'hall', rects: [[178, 400, 361, 684], [361, 483, 382, 684]] });
  if (none) {
    zones.push({ key: 'R1', name: '儲藏室', kind: 'storage', use: 'storage', rects: [[0, 0, 361, 400]], fur: [[0, 'storage']] });
  } else {
    zones.push({ key: 'R1', name: backR.name, kind: backR.kind, use: backR.use, rects: [[0, 0, 361, 400]], fur: [[0, backR.use, { role: 'guest' }]] });
  }
  zones.push({ key: 'B', name: '頂樓浴室', kind: 'bath', use: 'bath', rects: [[0, 400, 178, 684]], fur: [[0, 'bath', { tub: false }]] });
  links.push({ a: 'R1', b: 'L', type: backR.use === 'tatami' ? 'sliding' : 'door', w: backR.use === 'tatami' ? 120 : 85 }, { a: 'B', b: 'L', type: 'door', w: 75 });
  if (two) {
    const r2fur = frontR.use === 'altar' ? [[1, 'altar', { backEdge: 'N' }], [0, 'nook']] : frontR.use === 'tatami' ? [[1, 'tatami'], [0, 'nook']] : [[1, frontR.use], [0, 'nook']];
    zones.push({ key: 'R2', name: frontR.name, kind: frontR.kind, use: frontR.use, rects: [[178, 684, 382, 1100], [382, 677, 600, 1100]], fur: r2fur });
    zones.push({ key: 'T', name: '露台', kind: 'balcony', use: 'terrace', outdoor: true, rects: [[178, 1100, 600, 1550], [0, 899, 178, 1550]], fur: [[0, 'terrace']] });
    links.push({ a: 'R2', b: 'L', type: frontR.use === 'altar' ? 'opening' : 'door', w: frontR.use === 'altar' ? 140 : 90 }, { a: 'T', b: 'R2', type: 'sliding', w: 240 });
  } else {
    zones.push({ key: 'T', name: '露台', kind: 'balcony', use: 'terrace', outdoor: true, rects: [[178, 684, 600, 1550], [0, 899, 178, 1550]], fur: [[0, 'terrace', { near: { x: 300, y: 720 } }]] });
    links.push({ a: 'T', b: 'L', type: 'sliding', w: 160 });
  }
  assemble(bb, zones, links);
  // 水塔放在樓梯間的屋頂上（只在整棟 3D 顯示），露台角落放太陽能熱水器的位置不另外畫
  return { plan: bb.plan, zones, extra: { rooms: two ? 2 : none ? 0 : 1 } };
}

// ---------- 空著 ----------
function planEmpty(fl, style) {
  const meta = { name: '', style, elevation: fl.elev, floorHeight: fl.h, wallHeight: fl.level === 1 ? Math.min(fl.h - 45, 420) : 300 };
  const bb = builder(meta);
  if (fl.level === 1) core1F(bb, { entry: 'back' }, fl.h);
  else if (fl.roof) coreRoof(bb, false);
  else core(bb, { ...meta, lightwell: { right: { w: 160, sill: 100, h: 120 } } });
  DUCTS(bb.I);
  const zones = [...CORE_ZONES(), { key: 'X', name: '（還沒規劃）', kind: fl.roof ? 'balcony' : 'other', outdoor: !!fl.roof, rects: [[0, 0, 361, 684], [361, 483, 382, 684], [178, 684, 600, 1550], [0, 899, 178, 1550]] }];
  assemble(bb, zones, [{ a: 'X', b: 'STAIR', type: 'open' }]);
  return { plan: bb.plan, zones, extra: {} };
}

// ---------- 自住：沿用既有方案 ----------
export function homeSources(project) {
  const builtin = builtinPlans();
  const list = builtin.filter((p) => !['a', 'b', 'c'].includes(p.key)).map((p) => ({ id: p.key, name: p.name, builtin: true, plan: p }));
  for (const p of builtin.filter((q) => ['a', 'b', 'c'].includes(q.key))) list.push({ id: p.key, name: p.name, builtin: true, plan: p });
  for (const p of project?.plans || []) if (!p.floor && !p.key) list.push({ id: p.id, name: p.name, plan: p });
  return list;
}

function planHome(fl, src, project) {
  const list = homeSources(project);
  const s = list.find((x) => x.id === src) || list.find((x) => x.id === 'd') || list[0];
  const p = normalizePlan(clone(s.plan));
  p.elevation = fl.elev;
  p.floorHeight = fl.h;
  delete p.underlay;
  delete p.key;
  return { plan: p, zones: null, extra: { source: s.id, sourceName: s.name } };
}

// ---------- 產生一層 ----------
export function makeFloorPlan(b, fl, site, project) {
  const use = useOf(b, fl);
  let res;
  if (use === 'shop') res = planShop(fl, b.shop, b.shop.style || 'nordic');
  else if (use === 'rent') res = planRent(fl, b.rent, b.rent.style || 'nordic');
  else if (use === 'roof') res = planRoof(fl, b.roof, b.roof.style || 'japandi');
  else if (use === 'home') res = planHome(fl, b.home[fl.id] || 'd', project);
  else res = planEmpty(fl, 'basic');
  const plan = res.plan;
  let notes = [];
  if (res.zones) {
    try { designWindows(plan, site); } catch (e) { console.warn('windows', e); }
    notes = furnishZones(plan, res.zones, plan.style, { accessible: false });
  }
  plan.floor = fl.id;
  plan.name = floorPlanName(b, fl, use, res.extra);
  plan.note = floorNote(b, fl, use, res.extra);
  plan.brief = floorBrief(b, fl, use, res.extra, notes);
  return normalizePlan(plan);
}

export function floorPlanName(b, fl, use, extra = {}) {
  if (use === 'shop') return `${fl.label} ${HALL[b.shop.hall]?.name || '大空間'}${extra.parked ? `＋機車 ${extra.parked} 台` : ''}`;
  if (use === 'rent') return `${fl.label} 出租 ${RENT[extra.rooms || b.rent.rooms]?.name || ''}`;
  if (use === 'roof') {
    const rs = extra.rooms === 0 ? '儲藏' : extra.rooms === 1 ? ROOF_ROOM[b.roof.back]?.name : `${ROOF_ROOM[b.roof.front]?.name}＋${ROOF_ROOM[b.roof.back]?.name}`;
    return `頂樓 ${rs}＋露台`;
  }
  if (use === 'home') return `${fl.label} 自住 · ${(extra.sourceName || '').replace(/^提案 /, '')}`;
  return `${fl.label}（空著）`;
}

function floorNote(b, fl, use, extra) {
  if (use === 'shop') {
    const e = ENTRY[b.shop.entry] || ENTRY.back;
    return `${e.desc}。${extra.maxPark && b.shop.scooters > extra.maxPark ? `這個位置最多停 ${extra.maxPark} 台機車。` : ''}`;
  }
  if (use === 'rent') return RENT[extra.rooms]?.desc + '。從樓梯間進公共走廊，走廊旁是共用茶水洗衣間。';
  if (use === 'roof') return '樓梯間和電梯升到屋頂的部分是「屋突」；房間另外算一層樓地板面積。露台有曬衣架、植栽與戶外桌。';
  if (use === 'home') return `沿用「${extra.sourceName}」，可以到這一層再拖拉修改，或用自動規劃換一個。`;
  return '還沒決定用途。';
}

function floorBrief(b, fl, use, extra, notes) {
  const out = [];
  if (use === 'shop') {
    out.push(b.shop.entry === 'side' ? '樓梯、電梯從右側通道進出，不用經過一樓大空間；電梯一樓開後門（貫通型），面向通道。' : '樓梯、電梯從後巷進出，不用經過一樓大空間；後面是附小門的鐵捲門。');
    out.push(`機車停${b.shop.entry === 'side' ? '側邊通道' : '後段'}：${extra.parked} 台。`);
    out.push('前面落地門外加鐵捲門。大空間與梯廳之間有一扇門，家人也可以直接上樓。');
  }
  if (use === 'rent') {
    out.push('出租大門設在樓梯間旁，房客不會經過自住樓層。');
    out.push('每間套房都有對外窗；浴室靠管道間，排水排風路徑短。');
    out.push('共用茶水洗衣間有水槽、冰箱、洗衣機與烘衣機。');
  }
  if (use === 'roof') {
    out.push('屋突（樓梯間＋電梯）水平投影約 15.8㎡，在「建築面積 1/8，或不超過 18㎡」的範圍內。');
    out.push('頂樓房間不能當屋突申請，要在建照裡算成一層樓（計入容積），不然會是違建。');
  }
  for (const n of notes.slice(0, 3)) out.push(`注意：${n}。`);
  return out;
}

// ---------- 整棟檢查 ----------
// 依內政部 107 年函令：住宅任一樓層分間 6 個以上使用單元（不含客廳、餐廳）或 10 個以上床位，屬 H-1 類組（供公眾使用）；
// 110 年函：整棟同一所有人時各層加總計算。屋突：樓梯間、昇降機間等水平投影合計不超過建築面積 1/8（未達 18㎡ 者得建 18㎡），
// 高度 6 m 以內（有昇降機通達屋頂時 9 m）不計入建築物高度。
export function buildingChecks(b, floors, plansOf, site) {
  const out = [];
  const units = [];
  let beds = 0;
  for (const fl of floors) {
    const p = plansOf(fl);
    if (!p) continue;
    const u = p.rooms.filter((r) => ['bedroom', 'storage'].includes(r.kind) || (r.kind === 'kitchen' && !/茶水|廚房／餐廳/.test(r.name) && hasDoor(p, r))).length;
    units.push({ fl, u });
    beds += p.items.filter((i) => i.kind === 'bed' || i.kind === 'bed_single').length;
  }
  const maxU = Math.max(0, ...units.map((x) => x.u));
  const total = units.reduce((s, x) => s + x.u, 0);
  const rentFloors = floors.filter((fl) => useOf(b, fl) === 'rent');
  if (rentFloors.length) {
    const lvl = maxU >= 6 || total >= 6 || beds >= 10 ? 'warn' : 'ok';
    out.push({ lvl, t: '出租隔間數量', d: `各層有門的房間（臥室、儲藏等）：${units.map((x) => `${x.fl.label} ${x.u}`).join('、')}，合計 ${total} 間；床 ${beds} 張。依內政部函釋，住宅任一層分間 6 間以上或 10 床以上屬 H-1 類組（供公眾使用），要申請室內裝修審查、分間牆用不燃材料；整棟同一所有人時可能各層加總。${lvl === 'warn' ? '這個配置可能適用，請先問建築師。' : ''}` });
  }
  if (b.hasRoof) {
    const fl = floors.find((f) => f.roof);
    const p = fl && plansOf(fl);
    if (p) {
      const proj = p.rooms.filter((r) => ['stair', 'elevator'].includes(r.kind)).reduce((s, r) => s + polygonArea(r.pts) / 1e4, 0);
      const bldg = 6 * 15.5;
      const lim = Math.max(bldg / 8, 18);
      out.push({ lvl: proj <= lim ? 'ok' : 'warn', t: '屋突面積', d: `樓梯間＋電梯約 ${proj.toFixed(1)}㎡；上限為建築面積 1/8（約 ${(bldg / 8).toFixed(1)}㎡），未達 18㎡ 者可以做到 18㎡。高度 6 m 以內（有電梯通到屋頂 9 m）不算樓層高度。` });
      const rooms = p.rooms.filter((r) => !['stair', 'elevator', 'void', 'balcony'].includes(r.kind));
      if (rooms.length) {
        const a = rooms.reduce((s, r) => s + polygonArea(r.pts) / 1e4, 0);
        out.push({ lvl: 'warn', t: '頂樓的房間', d: `頂樓房間約 ${a.toFixed(1)}㎡（${m2ToPing(a).toFixed(1)} 坪）。屋突只能放樓梯、電梯、水塔、機械，房間要在建照裡申請成第 ${b.n + 1} 層並計入容積，沒申請就是違建。` });
      }
    }
  }
  const f1 = floors.find((f) => f.level === 1);
  if (f1 && useOf(b, f1) === 'shop') {
    const p = plansOf(f1);
    const n = p ? p.items.filter((i) => i.kind === 'scooter').length : 0;
    out.push({ lvl: 'ok', t: '上樓不用經過一樓', d: b.shop.entry === 'side' ? '右側通道直通樓梯與電梯；電梯一樓開後門面向通道。' : '後巷進來就是樓梯與電梯；一樓大空間另有門可以上樓。' });
    out.push({ lvl: n >= b.shop.scooters ? 'ok' : 'warn', t: '機車', d: `可以停 ${n} 台${n < b.shop.scooters ? `（想停 ${b.shop.scooters} 台，${b.shop.entry === 'side' ? '側邊通道' : '後段'}只放得下 ${n} 台）` : ''}。` });
  }
  void site;
  return out;
}

// 房間邊界上有沒有門（開放式廚房沒有門，不算一個使用單元）
function hasDoor(p, r) {
  return p.openings.some((o) => {
    if (o.type === 'window') return false;
    const e = openingEnds(p, o);
    if (!e) return false;
    return r.pts.some((q, i) => {
      const n = r.pts[(i + 1) % r.pts.length];
      const dx = n.x - q.x, dy = n.y - q.y;
      const t = Math.max(0, Math.min(1, ((e.c.x - q.x) * dx + (e.c.y - q.y) * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(e.c.x - q.x - dx * t, e.c.y - q.y - dy * t) < 2;
    });
  });
}

// 這層的摘要（給整棟清單用）
export function floorSummary(p) {
  if (!p) return '';
  const indoor = p.rooms.filter((r) => !['balcony', 'void', 'stair', 'elevator'].includes(r.kind)).reduce((s, r) => s + polygonArea(r.pts) / 1e4, 0);
  const beds = p.rooms.filter((r) => r.kind === 'bedroom').length;
  const baths = p.rooms.filter((r) => r.kind === 'bath').length;
  const parts = [];
  if (beds) parts.push(`${beds} 房`);
  if (baths) parts.push(`${baths} 衛`);
  parts.push(`室內 ${m2ToPing(indoor).toFixed(1)} 坪`);
  return parts.join('・');
}

