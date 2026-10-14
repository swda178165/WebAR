// 基地條件、日照與採光模擬、依基地條件自動開窗。
// 座標沿用平面：x 向右、y 向前（圖面下方＝房子正面），z 為離地高度，單位 cm。
// 天空採 CIE 全陰天亮度分布，採光係數 DF＝室內水平照度／室外無遮擋水平照度（%）。
import { wallFrame, wallSegments, openingEnds, polygonArea, pointInPolygon, polygonCentroid, uid, itemCorners } from './model.js';

const D2R = Math.PI / 180;

export const CITIES = {
  keelung: ['基隆', 25.13, 121.74], taipei: ['台北', 25.04, 121.56], newtaipei: ['新北', 25.01, 121.46], taoyuan: ['桃園', 24.99, 121.30], hsinchu: ['新竹', 24.80, 120.97],
  miaoli: ['苗栗', 24.56, 120.82], taichung: ['台中', 24.15, 120.68], changhua: ['彰化', 24.08, 120.54], nantou: ['南投', 23.91, 120.69], yunlin: ['雲林', 23.71, 120.43],
  chiayi: ['嘉義', 23.48, 120.45], tainan: ['台南', 22.99, 120.21], kaohsiung: ['高雄', 22.63, 120.31], pingtung: ['屏東', 22.67, 120.49], yilan: ['宜蘭', 24.75, 121.75],
  hualien: ['花蓮', 23.99, 121.60], taitung: ['台東', 22.76, 121.14], penghu: ['澎湖', 23.57, 119.57],
};

export const DIRS = [['北', 0], ['東北', 45], ['東', 90], ['東南', 135], ['南', 180], ['西南', 225], ['西', 270], ['西北', 315]];
export const dirName = (deg) => DIRS[Math.round((((deg % 360) + 360) % 360) / 45) % 8][0];

export const SIDE_TYPES = {
  party: { name: '緊貼鄰房（共同壁）', hint: '牆貼著隔壁，不能開窗' },
  building: { name: '鄰房，中間有空隙', hint: '輸入到對面外牆的距離與對方樓層' },
  lane: { name: '巷道／防火巷', hint: '輸入巷寬（到對面外牆）與對面樓層' },
  road: { name: '馬路', hint: '輸入到對面建物的距離與對面樓層' },
  open: { name: '空地／公園（無遮擋）', hint: '' },
};
export const SIDE_NAMES = { front: '前面', back: '後面', left: '左側', right: '右側' };
export const SIDE_HINTS = { front: '前陽台那一面', back: '後陽台那一面', left: '從前面看的左邊（天井這一側）', right: '從前面看的右邊（樓梯電梯這一側）' };

export const DAYS = { winter: [355, '冬至 12/22'], equinox: [80, '春分 3/21'], summer: [172, '夏至 6/21'] };
export const STOREY_H = 330; // 對面建物每層約 3.3 m

export function defaultSite() {
  return {
    city: 'taipei', front: 180, floors: 5, groundH: 465, floorH: 350,
    sides: {
      front: { type: 'road', dist: 12, floors: 4 },
      back: { type: 'lane', dist: 4, floors: 4 },
      left: { type: 'party', dist: 0, floors: 5 },
      right: { type: 'party', dist: 0, floors: 5 },
    },
    lw: { top: 'open', wall: 'normal' },
  };
}

export function normalizeSite(s) {
  const d = defaultSite();
  if (!s) return d;
  const out = { ...d, ...s, sides: { ...d.sides } };
  for (const k of Object.keys(d.sides)) out.sides[k] = { ...d.sides[k], ...(s.sides?.[k] || {}) };
  out.lw = { ...LW_DEFAULT, ...(s.lw || {}) };
  return out;
}

// 天井：頂部做法（影響採光與拔風）、四周牆面顏色
export const LW_DEFAULT = { top: 'open', wall: 'normal' };
export const LW_TOPS = {
  open: { name: '開放（不加蓋）', sky: 1, vent: 1 },
  louver: { name: '透光頂蓋＋側邊百葉', sky: 0.75, vent: 0.45 },
  sealed: { name: '採光罩整個封住', sky: 0.75, vent: 0.01 },
};
export const LW_WALLS = { normal: { name: '一般外牆', refl: 0.18 }, light: { name: '刷白／淺色磁磚', refl: 0.32 } };
const lwOf = (site) => ({ ...LW_DEFAULT, ...(site.lw || {}) });

export const latOf = (site) => (CITIES[site.city]?.[1] ?? site.lat ?? 25);
export const roofLevel = (site) => site.groundH + (site.floors - 1) * site.floorH; // 屋頂樓板
export const buildingTop = (site) => roofLevel(site) + 110; // 含女兒牆
export function floorLabel(site, elevation) {
  if (elevation < site.groundH * 0.5) return '1F';
  return Math.round((elevation - site.groundH) / site.floorH) + 2 + 'F';
}

// ---------- 太陽 ----------
// 回傳高度角 alt、方位角 az（自正北順時針），弧度。hour 為太陽時。
export function sunPosition(lat, day, hour) {
  const decl = 23.44 * D2R * Math.sin(2 * Math.PI * (284 + day) / 365);
  const H = (hour - 12) * 15 * D2R;
  const phi = lat * D2R;
  const alt = Math.asin(Math.sin(phi) * Math.sin(decl) + Math.cos(phi) * Math.cos(decl) * Math.cos(H));
  let az = Math.atan2(-Math.cos(decl) * Math.sin(H), Math.sin(decl) * Math.cos(phi) - Math.cos(decl) * Math.sin(phi) * Math.cos(H));
  if (az < 0) az += 2 * Math.PI;
  return { alt, az };
}

