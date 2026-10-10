// 自動擺家具：給一個矩形房間（四面牆、門、窗、障礙物），依用途挑出最合適的家具位置。
// 每種家具會列出所有可能位置、檢查淨空與動線，再依人體工學與常見風水禁忌打分數，取最好的。
import { uid } from './model.js';
import { CATALOG } from './catalog.js';

export const OPP = { N: 'S', S: 'N', W: 'E', E: 'W' };
const ROT = { N: 0, S: 180, W: 270, E: 90 }; // 靠在這面牆的家具，正面朝房間內
const PERP = { N: ['W', 'E'], S: ['W', 'E'], W: ['N', 'S'], E: ['N', 'S'] };
const EDGES = ['N', 'S', 'W', 'E'];

export const overlap = (a, b, eps = 0.5) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > eps && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > eps;
const cx = (r) => (r.x0 + r.x1) / 2, cy = (r) => (r.y0 + r.y1) / 2;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

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
  return parts.filter(([a, b]) => b - a > 1);
}

// spec：{ rect:{x0,y0,x1,y1}（牆中心線）, edges:{N:{t, walls:[[a,b]], nb}}, doors:[{edge,a,b,kind}], windows:[{edge,a,b,sill,h}], obstacles:[rect], ducts:[{x,y}] }
export class RoomLayout {
  constructor(spec) {
    this.spec = spec;
    const r = spec.rect, E = spec.edges;
    const ins = (k) => ((E[k]?.walls?.length ? (E[k].t || 12) / 2 : 0) + 1);
    this.ix0 = r.x0 + ins('W'); this.ix1 = r.x1 - ins('E');
    this.iy0 = r.y0 + ins('N'); this.iy1 = r.y1 - ins('S');
    this.W = this.ix1 - this.ix0; this.H = this.iy1 - this.iy0;
    this.area = (this.W * this.H) / 10000;
    this.items = [];
    this.occ = (spec.obstacles || []).map((o) => ({ ...o }));
    this.clear = [];
    this.notes = [];
    for (const d of spec.doors || []) this.clear.push({ ...this.doorZone(d), door: d.kind !== 'open' });
  }

  range(e) { return e === 'N' || e === 'S' ? [this.ix0, this.ix1] : [this.iy0, this.iy1]; }
  mid(e) { const [a, b] = this.range(e); return (a + b) / 2; }
  depthFrom(e) { return e === 'N' || e === 'S' ? this.H : this.W; }

  rectAt(e, w, d, t) {
    if (e === 'N') return { x0: t, y0: this.iy0, x1: t + w, y1: this.iy0 + d };
    if (e === 'S') return { x0: t, y0: this.iy1 - d, x1: t + w, y1: this.iy1 };
    if (e === 'W') return { x0: this.ix0, y0: t, x1: this.ix0 + d, y1: t + w };
    return { x0: this.ix1 - d, y0: t, x1: this.ix1, y1: t + w };
  }
  front(r, e, depth) {
    if (e === 'N') return { x0: r.x0, y0: r.y1, x1: r.x1, y1: r.y1 + depth };
    if (e === 'S') return { x0: r.x0, y0: r.y0 - depth, x1: r.x1, y1: r.y0 };
    if (e === 'W') return { x0: r.x1, y0: r.y0, x1: r.x1 + depth, y1: r.y1 };
    return { x0: r.x0 - depth, y0: r.y0, x1: r.x0, y1: r.y1 };
  }
  doorZone(d) {
    const len = d.b - d.a;
    // 門片掃過的是四分之一圓，正方形角落其實用不到，留門寬減 10 cm 即可
    const depth = d.kind === 'door' ? Math.max(60, len - 10) : d.kind === 'open' ? 70 : 62;
    return this.rectAt(d.edge, len + 4, depth, d.a - 2);
  }
  inside(r, slack = 0.6) { return r.x0 >= this.ix0 - slack && r.y0 >= this.iy0 - slack && r.x1 <= this.ix1 + slack && r.y1 <= this.iy1 + slack; }
  hits(r, list) { for (const o of list) if (overlap(r, o)) return true; return false; }
  free(r, { clear = true } = {}) { return this.inside(r) && !this.hits(r, this.occ) && (!clear || !this.hits(r, this.clear)); }

  // 沿牆不能靠家具的範圍（門、沒有牆的開放邊、高家具遇到窗）
  cuts(e, { tall = 0, wall = true } = {}) {
    const [lo, hi] = this.range(e);
    const E = this.spec.edges[e] || {};
    const cuts = [];
    if (wall) for (const iv of subtract([lo, hi], (E.walls || []).map(([a, b]) => [a, b]))) cuts.push(iv);
    for (const d of this.spec.doors || []) if (d.edge === e) cuts.push([d.a - 8, d.b + 8]);
    if (tall) for (const w of this.spec.windows || []) if (w.edge === e && w.sill < tall) cuts.push([w.a - 5, w.b + 5]);
    // 障礙物（管道間）貼著這面牆
    for (const o of this.occ) {
      const near = e === 'N' ? o.y0 < this.iy0 + 30 : e === 'S' ? o.y1 > this.iy1 - 30 : e === 'W' ? o.x0 < this.ix0 + 30 : o.x1 > this.ix1 - 30;
      if (near) cuts.push(e === 'N' || e === 'S' ? [o.x0, o.x1] : [o.y0, o.y1]);
    }
    return cuts;
  }
  spans(e, opt) { return subtract(this.range(e), this.cuts(e, opt)); }
  windowOn(e, a, b) { return (this.spec.windows || []).some((w) => w.edge === e && w.b > a + 5 && w.a < b - 5); }
  doorOn(e, a, b) { return (this.spec.doors || []).some((d) => d.edge === e && d.b > a && d.a < b); }
  isWall(e, a, b) {
    const E = this.spec.edges[e];
    if (!E?.walls?.length) return false;
    return subtract([a, b], E.walls).length === 0;
  }
  neighbor(e, a, b) {
    const E = this.spec.edges[e];
    if (!E?.nbs) return E?.nb || null;
    for (const n of E.nbs) if (n.b > a && n.a < b) return n.use;
    return null;
  }

  // 沿著家具側面量淨空（到牆或其他家具），最多量到 max
  gap(r, dir, max = 140, fromInset = 0) {
    let g = 0;
    while (g < max) {
      const s = g + 5;
      let z;
      if (dir === 'W') z = { x0: r.x0 - s, y0: r.y0 + fromInset, x1: r.x0, y1: r.y1 };
      else if (dir === 'E') z = { x0: r.x1, y0: r.y0 + fromInset, x1: r.x1 + s, y1: r.y1 };
      else if (dir === 'N') z = { x0: r.x0 + fromInset, y0: r.y0 - s, x1: r.x1, y1: r.y0 };
      else z = { x0: r.x0 + fromInset, y0: r.y1, x1: r.x1, y1: r.y1 + s };
      if (!this.inside(z) || this.hits(z, this.occ)) break;
      g = s;
    }
    return g;
  }

