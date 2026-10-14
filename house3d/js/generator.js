// 依需求自動產生格局。
// 做法：把可以變動的室內切成幾個「格子」（後段、天井兩側、中段、前段…，邊界位置也有幾種選擇），
// 列舉每種房間放進哪個格子的組合，先用面積、採光、管道間、動線、隱私快速打分；
// 分數最高的幾十種再真的蓋出牆、門、依基地條件開窗、擺家具、跑採光模擬與風水檢查，最後挑出彼此不同的前幾名。
import { DEFAULTS, normalizePlan, polygonArea, polygonCentroid, openingEnds, m2ToPing } from './model.js';
import { builder, core, DUCTS, DUCT_RECTS, laundryBack } from './plans.js';
import { RoomLayout, furnish } from './layout.js';
import { makeEnv, openingInfoForProbe, vsc, sunHours, DAYS, designWindows, analyzeDaylight, lineOfSight, dfTarget, sideLabel, floorLabel, bearingOf, dirName } from './site.js';
import { STYLES } from './styles.js';

export const USE = {
  master: { name: '主臥', kind: 'bedroom', min: 9, ideal: 13.5, minW: 280, light: 2.5, bed: true },
  elder: { name: '長輩房', kind: 'bedroom', min: 9, ideal: 12, minW: 290, light: 2.5, bed: true },
  kid: { name: '小孩房', kind: 'bedroom', min: 6.5, ideal: 9, minW: 240, light: 2, bed: true },
  guest: { name: '客房', kind: 'bedroom', min: 6, ideal: 8.5, minW: 230, light: 1.5, bed: true },
  study: { name: '書房', kind: 'bedroom', min: 4.2, ideal: 7, minW: 165, light: 1.5 },
  tatami: { name: '和室', kind: 'bedroom', min: 5, ideal: 7.5, minW: 175, light: 1.5 },
  altar: { name: '神明廳', kind: 'living', min: 6, ideal: 10, minW: 230, light: 1.2 },
  living: { name: '客廳', kind: 'living', min: 10, ideal: 18, minW: 280, light: 3, open: true },
  dining: { name: '餐廳', kind: 'living', min: 4.5, ideal: 7, minW: 200, light: 1, open: true },
  kitchen: { name: '廚房', kind: 'kitchen', min: 4.2, ideal: 7, minW: 165, light: 0.8 },
  bath: { name: '浴室', kind: 'bath', min: 2.8, ideal: 4.2, minW: 140, light: 0 },
  ensuite: { name: '主浴', kind: 'bath', min: 2.8, ideal: 4.5, minW: 140, light: 0, attach: true },
  walkin: { name: '更衣室', kind: 'storage', min: 2, ideal: 4, minW: 140, light: 0, attach: true },
  storage: { name: '儲藏室', kind: 'storage', min: 1.2, ideal: 3, minW: 90, light: 0 },
  family: { name: '起居室', kind: 'living', min: 5, ideal: 9, minW: 200, light: 1, open: true },
  hall: { name: '走道', kind: 'hall', min: 0, ideal: 0, minW: 90, light: 0, open: true },
  entry: { name: '玄關', kind: 'hall', min: 0, ideal: 0, minW: 90, light: 0, open: true },
};
const BEDLIKE = ['master', 'elder', 'kid', 'guest'];
const HABITABLE = ['master', 'elder', 'kid', 'guest', 'study', 'tatami', 'altar', 'living', 'family'];

// 每個格子可以放哪些用途（浴室、廚房必須靠近管道間或外牆）
const ALLOW = {
  B: ['master', 'elder', 'kid', 'guest', 'study', 'tatami', 'altar', 'living', 'dining', 'kitchen', 'family'],
  BL: ['bath', 'ensuite', 'walkin', 'storage', 'study', 'tatami'],
  ML: ['dining', 'living', 'family'],
  MR: ['kitchen', 'bath', 'storage', 'dining', 'living', 'family'],
  L2: ['bath', 'ensuite', 'walkin', 'storage', 'study', 'tatami'],
  CL: ['hall', 'living', 'dining', 'family'],
  CR: ['bath', 'ensuite', 'walkin', 'storage', 'study', 'kitchen', 'living', 'dining', 'family'],
  F1: ['master', 'elder', 'kid', 'guest', 'study', 'tatami', 'altar', 'living', 'family'],
  F2: ['master', 'elder', 'kid', 'guest', 'study', 'tatami', 'altar', 'living', 'family'],
};
const ENTRANCE = { x: 361, y: 416 };
const YM = 957;

export function defaultProgram() {
  return {
    elevation: 465, master: true, masterBath: true, kids: 1, elder: false, guest: false, baths: 2,
    living: true, dining: true, seats: 4, kitchen: 'open', island: false,
    study: false, tatami: false, altar: false, walkin: false, storage: false,
    accessible: false, priority: 'balance', fengshui: true, style: 'japandi',
  };
}

// ---------- 格子 ----------
function rectCell(id, x0, y0, x1, y1) {
  return { id, rect: { x0, y0, x1, y1 }, pts: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }], area: ((x1 - x0) * (y1 - y0)) / 1e4, minW: Math.min(x1 - x0, y1 - y0) };
}
function makeCells(P) {
  const cells = [
    rectCell('B', 0, 0, 361, P.yb),
    rectCell('BL', 0, P.yb, 178, 684),
    (() => {
      const pts = [[178, P.yb], [361, P.yb], [361, 483], [382, 483], [382, 684], [178, 684]].map(([x, y]) => ({ x, y }));
      return { id: 'E', rect: { x0: 178, y0: P.yb, x1: 361, y1: 684 }, pts, area: polygonArea(pts) / 1e4, minW: 183 };
    })(),
    rectCell('ML', 178, 684, 382, YM),
    rectCell('MR', 382, 677, 600, YM),
    rectCell('L2', 0, 899, 178, P.yf),
    rectCell('CL', 178, YM, P.xc, P.yf),
  ];
  if (P.xc < 600) cells.push(rectCell('CR', P.xc, YM, 600, P.yf));
  cells.push(rectCell('F1', 0, P.yf, P.xs, 1550));
  if (P.xs < 600) cells.push(rectCell('F2', P.xs, P.yf, 600, 1550));
  const byId = Object.fromEntries(cells.map((c) => [c.id, c]));
  // 共用邊
  const adj = {};
  for (const c of cells) adj[c.id] = {};
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const segs = sharedSegs(cells[i].pts, cells[j].pts);
    if (!segs.length) continue;
    const len = segs.reduce((s, g) => s + g.b - g.a, 0);
    adj[cells[i].id][cells[j].id] = { segs, len };
    adj[cells[j].id][cells[i].id] = { segs, len };
  }
  return { cells, byId, adj };
}

