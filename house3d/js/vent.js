// 通風模擬（規劃階段比較用）：
// 1. 開窗通風：外面的風（風壓）＋天井、樓梯間的煙囪效應（浮力），用多區域氣流網路（每個房間一個節點、
//    每個窗、門、開口一條孔口流）解出每個房間的換氣量與風的路徑；只有一面開窗的房間另加單面通風估算。
// 2. 冷氣房關窗睡覺：臥室的二氧化碳一夜會累積到多少；全熱交換器要送多少新鮮空氣。
// 3. 法規：建築技術規則設計施工編第 43 條（居室、浴廁有效通風面積 ≥ 樓地板 5%；廚房 ≥ 1/10 且 ≥ 0.8㎡），
//    不足時依建築設備編第 102 條機械通風量（臥室、起居 8、住宅浴廁 20、非營業廚房 35 m³/h·㎡）。
// 座標沿用平面（cm）；氣流以 m³/s 計算、m³/h 顯示。
import { polygonArea, polygonCentroid, pointInPolygon, openingEnds } from './model.js';
import { makeEnv, bearingOf, dirName, roofLevel, buildingTop } from './site.js';

const G = 9.81;
const rhoOf = (tC) => 353 / (tC + 273.15);

export const SEASONS = { summer: '夏天', winter: '冬天' };
export const TERRAINS = {
  city: { name: '市區、房子很密', a: 0.33, delta: 460, cp: [0.2, 0.05, -0.25, -0.3, -0.25], roof: -0.4 },
  suburb: { name: '郊區、透天聚落', a: 0.22, delta: 370, cp: [0.4, 0.1, -0.3, -0.35, -0.2], roof: -0.5 },
  open: { name: '空曠、田邊海邊', a: 0.14, delta: 270, cp: [0.7, 0.35, -0.5, -0.45, -0.35], roof: -0.6 },
};
// 窗型：可以打開的比例（有效通風面積／窗洞面積）
export const WINDOW_TYPES = {
  slide: { name: '橫拉窗', open: 0.5 },
  casement: { name: '推射窗', open: 0.85 },
  tilt: { name: '上懸／內倒窗', open: 0.3 },
  fixed: { name: '固定窗', open: 0 },
};
export const DOOR_MODES = { open: '房門打開', closed: '房門關上' };

// 各地常見風向（風從哪個方位吹來，度）。依氣象站盛行風的大致情況，地形、街道會改變，可以自己改。
const WIND = {
  keelung: [45, 225], taipei: [70, 110], newtaipei: [70, 110], taoyuan: [45, 225], hsinchu: [30, 225], miaoli: [20, 225],
  taichung: [0, 225], changhua: [0, 225], nantou: [0, 225], yunlin: [0, 225], chiayi: [0, 225], tainan: [0, 225],
  kaohsiung: [340, 270], pingtung: [340, 225], yilan: [45, 135], hualien: [20, 180], taitung: [20, 180], penghu: [20, 200],
};
export const cityWind = (city, season) => (WIND[city] || [45, 225])[season === 'winter' ? 0 : 1];

export function defaultVent() {
  return {
    season: 'summer', wind: null, speed: 2, terrain: 'city',
    doors: 'open', window: 'slide', screen: true,
    stairVent: true, bathFan: true, erv: false,
  };
}
export const ventOf = (site) => ({ ...defaultVent(), ...(site.vent || {}) });
export const windFrom = (site, v = ventOf(site)) => (v.wind ?? cityWind(site.city, v.season));
// 風前進的方向（平面座標單位向量）
export function windTravel(site, v = ventOf(site)) {
  const a = ((windFrom(site, v) - site.front + 180) * Math.PI) / 180;
  return { x: -Math.sin(a), y: Math.cos(a) };
}
// 風是從前面、後面，還是沿著街道（側面）吹
export function windSide(site, v = ventOf(site)) {
  const c = Math.cos(((windFrom(site, v) - site.front) * Math.PI) / 180);
  return c > 0.35 ? 'front' : c < -0.35 ? 'back' : 'side';
}
export const fmtAch = (x) => (x >= 30 ? '30+' : x >= 10 ? String(Math.round(x)) : x.toFixed(1));

const LW_VENT = { open: 1, louver: 0.45, sealed: 0.01 };
const CD = 0.6;
const DELTA = 0.002; // Pa，讓孔口流在壓差趨近 0 時可微分