// 平面方向 (dx,dy) 的羅盤方位（度）；正面 (0,1) ＝ site.front
export const bearingOf = (site, dx, dy) => ((Math.atan2(dx, -dy) / D2R + site.front - 180) % 360 + 360) % 360;

// 太陽方向（指向太陽）的平面座標單位向量 {x,y,z}
export function sunVector(site, alt, az) {
  const b = az / D2R - (site.front - 180);
  const h = Math.cos(alt);
  return { x: Math.sin(b * D2R) * h, y: -Math.cos(b * D2R) * h, z: Math.sin(alt) };
}

// ---------- 平面外框、立面、天井 ----------
export function planFrame(plan) {
  const ext = plan.walls.filter((w) => w.kind === 'ext' && wallFrame(w).L >= 200);
  const src = ext.length >= 2 ? ext : plan.walls;
  if (!src.length) return { minX: 0, maxX: 600, minY: 0, maxY: 1500 };
  const xs = [], ys = [];
  for (const w of src) { xs.push(w.a.x, w.b.x); ys.push(w.a.y, w.b.y); }
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

function facadeOf(w, fr) {
  const tol = 6;
  if (Math.abs(w.a.y - w.b.y) < 1) {
    if (Math.abs(w.a.y - fr.minY) < tol) return { name: 'back', n: { x: 0, y: -1 } };
    if (Math.abs(w.a.y - fr.maxY) < tol) return { name: 'front', n: { x: 0, y: 1 } };
  } else if (Math.abs(w.a.x - w.b.x) < 1) {
    if (Math.abs(w.a.x - fr.minX) < tol) return { name: 'left', n: { x: -1, y: 0 } };
    if (Math.abs(w.a.x - fr.maxX) < tol) return { name: 'right', n: { x: 1, y: 0 } };
  }
  return null;
}

function rectOf(pts) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}

// 牆是否貼著天井（void）；回傳指向天井內的法線
function voidOf(w, voids) {
  const { L, u } = wallFrame(w);
  if (L < 1) return null;
  const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
  for (const v of voids) {
    const r = v.rect;
    const onEdge = (Math.abs(u.y) < 0.01 && (Math.abs(m.y - r.y0) < 3 || Math.abs(m.y - r.y1) < 3) && m.x > r.x0 - 3 && m.x < r.x1 + 3)
      || (Math.abs(u.x) < 0.01 && (Math.abs(m.x - r.x0) < 3 || Math.abs(m.x - r.x1) < 3) && m.y > r.y0 - 3 && m.y < r.y1 + 3);
    if (!onEdge) continue;
    const c = { x: (r.x0 + r.x1) / 2, y: (r.y0 + r.y1) / 2 };
    const n = Math.abs(u.y) < 0.01 ? { x: 0, y: Math.sign(c.y - m.y) || 1 } : { x: Math.sign(c.x - m.x) || 1, y: 0 };
    return { void: v, n };
  }
  return null;
}

// 天井四面牆的頂端高度（離地 cm）：自己的屋頂（含女兒牆）；貼著共同壁的那一面是鄰房外牆，鄰房比較高就以鄰房為準；
// 整棟規劃時，頂樓房間、浴室貼著天井的那一面會再高一層（site.derived.lwTops，由 building-ui 依頂樓平面算好）。
export function voidTops(plan, site, fr, rect, top = buildingTop(site)) {
  const t = { x0: top, x1: top, y0: top, y1: top };
  for (const [edge, side, c, lim] of [['x0', 'left', rect.x0, fr.minX], ['x1', 'right', rect.x1, fr.maxX], ['y0', 'back', rect.y0, fr.minY], ['y1', 'front', rect.y1, fr.maxY]]) {
    if (Math.abs(c - lim) > 6) continue;
    const s = site.sides?.[side];
    if (s && (s.type === 'party' || (s.type === 'building' && (s.dist || 0) < 1))) t[edge] = Math.max(t[edge], (s.floors || 0) * STOREY_H);
  }
  const d = plan.floor && site.derived?.lwTops;
  if (d) for (const k of Object.keys(t)) if (d[k]) t[k] = Math.max(t[k], d[k]);
  return t;
}

// 天井一扇窗依建築技術規則第 42 條檢討：D＝到對面牆的水平淨距、H＝窗中心到對面牆頂的高度，D/H ≥ 1/4（住宅區）才算有效採光
export function voidDH(w) {
  const alongX = Math.abs(w.n.x) > 0.5;
  const D = (alongX ? w.void.x1 - w.void.x0 : w.void.y1 - w.void.y0) - 15;
  const facing = alongX ? (w.n.x > 0 ? 'x1' : 'x0') : (w.n.y > 0 ? 'y1' : 'y0');
  const H = (w.voidTops?.[facing] ?? w.voidTop) - w.zc;
  return { D, H, ratio: H > 0 ? D / H : Infinity, facing };
}