function sharedSegs(A, B) {
  const out = [];
  const edges = (P) => P.map((p, i) => [p, P[(i + 1) % P.length]]);
  for (const [p, q] of edges(A)) for (const [r, s] of edges(B)) {
    if (Math.abs(p.y - q.y) < 0.5 && Math.abs(r.y - s.y) < 0.5 && Math.abs(p.y - r.y) < 0.5) {
      const a = Math.max(Math.min(p.x, q.x), Math.min(r.x, s.x)), b = Math.min(Math.max(p.x, q.x), Math.max(r.x, s.x));
      if (b - a > 1) out.push({ o: 'h', c: p.y, a, b });
    } else if (Math.abs(p.x - q.x) < 0.5 && Math.abs(r.x - s.x) < 0.5 && Math.abs(p.x - r.x) < 0.5) {
      const a = Math.max(Math.min(p.y, q.y), Math.min(r.y, s.y)), b = Math.min(Math.max(p.y, q.y), Math.max(r.y, s.y));
      if (b - a > 1) out.push({ o: 'v', c: p.x, a, b });
    }
  }
  return out;
}

// ---------- 採光來源 ----------
function sourcesOf(cell, P, site) {
  const r = cell.rect, s = [];
  const L = site.sides.left.type !== 'party', Rt = site.sides.right.type !== 'party';
  const id = cell.id;
  if (id === 'B') { s.push({ key: 'back', a: 0, b: Math.min(r.x1, 354) }); if (L) s.push({ key: 'left', a: 0, b: r.y1 }); }
  if (id === 'BL') { s.push({ key: 'lwTop', a: 0, b: 178 }); if (L) s.push({ key: 'left', a: r.y0, b: 684 }); }
  if (id === 'ML') s.push({ key: 'lw', a: 0, b: 215 });
  if (id === 'MR' && Rt) s.push({ key: 'right', a: 677, b: YM });
  if (id === 'L2') { s.push({ key: 'lwBot', a: 0, b: 178 }); if (L) s.push({ key: 'left', a: 899, b: r.y1 }); }
  if (id === 'CL' && P.xc >= 600 && Rt) s.push({ key: 'right', a: YM, b: r.y1 });
  if (id === 'CR' && Rt) s.push({ key: 'right', a: YM, b: r.y1 });
  if (id === 'F1') { s.push({ key: 'front', a: 0, b: r.x1 }); if (L) s.push({ key: 'left', a: r.y0, b: 1550 }); if (P.xs >= 600 && Rt) s.push({ key: 'right', a: r.y0, b: 1550 }); }
  if (id === 'F2') { s.push({ key: 'front', a: r.x0, b: 600 }); if (Rt) s.push({ key: 'right', a: r.y0, b: 1550 }); }
  return s;
}

function corePlan(elev) {
  const meta = { name: '_', elevation: elev, floorHeight: 350, wallHeight: 300 };
  const b = builder(meta);
  core(b, { ...meta, lightwell: { right: { w: 190, sill: 50, h: 180 } } });
  return b.plan;
}

function coreWallKey(plan) {
  const find = (f) => plan.walls.find(f);
  return {
    back: find((w) => w.kind === 'ext' && Math.abs(w.a.y) < 1 && Math.abs(w.b.y) < 1 && Math.abs(w.b.x - w.a.x) > 500),
    front: find((w) => w.kind === 'ext' && Math.abs(w.a.y - 1550) < 1 && Math.abs(w.b.y - 1550) < 1),
    left: find((w) => w.kind === 'ext' && Math.abs(w.a.x) < 1 && Math.abs(w.b.x) < 1 && Math.abs(w.b.y - w.a.y) > 1000),
    right: find((w) => w.kind === 'ext' && Math.abs(w.a.x - 600) < 1 && Math.abs(w.b.x - 600) < 1),
    lwTop: find((w) => Math.abs(w.a.y - 684) < 1 && Math.abs(w.b.y - 684) < 1 && w.b.x <= 179),
    lw: find((w) => Math.abs(w.a.x - 178) < 1 && Math.abs(w.b.x - 178) < 1 && Math.abs(w.a.y - 684) < 1),
    lwBot: find((w) => Math.abs(w.a.y - 899) < 1 && Math.abs(w.b.y - 899) < 1 && w.b.x <= 179),
  };
}

// 某面牆某一段開一扇窗的條件（天空、冬至日照、西曬）
function makeProbe(site, elev) {
  const plan = corePlan(elev);
  const env = makeEnv(plan, site);
  const walls = coreWallKey(plan);
  const cache = new Map();
  return (key, a, b) => {
    const w = walls[key];
    if (!w) return null;
    const pos = (a + b) / 2;
    const ck = key + ':' + Math.round(pos / 20);
    if (cache.has(ck)) return cache.get(ck);
    const width = Math.max(60, Math.min(150, b - a - 30));
    const info = openingInfoForProbe(env, { id: '_p', wall: w.id, type: 'window', pos, w: width, sill: 90, h: 140 });
    let res = null;
    if (info && !info.party) {
      res = { vsc: vsc(info), sunW: sunHours(env, info, DAYS.winter[0]), west: sunHours(env, info, DAYS.summer[0], 13, 18.5), bearing: bearingOf(site, info.n.x, info.n.y), side: info.side };
    }
    cache.set(ck, res);
    return res;
  };
}

// ---------- 需求 → 房間清單 ----------
function requiredRooms(pg) {
  const R = [];
  if (pg.living) R.push({ use: 'living' });
  if (pg.kitchen !== 'none') R.push({ use: 'kitchen' });
  if (pg.master) R.push({ use: 'master' });
  if (pg.elder) R.push({ use: 'elder' });
  for (let i = 0; i < (pg.kids || 0); i++) R.push({ use: 'kid' });
  if (pg.guest) R.push({ use: 'guest' });
  if (pg.altar) R.push({ use: 'altar' });
  if (pg.tatami) R.push({ use: 'tatami' });
  if (pg.study) R.push({ use: 'study' });
  if (pg.dining) R.push({ use: 'dining' });
  const ens = pg.master && pg.masterBath && pg.baths > 0 ? 1 : 0;
  if (ens) R.push({ use: 'ensuite', parent: R.findIndex((r) => r.use === 'master') });
  for (let i = 0; i < Math.max(0, (pg.baths || 0) - ens); i++) R.push({ use: 'bath' });
  if (pg.walkin) R.push({ use: 'walkin', parent: R.findIndex((r) => BEDLIKE.includes(r.use)) });
  if (pg.storage) R.push({ use: 'storage' });
  return R;
}