  add(kind, r, face, extra = {}) {
    const rot = typeof face === 'number' ? face : ROT[face];
    const side = rot === 90 || rot === 270;
    const it = {
      id: uid('i'), kind, x: Math.round(cx(r) * 10) / 10, y: Math.round(cy(r) * 10) / 10,
      w: Math.round((side ? r.y1 - r.y0 : r.x1 - r.x0) * 10) / 10, d: Math.round((side ? r.x1 - r.x0 : r.y1 - r.y0) * 10) / 10, rot,
      h: extra.h ?? CATALOG[kind]?.h,
    };
    for (const [k, v] of Object.entries(extra)) if (v !== undefined && k !== 'noOcc') it[k] = v;
    this.items.push(it);
    if (!extra.noOcc) this.occ.push(r);
    return it;
  }

  // 位置候選：沿著可用區段，每 step 公分一個，另外加上貼齊區段兩端
  *slots(e, w, opt = {}, step = 10) {
    for (const [a, b] of this.spans(e, opt)) {
      if (b - a < w - 0.5) continue;
      const seen = new Set();
      const push = (t) => { const k = Math.round(t); if (!seen.has(k)) { seen.add(k); return true; } return false; };
      for (let t = a; t <= b - w + 0.01; t += step) if (push(t)) yield { t, a, b };
      if (push(b - w)) yield { t: b - w, a, b };
    }
  }

  // 找一個空角落放小東西
  corner(w, d, prefer = null) {
    const cands = [];
    for (const e of EDGES) {
      for (const { t, a, b } of this.slots(e, w, { wall: false }, 5)) {
        if (t > a + 1 && t < b - w - 1) continue;
        const r = this.rectAt(e, w, d, t);
        if (!this.free(r)) continue;
        let s = 0;
        if (prefer) s -= dist({ x: cx(r), y: cy(r) }, prefer) / 100;
        cands.push({ r, e, s });
      }
    }
    cands.sort((x, y) => y.s - x.s);
    return cands[0] || null;
  }

  // 冷氣：掛在沒有窗、沒有門的牆段中間
  addAC(avoidEdge = null) {
    let best = null;
    for (const e of EDGES) {
      for (const [a, b] of this.spans(e, { tall: 260 })) {
        if (b - a < 100) continue;
        const s = (e === avoidEdge ? -2 : 0) + (b - a) / 200 + (PERP[e].includes(avoidEdge) ? 1 : 0);
        if (!best || s > best.s) best = { e, t: (a + b) / 2 - 45, s };
      }
    }
    if (best) this.add('ac', this.rectAt(best.e, 90, 22, best.t), best.e, { noOcc: true });
  }
}

// ======================================================================
// 各用途
// ======================================================================
export function furnish(L, use, opt = {}) {
  const fn = RECIPES[use];
  if (fn) fn(L, opt);
  return { items: L.items, notes: L.notes };
}

const DENSE = { basic: 1, japandi: 0, nordic: 1, wabi: 0, industrial: 1, luxe: 2 };

function bedroom(L, opt) {
  const role = opt.role || 'master';
  const kid = role === 'kid';
  const small = L.area < 7.6;
  let bw = kid || ((role === 'guest' || role === 'study') && small) ? 106 : 152;
  if (role === 'master' && Math.min(L.W, L.H) >= 330 && L.area >= 12.5) bw = 182;
  const bd = bw === 106 ? 196 : 205;
  let best = null;
  for (const e of EDGES) {
    for (const { t } of this_slots(L, e, bw, { wall: true }, 5)) {
      const r = L.rectAt(e, bw, bd, t);
      if (!L.free(r)) continue;
      const foot = L.front(r, e, 55);
      if (!L.inside(foot) || L.hits(foot, L.occ)) continue;
      const sideDirs = PERP[OPP[e]] || PERP[e];
      const g1 = L.gap(r, sideDirs[0], 130, 0), g2 = L.gap(r, sideDirs[1], 130, 0);
      let s = 0;
      if (kid || bw === 106) { s += Math.min(g1, g2) < 3 ? 2.5 : 0; s += Math.max(g1, g2) >= 60 ? 1.5 : -4; }
      else {
        if (Math.min(g1, g2) < 40) s -= 4;
        s += Math.min(g1, 75) / 30 + Math.min(g2, 75) / 30;
        s -= Math.abs((t + bw / 2) - L.mid(e)) / 120;
      }
      if (role === 'elder') s += Math.max(g1, g2) >= 90 ? 2 : -2;
      if (L.windowOn(e, t, t + bw)) s -= 2.5; // 床頭不靠窗
      if (L.doorOn(OPP[e], t + 10, t + bw - 10)) s -= 2.2; // 門對床尾
      for (const d of L.spec.doors || []) {
        if (!['bath', 'ensuite'].includes(d.nb)) continue;
        const z = L.rectAt(d.edge, d.b - d.a, 400, d.a);
        if (overlap(z, r)) s -= 2.5; // 浴室門對床
      }
      if (L.neighbor(e, t, t + bw) === 'bath') s -= 1;
      if (!L.isWall(e, t, t + bw)) s -= 6;
      if (!best || s > best.s) best = { r, e, t, s, g1, g2, sideDirs };
    }
  }
  if (!best) { L.notes.push('床放不下'); return; }
  const bed = L.add(bw === 106 ? 'bed_single' : 'bed', best.r, best.e, bw === 182 ? { label: '雙人床 6×6.2尺' } : role === 'study' ? { label: '沙發床' } : {});
  // 床頭櫃
  const ns = [];
  for (const k of [-1, 1]) {
    const t = k < 0 ? best.t - 47 : best.t + bw + 2;
    const r = L.rectAt(best.e, 45, 40, t);
    if (L.free(r) && (!(kid || bw === 106) || ns.length === 0)) { L.add('nightstand', r, best.e); ns.push(r); }
  }
  // 床邊走道留空
  const bedR = best.r;
  for (const dir of best.sideDirs) {
    const z = dir === 'W' ? { x0: bedR.x0 - 50, y0: bedR.y0, x1: bedR.x0, y1: bedR.y1 } : dir === 'E' ? { x0: bedR.x1, y0: bedR.y0, x1: bedR.x1 + 50, y1: bedR.y1 }
      : dir === 'N' ? { x0: bedR.x0, y0: bedR.y0 - 50, x1: bedR.x1, y1: bedR.y0 } : { x0: bedR.x0, y0: bedR.y1, x1: bedR.x1, y1: bedR.y1 + 50 };
    L.clear.push(z);
  }
  L.clear.push(L.front(bedR, best.e, 55));
  // 衣櫃
  const maxW = role === 'master' ? 240 : role === 'kid' ? 150 : role === 'study' ? 0 : 180;
  if (maxW) wardrobe(L, maxW, best.e);
  // 書桌
  if (kid || role === 'study' || (role === 'master' && L.area >= 13.5) || (role === 'guest' && L.area >= 10)) desk(L, kid ? 100 : 110);
  // 單椅＋立燈
  const dens = DENSE[opt.style] ?? 1;
  if ((role === 'master' || role === 'elder') && L.area >= 11) {
    const c = L.corner(75, 75);
    if (c) {
      L.add('armchair', c.r, c.e);
      if (dens >= 1) { const l = L.corner(40, 40); if (l) L.add('lamp', l.r, l.e); }
    }
  }
  if (dens >= 0 && !kid && L.area >= 9 && opt.rug !== false) {
    const rw = bw + 70, rd = Math.min(bd * 0.7, 150);
    const r = rugUnder(bedR, best.e, rw, rd);
    if (r) L.add('rug', r, best.e, { noOcc: true });
  }
  if (dens >= 1) { const p = L.corner(40, 40); if (p) L.add('plant', p.r, p.e); }
  L.addAC(best.e);
  void bed;
}