// 陽台（樓上的陽台板＝雨遮；本層陽台的女兒牆＝近處遮擋）
function balconyBands(plan, fr) {
  const bands = { front: [], back: [], left: [], right: [] };
  for (const r of plan.rooms) {
    if (r.kind !== 'balcony' || r.pts.length < 3) continue;
    const b = rectOf(r.pts);
    if (b.y0 >= fr.maxY - 3) bands.front.push({ a0: b.x0, a1: b.x1, depth: b.y1 - fr.maxY });
    else if (b.y1 <= fr.minY + 3) bands.back.push({ a0: b.x0, a1: b.x1, depth: fr.minY - b.y0 });
    else if (b.x1 <= fr.minX + 3) bands.left.push({ a0: b.y0, a1: b.y1, depth: fr.minX - b.x0 });
    else if (b.x0 >= fr.maxX - 3) bands.right.push({ a0: b.y0, a1: b.y1, depth: b.x1 - fr.maxX });
  }
  return bands;
}

// 建立模擬環境
export function makeEnv(plan, site) {
  const fr = planFrame(plan);
  const elev = plan.elevation || 0;
  const top = buildingTop(site);
  const voids = plan.rooms.filter((r) => r.kind === 'void' && r.pts.length >= 3).map((r) => {
    const rect = rectOf(r.pts);
    return { room: r, rect, tops: voidTops(plan, site, fr, rect, top) };
  });
  const hasAbove = elev + (plan.floorHeight || 350) < roofLevel(site) - 1;
  const bands = balconyBands(plan, fr);
  const sideInfo = (name) => {
    const s = site.sides[name] || { type: 'party' };
    const party = s.type === 'party';
    const open = s.type === 'open';
    return { party, obsD: open ? Infinity : Math.max(50, (s.dist || 0) * 100), obsH: open || party ? 0 : (s.floors || 0) * STOREY_H };
  };
  const env = { plan, site, fr, voids, elev, top, hasAbove, bands, sideInfo, wins: [], blockers: [] };
  // 會擋光的牆段（實牆、門、室內推拉門）
  for (const w of plan.walls) {
    if (w.kind === 'parapet') continue;
    const { L, u } = wallFrame(w);
    if (L < 1) continue;
    for (const sg of wallSegments(plan, w)) {
      const o = sg.opening;
      const clear = o && (o.type === 'window' || o.type === 'opening' || (o.type === 'sliding' && w.kind === 'ext'));
      if (clear) continue;
      env.blockers.push({ a: { x: w.a.x + u.x * sg.s, y: w.a.y + u.y * sg.s }, b: { x: w.a.x + u.x * sg.e, y: w.a.y + u.y * sg.e } });
    }
  }
  for (const o of plan.openings) {
    const info = openingInfo(env, o);
    if (info) env.wins.push(info);
  }
  return env;
}

// 一個開口的外部條件
export function openingInfo(env, o) {
  if (!['window', 'sliding', 'opening'].includes(o.type)) return null;
  const e = openingEnds(env.plan, o);
  if (!e) return null;
  const w = e.wall;
  const fac = w.kind === 'ext' ? facadeOf(w, env.fr) : null;
  const vd = fac ? null : voidOf(w, env.voids);
  if (!fac && !vd) return null;
  if (o.type === 'opening' && !vd) return null;
  const n = fac ? fac.n : vd.n;
  const t = w.t || 12;
  const sill = o.sill || 0, hgt = o.h || 120;
  const frame = o.type === 'sliding' ? 6 : 5;
  const gw = Math.max(10, o.w - 2 * frame), gh = Math.max(10, hgt - 2 * frame);
  const glassFactor = o.type === 'sliding' ? 0.88 : o.type === 'opening' ? 1 : 0.92;
  const info = {
    o, wall: w, n, u: e.u, kind: fac ? 'facade' : 'void', side: fac?.name || 'lightwell',
    c: { x: e.c.x + n.x * t / 2, y: e.c.y + n.y * t / 2 }, // 外牆面上的中心點
    a: { x: e.a.x + n.x * t / 2, y: e.a.y + n.y * t / 2 }, b: { x: e.b.x + n.x * t / 2, y: e.b.y + n.y * t / 2 },
    inner: e.c,
    z0: env.elev + sill + frame, z1: env.elev + sill + hgt - frame, zc: env.elev + sill + hgt / 2,
    gw, gh, area: (gw * gh * glassFactor) / 10000, // m²
    openable: o.type !== 'opening' ? 0.5 : 1,
  };
  if (fac) {
    Object.assign(info, env.sideInfo(fac.name));
    const along = Math.abs(n.y) > 0.5 ? e.c.x : e.c.y;
    const band = env.bands[fac.name].find((b) => along >= b.a0 - 5 && along <= b.a1 + 5);
    if (band) {
      info.parapet = { depth: band.depth, z: env.elev + 110 };
      if (env.hasAbove) info.overhang = { depth: band.depth, z: env.elev + (env.plan.floorHeight || 350) - 15 };
    }
  } else {
    const lw = lwOf(env.site);
    info.void = vd.void.rect;
    info.voidTops = vd.void.tops;
    info.voidTop = Math.max(...Object.values(vd.void.tops));
    info.skyKey = (LW_TOPS[lw.top] || LW_TOPS.open).sky < 1 ? 'skyc' : 'sky';
    info.wallKey = lw.wall === 'light' ? 'wallL' : 'wall';
  }
  return info;
}

const isSky = (k) => k === 'sky' || k === 'skyc';

