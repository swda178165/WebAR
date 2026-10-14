// 資料模型與幾何工具。所有座標單位為公分（cm），平面座標 x 向右、y 向下（圖面下方＝房子前方）。

export const uid = (p = 'o') => p + Math.random().toString(36).slice(2, 9);
export const clone = (o) => JSON.parse(JSON.stringify(o));

export const DEFAULTS = {
  wallHeight: 300,
  floorHeight: 350,
  doorHeight: 210,
  slidingHeight: 220,
  windowSill: 90,
  windowHeight: 120,
  parapet: 110,
};

export const ROOM_KINDS = {
  living: { name: '客廳', color: '#e9d9bf' },
  bedroom: { name: '臥室', color: '#efe3cd' },
  hall: { name: '走道', color: '#ece2d0' },
  kitchen: { name: '廚房', color: '#dfe3e3' },
  bath: { name: '浴室', color: '#d5e2e8' },
  balcony: { name: '陽台', color: '#e6d3c6' },
  stair: { name: '樓梯', color: '#dcdad4' },
  elevator: { name: '電梯', color: '#cfd3d6' },
  storage: { name: '儲藏室', color: '#e2dfd8' },
  void: { name: '天井', color: '#b9c3c9' },
  other: { name: '空間', color: '#e8e4dc' },
};

export const OPENING_TYPES = {
  door: '單開門',
  sliding: '推拉門',
  window: '窗',
  opening: '開口',
  elevator: '電梯門',
};

// ---------- 向量 ----------
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const len = (a) => Math.hypot(a.x, a.y);
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a) => { const l = len(a) || 1; return { x: a.x / l, y: a.y / l }; };
export const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const round1 = (v) => Math.round(v * 10) / 10;

export function wallFrame(w) {
  const d = sub(w.b, w.a);
  const L = len(d);
  const u = L ? { x: d.x / L, y: d.y / L } : { x: 1, y: 0 };
  return { L, u, n: { x: -u.y, y: u.x } };
}

// 點到線段的投影
export function projectOnSegment(p, a, b) {
  const d = sub(b, a);
  const L2 = dot(d, d) || 1;
  let t = dot(sub(p, a), d) / L2;
  const tc = Math.max(0, Math.min(1, t));
  const q = lerp(a, b, tc);
  return { t, tc, point: q, dist: dist(p, q) };
}

export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    s += p.x * q.y - q.x * p.y;
  }
  return Math.abs(s) / 2;
}

export function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const f = p.x * q.y - q.x * p.y;
    a += f; cx += (p.x + q.x) * f; cy += (p.y + q.y) * f;
  }
  if (Math.abs(a) < 1e-6) {
    const n = pts.length || 1;
    return { x: pts.reduce((s, p) => s + p.x, 0) / n, y: pts.reduce((s, p) => s + p.y, 0) / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

export function pointInPolygon(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// 家具四角（世界座標）；rot 為螢幕上順時針角度（度）
export function itemCorners(it) {
  const r = (it.rot || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const hw = it.w / 2, hd = it.d / 2;
  return [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, y]) => ({ x: it.x + x * c - y * s, y: it.y + x * s + y * c }));
}

export function toLocal(it, p) {
  const r = -(it.rot || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
  const x = p.x - it.x, y = p.y - it.y;
  return { x: x * c - y * s, y: x * s + y * c };
}

// 牆端點是否連到其他牆（用來決定端點要不要延伸半個牆厚來補角）
export function wallEndConnected(plan, wall, end) {
  const p = wall[end];
  for (const o of plan.walls) {
    if (o === wall) continue;
    if (dist(o.a, p) < 1 || dist(o.b, p) < 1) return true;
    const pr = projectOnSegment(p, o.a, o.b);
    if (pr.t > -0.001 && pr.t < 1.001 && pr.dist < Math.max(1, o.t / 2 + 0.5)) return true;
  }
  return false;
}

export function wallOpenings(plan, wall) {
  return plan.openings.filter((o) => o.wall === wall.id).sort((a, b) => a.pos - b.pos);
}

// 將牆沿長度切成實牆段與開口段
export function wallSegments(plan, wall) {
  const { L } = wallFrame(wall);
  const ops = wallOpenings(plan, wall);
  const segs = [];
  let cur = 0;
  for (const o of ops) {
    const s = Math.max(cur, o.pos - o.w / 2), e = Math.min(L, o.pos + o.w / 2);
    if (e <= s) continue;
    if (s > cur) segs.push({ s: cur, e: s, solid: true });
    segs.push({ s, e, solid: false, opening: o });
    cur = e;
  }
  if (cur < L) segs.push({ s: cur, e: L, solid: true });
  return segs;
}

// 單一牆段外框（含端點補角延伸）
export function wallQuad(wall, s, e, extA = 0, extB = 0) {
  const { u, n } = wallFrame(wall);
  const h = wall.t / 2;
  const p0 = add(wall.a, mul(u, s - extA)), p1 = add(wall.a, mul(u, e + extB));
  return [add(p0, mul(n, h)), add(p1, mul(n, h)), add(p1, mul(n, -h)), add(p0, mul(n, -h))];
}

export function wallExtents(plan, wall) {
  return {
    extA: wallEndConnected(plan, wall, 'a') ? wall.t / 2 : 0,
    extB: wallEndConnected(plan, wall, 'b') ? wall.t / 2 : 0,
  };
}

export function planBounds(plan) {
  const xs = [], ys = [];
  for (const w of plan.walls) { xs.push(w.a.x, w.b.x); ys.push(w.a.y, w.b.y); }
  for (const r of plan.rooms) for (const p of r.pts) { xs.push(p.x); ys.push(p.y); }
  for (const it of plan.items) for (const p of itemCorners(it)) { xs.push(p.x); ys.push(p.y); }
  if (!xs.length) return { minX: 0, minY: 0, maxX: 600, maxY: 800 };
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function openingEnds(plan, o) {
  const w = plan.walls.find((x) => x.id === o.wall);
  if (!w) return null;
  const { u, n } = wallFrame(w);
  return {
    wall: w, u, n,
    a: add(w.a, mul(u, o.pos - o.w / 2)),
    b: add(w.a, mul(u, o.pos + o.w / 2)),
    c: add(w.a, mul(u, o.pos)),
  };
}

export function newPlan(name = '新平面') {
  return {
    id: uid('p'), name, note: '',
    elevation: 0, floorHeight: DEFAULTS.floorHeight, wallHeight: DEFAULTS.wallHeight, style: 'basic',
    walls: [], openings: [], rooms: [], items: [], underlay: null,
  };
}

export function normalizePlan(p) {
  const plan = Object.assign(newPlan(p.name || '平面'), p);
  plan.walls = (plan.walls || []).map((w) => ({ id: w.id || uid('w'), kind: 'int', t: 12, h: plan.wallHeight, ...w }));
  plan.openings = (plan.openings || []).map((o) => ({ id: o.id || uid('d'), type: 'door', w: 90, h: DEFAULTS.doorHeight, sill: 0, hinge: 'a', side: 1, ...o }));
  plan.rooms = (plan.rooms || []).map((r) => ({ id: r.id || uid('r'), kind: 'other', name: '', ...r }));
  plan.items = (plan.items || []).map((it) => ({ id: it.id || uid('i'), rot: 0, ...it }));
  return plan;
}

// 從房間多邊形估算樓地板面積（m²）
export const areaM2 = (pts) => polygonArea(pts) / 10000;
export const m2ToPing = (m2) => m2 * 0.3025;