// 風向與立面法線夾角 → 風壓係數（低層建築的簡化表，依周圍遮蔽程度）
function cpAt(table, phiDeg) {
  const p = Math.min(180, Math.abs(((phiDeg + 540) % 360) - 180));
  const i = Math.min(3, Math.floor(p / 45)), t = (p - i * 45) / 45;
  return table[i] + (table[i + 1] - table[i]) * t;
}

// 溫度（°C）：夏天白天、冬天東北季風
function temps(season) {
  if (season === 'winter') return { out: 16, room: 21, lw: 17, stair: 19 };
  return { out: 31, room: 31.5, lw: 32.5, stair: 32.5 };
}

const roomOfPoint = (rooms, p) => rooms.find((r) => pointInPolygon(p, r.pts));

// 房間之間沒有牆的共用邊（開放式空間）：總長度（cm）、最長一段的中點、由 A 指向 B 的方向
function openEdges(plan, A, B) {
  let L = 0, best = null;
  const cb = polygonCentroid(B.pts);
  const segs = (r) => r.pts.map((p, i) => [p, r.pts[(i + 1) % r.pts.length]]);
  for (const [a1, a2] of segs(A)) for (const [b1, b2] of segs(B)) {
    const horiz = Math.abs(a1.y - a2.y) < 0.5 && Math.abs(b1.y - b2.y) < 0.5 && Math.abs(a1.y - b1.y) < 0.5;
    const vert = Math.abs(a1.x - a2.x) < 0.5 && Math.abs(b1.x - b2.x) < 0.5 && Math.abs(a1.x - b1.x) < 0.5;
    if (!horiz && !vert) continue;
    const k = horiz ? 'x' : 'y';
    const lo = Math.max(Math.min(a1[k], a2[k]), Math.min(b1[k], b2[k])), hi = Math.min(Math.max(a1[k], a2[k]), Math.max(b1[k], b2[k]));
    if (hi - lo < 20) continue;
    // 扣掉這條線上的牆
    let parts = [[lo, hi]];
    const c = horiz ? a1.y : a1.x;
    for (const w of plan.walls) {
      const on = horiz ? Math.abs(w.a.y - c) < 8 && Math.abs(w.b.y - c) < 8 : Math.abs(w.a.x - c) < 8 && Math.abs(w.b.x - c) < 8;
      if (!on) continue;
      const w0 = Math.min(w.a[k], w.b[k]), w1 = Math.max(w.a[k], w.b[k]);
      parts = parts.flatMap(([s, e]) => (w1 <= s || w0 >= e ? [[s, e]] : [...(w0 > s ? [[s, w0]] : []), ...(w1 < e ? [[w1, e]] : [])]));
    }
    for (const [x, y] of parts) {
      const len = Math.max(0, y - x - 2);
      L += len;
      if (len > 0 && (!best || len > best.len)) {
        const m = (x + y) / 2;
        best = horiz ? { len, mid: { x: m, y: c }, dir: { x: 0, y: Math.sign(cb.y - c) || 1 } } : { len, mid: { x: c, y: m }, dir: { x: Math.sign(cb.x - c) || 1, y: 0 } };
      }
    }
  }
  return { L, mid: best?.mid, dir: best?.dir };
}

// 線性方程（小矩陣，部分主元高斯消去）
function solveLinear(J, b) {
  const n = b.length;
  const M = J.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) return null;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (!f) continue;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  const x = new Array(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r][n];
    for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
    x[r] = s / M[r][r];
  }
  return x;
}

const NODE_SKIP = ['void', 'balcony', 'elevator'];