function this_slots(L, e, w, opt, step) { return L.slots(e, w, opt, step); }

function rugUnder(bedR, e, rw, rd) {
  // 床尾那一半下方
  if (e === 'N') return { x0: cx(bedR) - rw / 2, y0: bedR.y1 - rd + 40, x1: cx(bedR) + rw / 2, y1: bedR.y1 + 40 };
  if (e === 'S') return { x0: cx(bedR) - rw / 2, y0: bedR.y0 - 40, x1: cx(bedR) + rw / 2, y1: bedR.y0 + rd - 40 };
  if (e === 'W') return { x0: bedR.x1 - rd + 40, y0: cy(bedR) - rw / 2, x1: bedR.x1 + 40, y1: cy(bedR) + rw / 2 };
  return { x0: bedR.x0 - 40, y0: cy(bedR) - rw / 2, x1: bedR.x0 + rd - 40, y1: cy(bedR) + rw / 2 };
}

function wardrobe(L, maxW, avoidEdge = null, depth = 60, label = '衣櫃', relax = false) {
  let best = null;
  const doorsOnly = L.clear.filter((z) => z.door);
  for (const e of EDGES) {
    for (const [a, b] of L.spans(e, { tall: 230 })) {
      const lens = [];
      for (let len = Math.min(maxW, Math.floor((b - a) / 10) * 10); len >= (relax ? 60 : 90); len -= 30) lens.push(len);
      for (const len of lens) for (let t = a; t <= b - len + 0.01; t += 10) {
        const r = L.rectAt(e, len, depth, t);
        if (relax ? !L.inside(r) || L.hits(r, L.occ) || L.hits(r, doorsOnly) : !L.free(r)) continue;
        const fz = L.front(r, e, relax ? 40 : 55);
        if (!L.inside(fz) || L.hits(fz, L.occ)) continue;
        let s = len / 60 + (t <= a + 1 || t >= b - len - 10 ? 0.6 : 0) - (e === avoidEdge ? 0.4 : 0);
        if (L.doorOn(OPP[e], t, t + len)) s -= 0.3;
        if (!best || s > best.s) best = { r, e, s, len };
      }
    }
  }
  if (!best) {
    if (!relax) return wardrobe(L, maxW, avoidEdge, depth === 60 ? 55 : depth, label, true);
    L.notes.push('衣櫃放不下');
    return null;
  }
  L.clear.push(L.front(best.r, best.e, 55));
  return L.add('wardrobe', best.r, best.e, { label, w: best.len });
}

function desk(L, w = 100, label = '書桌') {
  let best = null;
  for (const e of EDGES) {
    for (const { t, a, b } of L.slots(e, w, { tall: 0 }, 10)) {
      const r = L.rectAt(e, w, 55, t);
      if (!L.free(r)) continue;
      const cz = L.front(r, e, 70);
      if (!L.inside(cz) || L.hits(cz, L.occ)) continue;
      let s = L.windowOn(e, t, t + w) ? 3 : 0;
      if (t <= a + 1 || t >= b - w - 1) s += 0.6;
      if (!best || s > best.s) best = { r, e, s };
    }
  }
  if (!best) return null;
  const d = L.add('desk', best.r, best.e, { label });
  const ch = L.front(best.r, best.e, 50);
  const chair = { x0: cx(ch) - 25, y0: cy(ch) - 25, x1: cx(ch) + 25, y1: cy(ch) + 25 };
  const fz = L.front(best.r, best.e, 70);
  L.add('chair', chair, ROT[OPP[best.e]], { noOcc: true });
  L.occ.push(fz);
  return d;
}

// ---------- 客廳 ----------
function living(L, opt) {
  const lite = opt.lite;
  let best = livingPass(L, lite, true);
  if (!best) best = livingPass(L, lite, false);
  if (!best) { L.notes.push('沙發放不下'); return; }
  placeLiving(L, opt, best, lite);
}

function livingPass(L, lite, needTV) {
  let best = null;
  for (const e of EDGES) {
    const o = OPP[e];
    const depth = L.depthFrom(e);
    if (depth < (lite ? 190 : 250)) continue;
    for (const sw of lite ? [170, 150] : [220, 200, 170, 150]) {
      for (const { t } of L.slots(e, sw, { wall: false }, 10)) {
        const r = L.rectAt(e, sw, 90, t);
        if (!L.free(r)) continue;
        const onWall = L.isWall(e, t, t + sw);
        const c = t + sw / 2;
        // 電視
        let tv = null;
        for (const tw of [180, 160, 140]) {
          for (const { t: tt } of L.slots(o, tw, { tall: 140 }, 5)) {
            const tr = L.rectAt(o, tw, 42, tt);
            if (!L.free(tr) || !L.isWall(o, tt, tt + tw)) continue;
            const off = Math.abs(tt + tw / 2 - c);
            if (!tv || off < tv.off) tv = { r: tr, off, tw };
          }
          if (tv && tv.off < 40) break;
        }
        const view = depth - 90 - 42;
        if (!tv && needTV && !lite) continue;
        let s = 0;
        s += onWall ? 2.5 : -1.2;
        if (L.windowOn(e, t, t + sw)) s -= 0.4;
        if (tv) { s += 2 - tv.off / 60; s += view >= 220 && view <= 360 ? 1 : view < 180 ? -2 : 0; }
        else s -= 1.5;
        s += sw / 200;
        s -= Math.abs(c - L.mid(e)) / 200;
        // 茶几位置要空
        const cr = L.front(r, e, 45 + 60);
        const coffee = shrinkTo(cr, e, Math.min(110, sw - 60), 60, 45);
        if (!L.free(coffee)) s -= 3;
        if (!best || s > best.s) best = { r, e, o, sw, tv, s, coffee };
      }
    }
  }
  return best;
}