export function capacityCheck(pg, site) {
  const beds = (pg.master ? 1 : 0) + (pg.elder ? 1 : 0) + (pg.kids || 0) + (pg.guest ? 1 : 0);
  const big = beds + (pg.tatami ? 1 : 0) + (pg.altar ? 1 : 0) + (pg.living ? 1 : 0);
  const msgs = [];
  if (beds > 3) msgs.push(`這一層扣掉樓梯、電梯、天井後約 26 坪，能開窗的大房間位置只有後段 1 間與前段 2 間，最多放 3 間臥室（另可加 1 間小書房）。想要 ${beds} 房，可以把部分臥室放到其他樓層。`);
  else if (big > 4) msgs.push('臥室、客廳、和室、神明廳加起來超過 4 間大房間，有的會被排到沒有窗的中間區域；可以考慮把其中一項放到其他樓層。');
  if ((pg.baths || 0) > 3) msgs.push('這層只有 3 個管道間，最多 3 間衛浴。');
  if (pg.island && pg.kitchen === 'none') msgs.push('沒有廚房就不會有中島。');
  void site;
  return msgs;
}

const RELAX = [
  ['書房', (p) => p.study && { ...p, study: false }],
  ['儲藏室', (p) => p.storage && { ...p, storage: false }],
  ['更衣室', (p) => p.walkin && { ...p, walkin: false }],
  ['和室', (p) => p.tatami && { ...p, tatami: false }],
  ['客房', (p) => p.guest && { ...p, guest: false }],
  ['獨立餐廳', (p) => p.dining && { ...p, dining: false }],
  ['一間衛浴', (p) => p.baths > 1 && { ...p, baths: p.baths - 1 }],
  ['神明廳', (p) => p.altar && { ...p, altar: false }],
  ['一間小孩房', (p) => p.kids > 0 && { ...p, kids: p.kids - 1 }],
];

function explainFail(pg) {
  const beds = (pg.master ? 1 : 0) + (pg.elder ? 1 : 0) + (pg.kids || 0) + (pg.guest ? 1 : 0);
  const out = [];
  if (beds >= 3 && (pg.altar || pg.tatami)) out.push('3 間臥室已經用掉後段與前段所有能開窗的位置，神明廳或和室沒有地方放；可以改放到別層，或少一間臥室。');
  if (beds >= 3 && pg.walkin) out.push('3 房時沒有多的空間做更衣室，可以改成大衣櫃。');
  if ((pg.baths || 0) >= 3 && beds >= 3) out.push('3 房 3 衛時，管道間旁的位置不夠同時放下浴室與其他需求。');
  if (!out.length) out.push('找不到同時滿足這些需求的格局，試著減少房間數、衛浴數或其他空間。');
  return out;
}

// ---------- 列舉 ----------
const PARAMS = [];
for (const yb of [350, 417.5]) for (const yf of [1152, 1231]) for (const xc of [300, 416, 600]) for (const xs of [300, 600]) PARAMS.push({ yb, yf, xc, xs });

function enumerate(pg, site, probe, P, out, limit = 4000) {
  const { cells, byId, adj } = makeCells(P);
  const rooms = requiredRooms(pg);
  const src = Object.fromEntries(cells.map((c) => [c.id, sourcesOf(c, P, site).map((s) => ({ ...s, q: probe(s.key, s.a, s.b) })).filter((s) => s.q)]));
  const assign = {}; // cellId → [use...]
  const roomCell = [];
  const free = (id) => !assign[id];
  const cand = (rm, i) => {
    const U = USE[rm.use];
    const list = [];
    if (U.attach) {
      const pc = roomCell[rm.parent];
      if (!pc) return list;
      for (const [nid, a] of Object.entries(adj[pc])) {
        if (!free(nid) || !ALLOW[nid]?.includes(rm.use) || a.len < 100) continue;
        list.push(nid);
      }
      return list;
    }
    for (const c of cells) {
      if (c.id === 'E') continue;
      if (rm.use === 'dining' && assign[c.id]) {
        const u = assign[c.id];
        if ((u.includes('kitchen') && c.id === 'B') || (u.includes('living') && c.area >= 19 && ['F1', 'B'].includes(c.id))) list.push(c.id);
        continue;
      }
      if (!free(c.id) || !ALLOW[c.id]?.includes(rm.use)) continue;
      if (c.area < U.min * 0.92 || c.minW < U.minW * 0.95) continue;
      if (BEDLIKE.includes(rm.use) && !src[c.id].length) continue; // 臥室一定要能開窗
      list.push(c.id);
    }
    void i;
    return list;
  };
  let count = 0;
  const rec = (i) => {
    if (count > limit) return;
    if (i === rooms.length) {
      const sol = finalize(pg, site, P, cells, byId, adj, assign, src);
      count++;
      if (sol) out.push(sol);
      return;
    }
    const rm = rooms[i];
    for (const cid of cand(rm, i)) {
      (assign[cid] ||= []).push(rm.use);
      roomCell[i] = cid;
      rec(i + 1);
      assign[cid].pop();
      if (!assign[cid].length) delete assign[cid];
      roomCell[i] = undefined;
    }
  };
  rec(0);
}

const OPEN_USES = (pg) => ['entry', 'hall', 'living', 'dining', 'family', ...(pg.kitchen === 'open' ? ['kitchen'] : [])];