// 從窗外表面一點 Q 往方向 d 看出去：'sky' 看到天空、'obs' 看到對面建物、'wall' 天井牆、'block' 被擋住
export function trace(info, Q, d) {
  const h = Math.hypot(d.x, d.y);
  if (h < 1e-6) return info.overhang ? 'block' : 'sky';
  const tanG = d.z / h;
  const cosPhi = (d.x * info.n.x + d.y * info.n.y) / h;
  if (cosPhi <= 0.02) return 'block';
  if (info.kind === 'void') {
    const r = info.void;
    const dx = d.x / h, dy = d.y / h;
    let t = Infinity, edge = null;
    const hit = (tt, e) => { if (tt < t) { t = tt; edge = e; } };
    if (dx > 1e-6) hit((r.x1 - Q.x) / dx, 'x1'); else if (dx < -1e-6) hit((r.x0 - Q.x) / dx, 'x0');
    if (dy > 1e-6) hit((r.y1 - Q.y) / dy, 'y1'); else if (dy < -1e-6) hit((r.y0 - Q.y) / dy, 'y0');
    if (!(t > 0)) t = 0;
    const topZ = (edge && info.voidTops?.[edge]) ?? info.voidTop;
    return Q.z + tanG * t >= topZ ? (info.skyKey || 'sky') : (info.wallKey || 'wall');
  }
  if (info.party) return 'block';
  if (info.overhang && d.z > 0) {
    const sPerp = ((info.overhang.z - Q.z) / tanG) * cosPhi;
    if (sPerp < info.overhang.depth) return 'block';
  }
  if (info.parapet && Q.z + (tanG * info.parapet.depth) / cosPhi < info.parapet.z) return 'obs';
  if (info.obsH > 0 && isFinite(info.obsD) && Q.z + (tanG * info.obsD) / cosPhi < info.obsH) return 'obs';
  return 'sky';
}

const LUM = { sky: 1, skyc: LW_TOPS.louver.sky, obs: 0.12, wall: LW_WALLS.normal.refl, wallL: LW_WALLS.light.refl, block: 0 };
const skyL = (sinG) => (1 + 2 * sinG) / 3;
const E_OUT = (7 * Math.PI) / 9;

// 垂直天空係數 VSC（%，無遮擋約 40%）
export function vsc(info, Q = { ...info.c, z: info.zc }) {
  let s = 0;
  const t = { x: -info.n.y, y: info.n.x };
  const NG = 18, NP = 30;
  for (let i = 0; i < NG; i++) {
    const g = ((i + 0.5) / NG) * (Math.PI / 2);
    const cg = Math.cos(g), sg = Math.sin(g);
    for (let j = 0; j < NP; j++) {
      const p = -Math.PI / 2 + ((j + 0.5) / NP) * Math.PI;
      const d = { x: cg * (Math.cos(p) * info.n.x + Math.sin(p) * t.x), y: cg * (Math.cos(p) * info.n.y + Math.sin(p) * t.y), z: sg };
      const f = LUM[trace(info, Q, d)];
      if (f) s += f * skyL(sg) * cg * Math.cos(p) * cg * (Math.PI / 2 / NG) * (Math.PI / NP);
    }
  }
  return (s / E_OUT) * 100;
}

// 窗中心垂直面上看得到天空的角度（度），供平均採光係數估算
export function skyAngle(info) {
  let n = 0;
  const Q = { ...info.c, z: info.zc };
  for (let a = 0.5; a < 90; a += 1) {
    const d = { x: Math.cos(a * D2R) * info.n.x, y: Math.cos(a * D2R) * info.n.y, z: Math.sin(a * D2R) };
    if (isSky(trace(info, Q, d))) n++;
  }
  return n;
}

// 直射日照時數（窗中心）
export function sunHours(env, info, day, from = 6, to = 18, step = 0.25) {
  const lat = latOf(env.site);
  let hrs = 0;
  const Q = { ...info.c, z: info.zc };
  for (let hr = from + step / 2; hr < to; hr += step) {
    const { alt, az } = sunPosition(lat, day, hr);
    if (alt < 3 * D2R) continue;
    const s = sunVector(env.site, alt, az);
    if (s.x * info.n.x + s.y * info.n.y <= 0.03) continue;
    if (isSky(trace(info, Q, s))) hrs += step;
  }
  return hrs;
}

// ---------- 視線遮擋 ----------
function segHit(p, q, a, b) {
  const r = { x: q.x - p.x, y: q.y - p.y }, s = { x: b.x - a.x, y: b.y - a.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-9) return false;
  const t = ((a.x - p.x) * s.y - (a.y - p.y) * s.x) / den;
  const u = ((a.x - p.x) * r.y - (a.y - p.y) * r.x) / den;
  return t > 1e-4 && t < 0.985 && u > -1e-6 && u < 1 + 1e-6;
}
function visible(env, p, q) {
  for (const bl of env.blockers) if (segHit(p, q, bl.a, bl.b)) return false;
  return true;
}
export const lineOfSight = visible;

// ---------- 採光分析 ----------
const LIT_KINDS = ['living', 'bedroom', 'kitchen', 'hall', 'bath', 'storage', 'other', 'stair'];

function distToPoly(p, pts) {
  let m = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const dx = b.x - a.x, dy = b.y - a.y;
    const L2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2));
    m = Math.min(m, Math.hypot(p.x - a.x - dx * t, p.y - a.y - dy * t));
  }
  return m;
}

// 窗屬於哪個房間：窗內側中心點落在房間邊界上
function roomWindows(env, room) {
  return env.wins.filter((w) => distToPoly(w.inner, room.pts) < (w.wall.t || 12) / 2 + 4 && pointNear(room, w));
}
function pointNear(room, w) {
  const p = { x: w.inner.x - w.n.x * ((w.wall.t || 12) / 2 + 4), y: w.inner.y - w.n.y * ((w.wall.t || 12) / 2 + 4) };
  return pointInPolygon(p, room.pts);
}