function placeLiving(L, opt, best, lite) {
  L.add('sofa', best.r, best.e, { label: best.sw >= 200 ? '三人沙發' : '雙人沙發', w: best.sw });
  if (best.tv) L.add('tv', best.tv.r, best.o, { label: '電視櫃' });
  if (L.free(best.coffee)) L.add('coffee', best.coffee, best.e);
  // 地毯：沙發與電視之間
  const span = best.tv ? betweenRect(best.r, best.tv.r, best.e) : L.front(best.r, best.e, 170);
  const rug = centerRect(span, Math.min(best.sw + 30, 240), Math.min(170, depthOf(span, best.e) - 20), best.e);
  if (rug && opt.rug !== false) L.add('rug', rug, best.e, { noOcc: true });
  // 單椅
  const dens = DENSE[opt.style] ?? 1;
  if (!lite) {
    const n = dens >= 2 ? 2 : 1;
    let placed = 0;
    for (const side of [1, -1]) {
      if (placed >= n) break;
      const a = armchairBeside(L, best.coffee, best.e, side);
      if (a) placed++;
    }
  }
  // 立燈、書櫃、植栽
  if (dens >= 0 && !lite) { const l = L.corner(40, 40, { x: cx(best.r), y: cy(best.r) }); if (l) L.add('lamp', l.r, l.e); }
  shelf(L, lite ? 120 : 160);
  if (dens >= 1) { const p = L.corner(45, 45); if (p) L.add('plant', p.r, p.e); }
  L.addAC(best.e);
}

const depthOf = (r, e) => (e === 'N' || e === 'S' ? r.y1 - r.y0 : r.x1 - r.x0);
function betweenRect(a, b, e) {
  if (e === 'N' || e === 'S') return { x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1), y0: Math.min(a.y1, b.y1), y1: Math.max(a.y0, b.y0) };
  return { y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), x0: Math.min(a.x1, b.x1), x1: Math.max(a.x0, b.x0) };
}
function centerRect(span, along, deep, e) {
  if (deep < 60) return null;
  const c = { x: cx(span), y: cy(span) };
  return e === 'N' || e === 'S' ? { x0: c.x - along / 2, x1: c.x + along / 2, y0: c.y - deep / 2, y1: c.y + deep / 2 } : { x0: c.x - deep / 2, x1: c.x + deep / 2, y0: c.y - along / 2, y1: c.y + along / 2 };
}
// 在 frontZone 中靠近沙發那側，取 along×deep 的矩形（離沙發 gap）
function shrinkTo(zone, e, along, deep, gap) {
  const c = e === 'N' || e === 'S' ? cx(zone) : cy(zone);
  if (e === 'N') return { x0: c - along / 2, x1: c + along / 2, y0: zone.y0 + gap, y1: zone.y0 + gap + deep };
  if (e === 'S') return { x0: c - along / 2, x1: c + along / 2, y1: zone.y1 - gap, y0: zone.y1 - gap - deep };
  if (e === 'W') return { y0: c - along / 2, y1: c + along / 2, x0: zone.x0 + gap, x1: zone.x0 + gap + deep };
  return { y0: c - along / 2, y1: c + along / 2, x1: zone.x1 - gap, x0: zone.x1 - gap - deep };
}
function armchairBeside(L, coffee, e, side) {
  const s = 75;
  let r, face;
  if (e === 'N' || e === 'S') {
    const x0 = side > 0 ? coffee.x1 + 30 : coffee.x0 - 30 - s;
    r = { x0, x1: x0 + s, y0: cy(coffee) - s / 2, y1: cy(coffee) + s / 2 };
    face = side > 0 ? 90 : 270;
  } else {
    const y0 = side > 0 ? coffee.y1 + 30 : coffee.y0 - 30 - s;
    r = { y0, y1: y0 + s, x0: cx(coffee) - s / 2, x1: cx(coffee) + s / 2 };
    face = side > 0 ? 180 : 0;
  }
  if (!L.free(r)) return null;
  return L.add('armchair', r, face);
}

function shelf(L, maxW = 160, label = '書櫃', depth = 35) {
  let best = null;
  for (const e of EDGES) {
    for (const [a, b] of L.spans(e, { tall: 200 })) {
      const len = Math.min(maxW, Math.floor((b - a) / 10) * 10);
      if (len < 80) continue;
      for (const t of [a, b - len]) {
        const r = L.rectAt(e, len, depth, t);
        if (!L.free(r)) continue;
        const fz = L.front(r, e, 50);
        if (!L.inside(fz) || L.hits(fz, L.occ)) continue;
        const s = len / 100;
        if (!best || s > best.s) best = { r, e, s, len };
      }
    }
  }
  if (!best) return null;
  return L.add('shelf', best.r, best.e, { label, w: best.len });
}

// ---------- 餐桌 ----------
function dining(L, opt) {
  const seats = opt.seats || 4;
  const [tw, td] = seats >= 6 ? [180, 90] : seats <= 2 ? [90, 75] : [140, 85];
  const per = Math.max(1, Math.round(seats / 2));
  let best = null;
  const room = { x: (L.ix0 + L.ix1) / 2, y: (L.iy0 + L.iy1) / 2 };
  const target = opt.near || room;
  for (const horiz of [true, false]) {
    const W = horiz ? tw : td, D = horiz ? td : tw;
    const cw = horiz ? 0 : 42, ch = horiz ? 42 : 0; // 椅子伸出
    const zx = horiz ? 30 : 75, zy = horiz ? 75 : 30;
    for (let x = L.ix0 + W / 2 + cw; x <= L.ix1 - W / 2 - cw + 0.1; x += 10) {
      for (let y = L.iy0 + D / 2 + ch; y <= L.iy1 - D / 2 - ch + 0.1; y += 10) {
        const t = { x0: x - W / 2, x1: x + W / 2, y0: y - D / 2, y1: y + D / 2 };
        const withChairs = { x0: t.x0 - cw, x1: t.x1 + cw, y0: t.y0 - ch, y1: t.y1 + ch };
        if (!L.free(withChairs, { clear: false })) continue;
        const zone = { x0: t.x0 - zx, x1: t.x1 + zx, y0: t.y0 - zy, y1: t.y1 + zy };
        const zoneIn = { x0: Math.max(zone.x0, L.ix0 - (opt.openW ? 80 : 0)), x1: Math.min(zone.x1, L.ix1 + (opt.openE ? 80 : 0)), y0: Math.max(zone.y0, L.iy0 - (opt.openN ? 80 : 0)), y1: Math.min(zone.y1, L.iy1 + (opt.openS ? 80 : 0)) };
        let s = -dist({ x, y }, target) / 80;
        if (zoneIn.x1 - zoneIn.x0 < zone.x1 - zone.x0 - 1 || zoneIn.y1 - zoneIn.y0 < zone.y1 - zone.y0 - 1) s -= 2.5;
        if (L.hits(zone, L.occ)) s -= 2;
        for (const z of L.clear) if (overlap(withChairs, z)) s -= z.door ? 3 : 1.2;
        if (L.hits(t, L.clear.filter((z) => z.door))) s -= 4;
        if ((horiz && L.W >= L.H) || (!horiz && L.H > L.W)) s += 0.5;
        if (!best || s > best.s) best = { t, horiz, s, x, y };
      }
    }
  }
  if (!best) { L.notes.push('餐桌放不下'); return; }
  const { t, horiz } = best;
  L.add('table', t, horiz ? 0 : 90, { label: '餐桌', w: horiz ? tw : tw, d: td });
  const chairs = [];
  const span = horiz ? t.x1 - t.x0 : t.y1 - t.y0;
  for (let i = 0; i < per; i++) {
    const p = (horiz ? t.x0 : t.y0) + span * (i + 0.5) / per;
    if (horiz) {
      chairs.push([{ x0: p - 25, x1: p + 25, y0: t.y0 - 40, y1: t.y0 + 8 }, 0]);
      chairs.push([{ x0: p - 25, x1: p + 25, y0: t.y1 - 8, y1: t.y1 + 40 }, 180]);
    } else {
      chairs.push([{ y0: p - 25, y1: p + 25, x0: t.x0 - 40, x1: t.x0 + 8 }, 270]);
      chairs.push([{ y0: p - 25, y1: p + 25, x0: t.x1 - 8, x1: t.x1 + 40 }, 90]);
    }
  }
  for (const [r, f] of chairs) L.add('chair', r, f, { noOcc: true });
  L.occ.push({ x0: t.x0 - (horiz ? 0 : 75), x1: t.x1 + (horiz ? 0 : 75), y0: t.y0 - (horiz ? 75 : 0), y1: t.y1 + (horiz ? 75 : 0) });
  // 餐邊櫃
  if (opt.sideboard !== false) {
    let sb = null;
    for (const e of EDGES) for (const { t: tt } of L.slots(e, 120, { tall: 90 }, 10)) {
      const r = L.rectAt(e, 120, 42, tt);
      if (!L.free(r)) continue;
      const fz = L.front(r, e, 50);
      if (L.hits(fz, L.occ)) continue;
      sb = { r, e };
      break;
    }
    if (sb) L.add('cabinet', sb.r, sb.e, { label: '餐邊櫃', h: 85 });
  }
}