function finalize(pg, site, P, cells, byId, adj, assign0, src) {
  const assign = {};
  for (const [k, v] of Object.entries(assign0)) assign[k] = [...v];
  const filler = {};
  assign.E = ['entry'];
  for (const c of cells) {
    if (assign[c.id]) continue;
    let u;
    if (c.id === 'CL') u = 'hall';
    else if (c.id === 'ML') u = 'family';
    else if (c.id === 'BL') u = assign.B && BEDLIKE.includes(assign.B[0]) ? 'walkin' : 'storage';
    else if (c.id === 'L2') u = assign.F1 && BEDLIKE.includes(assign.F1[0]) ? 'walkin' : 'storage';
    else if (c.id === 'MR' || c.id === 'CR') u = 'storage';
    else u = 'family';
    assign[c.id] = [u];
    filler[c.id] = true;
  }
  const open = OPEN_USES(pg);
  const isOpen = (id) => open.includes(assign[id][0]);
  // 動線：開放空間要能從玄關走到
  const seen = new Set(['E']);
  const stack = ['E'];
  while (stack.length) {
    const id = stack.pop();
    for (const [n, a] of Object.entries(adj[id])) if (!seen.has(n) && isOpen(n) && a.len >= 90) { seen.add(n); stack.push(n); }
  }
  for (const c of cells) if (isOpen(c.id) && !seen.has(c.id)) return null;
  // 每個封閉房間要有門
  const access = {};
  const rank = { entry: 0, hall: 0, dining: 1, family: 1, living: 2, kitchen: 3 };
  for (const c of cells) {
    if (isOpen(c.id)) continue;
    const u = assign[c.id][0];
    let best = null;
    for (const [n, a] of Object.entries(adj[c.id])) {
      if (a.len < 100) continue;
      let r = null;
      if (USE[u].attach || (filler[c.id] && u === 'walkin')) { if (BEDLIKE.includes(assign[n][0])) r = 0; }
      else if (isOpen(n) && seen.has(n)) r = rank[assign[n][0]] ?? 4;
      if (r === null) continue;
      if (!best || r < best.r || (r === best.r && a.len > best.len)) best = { id: n, r, len: a.len };
    }
    if (!best) {
      if (filler[c.id] && u === 'walkin') {
        // 退回儲藏室，從公共空間進出
        assign[c.id] = ['storage'];
        for (const [n, a] of Object.entries(adj[c.id])) if (a.len >= 100 && isOpen(n) && seen.has(n)) { best = { id: n, r: 1, len: a.len }; break; }
      }
      if (!best) { if (filler[c.id]) { assign[c.id] = ['_void']; continue; } return null; }
    }
    access[c.id] = best.id;
  }
  // ---- 快速評分 ----
  let s = 0;
  const notes = [];
  const areaOf = (id, u) => {
    const c = byId[id];
    const list = assign[id];
    if (list.length === 1) return c.area;
    if (u === 'kitchen') return c.area * 0.45;
    if (u === 'dining') return c.area * (list.includes('kitchen') ? 0.55 : 0.32);
    if (u === 'living') return c.area * 0.68;
    return c.area / list.length;
  };
  const qOf = (id) => {
    const ss = src[id] || [];
    if (!ss.length) return null;
    let best = null;
    for (const x of ss) if (!best || x.q.vsc > best.vsc) best = x.q;
    return best;
  };
  let hallA = 0, total = 0;
  for (const c of cells) {
    total += c.area;
    for (const u of assign[c.id]) {
      if (u === '_void') continue;
      const U = USE[u];
      if (u === 'hall' || u === 'entry') { hallA += c.area; continue; }
      const A = areaOf(c.id, u);
      if (U.min) {
        if (A < U.min) s -= 3 + (6 * (U.min - A)) / U.min;
        else s -= Math.min(1.5, (Math.abs(A - U.ideal) / U.ideal) * 1.2);
      }
      const q = qOf(c.id);
      if (U.light) {
        if (q) s += U.light * (Math.min(q.vsc, 36) / 30 - 0.25);
        else if (HABITABLE.includes(u)) s -= U.light * 2.2;
        else s -= U.light * 0.8;
      }
      if (q && ['living', 'master', 'elder', 'kid'].includes(u)) s += Math.min(q.sunW, 4) * (u === 'living' ? 0.3 : 0.15);
      if (q && q.west > 1.5 && q.bearing > 200 && q.bearing < 340 && BEDLIKE.includes(u)) s -= 0.4;
      if (BEDLIKE.includes(u)) {
        const front = c.id === 'F1' || c.id === 'F2';
        const busy = site.sides.front.type === 'road';
        if (front && busy) s -= pg.priority === 'quiet' ? 1.2 : 0.35;
        if (c.id === 'B' && pg.priority === 'quiet') s += 0.6;
        if (front && pg.priority === 'light') s += 0.6;
        const acc = access[c.id];
        if (acc && ['living', 'kitchen'].includes(assign[acc][0])) s -= 0.6;
      }
      if (u === 'living') s += ['F1', 'F2'].includes(c.id) ? 1.4 : c.id === 'B' ? 0.3 : c.id === 'CL' ? -1 : 0;
      if (u === 'kitchen') s += c.id === 'B' ? 0.5 : c.id === 'MR' ? 0.5 : 0;
      if ((u === 'bath') && c.id === 'MR') s -= pg.fengshui ? 1.4 : 0.6;
      if (u === 'ensuite' && c.id === 'BL') s += 0.4;
      if (filler[c.id] && (c.id === 'B' || c.id === 'F1' || c.id === 'F2')) s -= 2.5;
      if (filler[c.id] && u === 'family' && c.id === 'ML') s -= 0.2;
    }
  }
  s -= (hallA / total) * 6;
  // 餐廳靠近廚房
  const cellOf = (u) => cells.find((c) => assign[c.id].includes(u))?.id;
  const kc = cellOf('kitchen'), dc = cellOf('dining'), lc = cellOf('living');
  if (kc && dc) s += kc === dc ? 1 : adj[kc][dc]?.len >= 100 ? (pg.kitchen === 'open' ? 1.2 : 0.8) : -1.6;
  if (lc && dc && lc !== dc && adj[lc][dc]?.len >= 100) s += 0.5;
  // 長輩：浴室要近
  const ec = cellOf('elder');
  if (ec) {
    const near = Object.entries(adj[ec]).some(([n, a]) => a.len >= 100 && ['bath', 'ensuite'].includes(assign[n][0]));
    const sameHall = cells.some((c) => assign[c.id][0] === 'bath' && access[c.id] && access[c.id] === access[ec]);
    s += near ? 2 : sameHall ? 1 : -2;
  }
  // 後陽台（洗衣）要穿過臥室
  if (BEDLIKE.includes(assign.B[0]) || ['study', 'tatami', 'altar'].includes(assign.B[0])) { s -= 0.7; notes.push('laundryThroughRoom'); }
  // 主臥套房在一起
  return { P, assign, access, filler, s, notes, sig: cells.map((c) => c.id + ':' + assign[c.id].join('+')).join('|') };
}

// ---------- 蓋出平面 ----------
const DOOR = {
  master: ['door', 90], elder: ['sliding', 100], kid: ['door', 85], guest: ['door', 85], study: ['door', 85], tatami: ['sliding', 140], altar: ['opening', 140],
  bath: ['door', 75], ensuite: ['sliding', 80], walkin: ['opening', 80], storage: ['door', 75], kitchen: ['sliding', 130], family: ['door', 85],
};