const IRC_C = [39, 35, 31, 25, 20, 14, 10, 7, 5, 5];
function ircFor(room, wins, ceilH) {
  const area = polygonArea(room.pts) / 10000;
  let per = 0;
  for (let i = 0; i < room.pts.length; i++) { const a = room.pts[i], b = room.pts[(i + 1) % room.pts.length]; per += Math.hypot(b.x - a.x, b.y - a.y) / 100; }
  const A = 2 * area + per * ceilH / 100;
  let irc = 0;
  for (const w of wins) {
    const theta = 90 - (w.sky ?? 90);
    const C = IRC_C[Math.max(0, Math.min(9, Math.round(theta / 10)))];
    irc += ((0.85 * w.area) / (A * 0.5)) * (C * 0.3 + 5 * 0.7) * 0.9;
  }
  return { irc, A, area };
}

export function analyzeDaylight(plan, site, { step = 30, patches = true } = {}) {
  const env = makeEnv(plan, site);
  const TAU = 0.68;
  for (const w of env.wins) {
    w.sky = skyAngle(w);
    w.vsc = vsc(w);
    const nu = Math.max(2, Math.min(8, Math.round(w.gw / 30))), nv = Math.max(2, Math.min(6, Math.round(w.gh / 30)));
    w.patches = [];
    const pA = (w.gw * w.gh) / (nu * nv) * (w.area * 10000 / (w.gw * w.gh));
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const s = (i + 0.5) / nu, z = w.z0 + ((j + 0.5) / nv) * (w.z1 - w.z0);
      const along = -w.gw / 2 + s * w.gw;
      w.patches.push({ x: w.c.x + w.u.x * along, y: w.c.y + w.u.y * along, z, A: pA });
    }
    if (!patches) w.patches = [{ x: w.c.x, y: w.c.y, z: w.zc, A: w.area * 10000 }];
    w.sun = { winter: sunHours(env, w, DAYS.winter[0]), equinox: sunHours(env, w, DAYS.equinox[0]), summer: sunHours(env, w, DAYS.summer[0]) };
    w.west = sunHours(env, w, DAYS.summer[0], 13, 18.5);
    w.bearing = bearingOf(site, w.n.x, w.n.y);
  }
  const ceilH = plan.wallHeight || 300;
  const zP = env.elev + 75;
  const grid = [];
  const rooms = [];
  for (const r of plan.rooms) {
    if (!LIT_KINDS.includes(r.kind) || r.pts.length < 3) continue;
    const own = roomWindows(env, r);
    const { irc, area } = ircFor(r, own, ceilH);
    const b = rectOf(r.pts);
    const pts = [];
    for (let y = b.y0 + step / 2; y < b.y1; y += step) for (let x = b.x0 + step / 2; x < b.x1; x += step) {
      const p = { x, y };
      if (!pointInPolygon(p, r.pts) || distToPoly(p, r.pts) < 25) continue;
      let sum = 0;
      for (const w of env.wins) {
        const toC = (w.inner.x - x) * w.n.x + (w.inner.y - y) * w.n.y;
        if (toC <= 0) continue;
        const ends = [w.inner, { x: w.inner.x + w.u.x * w.gw * 0.4, y: w.inner.y + w.u.y * w.gw * 0.4 }, { x: w.inner.x - w.u.x * w.gw * 0.4, y: w.inner.y - w.u.y * w.gw * 0.4 }];
        let vis = 0;
        for (const q of ends) if (visible(env, p, q)) vis++;
        if (!vis) continue;
        let s = 0;
        for (const pa of w.patches) {
          const vx = pa.x - x, vy = pa.y - y, vz = pa.z - zP;
          if (vz <= 0) continue;
          const r2 = vx * vx + vy * vy + vz * vz, rr = Math.sqrt(r2);
          const dn = (vx * w.n.x + vy * w.n.y) / rr;
          if (dn <= 0) continue;
          const d = { x: vx / rr, y: vy / rr, z: vz / rr };
          const f = LUM[trace(w, pa, d)];
          if (!f) continue;
          s += f * skyL(d.z) * d.z * (pa.A * dn) / r2;
        }
        sum += (s * vis) / 3;
      }
      const df = TAU * (sum / E_OUT) * 100 + irc;
      pts.push({ x, y, df });
      grid.push({ x, y, df, room: r.id });
    }
    const dfs = pts.map((p) => p.df).sort((a, c) => a - c);
    const avg = dfs.length ? dfs.reduce((s, v) => s + v, 0) / dfs.length : irc;
    const glass = own.reduce((s, w) => s + w.area, 0);
    const eff = own.filter((w) => effective(w)).reduce((s, w) => s + w.area, 0);
    const openA = own.reduce((s, w) => s + w.area * w.openable, 0);
    const sunW = Math.max(0, ...own.map((w) => w.sun.winter));
    const sunS = Math.max(0, ...own.map((w) => w.sun.summer));
    const west = Math.max(0, ...own.map((w) => (w.bearing > 200 && w.bearing < 340 ? w.west : 0)));
    rooms.push({
      id: r.id, name: r.name || '', kind: r.kind, area, glass, eff, openA,
      ratio: area ? glass / area : 0, effRatio: area ? eff / area : 0, ventRatio: area ? openA / area : 0,
      df: avg, dfMin: dfs[0] ?? avg, dfMed: dfs[Math.floor(dfs.length / 2)] ?? avg,
      sunWinter: sunW, sunSummer: sunS, west, windows: own.map((w) => w.o.id),
      sides: [...new Set(own.map((w) => w.side))],
      lightwellOnly: own.length > 0 && own.every((w) => w.kind === 'void'),
    });
  }
  for (const r of rooms) r.notes = roomNotes(r, plan);
  const sides = new Set(env.wins.filter((w) => w.openable > 0).map((w) => w.side));
  const cross = (sides.has('front') && sides.has('back')) || (sides.has('left') && sides.has('right'));
  return { env, grid, step, rooms, wins: env.wins, cross, sides: [...sides], site, elev: env.elev };
}