// ---------- 廚房 ----------
function kitchen(L, opt) {
  const D = 62;
  const ducts = opt.ducts || [];
  const vent = opt.ventEdges || []; // 可直接對外排油煙的外牆
  const arms = [];
  for (const e of EDGES) {
    for (const [a, b] of subtract(L.range(e), [...L.cuts(e, {}), ...(L.spec.windows || []).filter((w) => w.edge === e && w.sill < 88).map((w) => [w.a - 3, w.b + 3])])) {
      if (b - a >= 60) arms.push({ e, a, b });
    }
  }
  const layouts = [];
  for (const A of arms) if (A.b - A.a >= 170) layouts.push([{ ...A, dir: 1 }]);
  // L 型：兩段在角落相接
  for (const A of arms) for (const B of arms) {
    if (!PERP[A.e].includes(B.e)) continue;
    const cA = cornerCoord(L, A.e, B.e), cB = cornerCoord(L, B.e, A.e);
    const aHas = Math.abs(A.a - cA) < 1 || Math.abs(A.b - cA) < 1;
    const bHas = Math.abs(B.a - cB) < 1 || Math.abs(B.b - cB) < 1;
    if (!aHas || !bHas) continue;
    // A 從遠端走到角落（含角落方塊），B 從角落外側往遠端
    const aDir = Math.abs(A.b - cA) < 1 ? 1 : -1;
    const bDir = Math.abs(B.a - cB) < 1 ? 1 : -1;
    const bSeg = bDir > 0 ? { e: B.e, a: B.a + D, b: B.b, dir: 1 } : { e: B.e, a: B.a, b: B.b - D, dir: -1 };
    if (bSeg.b - bSeg.a < 60 || A.b - A.a < 100) continue;
    layouts.push([{ ...A, dir: aDir }, bSeg]);
  }
  let best = null;
  for (const lay of layouts) {
    const plan = planKitchen(L, lay, D, ducts, vent);
    if (plan && (!best || plan.s > best.s)) best = plan;
  }
  if (!best) { L.notes.push('流理台排不下'); return; }
  for (const p of best.pieces) {
    if (p.kind === 'fridge') L.add('fridge', L.rectAt(p.e, 72, 70, p.t), p.e, { label: '冰箱' });
    else L.add('counter', L.rectAt(p.e, p.w, D, p.t), p.e, { top: p.top, label: { sink: '水槽', stove: '瓦斯爐', plain: '備料' }[p.top] });
  }
  for (const pl of best.pieces) L.clear.push(L.front(L.rectAt(pl.e, pl.w || 72, D, pl.t), pl.e, 95));
  if (opt.island) {
    let isl = null;
    for (const [iw, id] of [[160, 90], [140, 85], [120, 80]]) {
      for (let x = L.ix0 + iw / 2 + 95; x <= L.ix1 - iw / 2 - 95; x += 10) for (let y = L.iy0 + id / 2 + 95; y <= L.iy1 - id / 2 - 95; y += 10) {
        const r = { x0: x - iw / 2, x1: x + iw / 2, y0: y - id / 2, y1: y + id / 2 };
        const z = { x0: r.x0 - 95, x1: r.x1 + 95, y0: r.y0 - 95, y1: r.y1 + 95 };
        if (!L.free(r, { clear: false }) || L.hits(z, L.occ)) continue;
        isl = r; break;
      }
      if (isl) break;
    }
    if (isl) L.add('island', isl, 0, { label: '中島' });
    else L.notes.push('空間不夠放中島（四周要留 95 cm 走道）');
  }
  L.stove = best.stove;
  L.counterLen = best.len;
}

function cornerCoord(L, e, other) {
  // e 這面牆上，和 other 牆交會那一端的座標
  if (e === 'N' || e === 'S') return other === 'W' ? L.ix0 : L.ix1;
  return other === 'N' ? L.iy0 : L.iy1;
}