export function buildPlan(sol, pg, site, { index = 1 } = {}) {
  const P = sol.P;
  const { cells, byId, adj } = makeCells(P);
  const meta = { name: `自動方案 ${index}`, style: pg.style, elevation: pg.elevation, floorHeight: 350, wallHeight: 300 };
  const b = builder(meta);
  const { W, O, I, R } = b;
  core(b, { ...meta, lightwell: { right: { w: 190, sill: 50, h: 180 } } });
  DUCTS(I);
  laundryBack(I);
  const plan = b.plan;
  const coreWalls = plan.walls.slice();
  const assign = sol.assign;
  const open = OPEN_USES(pg);
  const useOf = (id) => assign[id]?.[0];
  const isOpen = (id) => open.includes(useOf(id));
  const live = cells.filter((c) => useOf(c.id) !== '_void');
  // 房間
  const counts = {};
  for (const c of live) for (const u of assign[c.id]) counts[USE[u].name] = (counts[USE[u].name] || 0) + 1;
  const seq = {};
  const roomOf = {};
  for (const c of live) {
    const us = assign[c.id];
    let name, kind;
    if (us.length > 1) {
      if (us.includes('kitchen')) { name = '廚房／餐廳'; kind = 'kitchen'; } else { name = '客餐廳'; kind = 'living'; }
    } else {
      const U = USE[us[0]];
      name = c.id === 'ML' && us[0] === 'family' ? '起居區' : U.name;
      kind = U.kind;
      if (counts[U.name] > 1 && !['走道'].includes(U.name)) { seq[U.name] = (seq[U.name] || 0) + 1; name += ' ' + seq[U.name]; }
    }
    R(name, kind, c.pts.flatMap((p) => [p.x, p.y]));
    roomOf[c.id] = plan.rooms[plan.rooms.length - 1];
  }
  // 牆：兩格屬於不同房間、且至少一邊是封閉空間
  const segs = [];
  for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
    const A = cells[i], B = cells[j];
    const a = adj[A.id][B.id];
    if (!a) continue;
    const voidA = useOf(A.id) === '_void', voidB = useOf(B.id) === '_void';
    if (voidA && voidB) continue;
    if (isOpen(A.id) && isOpen(B.id)) continue;
    for (const g of a.segs) segs.push({ ...g, pair: [A.id, B.id] });
  }
  // 後段與樓梯間之間
  if (P.yb > 360 && !isOpen('B')) segs.push({ o: 'v', c: 361, a: 350, b: P.yb, pair: ['B', 'STAIR'] });
  // 扣掉核心既有的牆
  const coreIv = (o, c) => coreWalls.filter((w) => (o === 'h' ? Math.abs(w.a.y - c) < 1 && Math.abs(w.b.y - c) < 1 : Math.abs(w.a.x - c) < 1 && Math.abs(w.b.x - c) < 1))
    .map((w) => (o === 'h' ? [Math.min(w.a.x, w.b.x), Math.max(w.a.x, w.b.x)] : [Math.min(w.a.y, w.b.y), Math.max(w.a.y, w.b.y)]));
  const pieces = [];
  for (const g of segs) {
    let parts = [[g.a, g.b]];
    for (const [c0, c1] of coreIv(g.o, g.c)) {
      const nx = [];
      for (const [a, b2] of parts) { if (c1 <= a || c0 >= b2) nx.push([a, b2]); else { if (c0 > a) nx.push([a, c0]); if (c1 < b2) nx.push([c1, b2]); } }
      parts = nx;
    }
    for (const [a, b2] of parts) if (b2 - a >= 15) pieces.push({ o: g.o, c: g.c, a, b: b2, pair: g.pair });
  }
  // 共線相接的合併成一道牆
  pieces.sort((p, q) => (p.o + p.c).localeCompare(q.o + q.c) || p.o.localeCompare(q.o) || p.c - q.c || p.a - q.a);
  const merged = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.o === p.o && Math.abs(last.c - p.c) < 0.5 && p.a - last.b < 1) { last.b = Math.max(last.b, p.b); last.parts.push(p); }
    else merged.push({ o: p.o, c: p.c, a: p.a, b: p.b, parts: [p] });
  }
  const wallOfPart = new Map();
  for (const m of merged) {
    const w = m.o === 'h' ? W(m.a, m.c, m.b, m.c, 12) : W(m.c, m.a, m.c, m.b, 12);
    for (const p of m.parts) wallOfPart.set(p, w);
  }
  // 門
  const doors = [];
  for (const c of live) {
    const acc = sol.access[c.id];
    if (!acc || isOpen(c.id)) continue;
    const u = useOf(c.id);
    let [type, dw] = DOOR[u] || ['door', 85];
    if (pg.accessible && ['bath', 'ensuite', 'master', 'elder', 'kid', 'guest'].includes(u)) { type = 'sliding'; dw = Math.max(dw, 90); }
    const cand = pieces.filter((p) => (p.pair[0] === c.id && p.pair[1] === acc) || (p.pair[1] === c.id && p.pair[0] === acc)).sort((a, b2) => (b2.b - b2.a) - (a.b - a.a));
    const p = cand[0];
    if (!p) continue;
    const len = p.b - p.a;
    if (len < dw + 20) dw = Math.max(65, Math.floor((len - 20) / 5) * 5);
    if (len < dw + 20) continue;
    const anchor = acc === 'E' ? ENTRANCE : polygonCentroid(byId[acc].pts);
    const parentDoor = USE[u]?.attach || u === 'walkin' ? doors.find((d) => d.cell === acc) : null;
    const opts = [p.a + 12 + dw / 2, p.b - 12 - dw / 2];
    if (type === 'opening' || type === 'sliding') opts.push((p.a + p.b) / 2);
    let best = null;
    for (const ctr of opts) {
      const pt = p.o === 'h' ? { x: ctr, y: p.c } : { x: p.c, y: ctr };
      let sc = -Math.hypot(pt.x - anchor.x, pt.y - anchor.y) / 100;
      // 套房浴室、更衣室的門離臥室房門遠一點，床才有完整的牆可靠
      if (parentDoor) { const pp = parentDoor.o === 'h' ? { x: parentDoor.ctr, y: parentDoor.c } : { x: parentDoor.c, y: parentDoor.ctr }; sc = Math.hypot(pt.x - pp.x, pt.y - pp.y) / 100; }
      // 不要正對其他門
      for (const d of doors) if (d.o === p.o && Math.abs(d.c - p.c) < 260 && Math.abs(d.ctr - ctr) < (d.w + dw) / 2 - 10 && d.c !== p.c) sc -= 1.5;
      if (!best || sc > best.sc) best = { ctr, sc, pt };
    }
    const w = wallOfPart.get(p);
    const wf = { x: w.b.x - w.a.x, y: w.b.y - w.a.y };
    const L = Math.hypot(wf.x, wf.y);
    const n = { x: -wf.y / L, y: wf.x / L };
    const cc = polygonCentroid(c.pts);
    const side = (cc.x - best.pt.x) * n.x + (cc.y - best.pt.y) * n.y >= 0 ? 1 : -1;
    const nearStart = Math.abs(best.ctr - (p.a + 12 + dw / 2)) < 1;
    // 牆的 a 端在 p.a 那一側（牆都是由小到大建立）
    const opt = type === 'door' ? { hinge: nearStart ? 'a' : 'b', side } : { h: DEFAULTS.doorHeight };
    O(w, best.ctr, dw, type, opt);
    doors.push({ o: p.o, c: p.c, ctr: best.ctr, w: dw, cell: c.id, use: u });
  }
  // 開窗：依基地條件
  const winRes = designWindows(plan, site);
  // 家具
  const layouts = {};
  const allNotes = [];
  for (const c of live) {
    const us = assign[c.id];
    if (us[0] === '_void') continue;
    const L = new RoomLayout(roomSpec(plan, c, cells, adj, assign));
    const opt = {
      style: pg.style, seats: pg.seats || 4, island: !!pg.island, accessible: pg.accessible || us[0] === 'elder',
      tub: us[0] === 'ensuite' ? byId[c.id].area >= 5 : byId[c.id].area >= 5.6,
      ducts: DUCT_RECTS.map(([x0, y0, x1, y1]) => ({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 })),
      ventEdges: c.id === 'B' ? ['N'] : [],
      entrance: c.id === 'E' ? ENTRANCE : null,
      backEdge: c.id.startsWith('F') ? 'N' : 'S',
      guest: us[0] === 'study' && !!pg.studyGuest,
    };
    for (const u of us) furnish(L, sol.filler[c.id] && u === 'family' && c.id === 'ML' ? 'nook' : u, opt);
    for (const it of L.items) plan.items.push(it);
    layouts[c.id] = L;
    for (const n of L.notes) allNotes.push(`${roomOf[c.id]?.name}：${n}`);
  }
  // 前陽台植栽
  I('plant', 130, 1662, 175, 1707);
  I('plant', 420, 1662, 465, 1707);
  return { plan: normalizePlan(plan), layouts, doors, winRes, notes: allNotes, roomOf, cells, byId, adj };
}