// 建築技術規則：有效採光以 D/H ≥ 1/4 粗估（D＝窗前淨距，H＝窗中心以上的遮擋高度）
export function effective(w) {
  if (w.kind === 'void') return voidDH(w).ratio >= 0.25;
  if (w.party) return false;
  if (!(w.obsH > w.zc) || !isFinite(w.obsD)) return true;
  return w.obsD / (w.obsH - w.zc) >= 0.25;
}

const HABITABLE = ['living', 'bedroom', 'kitchen'];
export const dfTarget = (kind) => ({ living: 2, kitchen: 2, bedroom: 1.5, other: 1.5 }[kind] ?? 0);
export function dfGrade(df) {
  if (df < 0.5) return ['很暗', 0];
  if (df < 1) return ['偏暗', 1];
  if (df < 2) return ['尚可', 2];
  if (df < 5) return ['明亮', 3];
  return ['很亮', 4];
}

function roomNotes(r) {
  const notes = [];
  const hab = HABITABLE.includes(r.kind);
  if (hab && !r.windows.length) notes.push({ lv: 'bad', t: '沒有對外窗：居室依法要能採光，建議改成更衣室、儲藏或走道，或換到有外牆的位置' });
  else if (hab && r.effRatio < 1 / 8) notes.push({ lv: 'warn', t: `有效採光窗 ${(r.effRatio * 100).toFixed(1)}%，未達樓地板面積 1/8（12.5%）` });
  if (r.lightwellOnly && hab) notes.push({ lv: 'warn', t: '只靠天井採光，低樓層光線有限；天井牆面刷白、窗做大可以改善' });
  if (r.west >= 1.5 && hab) notes.push({ lv: 'warn', t: `夏天下午西曬約 ${r.west.toFixed(1)} 小時，建議外遮陽、Low-E 玻璃或深色窗簾` });
  if (hab && r.windows.length && r.sunWinter >= 2) notes.push({ lv: 'good', t: `冬至仍有 ${r.sunWinter.toFixed(1)} 小時日照` });
  if (r.kind === 'bath' && !r.windows.length) notes.push({ lv: 'info', t: '無窗浴室：需裝排風機接管道間' });
  return notes;
}

// ---------- 自動開窗 ----------
const WIN_SPEC = {
  living: { sill: 45, h: 185, maxW: 240, df: 2 },
  bedroom: { sill: 90, h: 140, maxW: 180, df: 1.5 },
  kitchen: { sill: 105, h: 105, maxW: 150, df: 2 },
  other: { sill: 90, h: 140, maxW: 180, df: 1.5 },
  bath: { sill: 160, h: 60, maxW: 90, df: 0, small: true },
  hall: { sill: 90, h: 120, maxW: 120, df: 0.5, optional: true },
  stair: { sill: 120, h: 120, maxW: 120, df: 0.5, optional: true },
};

// 房間在外牆／天井牆上的可開窗區段
function exteriorRuns(env, room) {
  const out = [];
  for (const w of env.plan.walls) {
    if (w.kind === 'parapet') continue;
    const { L, u } = wallFrame(w);
    if (L < 60) continue;
    const fac = w.kind === 'ext' ? facadeOf(w, env.fr) : null;
    const vd = fac ? null : voidOf(w, env.voids);
    if (!fac && !vd) continue;
    // 房間邊與牆中心線共線的部分
    for (let i = 0; i < room.pts.length; i++) {
      const p = room.pts[i], q = room.pts[(i + 1) % room.pts.length];
      const dp = Math.abs((p.x - w.a.x) * u.y - (p.y - w.a.y) * u.x), dq = Math.abs((q.x - w.a.x) * u.y - (q.y - w.a.y) * u.x);
      if (dp > 2 || dq > 2) continue;
      const sp = (p.x - w.a.x) * u.x + (p.y - w.a.y) * u.y, sq = (q.x - w.a.x) * u.x + (q.y - w.a.y) * u.y;
      const s0 = Math.max(0, Math.min(sp, sq)), s1 = Math.min(L, Math.max(sp, sq));
      if (s1 - s0 < 60) continue;
      out.push({ wall: w, s0, s1, fac, vd });
    }
  }
  return out;
}

function subtract(iv, cuts) {
  let parts = [iv];
  for (const [c0, c1] of cuts) {
    const next = [];
    for (const [a, b] of parts) {
      if (c1 <= a || c0 >= b) { next.push([a, b]); continue; }
      if (c0 > a) next.push([a, c0]);
      if (c1 < b) next.push([c1, b]);
    }
    parts = next;
  }
  return parts;
}