// 主要分析
export function analyzeVent(plan, site, opts = {}) {
  const v = { ...ventOf(site), ...(opts.vent || {}) };
  const lw = { top: 'open', wall: 'normal', ...(site.lw || {}) };
  const ter = TERRAINS[v.terrain] || TERRAINS.city;
  const T = temps(v.season);
  const rhoO = rhoOf(T.out);
  const elev = plan.elevation || 0;
  const ceil = (plan.wallHeight || 300) / 100;
  const env = makeEnv(plan, site);
  const Hb = buildingTop(site) / 100;
  // 風速：氣象站（10 m 高、空曠）換算到建築物高度（ASHRAE 邊界層公式）
  const UH = (v.speed || 0) * Math.pow(270 / 10, 0.14) * Math.pow(Math.max(3, Hb) / ter.delta, ter.a);
  const q = 0.5 * rhoO * UH * UH;
  const wind = windFrom(site, v);

  // 節點
  const rooms = plan.rooms.filter((r) => r.pts.length >= 3);
  const nodes = [];
  const nodeOfRoom = new Map();
  const derived = plan.floor ? site.derived || {} : {};
  const stairTop = (derived.stairTop || roofLevel(site) + 300) / 100;
  let stairNode = null;
  for (const r of rooms) {
    if (NODE_SKIP.includes(r.kind)) continue;
    const area = polygonArea(r.pts) / 1e4;
    if (r.kind === 'stair') {
      // 樓梯間是貫通各層的豎井：壓力以頂部為參考高度
      if (!stairNode) {
        stairNode = { id: 'stair', kind: 'stair', name: '樓梯間', z: stairTop, t: T.stair, rooms: [], area: 0, vol: 0 };
        nodes.push(stairNode);
      }
      stairNode.rooms.push(r);
      stairNode.area += area;
      nodeOfRoom.set(r.id, stairNode);
      continue;
    }
    const n = { id: r.id, kind: 'room', room: r, name: r.name || '', rk: r.kind, z: elev / 100, t: T.room, area, vol: area * ceil };
    nodes.push(n);
    nodeOfRoom.set(r.id, n);
  }
  // 天井：每個天井一個節點（室外空氣，但被太陽曬熱、頂部開口會拔風）
  const lwNodes = [];
  for (const vd of env.voids) {
    const tops = Object.values(vd.tops);
    const ztop = tops.reduce((s, x) => s + x, 0) / tops.length / 100;
    const area = Math.max(0.3, ((vd.rect.x1 - vd.rect.x0 - 15) * (vd.rect.y1 - vd.rect.y0 - 15)) / 1e4);
    const n = { id: 'lw:' + vd.room.id, kind: 'lw', name: '天井', z: ztop, t: T.lw, area, rect: vd.rect, room: vd.room };
    nodes.push(n);
    lwNodes.push(n);
    nodeOfRoom.set(vd.room.id, n);
  }
  nodes.forEach((n, i) => { n.i = i; n.rho = rhoOf(n.t); });

  // 連線（孔口）
  const edges = [];
  const wtype = (o) => WINDOW_TYPES[o.vtype] || (o.type === 'window' ? WINDOW_TYPES[v.window] : null);
  const openFrac = (o) => {
    if (o.type === 'opening') return 1;
    if (o.type === 'sliding') return 0.5;
    if (o.type === 'window') return (wtype(o) || WINDOW_TYPES.slide).open;
    return 0;
  };
  const screen = v.screen ? 0.75 : 1;
  const lwFrac = LW_VENT[lw.top] ?? 1;
  // 室外的開口（立面、天井）
  for (const w of env.wins) {
    if (w.party) continue;
    const o = w.o;
    const legalA = (o.w * (o.h || 120)) / 1e4 * openFrac(o);
    if (legalA <= 0) continue;
    const probe = { x: w.inner.x - w.n.x * ((w.wall.t || 12) / 2 + 6), y: w.inner.y - w.n.y * ((w.wall.t || 12) / 2 + 6) };
    const r = roomOfPoint(rooms.filter((x) => !NODE_SKIP.includes(x.kind)), probe);
    const a = r && nodeOfRoom.get(r.id);
    if (!a) continue;
    const z = (elev + (o.sill || 0) + (o.h || 120) / 2) / 100;
    if (w.kind === 'void') {
      const lwn = lwNodes.find((n) => n.room === env.voids.find((vd) => vd.rect === w.void)?.room) || lwNodes[0];
      if (!lwn) continue;
      edges.push({ a: a.i, b: lwn.i, A: legalA * screen, legalA, z, kind: 'win', o, side: 'lightwell', info: w, at: { ...w.inner }, dir: { ...w.n } });
    } else {
      const bearing = bearingOf(site, w.n.x, w.n.y);
      const cp = cpAt(ter.cp, wind - bearing);
      edges.push({ a: a.i, b: -1, A: legalA * screen, legalA, z, pw: cp * q, cp, kind: 'win', o, side: w.side, info: w, bearing, at: { ...w.inner }, dir: { ...w.n } });
    }
  }
  // 室內的門、開口
  const doorOpen = v.doors !== 'closed';
  for (const o of plan.openings) {
    if (o.type === 'window') continue;
    const e = openingEnds(plan, o);
    if (!e || e.wall.kind === 'ext' && !['door', 'elevator'].includes(o.type)) continue;
    if (o.type === 'elevator') continue;
    const off = (e.wall.t || 12) / 2 + 8;
    const p1 = { x: e.c.x + e.n.x * off, y: e.c.y + e.n.y * off }, p2 = { x: e.c.x - e.n.x * off, y: e.c.y - e.n.y * off };
    const r1 = roomOfPoint(rooms, p1), r2 = roomOfPoint(rooms, p2);
    const n1 = r1 && nodeOfRoom.get(r1.id), n2 = r2 && nodeOfRoom.get(r2.id);
    if (!n1 || !n2 || n1 === n2 || n1.kind === 'lw' || n2.kind === 'lw') continue; // 天井牆上的開口已算在室外開口
    const h = (o.h || 210) / 100, wm = o.w / 100;
    const isDoor = o.type === 'door' || o.type === 'sliding';
    const open = !isDoor || doorOpen;
    const A = open ? wm * h * (o.type === 'sliding' ? 0.5 : 0.9) : wm * 0.012 + 0.004; // 關門：門縫
    edges.push({ a: n1.i, b: n2.i, A, z: (elev + 105) / 100, kind: open ? 'door' : 'gap', o, legalA: 0, at: { ...e.c }, dir: { x: -e.n.x, y: -e.n.y } });
  }
  // 沒有牆隔開的房間（開放式）
  const rn = rooms.filter((r) => nodeOfRoom.has(r.id));
  for (let i = 0; i < rn.length; i++) for (let j = i + 1; j < rn.length; j++) {
    const A = nodeOfRoom.get(rn[i].id), B = nodeOfRoom.get(rn[j].id);
    if (A === B || A.kind === 'lw' || B.kind === 'lw') continue;
    const oe = openEdges(plan, rn[i], rn[j]);
    if (oe.L < 40) continue;
    edges.push({ a: A.i, b: B.i, A: (oe.L / 100) * ceil * 0.7, z: (elev / 100) + ceil / 2, kind: 'open', legalA: 0, at: oe.mid, dir: oe.dir });
  }
  // 天井頂、樓梯間頂
  for (const n of lwNodes) edges.push({ a: n.i, b: -1, A: n.area * lwFrac, z: n.z, pw: ter.roof * q, cp: ter.roof, kind: 'top', side: 'roof', at: { x: (n.rect.x0 + n.rect.x1) / 2, y: (n.rect.y0 + n.rect.y1) / 2 } });
  if (stairNode) edges.push({ a: stairNode.i, b: -1, A: v.stairVent ? 0.6 : 0.02, z: stairTop - 0.5, pw: ter.roof * q, cp: ter.roof, kind: 'top', side: 'roof', at: polygonCentroid(stairNode.rooms[0].pts) });
  // 背景滲透（每個房間一點縫隙，避免孤立節點）
  for (const n of nodes) if (n.kind === 'room') edges.push({ a: n.i, b: -1, A: 0.0006 * Math.max(4, n.area), z: n.z + ceil / 2, pw: 0, cp: 0, kind: 'leak' });
  // 機械排風：無窗浴室的排風機（24 小時低速）
  const fans = [];
  const hasOwnWin = (n) => edges.some((ed) => ed.kind === 'win' && (ed.a === n.i));
  for (const n of nodes) {
    if (n.kind !== 'room' || n.rk !== 'bath' || !v.bathFan) continue;
    if (hasOwnWin(n)) continue;
    fans.push({ i: n.i, Q: (20 * n.area) / 3600 });
  }

  // 解壓力
  const unk = nodes.length;
  const P = nodes.map((n) => -rhoO * G * n.z);
  const dp = (ed, P) => {
    const na = nodes[ed.a];
    const pa = P[ed.a] - na.rho * G * (ed.z - na.z);
    let pb;
    if (ed.b < 0) pb = (ed.pw || 0) - rhoO * G * ed.z;
    else { const nb = nodes[ed.b]; pb = P[ed.b] - nb.rho * G * (ed.z - nb.z); }
    return pa - pb;
  };
  const flow = (ed, d) => {
    const rho = d >= 0 ? nodes[ed.a].rho : ed.b < 0 ? rhoO : nodes[ed.b].rho;
    const k = CD * ed.A * Math.sqrt(2 / rho);
    const s = Math.sqrt(Math.abs(d) + DELTA);
    return { Q: (k * d) / s, dQ: (k * (0.5 * Math.abs(d) + DELTA)) / (s * s * s) };
  };
  const residual = (P) => {
    const R = new Array(unk).fill(0);
    for (const ed of edges) {
      const { Q } = flow(ed, dp(ed, P));
      R[ed.a] -= Q;
      if (ed.b >= 0) R[ed.b] += Q;
    }
    for (const f of fans) R[f.i] -= f.Q;
    return R;
  };
  // Newton 法（線搜尋以殘差平方和為準、只接受變小的一步）；Newton 走不下去時改用 Levenberg–Marquardt
  const jac = (P) => {
    const J = Array.from({ length: unk }, () => new Array(unk).fill(0));
    for (const ed of edges) {
      const { dQ } = flow(ed, dp(ed, P));
      J[ed.a][ed.a] -= dQ;
      if (ed.b >= 0) { J[ed.a][ed.b] += dQ; J[ed.b][ed.b] -= dQ; J[ed.b][ed.a] += dQ; }
    }
    return J;
  };
  const lmStep = (J, R, mu) => {
    const A = Array.from({ length: unk }, (_, i) => Array.from({ length: unk }, (_, j) => { let t = 0; for (let k = 0; k < unk; k++) t += J[k][i] * J[k][j]; return t; }));
    const g = Array.from({ length: unk }, (_, i) => { let t = 0; for (let k = 0; k < unk; k++) t += J[k][i] * R[k]; return -t; });
    for (let i = 0; i < unk; i++) A[i][i] += mu * (A[i][i] || 1e-12);
    return solveLinear(A, g);
  };
  const sq = (v) => v.reduce((t, x) => t + x * x, 0);
  let R = residual(P);
  let merit = sq(R);
  let norm = Math.max(0, ...R.map(Math.abs));
  let mu = 1e-3;
  // need：要求的下降比例（Newton 用 Armijo 條件，避免來回翻轉流向卻只小降一點）
  const tryStep = (st, lam, need = 0) => {
    const Pn = P.map((x, i) => x + lam * st[i]);
    const Rn = residual(Pn);
    const mn = sq(Rn);
    if (!(mn < merit * (1 - need))) return false;
    for (let i = 0; i < unk; i++) P[i] = Pn[i];
    R = Rn; merit = mn; norm = Math.max(0, ...Rn.map(Math.abs));
    return true;
  };
  for (let it = 0; it < 200 && norm > 1e-9; it++) {
    const J = jac(P);
    let ok = false;
    const step = solveLinear(J, R.map((x) => -x));
    if (step) {
      const mx = Math.max(...step.map(Math.abs));
      let lam = mx > 20 ? 20 / mx : 1;
      for (let tries = 0; tries < 10 && !ok; tries++, lam /= 2) ok = tryStep(step, lam, 0.2 * lam);
    }
    for (let k = 0; k < 40 && !ok && mu < 1e14; k++) {
      const st = lmStep(J, R, mu);
      if (st && tryStep(st, 1)) { ok = true; mu = Math.max(1e-9, mu / 5); } else mu *= 5;
    }
    if (!ok) break;
  }
  for (const ed of edges) ed.Q = flow(ed, dp(ed, P)).Q; // ＋：a → b

  // 沒有牆隔開的房間（開放式客餐廳、廚房）在法規上是同一個空間，通風面積合併計算
  const grp = nodes.map((n) => n.i);
  const find = (i) => (grp[i] === i ? i : (grp[i] = find(grp[i])));
  for (const ed of edges) if (ed.kind === 'open' && nodes[ed.a].kind === 'room' && nodes[ed.b].kind === 'room') grp[find(ed.a)] = find(ed.b);
  const extOf = (n) => edges.filter((ed) => ed.kind === 'win' && ed.a === n.i);

  // 每個房間的結果
  const out = [];
  const nameOf = (i) => (i < 0 ? '室外' : nodes[i].name || '房間');
  for (const n of nodes) {
    if (n.kind !== 'room') continue;
    const mine = edges.filter((ed) => ed.a === n.i || ed.b === n.i);
    let qin = 0;
    for (const ed of mine) { const into = ed.b === n.i ? ed.Q : -ed.Q; if (into > 0) qin += into; }
    const fan = fans.find((f) => f.i === n.i);
    if (fan) qin = Math.max(qin, fan.Q);
    const ext = mine.filter((ed) => ed.kind === 'win' && ed.a === n.i);
    const sides = [...new Set(ext.map((ed) => ed.side))];
    // 單面通風（BS 5925：風 0.025·A·U；浮力 Cd·A/3·√(g·h·ΔT/T)）
    let qss = 0;
    for (const ed of ext) {
      const U = ed.side === 'lightwell' ? UH * 0.15 : UH;
      const hgt = (ed.o.h || 120) / 100;
      const dT = Math.max(0.5, Math.abs(T.room - T.out));
      const qw = 0.025 * ed.A * U, qs = (CD * ed.A / 3) * Math.sqrt((G * hgt * dT) / (T.out + 273.15));
      qss += Math.sqrt(qw * qw + qs * qs);
    }
    const qtot = Math.sqrt(qin * qin + qss * qss);
    const ach = n.vol > 0 ? (qtot * 3600) / n.vol : 0;
    const achNet = n.vol > 0 ? (qin * 3600) / n.vol : 0;
    let type;
    if (achNet >= 2 && qin >= qss) type = 'cross';
    else if (ext.length) type = 'single';
    else if (fan) type = 'fan';
    else if (ach >= 0.5) type = 'indirect';
    else type = 'none';
    // 風從哪裡來、往哪裡去
    const ins = [], outs = [];
    for (const ed of mine) {
      const into = ed.b === n.i ? ed.Q : -ed.Q;
      const other = ed.b === n.i ? ed.a : ed.b;
      const label = ed.kind === 'win' ? (ed.side === 'lightwell' ? '天井' : sideWord(ed.side)) : ed.kind === 'leak' ? null : nameOf(other);
      if (!label || Math.abs(into) * 3600 < 3) continue;
      (into > 0 ? ins : outs).push({ label, q: Math.abs(into) * 3600 });
    }
    if (fan) outs.push({ label: '排風機', q: fan.Q * 3600 });
    const mates = nodes.filter((m) => m.kind === 'room' && m !== n && find(m.i) === find(n.i) && LEGAL[m.rk]);
    const legal = legalCheck(n, ext, mates.map((m) => ({ n: m, ext: extOf(m) })));
    out.push({
      id: n.id, name: n.name, kind: n.rk, area: n.area, vol: n.vol,
      q: qtot * 3600, qNet: qin * 3600, qSingle: qss * 3600, ach, type, sides,
      ins: merge(ins), outs: merge(outs), legal, fan: fan ? fan.Q * 3600 : 0,
      depth: roomDepth(n.room, ext), ceil,
    });
  }
  for (const r of out) r.iaq = r.kind === 'bedroom' ? iaq(r, plan, v) : null;
  const shafts = nodes.filter((n) => n.kind === 'lw' || n.kind === 'stair').map((n) => {
    const top = edges.find((ed) => ed.kind === 'top' && ed.a === n.i);
    const fromRooms = edges.filter((ed) => (ed.b === n.i && ed.Q > 0) || (ed.a === n.i && ed.b >= 0 && ed.Q < 0)).reduce((s, ed) => s + Math.abs(ed.Q), 0);
    return { id: n.id, kind: n.kind, name: n.name, up: top ? top.Q * 3600 : 0, fromRooms: fromRooms * 3600, rect: n.rect, rooms: n.rooms };
  });
  const hab = out.filter((r) => ['living', 'bedroom', 'kitchen'].includes(r.kind));
  const avgAch = hab.length ? hab.reduce((s, r) => s + r.ach * r.vol, 0) / hab.reduce((s, r) => s + r.vol, 0) : 0;
  const res = { plan, site, v, lw, wind, UH, q, T, nodes, edges, rooms: out, shafts, avgAch, residual: norm, elev };
  if (opts.debug) res.debug = { residual, jac, P, dp, flow };
  res.tips = ventTips(res);
  return res;
}