// 房間四周的牆、門窗、障礙物，給擺家具用
function roomSpec(plan, c, cells, adj, assign) {
  const r = c.rect;
  const sides = { N: ['h', r.y0, r.x0, r.x1], S: ['h', r.y1, r.x0, r.x1], W: ['v', r.x0, r.y0, r.y1], E: ['v', r.x1, r.y0, r.y1] };
  const edges = {}, doors = [], windows = [];
  for (const [k, [o, cc, lo, hi]] of Object.entries(sides)) {
    const walls = [];
    let t = 12;
    for (const w of plan.walls) {
      if (w.kind === 'parapet') continue;
      const on = o === 'h' ? Math.abs(w.a.y - cc) < 1 && Math.abs(w.b.y - cc) < 1 : Math.abs(w.a.x - cc) < 1 && Math.abs(w.b.x - cc) < 1;
      if (!on) continue;
      const a = o === 'h' ? Math.min(w.a.x, w.b.x) : Math.min(w.a.y, w.b.y), b = o === 'h' ? Math.max(w.a.x, w.b.x) : Math.max(w.a.y, w.b.y);
      const a2 = Math.max(a, lo), b2 = Math.min(b, hi);
      if (b2 - a2 < 1) continue;
      walls.push([a2, b2]);
      t = Math.max(t, w.t);
      for (const op of plan.openings) {
        if (op.wall !== w.id) continue;
        const e = openingEnds(plan, op);
        const oa = o === 'h' ? Math.min(e.a.x, e.b.x) : Math.min(e.a.y, e.b.y), ob = o === 'h' ? Math.max(e.a.x, e.b.x) : Math.max(e.a.y, e.b.y);
        if (ob < lo + 1 || oa > hi - 1) continue;
        if (op.type === 'window') windows.push({ edge: k, a: oa, b: ob, sill: op.sill || 0, h: op.h });
        else {
          let nb = null;
          for (const [nid, a] of Object.entries(adj[c.id])) for (const g of a.segs) if (g.o === o && Math.abs(g.c - cc) < 1 && g.b > oa && g.a < ob) nb = assign[nid]?.[0];
          doors.push({ edge: k, a: oa, b: ob, kind: op.type, nb });
        }
      }
    }
    // 鄰接用途
    const nbs = [];
    for (const [nid, a] of Object.entries(adj[c.id])) for (const g of a.segs) if (g.o === o && Math.abs(g.c - cc) < 1) nbs.push({ a: g.a, b: g.b, use: assign[nid]?.[0] });
    edges[k] = { t, walls, nbs };
  }
  // 開放邊上要保留通道：與其他開放格子相接的段落
  const obstacles = [];
  for (const [x0, y0, x1, y1] of DUCT_RECTS) {
    const o = { x0, y0, x1, y1 };
    if (Math.min(o.x1, r.x1) - Math.max(o.x0, r.x0) > 1 && Math.min(o.y1, r.y1) - Math.max(o.y0, r.y0) > 1) obstacles.push(o);
  }
  // 開放邊視為「門」：前面留走道
  for (const [k, e] of Object.entries(edges)) {
    const [, , lo, hi] = sides[k];
    for (const n of e.nbs) {
      const openAlong = subtractIv([n.a, n.b], e.walls);
      for (const [a, b] of openAlong) if (b - a >= 80) doors.push({ edge: k, a: (a + b) / 2 - 40, b: (a + b) / 2 + 40, kind: 'open' });
    }
    void lo; void hi;
  }
  return { rect: r, edges, doors, windows, obstacles };
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

// ---------- 詳細評估 ----------
function evaluate(built, sol, pg, site) {
  const { plan, layouts, doors, roomOf } = built;
  const dl = analyzeDaylight(plan, site, { step: 40 });
  const env = dl.env;
  let s = sol.s;
  const good = [], warn = [], fs = [];
  const roomDL = Object.fromEntries(dl.rooms.map((r) => [r.id, r]));
  const habit = [];
  for (const [cid, room] of Object.entries(roomOf)) {
    const us = sol.assign[cid];
    const u = us[0];
    const d = roomDL[room.id];
    if (!d) continue;
    if (HABITABLE.includes(u) || u === 'kitchen' || u === 'dining') {
      const tgt = dfTarget(room.kind) || 1;
      const w = USE[u]?.light || 1;
      s += w * 1.4 * (Math.min(d.df / tgt, 1.3) - 0.65);
      if (HABITABLE.includes(u)) habit.push({ name: room.name, df: d.df, area: d.area, u, d });
    }
  }
  // 家具放不下：床、流理台、沙發、淋浴放不下等於這個房間不能用
  const CRIT = ['床放不下', '流理台排不下', '沙發放不下', '淋浴區放不下', '餐桌放不下'];
  for (const L of Object.values(layouts)) for (const n of L.notes) {
    if (CRIT.some((c) => n.includes(c))) s -= 6;
    else if (n.includes('放不下')) s -= 1.5;
  }
  // 風水
  const stove = Object.values(layouts).find((L) => L.stove)?.stove;
  if (stove) {
    const seen = lineOfSight(env, ENTRANCE, stove);
    if (seen) { fs.push({ ok: false, t: '開門見灶：從樓梯口看得到爐灶' }); if (pg.fengshui) s -= 2.2; }
    else fs.push({ ok: true, t: '入口看不到爐灶' });
  }
  const baths = Object.entries(roomOf).filter(([cid]) => ['bath', 'ensuite'].includes(sol.assign[cid][0]));
  const center = baths.filter(([, r]) => { const c = polygonCentroid(r.pts); return c.x > 170 && c.x < 430 && c.y > 560 && c.y < 1000; });
  if (center.length) { fs.push({ ok: false, t: '廁所在房子中心（中宮）' }); }
  else if (baths.length) fs.push({ ok: true, t: '廁所不在房子正中央' });
  // 穿堂：後陽台門直通前陽台門
  const back = { x: 262, y: 5 };
  const through = [{ x: 207, y: 1545 }, { x: 386, y: 1545 }].some((p) => lineOfSight(env, back, p));
  if (through) { fs.push({ ok: false, t: '穿堂煞：前後陽台門一眼看穿' }); if (pg.fengshui) s -= 1.5; }
  else fs.push({ ok: true, t: '前後陽台門不會一眼看穿' });
  // 床頭靠窗、門對床
  let bedWin = 0;
  for (const it of plan.items) {
    if (it.kind !== 'bed' && it.kind !== 'bed_single') continue;
    const r = (it.rot || 0) * Math.PI / 180;
    const hx = it.x + Math.sin(r) * it.d / 2, hy = it.y - Math.cos(r) * it.d / 2;
    for (const o of plan.openings) {
      if (o.type !== 'window') continue;
      const e = openingEnds(plan, o);
      const d = distSeg({ x: hx, y: hy }, e.a, e.b);
      if (d < 25) { bedWin++; break; }
    }
  }
  if (bedWin) { fs.push({ ok: false, t: `${bedWin} 張床的床頭靠窗` }); if (pg.fengshui) s -= 0.8 * bedWin; }
  else if (plan.items.some((it) => it.kind === 'bed' || it.kind === 'bed_single')) fs.push({ ok: true, t: '床頭都靠實牆' });
  // 浴室門對床／爐灶／餐桌
  let bathFace = 0;
  for (const d of doors) {
    if (!['bath', 'ensuite'].includes(d.use)) continue;
    const pt = d.o === 'h' ? { x: d.ctr, y: d.c } : { x: d.c, y: d.ctr };
    for (const it of plan.items) {
      if (!['bed', 'bed_single', 'table'].includes(it.kind) && !(it.kind === 'counter' && it.top === 'stove')) continue;
      const dx = it.x - pt.x, dy = it.y - pt.y;
      const along = d.o === 'h' ? Math.abs(dy) : Math.abs(dx), across = d.o === 'h' ? Math.abs(dx) : Math.abs(dy);
      if (along < 320 && across < 50 && lineOfSight(env, pt, { x: it.x, y: it.y })) { bathFace++; break; }
    }
  }
  if (bathFace) { fs.push({ ok: false, t: '浴室門正對床、爐灶或餐桌' }); if (pg.fengshui) s -= 1.2 * bathFace; }
  // 門對門
  let dd = 0;
  for (let i = 0; i < doors.length; i++) for (let j = i + 1; j < doors.length; j++) {
    const a = doors[i], b2 = doors[j];
    if (a.o !== b2.o || Math.abs(a.c - b2.c) > 240 || Math.abs(a.c - b2.c) < 1) continue;
    if (Math.abs(a.ctr - b2.ctr) < (a.w + b2.w) / 2 - 15) dd++;
  }
  if (dd) { fs.push({ ok: false, t: `${dd} 組房門正對（門對門）` }); if (pg.fengshui) s -= 0.6 * dd; }
  // 神明桌背後
  for (const it of plan.items) if (it.kind === 'altar') fs.push({ ok: true, t: '神明桌背靠實牆，不靠廁所與廚房' });
  // 動線、空間摘要
  for (const h of habit) {
    if (!h.d.windows.length) warn.push(`${h.name}沒有對外窗`);
    else if (h.d.lightwellOnly) warn.push(`${h.name}只靠天井採光（約 ${h.df.toFixed(1)}%）`);
    else if (h.df >= dfTarget('bedroom') && ['living', 'master', 'elder'].includes(h.u)) good.push(`${h.name}採光 ${h.df.toFixed(1)}%${h.d.sunWinter >= 1 ? `，冬至日照 ${h.d.sunWinter.toFixed(1)} 小時` : ''}`);
  }
  if (sol.notes.includes('laundryThroughRoom')) warn.push(`洗衣機在後陽台，要穿過${roomOf.B?.name || '後段房間'}`);
  if (stove && built.layouts) {
    const kL = Object.values(layouts).find((L) => L.stove);
    let dmin = Infinity;
    for (const [x0, y0, x1, y1] of DUCT_RECTS) dmin = Math.min(dmin, Math.hypot(stove.x - (x0 + x1) / 2, stove.y - (y0 + y1) / 2));
    if (dmin < 200) good.push(`瓦斯爐距管道間 ${(dmin / 100).toFixed(1)} m，排油煙管短`);
    else if (sol.assign.B?.includes('kitchen') && kL?.stove?.e === 'N') good.push('瓦斯爐靠後牆，油煙直接排到後陽台');
    if (kL?.counterLen) good.push(`流理台總長 ${(kL.counterLen / 100).toFixed(1)} m`);
  }
  for (const n of built.notes) warn.push(n);
  return { score: s, daylight: dl, hab: habit, good, warn, fs };
}

function distSeg(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const L2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
  return Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t);
}