// 貼著這面牆、會擋窗的家具在牆上的範圍；avoid＝床頭（盡量不要正對窗）
function furnitureRanges(plan, w, room) {
  const { u } = wallFrame(w);
  const block = [], avoid = [];
  for (const it of plan.items) {
    const tall = ['wardrobe', 'cabinet', 'shelf', 'fridge', 'altar'].includes(it.kind) || (it.kind === 'tv');
    const bed = it.kind === 'bed' || it.kind === 'bed_single';
    if (!tall && !bed) continue;
    if (room && !pointInPolygon(it, room.pts)) continue;
    const cs = itemCorners(it);
    const near = cs.filter((c) => Math.abs((c.x - w.a.x) * u.y - (c.y - w.a.y) * u.x) < w.t / 2 + 22);
    if (near.length < 2) continue;
    const ss = near.map((c) => (c.x - w.a.x) * u.x + (c.y - w.a.y) * u.y);
    const rng = [Math.min(...ss) - 5, Math.max(...ss) + 5];
    if (bed) avoid.push(rng); else block.push(rng);
  }
  return { block, avoid };
}

export function designWindows(plan, site, { rooms: only = null, replace = true, includeOptional = false } = {}) {
  let env = makeEnv(plan, site);
  const report = [];
  const added = [];
  const removed = [];
  // 走道、樓梯（optional）預設不重新開窗，所以也不能把它們原有的窗拿掉（例如走廊對天井的窗）
  const targets = plan.rooms.filter((r) => r.pts.length >= 3 && WIN_SPEC[r.kind] && (!only || only.includes(r.id)) && (includeOptional || !WIN_SPEC[r.kind].optional));
  // 先移除這些房間外牆上的舊窗（保留門與陽台落地門）
  if (replace) {
    const kill = new Set();
    for (const r of targets) {
      for (const run of exteriorRuns(env, r)) {
        for (const o of plan.openings) {
          if (o.wall !== run.wall.id || o.type !== 'window') continue;
          if (o.pos >= run.s0 - 1 && o.pos <= run.s1 + 1) kill.add(o.id);
        }
      }
    }
    if (kill.size) {
      removed.push(...plan.openings.filter((o) => kill.has(o.id)));
      plan.openings = plan.openings.filter((o) => !kill.has(o.id));
      env = makeEnv(plan, site);
    }
  }
  const order = [...targets].sort((a, b) => (WIN_SPEC[a.kind].optional ? 1 : 0) - (WIN_SPEC[b.kind].optional ? 1 : 0) || (WIN_SPEC[b.kind].df - WIN_SPEC[a.kind].df));
  for (const r of order) {
    const spec = WIN_SPEC[r.kind];
    if (spec.optional && !includeOptional) continue;
    const area = polygonArea(r.pts) / 10000;
    const runs = exteriorRuns(env, r);
    const row = { room: r.id, name: r.name || '', kind: r.kind, area, added: [], notes: [] };
    // 已有的玻璃（陽台落地門等）
    const own = roomWindows(env, r);
    let have = own.reduce((s, w) => s + w.area * (effective(w) ? 1 : 0.5), 0);
    let A = 2 * area;
    for (let i = 0; i < r.pts.length; i++) { const a = r.pts[i], b = r.pts[(i + 1) % r.pts.length]; A += Math.hypot(b.x - a.x, b.y - a.y) / 100 * (plan.wallHeight || 300) / 100; }
    const cands = [];
    for (const run of runs) {
      const info0 = { wall: run.wall, n: run.fac ? run.fac.n : run.vd.n, kind: run.fac ? 'facade' : 'void' };
      const side = run.fac?.name || 'lightwell';
      if (run.fac && site.sides[side]?.type === 'party') { row.blockedParty = true; continue; }
      const L = wallFrame(run.wall).L;
      const cuts = [];
      for (const o of plan.openings) if (o.wall === run.wall.id) cuts.push([o.pos - o.w / 2 - 15, o.pos + o.w / 2 + 15]);
      const fr = furnitureRanges(plan, run.wall, r);
      cuts.push(...fr.block);
      const endM = (s) => (s <= 1 || s >= L - 1 ? 30 : 22);
      for (const [a, b] of subtract([run.s0 + endM(run.s0), run.s1 - endM(run.s1)], cuts)) {
        if (b - a < (spec.small ? 45 : 60)) continue;
        const mid = (a + b) / 2;
        const probe = { type: 'window', pos: mid, w: Math.min(b - a, 120), sill: spec.sill, h: spec.h, wall: run.wall.id, id: '_p' };
        const info = openingInfoForProbe(env, probe);
        if (!info) continue;
        const v = vsc(info);
        const sw = sunHours(env, info, DAYS.winter[0]);
        const west = sunHours(env, info, DAYS.summer[0], 13, 18.5);
        const bearing = bearingOf(site, info.n.x, info.n.y);
        let score = v / 20;
        if (['living', 'bedroom'].includes(r.kind)) score += Math.min(sw, 5) * 0.12;
        if (bearing > 200 && bearing < 340 && west > 1.2 && r.kind !== 'bath') score -= 0.35;
        if (run.vd) score -= 0.25;
        if (info.obsD < 350 && ['bedroom', 'bath'].includes(r.kind)) score -= 0.15;
        const avoidHit = fr.avoid.some(([c0, c1]) => c1 > a && c0 < b);
        cands.push({ run, a, b, info, score, vsc: v, sw, west, bearing, side, avoid: fr.avoid, avoidHit, sky: skyAngle(info) });
      }
    }
    cands.sort((x, y) => y.score - x.score);
    if (!runs.length) row.notes.push(r.kind === 'bath' ? '沒有外牆，靠排風機與管道間通風' : '這個房間沒有外牆或天井牆，無法開窗');
    else if (!cands.length) row.notes.push(row.blockedParty ? '外牆是和鄰房共用的牆，不能開窗' : '外牆被門或高櫃佔滿，沒有地方開窗');
    // 目標玻璃面積：1/8 法規與平均採光係數取大
    const usedSides = new Set();
    let count = 0;
    for (const c of cands) {
      if (count >= (spec.small ? 1 : 3)) break;
      const code = HABITABLE.includes(r.kind) || r.kind === 'other' ? area / 8 : 0;
      const theta = Math.max(5, c.sky);
      const byDF = spec.df ? (spec.df * A * 0.75) / (0.68 * theta) : 0;
      const need = Math.max(code, byDF) * 1.05 - have;
      if (count > 0 && need <= 0) break;
      if (count > 0 && usedSides.has(c.side) && need < 0.6) break;
      const glassH = (spec.h - 10) / 100;
      let wReq = spec.small ? 60 : Math.ceil(((Math.max(need, 0.5) / glassH) * 100 + 10) / 30) * 30;
      wReq = Math.max(spec.small ? 45 : 60, Math.min(wReq, spec.maxW));
      const room = c.b - c.a;
      const wid = Math.min(wReq, Math.floor(room / 5) * 5);
      if (wid < (spec.small ? 45 : 60)) continue;
      // 位置：盡量對準房間中心，避開床頭
      const cen = polygonCentroid(r.pts);
      const { u } = wallFrame(c.run.wall);
      let pos = (cen.x - c.run.wall.a.x) * u.x + (cen.y - c.run.wall.a.y) * u.y;
      pos = Math.max(c.a + wid / 2, Math.min(c.b - wid / 2, pos));
      for (const [c0, c1] of c.avoid) {
        if (pos + wid / 2 > c0 && pos - wid / 2 < c1) {
          const left = c0 - wid / 2, right = c1 + wid / 2;
          if (left >= c.a + wid / 2) pos = left; else if (right <= c.b - wid / 2) pos = right;
        }
      }
      pos = Math.round(pos);
      const frost = r.kind === 'bath' || (r.kind === 'bedroom' && c.info.obsD < 250 && c.side !== 'lightwell');
      const o = { id: uid('d'), wall: c.run.wall.id, pos, w: wid, type: 'window', sill: spec.sill, h: spec.h, hinge: 'a', side: 1, auto: true };
      if (frost) o.frosted = true;
      if (c.west > 1.2 && c.bearing > 200 && c.bearing < 340 && r.kind !== 'bath') o.shade = true;
      plan.openings.push(o);
      added.push(o);
      env = makeEnv(plan, site);
      const infoNew = env.wins.find((x) => x.o.id === o.id);
      have += infoNew ? infoNew.area * (effective(infoNew) ? 1 : 0.5) : 0;
      usedSides.add(c.side);
      count++;
      row.added.push({ side: c.side, bearing: c.bearing, w: wid, sill: spec.sill, h: spec.h, vsc: c.vsc, sunWinter: c.sw, west: c.west, frosted: !!o.frosted, shade: !!o.shade });
      if (spec.small) break;
    }
    if (row.added.some((x) => x.shade)) row.notes.push('西向窗：建議加外遮陽或 Low-E 玻璃');
    if (row.added.some((x) => x.side === 'lightwell') && !row.added.some((x) => x.side !== 'lightwell') && r.kind !== 'bath') row.notes.push('只能開在天井，採光有限');
    report.push(row);
  }
  return { added, removed, report };
}