const SIDE_WORD = { front: '前面', back: '後面', left: '左側', right: '右側', lightwell: '天井', roof: '屋頂' };
const sideWord = (s) => SIDE_WORD[s] || s;
function merge(list) {
  const m = new Map();
  for (const x of list) m.set(x.label, (m.get(x.label) || 0) + x.q);
  return [...m].map(([label, q]) => ({ label, q })).sort((a, b) => b.q - a.q);
}

// 房間深度：從有窗的牆往裡面多深（CIBSE AM10：單面通風有效深度約 2.5 倍天花高，對流約 5 倍）
function roomDepth(room, ext) {
  if (!room || !ext.length) return 0;
  const xs = room.pts.map((p) => p.x), ys = room.pts.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs), d = Math.max(...ys) - Math.min(...ys);
  const n = ext[0].info?.n;
  return (n && Math.abs(n.x) > 0.5 ? w : d) / 100;
}

// 第 43 條
export const LEGAL = {
  living: { ratio: 0.05, mech: 8 }, bedroom: { ratio: 0.05, mech: 8 }, other: { ratio: 0.05, mech: 8 },
  bath: { ratio: 0.05, mech: 20 }, kitchen: { ratio: 0.1, min: 0.8, mech: 35 },
};
function legalCheck(n, ext, mates = []) {
  const rule = LEGAL[n.rk];
  if (!rule) return null;
  // 開放空間：面積與窗合併，比例用比較嚴的那個（有廚房就要 1/10）
  const all = [{ n, ext }, ...mates];
  const area = all.reduce((s, x) => s + x.n.area, 0);
  const A = all.reduce((s, x) => s + x.ext.reduce((t, ed) => t + ed.legalA, 0), 0);
  const ratio = Math.max(...all.map((x) => LEGAL[x.n.rk]?.ratio || 0));
  const need = Math.max(area * ratio, rule.min || 0);
  return { A, need, area, ratio: area ? A / area : 0, ok: A >= need - 1e-6, mech: Math.ceil((rule.mech * n.area) / 5) * 5, rule, with: mates.map((x) => x.n.name).filter(Boolean), key: all.map((x) => x.n.id).sort().join('+') };
}
// 通風面積不足的空間數（開放式客餐廳廚房算一個；無窗浴室有排風機不算）
export function legalShort(rooms, v) {
  return new Set(rooms.filter((r) => r.legal && !r.legal.ok && !(r.kind === 'bath' && v.bathFan)).map((r) => r.legal.key)).size;
}