function planKitchen(L, lay, D, ducts, vent) {
  // 把各段串成一條路徑，用「路徑位置 → (牆, 沿牆座標)」換算
  const segs = lay.map((s) => ({ ...s, len: s.b - s.a }));
  const total = segs.reduce((a, s) => a + s.len, 0);
  if (total < 170) return null;
  const at = (p, w) => {
    let acc = 0;
    for (const s of segs) {
      if (p >= acc - 0.01 && p + w <= acc + s.len + 0.01) {
        const off = p - acc;
        const t = s.dir > 0 ? s.a + off : s.b - off - w;
        return { e: s.e, t };
      }
      acc += s.len;
    }
    return null;
  };
  const center = (pos) => { const r = L.rectAt(pos.e, pos.w, D, pos.t); return { x: cx(r), y: cy(r) }; };
  const fridgeW = 72, stoveW = 80, sinkW = 80;
  let best = null;
  for (const fEnd of [0, 1, -1]) { // 冰箱在起點、終點或不放在檯面線上
    const fPos = fEnd === 0 ? 0 : fEnd === 1 ? total - fridgeW : null;
    if (fPos !== null && fPos < 0) continue;
    const fSlot = fPos !== null ? at(fPos, fridgeW) : null;
    if (fPos !== null && !fSlot) continue;
    if (fSlot && L.windowOn(fSlot.e, fSlot.t, fSlot.t + fridgeW)) continue;
    const lo = fEnd === 0 ? fridgeW : 0, hi = fEnd === 1 ? total - fridgeW : total;
    for (let sp = lo + 30; sp + stoveW <= hi - 30 + 0.01; sp += 10) {
      const st = at(sp, stoveW);
      if (!st) continue;
      if (L.windowOn(st.e, st.t, st.t + stoveW)) continue; // 爐子不放窗下
      const stC = center({ ...st, w: stoveW });
      let ductD = Infinity;
      for (const d of ducts) ductD = Math.min(ductD, dist(stC, d));
      if (vent.includes(st.e)) ductD = Math.min(ductD, 60);
      for (let kp = lo; kp + sinkW <= hi + 0.01; kp += 10) {
        if (kp + sinkW > sp - 55 && kp < sp + stoveW + 55) continue; // 水火之間留備料台
        const sk = at(kp, sinkW);
        if (!sk) continue;
        const skC = center({ ...sk, w: sinkW });
        let s = 0;
        s -= ductD / 60;
        if (ductD > 260) s -= 3;
        if (L.windowOn(sk.e, sk.t, sk.t + sinkW)) s += 1.2;
        const fC = fSlot ? center({ ...fSlot, w: fridgeW }) : null;
        const tri = fC ? dist(fC, skC) + dist(skC, stC) + dist(stC, fC) : 0;
        if (fC) s += tri >= 300 && tri <= 700 ? 1 : -0.5;
        else s -= 1.5;
        const prep = Math.abs((kp + sinkW / 2) - (sp + stoveW / 2)) - (sinkW + stoveW) / 2;
        s += Math.min(prep, 120) / 120;
        s += total / 300;
        if (segs.length > 1) s += 0.4;
        if (!best || s > best.s) best = { s, fPos, sp, kp, ductD };
      }
    }
  }
  if (!best) return null;
  // 切成實際的檯面
  const mods = [];
  if (best.fPos !== null) mods.push({ p: best.fPos, w: fridgeW, kind: 'fridge' });
  mods.push({ p: best.sp, w: stoveW, top: 'stove' });
  mods.push({ p: best.kp, w: sinkW, top: 'sink' });
  mods.sort((a, b) => a.p - b.p);
  const pieces = [];
  let acc = 0;
  for (const s of segs) {
    const s0 = acc, s1 = acc + s.len;
    let cur = s0;
    const inSeg = mods.filter((m) => m.p >= s0 - 0.01 && m.p + m.w <= s1 + 0.01);
    const emit = (p, w, extra) => {
      if (w < 14) return;
      const pos = at(p, w) || { e: s.e, t: s.dir > 0 ? s.a + (p - s0) : s.b - (p - s0) - w };
      pieces.push({ e: s.e, t: pos.t, w, ...extra });
    };
    for (const m of inSeg) {
      if (m.p - cur >= 14) for (const [p, w] of splitRun(cur, m.p)) emit(p, w, { top: 'plain' });
      emit(m.p, m.w, m.kind ? { kind: m.kind } : { top: m.top });
      cur = m.p + m.w;
    }
    if (s1 - cur >= 14) for (const [p, w] of splitRun(cur, s1)) emit(p, w, { top: 'plain' });
    acc = s1;
  }
  const stoveP = pieces.find((p) => p.top === 'stove');
  const r = L.rectAt(stoveP.e, stoveP.w, D, stoveP.t);
  return { s: best.s, pieces, stove: { x: cx(r), y: cy(r), e: stoveP.e }, len: total, ductD: best.ductD };
}

function splitRun(a, b) {
  const out = [];
  const n = Math.max(1, Math.ceil((b - a) / 120));
  const w = (b - a) / n;
  for (let i = 0; i < n; i++) out.push([a + i * w, w]);
  return out;
}

// ---------- 浴室 ----------
function bath(L, opt) {
  const door = (L.spec.doors || [])[0];
  const de = door?.edge || 'S';
  const far = OPP[de];
  const doorC = door ? midOfDoor(L, door) : { x: (L.ix0 + L.ix1) / 2, y: (L.iy0 + L.iy1) / 2 };
  const ducts = opt.ducts || [];
  const wets = [];
  const fl = L.range(far);
  const farLen = fl[1] - fl[0];
  const acc = opt.accessible;
  // 整排淋浴
  if (farLen <= 230) for (const sd of acc ? [130, 120] : [100, 90, 110]) wets.push({ kind: 'shower', r: L.rectAt(far, farLen, sd, fl[0]), e: far, label: acc ? '淋浴（無門檻）' : '淋浴（乾濕分離）' });
  // 角落淋浴
  for (const e of [far, ...PERP[far]]) {
    const [a, b] = L.range(e);
    for (const [sw, sd] of acc ? [[120, 120], [130, 100]] : [[100, 95], [90, 90], [120, 85], [80, 100]]) {
      for (const t of [a, b - sw]) wets.push({ kind: 'shower', r: L.rectAt(e, sw, sd, t), e, label: acc ? '淋浴（無門檻）' : '淋浴' });
    }
  }
  if (opt.tub && L.area >= 4.4) {
    for (const e of [far, ...PERP[far]]) { const [a, b] = L.range(e); if (b - a >= 152) for (const t of [a, b - 150]) wets.push({ kind: 'bathtub', r: L.rectAt(e, 150, 75, t), e, label: '浴缸' }); }
  }
  let best = null;
  for (const w of wets) {
    if (!L.free(w.r)) continue;
    const occ1 = [...L.occ, w.r];
    const wetS = (w.e === far ? 1 : 0) + (w.kind === 'bathtub' ? 1.5 : 0) + dist({ x: cx(w.r), y: cy(w.r) }, doorC) / 200;
    // 馬桶
    const toilets = [];
    for (const e of EDGES) for (const { t } of L.slots(e, 42, {}, 5)) {
      const r = L.rectAt(e, 42, 70, t);
      const side = e === 'N' || e === 'S' ? { x0: r.x0 - 18, x1: r.x1 + 18, y0: r.y0, y1: r.y1 } : { x0: r.x0, x1: r.x1, y0: r.y0 - 18, y1: r.y1 + 18 };
      const fz = L.front(r, e, 55);
      if (!L.inside(side) && !L.inside(r)) continue;
      if (!L.inside(r) || L.hits(r, occ1) || L.hits(r, L.clear) || !L.inside(fz) || L.hits(fz, occ1)) continue;
      if (L.hits(side, occ1)) continue;
      let s = 0;
      let dd = Infinity;
      for (const d of ducts) dd = Math.min(dd, dist({ x: cx(r), y: cy(r) }, d));
      s -= isFinite(dd) ? dd / 50 : 0;
      if (door && e === OPP[de] && Math.abs((t + 21) - (door.a + door.b) / 2) < 45) s -= 2; // 馬桶正對門
      toilets.push({ r, e, s, fz });
    }
    toilets.sort((a, b) => b.s - a.s);
    for (const tl of toilets.slice(0, 12)) {
      const occ2 = [...occ1, tl.r, tl.fz];
      for (const e of EDGES) for (const { t } of L.slots(e, 60, {}, 5)) {
        const r = L.rectAt(e, 60, 48, t);
        const fz = L.front(r, e, 65);
        if (!L.inside(r) || L.hits(r, occ2) || L.hits(r, L.clear) || !L.inside(fz) || L.hits(fz, [...occ1, tl.r])) continue;
        let s = wetS + tl.s - dist({ x: cx(r), y: cy(r) }, doorC) / 90;
        if (acc) {
          // 150 cm 迴轉空間
          if (!turnSpace(L, [...occ1, tl.r, r])) s -= 3;
        }
        if (!best || s > best.s) best = { s, w, tl, b: { r, e } };
      }
    }
  }
  if (!best) {
    if (acc) { L.notes.push('浴室不夠大，無障礙淋浴改成一般尺寸'); return bath(L, { ...opt, accessible: false, tub: false }); }
    L.notes.push('浴室太小，淋浴區放不下');
    return;
  }
  L.add(best.w.kind, best.w.r, best.w.e, { label: best.w.label });
  L.add('toilet', best.tl.r, best.tl.e);
  L.add('basin', best.b.r, best.b.e, { label: '洗手台' });
  if (acc) L.notes.push('馬桶旁與淋浴區預留扶手（高 75–85 cm）');
}