export function openingInfoForProbe(env, probe) {
  const p = env.plan;
  p.openings.push(probe);
  const info = openingInfo(env, probe);
  p.openings.pop();
  return info;
}

// 立面方位說明，例如「前面（朝南）」
export function sideLabel(site, side) {
  const n = { front: [0, 1], back: [0, -1], left: [-1, 0], right: [1, 0] }[side];
  if (!n) return side === 'lightwell' ? '天井' : side;
  return `${SIDE_NAMES[side]}（朝${dirName(bearingOf(site, n[0], n[1]))}）`;
}

// 採光係數色階（暗藍 → 綠 → 黃 → 橘）
const DF_STOPS = [[0, [44, 62, 99]], [0.5, [69, 103, 154]], [1, [95, 159, 184]], [2, [159, 208, 143]], [3.5, [242, 223, 107]], [6, [255, 177, 61]]];
export function dfColor(df) {
  const v = Math.max(0, df);
  for (let i = 1; i < DF_STOPS.length; i++) {
    const [b, cb] = DF_STOPS[i], [a, ca] = DF_STOPS[i - 1];
    if (v <= b) {
      const t = (v - a) / (b - a);
      const c = ca.map((x, k) => Math.round(x + (cb[k] - x) * t));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  const c = DF_STOPS[DF_STOPS.length - 1][1];
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
export const DF_LEGEND = [0, 0.5, 1, 2, 3.5, 6];

// 某一時刻從窗戶照進室內的光斑（地板上的四邊形）
export function sunPatches(result, sun) {
  if (!result || !sun || sun.z <= 0.02) return [];
  const out = [];
  for (const w of result.wins) {
    if (sun.x * w.n.x + sun.y * w.n.y <= 0.02) continue;
    if (!isSky(trace(w, { ...w.c, z: w.zc }, sun))) continue;
    const pts = [];
    for (const [a, z] of [[-w.gw / 2, w.z0], [w.gw / 2, w.z0], [w.gw / 2, w.z1], [-w.gw / 2, w.z1]]) {
      const x = w.c.x + w.u.x * a, y = w.c.y + w.u.y * a;
      const k = (z - result.elev) / sun.z;
      pts.push({ x: x - sun.x * k, y: y - sun.y * k });
    }
    out.push({ win: w, pts });
  }
  return out;
}