// 臥室：冷氣房門窗關著睡 8 小時，二氧化碳
export const CO2 = { out: 420, start: 500, limit: 1000, perPerson: 0.013 }; // 睡眠成人約 13 L/h
export const AIRTIGHT_ACH = 0.2; // 氣密窗、門關著的滲透
export const ERV_PER_PERSON = 30;
function iaq(r, plan, v) {
  const room = plan.rooms.find((x) => x.id === r.id);
  let people = 0;
  for (const it of plan.items) {
    if (!room || !pointInPolygon(it, room.pts)) continue;
    if (it.kind === 'bed') people += 2; else if (it.kind === 'bed_single') people += 1; else if (it.kind === 'tatami') people += 2;
  }
  people = Math.max(1, Math.min(4, people || 1));
  const V = Math.max(10, r.vol);
  const infil = AIRTIGHT_ACH * V;
  const erv = v.erv ? ERV_PER_PERSON * people : 0;
  const co2 = (Q) => {
    const css = CO2.out + (people * CO2.perPerson * 1e6) / Q;
    return css + (CO2.start - css) * Math.exp((-Q / V) * 8);
  };
  const need = Math.ceil((people * CO2.perPerson * 1e6) / (CO2.limit - CO2.out) / 5) * 5;
  return { people, V, infil, erv, co2: co2(infil + erv), co2Closed: co2(infil), need };
}