function turnSpace(L, occ) {
  for (let x = L.ix0; x + 150 <= L.ix1 + 0.1; x += 10) for (let y = L.iy0; y + 150 <= L.iy1 + 0.1; y += 10) {
    const r = { x0: x, y0: y, x1: x + 150, y1: y + 150 };
    if (!occ.some((o) => overlap(r, o, 20))) return true;
  }
  return false;
}

function midOfDoor(L, d) {
  const m = (d.a + d.b) / 2;
  if (d.edge === 'N') return { x: m, y: L.iy0 };
  if (d.edge === 'S') return { x: m, y: L.iy1 };
  if (d.edge === 'W') return { x: L.ix0, y: m };
  return { x: L.ix1, y: m };
}

// ---------- 其他 ----------
function study(L, opt) {
  if (opt.guest) { bedroom(L, { ...opt, role: 'study' }); return; }
  desk(L, Math.min(140, Math.max(100, Math.floor(Math.max(L.W, L.H) / 2 / 10) * 10)), '書桌');
  shelf(L, 180, '書櫃');
  if (L.area >= 6.5) { const c = L.corner(75, 75); if (c) { L.add('armchair', c.r, c.e); const l = L.corner(40, 40); if (l) L.add('lamp', l.r, l.e); } }
  L.addAC();
}

function tatami(L, opt) {
  // 架高和室：留一條 80 cm 走道在門那一側，其餘做架高地板
  const door = (L.spec.doors || [])[0];
  const de = door?.edge || 'S';
  let r = { x0: L.ix0, y0: L.iy0, x1: L.ix1, y1: L.iy1 };
  if (de === 'N') r.y0 += 85; else if (de === 'S') r.y1 -= 85; else if (de === 'W') r.x0 += 85; else r.x1 -= 85;
  for (const o of L.occ) if (overlap(r, o)) { r = null; break; }
  if (r && r.x1 - r.x0 >= 170 && r.y1 - r.y0 >= 170) {
    L.add('tatami', r, OPP[de] ? ROT[OPP[de]] : 0, { label: '架高和室', noOcc: true });
    const c = { x: cx(r), y: cy(r) };
    L.add('lowtable', { x0: c.x - 45, x1: c.x + 45, y0: c.y - 30, y1: c.y + 30 }, 0, { label: '和室桌', elev: 40, noOcc: true });
    L.occ.push(r);
  } else {
    // 太窄做不了架高：整間平鋪榻榻米（留門口落塵區）
    const f = { x0: L.ix0, y0: L.iy0, x1: L.ix1, y1: L.iy1 };
    if (de === 'N') f.y0 += 60; else if (de === 'S') f.y1 -= 60; else if (de === 'W') f.x0 += 60; else f.x1 -= 60;
    L.add('tatami', f, 0, { label: '平鋪榻榻米', h: 6, noOcc: true });
    const c = { x: cx(f), y: cy(f) };
    L.add('lowtable', { x0: c.x - 40, x1: c.x + 40, y0: c.y - 28, y1: c.y + 28 }, 0, { label: '和室桌', elev: 6, noOcc: true });
  }
  L.addAC();
  void opt;
}

function altar(L, opt) {
  const door = (L.spec.doors || [])[0];
  let best = null;
  for (const e of EDGES) {
    for (const { t } of L.slots(e, 160, { tall: 200 }, 10)) {
      const r = L.rectAt(e, 160, 100, t);
      if (!L.free(r) || !L.isWall(e, t, t + 160)) continue;
      let s = -Math.abs(t + 80 - L.mid(e)) / 60;
      const nb = L.neighbor(e, t, t + 160);
      if (nb === 'bath' || nb === 'ensuite' || nb === 'kitchen') s -= 6; // 神明桌背後不靠廁所、廚房
      if (door && door.edge === OPP[e]) s += 2; // 面向入口
      if (e === (opt.backEdge || 'N')) s += 1.5; // 背靠內側、面向前方
      if (L.windowOn(e, t, t + 160)) s -= 5;
      if (!best || s > best.s) best = { r, e, s };
    }
  }
  if (!best) { L.notes.push('神明桌放不下'); return; }
  L.add('altar', best.r, best.e, { label: '神明桌' });
  L.clear.push(L.front(best.r, best.e, 90));
  const c = L.corner(75, 75);
  if (c) L.add('armchair', c.r, c.e);
  shelf(L, 120, '收納櫃', 40);
  L.addAC(best.e);
}

function walkin(L) {
  let n = 0;
  for (const e of L.W >= L.H ? ['N', 'S'] : ['W', 'E']) {
    const r = wardrobe(L, 300, null, 58, '衣櫃');
    if (r) n++;
    void e;
  }
  if (!n) L.notes.push('更衣室太窄');
}

function storage(L) {
  for (let i = 0; i < 2; i++) if (!shelf(L, 240, '收納層架', 45)) break;
}

function laundry(L) {
  for (const [k, w, d, label] of [['washer', 60, 62, '洗衣機'], ['washer', 60, 62, '烘衣機'], ['laundry', 50, 45, '洗衣台']]) {
    let ok = false;
    for (const e of EDGES) { for (const { t } of L.slots(e, w, {}, 5)) { const r = L.rectAt(e, w, d, t); if (L.free(r)) { L.add(k, r, e, { label }); ok = true; break; } } if (ok) break; }
  }
  shelf(L, 120, '收納層架', 40);
}