// ---------- 主流程 ----------
export async function generate(pg0, site, { onProgress = () => {}, top = 4 } = {}) {
  let pg = pg0;
  const t0 = performance.now();
  const msgs = capacityCheck(pg, site);
  const probe = makeProbe(site, pg.elevation);
  const enumAll = async (prog, lo, hi) => {
    const out = [];
    for (let i = 0; i < PARAMS.length; i++) {
      enumerate(prog, site, probe, PARAMS[i], out);
      if (i % 4 === 3) { onProgress(lo + ((hi - lo) * i) / PARAMS.length, '列舉格局組合…'); await tick(); }
    }
    return out;
  };
  let all = await enumAll(pg, 0.05, 0.3);
  if (!all.length) {
    // 完全符合的找不到：一次放寬一項，找最接近的
    const why = msgs.length ? msgs : explainFail(pg);
    for (const [label, f] of RELAX) {
      const p2 = f(pg);
      if (!p2) continue;
      const got = await enumAll(p2, 0.3, 0.4);
      if (got.length) {
        all = got;
        pg = p2;
        const specific = msgs.length ? msgs.join(' ') : explainFail(pg0).filter((m) => !m.startsWith('找不到')).join(' ');
        msgs.length = 0;
        msgs.push(`這一層放不下全部需求${specific ? `：${specific}` : '。'}以下方案先拿掉「${label}」，其他需求都有做到。`);
        break;
      }
    }
    if (!all.length) return { results: [], msgs: why, tried: 0 };
  }
  // 依「概念」（主要房間在哪一區）分組，每組取最好的兩種，避免候選全是同一種格局的小變化
  const groups = new Map();
  for (const s of all) { const k = conceptKey(s); (groups.get(k) || groups.set(k, []).get(k)).push(s); }
  const ranked = [...groups.values()].map((g) => g.sort((a, b) => b.s - a.s)).sort((a, b) => b[0].s - a[0].s);
  const pick = [];
  for (const g of ranked.slice(0, 8)) {
    pick.push(g[0]);
    const alt = g.find((x) => x !== g[0] && (x.P.yb !== g[0].P.yb || x.P.yf !== g[0].P.yf || x.P.xs !== g[0].P.xs));
    if (alt) pick.push(alt);
  }
  const evals = [];
  for (let i = 0; i < pick.length; i++) {
    const sol = pick[i];
    try {
      const built = buildPlan(sol, pg, site);
      const ev = evaluate(built, sol, pg, site);
      evals.push({ sol, built, ev, score: ev.score });
    } catch (e) { console.warn('build failed', e); }
    onProgress(0.4 + (0.58 * (i + 1)) / pick.length, `模擬第 ${i + 1}／${pick.length} 個候選（牆、門、開窗、家具、採光）…`);
    await tick();
  }
  evals.sort((a, b) => b.score - a.score);
  // 挑彼此不同的
  const chosen = [];
  for (const e of evals) {
    if (chosen.length >= top) break;
    if (chosen.some((c) => conceptKey(c.sol) === conceptKey(e.sol))) continue;
    chosen.push(e);
  }
  // 不同概念不夠時，補上分數高、但至少有一點不同的
  for (const e of evals) {
    if (chosen.length >= top) break;
    if (chosen.includes(e) || chosen.some((c) => c.sol.sig === e.sol.sig)) continue;
    if (chosen.some((c) => concept(c.sol).front === concept(e.sol).front && JSON.stringify(concept(c.sol)) === JSON.stringify(concept(e.sol)) && c.sol.P.yb === e.sol.P.yb)) continue;
    chosen.push(e);
  }
  chosen.forEach((c, i) => finishResult(c, i + 1, pg, site));
  return { results: chosen, msgs, tried: all.length, built: evals.length, ms: Math.round(performance.now() - t0), program: pg };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

// 兩個方案的「概念」差多少：主要房間落在哪一區（前段左右互換算同一種）
const ZONE = { B: 'back', BL: 'back', E: 'mid', ML: 'mid', MR: 'mid', L2: 'center', CL: 'center', CR: 'center', F1: 'front', F2: 'front' };
const MAJOR = ['living', 'kitchen', 'dining', 'master', 'elder', 'kid', 'guest', 'study', 'tatami', 'altar', 'bath', 'ensuite'];
function concept(sol) {
  const z = { back: [], mid: [], center: [], front: [] };
  for (const [cid, us] of Object.entries(sol.assign)) for (const u of us) if (MAJOR.includes(u)) z[ZONE[cid]].push(u);
  return Object.fromEntries(Object.entries(z).map(([k, v]) => [k, v.sort().join('+')]));
}
const conceptKey = (sol) => { const c = concept(sol); return `${c.back}|${c.mid}|${c.center}|${c.front}|${sol.P.xs}`; };
function diff(a, b) {
  const ca = concept(a), cb = concept(b);
  let n = 0;
  for (const k of Object.keys(ca)) if (ca[k] !== cb[k]) n++;
  if (a.P.xs !== b.P.xs) n++;
  return n;
}

// 名稱、摘要、設計說明
function finishResult(c, idx, pg, site) {
  const { plan } = c.built;
  const rooms = plan.rooms;
  const beds = rooms.filter((r) => r.kind === 'bedroom' && !/書房|和室/.test(r.name)).length;
  const halls = rooms.filter((r) => /客廳|客餐廳|起居室|神明廳/.test(r.name)).length + (rooms.some((r) => /餐廳/.test(r.name) && !/客餐廳/.test(r.name)) ? 1 : 0);
  const baths = rooms.filter((r) => r.kind === 'bath').length;
  const indoor = rooms.filter((r) => !['balcony', 'void', 'stair', 'elevator'].includes(r.kind)).reduce((s, r) => s + polygonArea(r.pts) / 1e4, 0);
  const label = `${beds} 房 ${Math.max(halls, pg.living ? 1 : 0)} 廳 ${baths} 衛`;
  const where = (u) => { const cid = Object.keys(c.sol.assign).find((k) => c.sol.assign[k].includes(u)); return cid ? ({ B: '後段', BL: '後段左側', ML: '中段', MR: '中段右側', L2: '前段左側', CL: '中段', CR: '中段右側', F1: c.sol.P.xs >= 600 ? '前段' : '前段左側', F2: '前段右側' }[cid]) : null; };
  const parts = [];
  if (where('living')) parts.push(`客廳在${where('living')}`);
  if (where('master')) parts.push(`主臥在${where('master')}`);
  if (where('elder')) parts.push(`長輩房在${where('elder')}`);
  if (where('kitchen')) parts.push(`廚房在${where('kitchen')}`);
  plan.name = `自動 ${idx} · ${label}`;
  plan.note = `${parts.join('，')}。室內約 ${indoor.toFixed(1)}㎡（${m2ToPing(indoor).toFixed(1)} 坪）。依「${STYLES[pg.style]?.name || ''}」風格與${floorLabel(site, pg.elevation)}的基地條件模擬產生。`;
  const ev = c.ev;
  const brief = [];
  brief.push(`格局：${parts.join('、')}。`);
  for (const g of ev.good.slice(0, 4)) brief.push(g + '。');
  const wr = c.built.winRes?.report || [];
  const winTxt = wr.filter((r) => r.added.length).map((r) => `${r.name}${r.added.map((a) => sideLabel(site, a.side)).join('、')}`);
  if (winTxt.length) brief.push(`依基地條件開窗：${winTxt.join('；')}。`);
  if (pg.fengshui) {
    const bad = ev.fs.filter((f) => !f.ok).map((f) => f.t);
    const ok = ev.fs.filter((f) => f.ok).map((f) => f.t);
    if (ok.length) brief.push(`風水：${ok.join('、')}。`);
    if (bad.length) brief.push(`要注意：${bad.join('、')}。`);
  }
  for (const w of ev.warn.slice(0, 4)) brief.push(`注意：${w}。`);
  plan.brief = brief;
  plan.generated = { program: { ...pg }, score: Math.round(ev.score * 10) / 10 };
  c.label = label;
  c.indoor = indoor;
  c.summary = parts.join('，');
  const habAvg = ev.hab.length ? ev.hab.reduce((a, x) => a + x.df * x.area, 0) / ev.hab.reduce((a, x) => a + x.area, 0) : 0;
  c.metrics = {
    light: habAvg,
    fengshui: ev.fs.length ? ev.fs.filter((f) => f.ok).length / ev.fs.length : 1,
    cross: ev.daylight.cross,
    hall: c.sol.assign && plan.rooms.filter((r) => r.kind === 'hall').reduce((s, r) => s + polygonArea(r.pts) / 1e4, 0),
  };
  void dirName;
}