export function achGrade(ach) {
  if (ach < 0.5) return ['幾乎不通風', 0];
  if (ach < 3) return ['只夠換氣', 1];
  if (ach < 10) return ['還不錯', 2];
  return ['很通風', 3];
}
const VENT_STOPS = [[0, [206, 200, 194]], [0.5, [176, 196, 214]], [3, [125, 178, 214]], [10, [62, 140, 196]], [25, [27, 96, 160]]];
export function achColor(ach) {
  const v = Math.max(0, ach);
  for (let i = 1; i < VENT_STOPS.length; i++) {
    const [b, cb] = VENT_STOPS[i], [a, ca] = VENT_STOPS[i - 1];
    if (v <= b) { const t = (v - a) / (b - a); const c = ca.map((x, k) => Math.round(x + (cb[k] - x) * t)); return `rgb(${c[0]},${c[1]},${c[2]})`; }
  }
  const c = VENT_STOPS[VENT_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export const VENT_LEGEND = [0, 0.5, 3, 10, 25];
export const TYPE_NAMES = { cross: '有對流', single: '單面開窗', fan: '靠排風機', indirect: '靠房門換氣', none: '不通風' };

// 建議（依這一層的結果挑相關的）
function ventTips(res) {
  const tips = [];
  const { rooms, v, lw, shafts } = res;
  const hab = rooms.filter((r) => ['living', 'bedroom'].includes(r.kind));
  const weak = hab.filter((r) => ['single', 'indirect', 'none'].includes(r.type));
  const lwS = shafts.find((s) => s.kind === 'lw');
  if (weak.length && v.doors === 'closed') tips.push({ k: 'door', t: `${weak.map((r) => r.name).join('、')}：門關著時只剩單面通風。門上加氣窗或改百葉門、門下留 1.5～2 cm 縫，風就能從窗戶穿過房間到走道、天井或樓梯間。` });
  else if (weak.length) tips.push({ k: 'single', t: `${weak.map((r) => r.name).join('、')}只有一面能進風。窗戶開在不同面（或靠天井、走道再開一個高窗）才會有穿堂風；做不到時用循環扇把風帶進來。` });
  if (lwS && lw.top === 'sealed') tips.push({ k: 'lwTop', t: '天井頂整個封住後只剩採光、沒有拔風。改成「透光頂蓋＋四周高側百葉」，防雨又能讓熱空氣從上面出去。' });
  if (lwS && lw.top === 'open') tips.push({ k: 'lwRain', t: '天井開放拔風效果最好；底部要做截水溝和排水，窗戶用推射窗或加雨遮，下雨時也能開一點。' });
  if (lwS && lw.wall !== 'light') tips.push({ k: 'lwWall', t: '天井四周牆面刷白或貼淺色磁磚，反射光能多送一些亮度到低樓層。' });
  const stair = shafts.find((s) => s.kind === 'stair');
  if (stair && !v.stairVent) tips.push({ k: 'stair', t: '樓梯間（屋突）最高處加可開的高窗、電動排煙窗或無動力通風球，夏天熱氣會從樓梯間往上排，各層從窗戶補進新鮮空氣（煙囪效應）。' });
  if (stair && v.stairVent) tips.push({ k: 'fire', t: '樓梯間當作拔風井時，出租或分租樓層通往樓梯間的門要用常閉防火門，避免火災時煙往上竄；自住樓層也建議白天開、晚上關。' });
  const bathNo = rooms.filter((r) => r.kind === 'bath' && !r.sides.length);
  if (bathNo.length) tips.push({ k: 'bath', t: `${bathNo.map((r) => r.name).join('、')}沒有窗：裝排風機接管道間（附逆止風門），設備編第 102 條住宅浴廁每㎡ 20 m³/h，${bathNo.map((r) => `${r.name}至少 ${r.legal?.mech || 0} m³/h`).join('、')}；建議 24 小時低速運轉。` });
  const kit = rooms.filter((r) => r.kind === 'kitchen' || /廚房|茶水/.test(r.name));
  if (kit.length) tips.push({ k: 'kitchen', t: '廚房排油煙機每小時抽 600～1000 m³，氣密窗關著會抽不動、還會把浴室、排水管的味道倒抽回來：留一個補氣口，或煮飯時把附近的窗開一個縫。' });
  const beds = rooms.filter((r) => r.iaq);
  const bad = beds.filter((r) => r.iaq.co2Closed > CO2.limit);
  if (bad.length && !v.erv) {
    const tot = bad.reduce((s, r) => s + r.iaq.people * ERV_PER_PERSON, 0);
    tips.push({ k: 'erv', t: `冷氣房關窗睡覺，${bad.map((r) => r.name).join('、')}早上二氧化碳約 ${Math.round(Math.max(...bad.map((r) => r.iaq.co2Closed)) / 100) * 100} ppm（室內空氣品質標準 1000 ppm）。新做的房子建議裝全熱交換器（這層約 ${tot} m³/h，濾網選能擋 PM2.5 的等級），或窗框加微通風進氣口。` });
  }
  if (v.window === 'slide') tips.push({ k: 'window', t: '橫拉窗只能開一半；臥室、浴室改推射窗或上懸窗，可開面積比較大，下雨也能開一點縫。' });
  if (hab.length) tips.push({ k: 'fan', t: '吊扇或循環扇讓室內有約 0.8 m/s 的風，體感能降 2～3°C，冷氣可以開高一點。' });
  return tips;
}

// 整棟：各層的摘要（給剖面圖、整棟面板用）
export function ventSummary(res) {
  const hab = res.rooms.filter((r) => ['living', 'bedroom', 'kitchen'].includes(r.kind));
  const cross = hab.filter((r) => r.type === 'cross').length;
  const legalBad = legalShort(res.rooms, res.v);
  const co2 = Math.max(0, ...res.rooms.filter((r) => r.iaq).map((r) => r.iaq.co2));
  return { avgAch: res.avgAch, hab: hab.length, cross, legalBad, co2, lwUp: res.shafts.find((s) => s.kind === 'lw')?.up || 0, stairUp: res.shafts.find((s) => s.kind === 'stair')?.up || 0 };
}

export const windLabel = (site, v = ventOf(site)) => `${SEASONS[v.season]}・${dirName(windFrom(site, v))}風 ${v.speed} m/s`;