function entry(L, opt) {
  const p = opt.entrance || { x: L.ix1, y: L.iy0 };
  let best = null;
  for (const e of EDGES) for (const { t } of L.slots(e, 120, { tall: 210 }, 5)) {
    for (const len of [180, 150, 120]) {
      const r = L.rectAt(e, len, 40, t);
      if (!L.free(r)) continue;
      const fz = L.front(r, e, 90);
      if (!L.inside(fz, 120) || L.hits(fz, L.occ)) continue;
      const s = len / 100 - dist({ x: cx(r), y: cy(r) }, p) / 150;
      if (!best || s > best.s) best = { r, e, s, len };
    }
  }
  if (best) {
    L.add('cabinet', best.r, best.e, { label: '玄關鞋櫃', h: 210 });
    L.clear.push(L.front(best.r, best.e, 90));
    // 穿鞋椅緊接在鞋櫃旁
    const e = best.e;
    const along = e === 'N' || e === 'S' ? [best.r.x0, best.r.x1] : [best.r.y0, best.r.y1];
    for (const t of [along[1] + 3, along[0] - 93]) {
      const r = L.rectAt(e, 90, 38, t);
      if (L.free(r)) { L.add('bench', r, e, { label: '穿鞋椅' }); break; }
    }
  }
}

function family(L, opt) { living(L, { ...opt, lite: true }); }

// 走道旁的小起居角：書櫃＋單椅＋立燈，不擋動線
function nook(L, opt) {
  shelf(L, 160, '書櫃', 35);
  const c = L.corner(75, 75);
  if (c) { L.add('armchair', c.r, c.e); const l = L.corner(40, 40); if (l) L.add('lamp', l.r, l.e); }
  if ((DENSE[opt.style] ?? 1) >= 1) { const p = L.corner(45, 45); if (p) L.add('plant', p.r, p.e); }
}

function hall(L, opt) {
  if (opt.entrance) return entry(L, opt);
  if (Math.min(L.W, L.H) >= 170) shelf(L, 120, '展示櫃', 35);
}

// ---------- 出租套房、公共空間、店面、頂樓 ----------
// 沿牆放一件設備：前方留操作空間，盡量跟已放的東西排成一列、靠近指定點（例如管道間）
function wallItem(L, kind, w, d, extra = {}, near = null, front = 60) {
  let best = null;
  const tall = extra.h ?? CATALOG[kind]?.h ?? 0;
  for (const e of EDGES) for (const { t, a, b } of L.slots(e, w, { tall: tall > 100 ? tall : 0 }, 5)) {
    const r = L.rectAt(e, w, d, t);
    if (!L.free(r)) continue;
    const fz = L.front(r, e, front);
    if (!L.inside(fz) || L.hits(fz, L.occ)) continue;
    let s = 0;
    if (near) s -= dist({ x: cx(r), y: cy(r) }, near) / 100;
    if (L.items.length && L.hits({ x0: r.x0 - 3, x1: r.x1 + 3, y0: r.y0 - 3, y1: r.y1 + 3 }, L.items.map(itemRect))) s += 1.2;
    if (t <= a + 1 || t >= b - w - 1) s += 0.3;
    if (!best || s > best.s) best = { r, e, s };
  }
  if (!best) return null;
  L.clear.push(L.front(best.r, best.e, front));
  return L.add(kind, best.r, best.e, extra);
}

function itemRect(it) {
  const side = it.rot === 90 || it.rot === 270;
  const w = side ? it.d : it.w, d = side ? it.w : it.d;
  return { x0: it.x - w / 2, x1: it.x + w / 2, y0: it.y - d / 2, y1: it.y + d / 2 };
}

function nearestDuct(L, opt) {
  const c = { x: (L.ix0 + L.ix1) / 2, y: (L.iy0 + L.iy1) / 2 };
  let best = null;
  for (const d of opt.ducts || []) if (!best || dist(d, c) < dist(best, c)) best = d;
  return best;
}

// 出租套房：學生用單人床、書桌、衣櫃、小冰箱
function tenant(L, opt) {
  bedroom(L, { ...opt, role: L.area >= 14 ? 'guest' : 'kid', rug: false });
  if (!L.items.some((i) => i.kind === 'desk')) desk(L, 100);
  const f = L.corner(55, 55);
  if (f) L.add('fridge', f.r, f.e, { label: '小冰箱', h: 85, w: 55, d: 55 });
}

// 共用茶水洗衣間
function pantry(L, opt) {
  const near = nearestDuct(L, opt);
  wallItem(L, 'counter', 120, 60, { top: 'sink', label: '水槽' }, near);
  wallItem(L, 'counter', 60, 60, { label: '微波爐台' }, near);
  wallItem(L, 'fridge', 70, 70, { label: '共用冰箱' }, near);
  wallItem(L, 'washer', 60, 62, { label: '洗衣機' }, near);
  wallItem(L, 'washer', 60, 62, { label: '烘衣機' }, near);
  if (L.area >= 7) { dining(L, { seats: 2, sideboard: false }); relabel(L, 'table', '小餐桌'); }
}

function relabel(L, kind, label) {
  for (let i = L.items.length - 1; i >= 0; i--) if (L.items[i].kind === kind) { L.items[i].label = label; return; }
}

// 公共梯廳／玄關：鞋櫃、信箱
function lobby(L, opt) {
  entry(L, opt);
  wallItem(L, 'cabinet', 80, 30, { label: '信箱', h: 120 }, opt.entrance, 80);
}

// 頂樓露台：曬衣架、戶外桌、植栽
function terrace(L, opt) {
  wallItem(L, 'rack', 160, 50, { label: '曬衣架' }, opt.near || null, 70);
  wallItem(L, 'rack', 160, 50, { label: '曬衣架' }, opt.near || null, 70);
  dining(L, { seats: 4, sideboard: false });
  relabel(L, 'table', '戶外桌');
  for (let i = 0; i < 5; i++) { const p = L.corner(50, 50); if (!p) break; L.add('plant', p.r, p.e); }
}

// 一樓店面：櫃台、展示架、展示桌
function shop(L, opt) {
  wallItem(L, 'counter', 160, 60, { label: '櫃台', h: 100 }, opt.entrance || null, 90);
  for (let i = 0; i < 4; i++) if (!shelf(L, 240, '展示架', 45)) break;
  dining(L, { seats: 2, sideboard: false });
  relabel(L, 'table', '展示桌');
  for (let i = L.items.length - 1; i >= 0; i--) if (L.items[i].kind === 'chair') L.items.splice(i, 1);
  for (let i = 0; i < 2; i++) { const p = L.corner(50, 50); if (!p) break; L.add('plant', p.r, p.e); }
}

// 一樓工作室：辦公桌、會議桌、檔案櫃
function office(L, opt) {
  for (let i = 0; i < 4; i++) if (!desk(L, 120, '辦公桌')) break;
  shelf(L, 200, '檔案櫃', 40);
  dining(L, { seats: 6, sideboard: false });
  relabel(L, 'table', '會議桌');
  void opt;
}

const RECIPES = {
  tenant, pantry, lobby, terrace, shop, office,
  master: (L, o) => bedroom(L, { ...o, role: 'master' }),
  elder: (L, o) => bedroom(L, { ...o, role: 'elder' }),
  kid: (L, o) => bedroom(L, { ...o, role: 'kid' }),
  guest: (L, o) => bedroom(L, { ...o, role: 'guest' }),
  study, tatami, altar, living, dining, kitchen, family, hall, nook,
  bath, ensuite: bath, walkin, storage, laundry, entry,
};
