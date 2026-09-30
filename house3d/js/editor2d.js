// 2D 平面編輯器（SVG）：平移縮放、拖拉牆／門窗／家具、畫牆、偵測房間、底圖校正。
import {
  uid, add, sub, mul, dot, dist, len, norm, lerp, round1, wallFrame, projectOnSegment,
  wallSegments, wallQuad, wallExtents, polygonCentroid, itemCorners, toLocal, areaM2, m2ToPing,
  pointInPolygon, planBounds, openingEnds, ROOM_KINDS, DEFAULTS,
} from './model.js';
import { CATALOG, itemName } from './catalog.js';
import { detectRoom } from './geometry.js';

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const f1 = (v) => Math.round(v * 10) / 10;
const pts = (arr) => arr.map((p) => `${f1(p.x)},${f1(p.y)}`).join(' ');

export class Editor2D {
  constructor(svg, app) {
    this.svg = svg;
    this.app = app;
    this.view = { cx: 300, cy: 780, scale: 0.4 }; // scale = px / cm
    this.drag = null;
    this.draft = null; // 繪製中的牆、房間、量測、校正
    this.hover = null;
    this.pointers = new Map();
    this.spaceDown = false;
    this._bind();
  }

  // ---------- 座標 ----------
  resizeObserve() {
    const ro = new ResizeObserver(() => this.render());
    ro.observe(this.svg);
  }

  size() {
    const r = this.svg.getBoundingClientRect();
    return { w: Math.max(50, r.width), h: Math.max(50, r.height), left: r.left, top: r.top };
  }

  toWorld(clientX, clientY) {
    const s = this.size();
    return {
      x: this.view.cx + (clientX - s.left - s.w / 2) / this.view.scale,
      y: this.view.cy + (clientY - s.top - s.h / 2) / this.view.scale,
    };
  }

  fit(padding = 40) {
    const plan = this.app.plan;
    let b = planBounds(plan);
    const u = plan.underlay;
    if (u?.visible && u.src && !plan.walls.length && !plan.items.length) {
      // 空白平面：以底圖範圍取景
      const m = u.matrix;
      const c = [[0, 0], [u.w, 0], [0, u.h], [u.w, u.h]].map(([px, py]) => ({ x: m[0] * px + m[2] * py + m[4], y: m[1] * px + m[3] * py + m[5] }));
      b = { minX: Math.min(...c.map((p) => p.x)), maxX: Math.max(...c.map((p) => p.x)), minY: Math.min(...c.map((p) => p.y)), maxY: Math.max(...c.map((p) => p.y)) };
    }
    const s = this.size();
    const w = b.maxX - b.minX || 600, h = b.maxY - b.minY || 800;
    this.view.scale = Math.min((s.w - padding * 2) / w, (s.h - padding * 2) / h);
    this.view.cx = (b.minX + b.maxX) / 2;
    this.view.cy = (b.minY + b.maxY) / 2;
    this.render();
  }

  zoomAt(clientX, clientY, factor) {
    const before = this.toWorld(clientX, clientY);
    this.view.scale = Math.min(8, Math.max(0.05, this.view.scale * factor));
    const after = this.toWorld(clientX, clientY);
    this.view.cx += before.x - after.x;
    this.view.cy += before.y - after.y;
    this.render();
  }

  px(n) { return n / this.view.scale; } // 螢幕像素 → cm

  // ---------- 繪製 ----------
  render() {
    const plan = this.app.plan;
    const s = this.size();
    const { cx, cy, scale } = this.view;
    const vw = s.w / scale, vh = s.h / scale;
    this.svg.setAttribute('viewBox', `${cx - vw / 2} ${cy - vh / 2} ${vw} ${vh}`);
    const st = this.app.settings;
    const sel = this.app.sel;
    const out = [];
    const fs = Math.max(14, this.px(12)); // 文字大小（cm）

    out.push(this.defs());
    // 底圖
    const u = plan.underlay;
    if (u && u.visible && u.src) {
      out.push(`<image href="${esc(u.src)}" width="${u.w}" height="${u.h}" transform="matrix(${u.matrix.join(' ')})" opacity="${u.opacity ?? 0.45}" preserveAspectRatio="none" data-hit="underlay" style="pointer-events:${this.app.tool === 'underlay' ? 'all' : 'none'}"/>`);
    }
    // 格線
    if (st.grid) {
      const x0 = Math.floor((cx - vw / 2) / 100) * 100, y0 = Math.floor((cy - vh / 2) / 100) * 100;
      out.push(`<rect x="${x0 - 100}" y="${y0 - 100}" width="${vw + 300}" height="${vh + 300}" fill="url(#grid)" pointer-events="none"/>`);
    }
    // 房間
    out.push('<g class="rooms">');
    for (const r of plan.rooms) {
      const col = r.kind === 'void' ? 'url(#voidHatch)' : (ROOM_KINDS[r.kind]?.color || ROOM_KINDS.other.color);
      const on = sel?.type === 'room' && sel.id === r.id;
      out.push(`<polygon points="${pts(r.pts)}" fill="${col}" class="room${on ? ' sel' : ''}" data-hit="room" data-id="${r.id}"/>`);
    }
    out.push('</g>');
    // 家具
    out.push('<g class="items">');
    for (const it of plan.items) out.push(this.itemSvg(it, sel?.type === 'item' && sel.id === it.id));
    out.push('</g>');
    // 牆（先畫螢光筆底色，再畫墨線）
    const wallPolys = [];
    for (const w of plan.walls) {
      const { extA, extB } = wallExtents(plan, w);
      const segs = wallSegments(plan, w);
      const { L } = wallFrame(w);
      for (const sg of segs) {
        if (!sg.solid) continue;
        const q = wallQuad(w, sg.s, sg.e, sg.s <= 0.01 ? extA : 0, sg.e >= L - 0.01 ? extB : 0);
        wallPolys.push({ w, q });
      }
    }
    if (st.highlighter) {
      out.push('<g class="hl">');
      for (const { w, q } of wallPolys) out.push(`<polygon points="${pts(q)}" class="hl-band" stroke-width="${Math.max(4, w.t * 0.9)}"/>`);
      out.push('</g>');
    }
    out.push('<g class="walls">');
    for (const { w, q } of wallPolys) {
      const on = sel?.type === 'wall' && sel.id === w.id;
      out.push(`<polygon points="${pts(q)}" class="wall ${w.kind}${on ? ' sel' : ''}" data-hit="wall" data-id="${w.id}"/>`);
    }
    // 牆的點擊熱區（含開口段）
    for (const w of plan.walls) {
      out.push(`<line x1="${f1(w.a.x)}" y1="${f1(w.a.y)}" x2="${f1(w.b.x)}" y2="${f1(w.b.y)}" class="wall-hit" stroke-width="${Math.max(w.t, this.px(10))}" data-hit="wall" data-id="${w.id}"/>`);
    }
    out.push('</g>');
    // 門窗
    out.push('<g class="openings">');
    for (const o of plan.openings) out.push(this.openingSvg(o, sel?.type === 'opening' && sel.id === o.id));
    out.push('</g>');
    // 文字
    if (st.labels) {
      out.push('<g class="labels">');
      for (const r of plan.rooms) {
        if (!r.name) continue;
        const c = r.label || polygonCentroid(r.pts);
        const a = areaM2(r.pts);
        out.push(`<text x="${f1(c.x)}" y="${f1(c.y)}" font-size="${f1(fs * 1.15)}" class="room-name">${esc(r.name)}</text>`);
        if (st.area && r.kind !== 'void') out.push(`<text x="${f1(c.x)}" y="${f1(c.y + fs * 1.2)}" font-size="${f1(fs * 0.8)}" class="room-area">${a.toFixed(1)}㎡ · ${m2ToPing(a).toFixed(1)}坪</text>`);
      }
      if (st.itemLabels) {
        for (const it of plan.items) {
          if (['chair', 'acout', 'duct', 'stair', 'elevator'].includes(it.kind)) continue;
          const small = Math.min(fs * 0.75, Math.min(it.w, it.d) * 0.45 + 4);
          if (small < this.px(7)) continue;
          out.push(`<text x="${f1(it.x)}" y="${f1(it.y + small * 0.35)}" font-size="${f1(small)}" class="item-name">${esc(itemName(it))}</text>`);
        }
      }
      out.push('</g>');
    }
    // 尺寸
    if (st.dims) out.push(this.dimsSvg(fs));
    out.push(this.selectionSvg(fs));
    out.push(this.draftSvg(fs));
    this.svg.innerHTML = out.join('');
    this.app.onRender2D?.();
  }

  defs() {
    const g = 100;
    return `<defs>
      <pattern id="grid" width="${g}" height="${g}" patternUnits="userSpaceOnUse">
        <path d="M ${g} 0 L 0 0 0 ${g}" class="grid-major" vector-effect="non-scaling-stroke"/>
        <path d="M ${g / 2} 0 L ${g / 2} ${g} M 0 ${g / 2} L ${g} ${g / 2}" class="grid-minor" vector-effect="non-scaling-stroke"/>
      </pattern>
      <pattern id="voidHatch" width="24" height="24" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="24" height="24" class="void-bg"/>
        <line x1="0" y1="0" x2="0" y2="24" class="void-line" vector-effect="non-scaling-stroke"/>
      </pattern>
    </defs>`;
  }

  openingSvg(o, on) {
    const plan = this.app.plan;
    const e = openingEnds(plan, o);
    if (!e) return '';
    const { wall, u, n } = e;
    const t = wall.t;
    const cls = `op ${o.type}${on ? ' sel' : ''}`;
    const jamb = (p) => { const a = add(p, mul(n, t / 2)), b = add(p, mul(n, -t / 2)); return `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" class="jamb" vector-effect="non-scaling-stroke"/>`; };
    let body = jamb(e.a) + jamb(e.b);
    if (o.type === 'door') {
      const hinge = o.hinge === 'b' ? e.b : e.a;
      const other = o.hinge === 'b' ? e.a : e.b;
      const side = o.side >= 0 ? 1 : -1;
      const hingeFace = add(hinge, mul(n, side * t / 2));
      const closedTip = add(other, mul(n, side * t / 2));
      const openTip = add(hingeFace, mul(n, side * o.w));
      const v1 = sub(openTip, hingeFace), v2 = sub(closedTip, hingeFace);
      const sweep = v1.x * v2.y - v1.y * v2.x > 0 ? 1 : 0;
      body += `<line x1="${f1(hingeFace.x)}" y1="${f1(hingeFace.y)}" x2="${f1(openTip.x)}" y2="${f1(openTip.y)}" class="leaf" vector-effect="non-scaling-stroke"/>`;
      body += `<path d="M ${f1(openTip.x)} ${f1(openTip.y)} A ${f1(o.w)} ${f1(o.w)} 0 0 ${sweep} ${f1(closedTip.x)} ${f1(closedTip.y)}" class="swing" vector-effect="non-scaling-stroke"/>`;
    } else if (o.type === 'sliding') {
      const off = t / 5, wid = o.w * 0.55;
      const p1 = add(e.a, mul(n, off)), p2 = add(p1, mul(u, wid));
      const p3 = add(e.b, mul(n, -off)), p4 = add(p3, mul(u, -wid));
      body += `<line x1="${f1(p1.x)}" y1="${f1(p1.y)}" x2="${f1(p2.x)}" y2="${f1(p2.y)}" class="panel" vector-effect="non-scaling-stroke"/>`;
      body += `<line x1="${f1(p3.x)}" y1="${f1(p3.y)}" x2="${f1(p4.x)}" y2="${f1(p4.y)}" class="panel" vector-effect="non-scaling-stroke"/>`;
    } else if (o.type === 'window') {
      for (const k of [-t / 2, -t / 7, t / 7, t / 2]) {
        const a = add(e.a, mul(n, k)), b = add(e.b, mul(n, k));
        body += `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" class="${Math.abs(k) < t / 3 ? 'glass' : 'frame'}" vector-effect="non-scaling-stroke"/>`;
      }
    } else if (o.type === 'elevator') {
      const a = add(e.a, mul(u, o.w * 0.1)), b = add(e.b, mul(u, -o.w * 0.1));
      body += `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" class="panel" vector-effect="non-scaling-stroke"/>`;
    } else {
      for (const k of [-t / 2, t / 2]) {
        const a = add(e.a, mul(n, k)), b = add(e.b, mul(n, k));
        body += `<line x1="${f1(a.x)}" y1="${f1(a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" class="header" vector-effect="non-scaling-stroke"/>`;
      }
    }
    const hit = wallQuad(wall, o.pos - o.w / 2, o.pos + o.w / 2);
    const hitPad = Math.max(0, this.px(8) - t / 2);
    const hq = hit.map((p, i) => add(p, mul(n, (i < 2 ? 1 : -1) * hitPad)));
    return `<g class="${cls}" data-hit="opening" data-id="${o.id}"><polygon points="${pts(hq)}" class="op-hit"/>${body}</g>`;
  }

  itemSvg(it, on) {
    const w = it.w, d = it.d, hw = w / 2, hd = d / 2;
    const r = (x, y, ww, hh, cls = '', rx = 0) => `<rect x="${f1(x)}" y="${f1(y)}" width="${f1(ww)}" height="${f1(hh)}" rx="${rx}" class="${cls}" vector-effect="non-scaling-stroke"/>`;
    const l = (x1, y1, x2, y2, cls = '') => `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" class="${cls}" vector-effect="non-scaling-stroke"/>`;
    const c = (x, y, rr, cls = '') => `<circle cx="${f1(x)}" cy="${f1(y)}" r="${f1(rr)}" class="${cls}" vector-effect="non-scaling-stroke"/>`;
    const el = (x, y, rx, ry, cls = '') => `<ellipse cx="${f1(x)}" cy="${f1(y)}" rx="${f1(rx)}" ry="${f1(ry)}" class="${cls}" vector-effect="non-scaling-stroke"/>`;
    let s = '';
    switch (it.kind) {
      case 'bed':
      case 'bed_single': {
        s += r(-hw, -hd, w, d, 'body');
        const pw = it.kind === 'bed' ? (w - 18) / 2 : w - 16;
        const n = it.kind === 'bed' ? 2 : 1;
        for (let i = 0; i < n; i++) s += r(-hw + 6 + i * (pw + 6), -hd + 6, pw, 26, 'soft', 6);
        s += l(-hw, -hd + d * 0.32, hw, -hd + d * 0.32, 'thin');
        s += l(-hw, -hd + d * 0.32, hw, hd, 'thin faint');
        break;
      }
      case 'wardrobe':
        s += r(-hw, -hd, w, d, 'body');
        s += l(-hw + 4, 0, hw - 4, 0, 'thin dash');
        for (let x = -hw + 15; x < hw - 5; x += 15) s += l(x - 5, -6, x + 5, 6, 'thin faint');
        break;
      case 'desk': case 'table': case 'nightstand': case 'box': case 'tv':
        s += r(-hw, -hd, w, d, 'body');
        if (it.kind === 'tv') s += r(-hw * 0.8, -hd + 3, w * 0.8, 6, 'dark');
        break;
      case 'chair':
        s += r(-hw + 3, -hd + 3, w - 6, d - 6, 'body', 4);
        s += l(-hw + 3, -hd + 8, hw - 3, -hd + 8, 'thick');
        break;
      case 'sofa':
        s += r(-hw, -hd, w, d, 'body', 6);
        s += r(-hw + 12, -hd + 18, w - 24, d - 22, 'soft', 4);
        break;
      case 'toilet':
        s += r(-hw, -hd, w, d * 0.28, 'body', 3);
        s += el(0, -hd + d * 0.28 + d * 0.33, hw * 0.92, d * 0.34, 'body');
        break;
      case 'basin':
        s += r(-hw, -hd, w, d, 'body', 3);
        s += el(0, 2, hw * 0.65, hd * 0.6, 'soft');
        break;
      case 'shower':
        s += r(-hw, -hd, w, d, 'body tile');
        s += l(-hw, -hd, hw, hd, 'thin faint') + l(hw, -hd, -hw, hd, 'thin faint');
        s += c(0, 0, 4, 'dark');
        break;
      case 'bathtub':
        s += r(-hw, -hd, w, d, 'body', 4);
        s += r(-hw + 7, -hd + 7, w - 14, d - 14, 'soft', 18);
        break;
      case 'counter':
        s += r(-hw, -hd, w, d, 'body');
        if (it.top === 'sink') s += r(-Math.min(hw - 8, 30), -hd + 10, Math.min(w - 16, 60), d - 22, 'soft', 6);
        if (it.top === 'stove') { const rr = Math.min(w, d) * 0.16; s += c(-hw * 0.45, 0, rr, 'soft') + c(hw * 0.45, 0, rr, 'soft'); }
        break;
      case 'fridge':
        s += r(-hw, -hd, w, d, 'body');
        s += l(-hw, -hd, hw, hd, 'thin faint');
        break;
      case 'washer':
        s += r(-hw, -hd, w, d, 'body', 3);
        s += c(0, 0, Math.min(hw, hd) * 0.62, 'soft');
        break;
      case 'laundry':
        s += r(-hw, -hd, w, d, 'body', 2);
        s += r(-hw + 6, -hd + 6, w - 12, d - 12, 'soft', 5);
        break;
      case 'ac':
        s += r(-hw, -hd, w, d, 'body dash');
        break;
      case 'acout':
        s += r(-hw, -hd, w, d, 'body');
        s += c(w * 0.12, 0, Math.min(hd, hw) * 0.75, 'thin');
        break;
      case 'ledge':
        s += r(-hw, -hd, w, d, 'ledge dash');
        break;
      case 'duct':
        s += r(-hw, -hd, w, d, 'body');
        s += l(-hw, -hd, hw, hd, 'thin') + l(hw, -hd, -hw, hd, 'thin');
        break;
      case 'column':
        s += r(-hw, -hd, w, d, 'solid');
        break;
      case 'elevator':
        s += r(-hw, -hd, w, d, 'body');
        s += l(-hw, -hd, hw, hd, 'thin') + l(hw, -hd, -hw, hd, 'thin');
        s += r(-hw * 0.4, hd - 14, w * 0.4 * 2, 6, 'soft', 2);
        break;
      case 'plant':
        s += c(0, 0, Math.min(hw, hd), 'soft') + c(0, 0, Math.min(hw, hd) * 0.5, 'thin');
        break;
      case 'stair':
        s += this.stairSvg(it);
        break;
      default:
        s += r(-hw, -hd, w, d, 'body');
    }
    return `<g class="item k-${it.kind}${on ? ' sel' : ''}" transform="translate(${f1(it.x)} ${f1(it.y)}) rotate(${f1(it.rot || 0)})" data-hit="item" data-id="${it.id}"><rect x="${f1(-hw)}" y="${f1(-hd)}" width="${f1(w)}" height="${f1(d)}" class="item-hit"/>${s}</g>`;
  }

  stairSvg(it) {
    const w = it.w, d = it.d, hw = w / 2, hd = d / 2;
    const L = (x1, y1, x2, y2, cls = 'thin') => `<line x1="${f1(x1)}" y1="${f1(y1)}" x2="${f1(x2)}" y2="${f1(y2)}" class="${cls}" vector-effect="non-scaling-stroke"/>`;
    let s = `<rect x="${f1(-hw)}" y="${f1(-hd)}" width="${f1(w)}" height="${f1(d)}" class="body stair"/>`;
    const g = stairGeometry(it);
    for (const tr of g.treads2d) s += L(tr[0].x, tr[0].y, tr[1].x, tr[1].y);
    if (g.well) s += `<rect x="${f1(g.well.x)}" y="${f1(g.well.y)}" width="${f1(g.well.w)}" height="${f1(g.well.h)}" class="soft"/>`;
    // 上樓方向箭頭
    const path = g.arrow.map((p, i) => `${i ? 'L' : 'M'} ${f1(p.x)} ${f1(p.y)}`).join(' ');
    s += `<path d="${path}" class="arrow" vector-effect="non-scaling-stroke"/>`;
    const tip = g.arrow[g.arrow.length - 1], prev = g.arrow[g.arrow.length - 2];
    const dir = norm(sub(tip, prev)), nn = { x: -dir.y, y: dir.x };
    const h1 = add(tip, add(mul(dir, -12), mul(nn, 6))), h2 = add(tip, add(mul(dir, -12), mul(nn, -6)));
    s += `<path d="M ${f1(h1.x)} ${f1(h1.y)} L ${f1(tip.x)} ${f1(tip.y)} L ${f1(h2.x)} ${f1(h2.y)}" class="arrow" vector-effect="non-scaling-stroke"/>`;
    const st = g.arrow[0];
    s += `<circle cx="${f1(st.x)}" cy="${f1(st.y)}" r="4" class="dark"/>`;
    return s;
  }

  dimsSvg(fs) {
    const plan = this.app.plan;
    const sel = this.app.sel;
    const out = ['<g class="dims">'];
    const dimLine = (a, b, off, text, strong = false) => {
      const d = sub(b, a), L = len(d);
      if (L < 1) return '';
      const u = mul(d, 1 / L), n = { x: -u.y, y: u.x };
      const pa = add(a, mul(n, off)), pb = add(b, mul(n, off));
      const mid = lerp(pa, pb, 0.5);
      let ang = Math.atan2(u.y, u.x) * 180 / Math.PI;
      if (ang > 90 || ang < -90) ang += 180;
      const tk = this.px(5);
      const tick = (p) => { const q1 = add(p, add(mul(u, -tk), mul(n, -tk))), q2 = add(p, add(mul(u, tk), mul(n, tk))); return `<line x1="${f1(q1.x)}" y1="${f1(q1.y)}" x2="${f1(q2.x)}" y2="${f1(q2.y)}" vector-effect="non-scaling-stroke"/>`; };
      const t = add(mid, mul(n, off > 0 ? fs * 0.1 : -fs * 0.35));
      return `<g class="dim${strong ? ' strong' : ''}"><line x1="${f1(pa.x)}" y1="${f1(pa.y)}" x2="${f1(pb.x)}" y2="${f1(pb.y)}" vector-effect="non-scaling-stroke"/>${tick(pa)}${tick(pb)}<text x="${f1(t.x)}" y="${f1(t.y)}" font-size="${f1(fs * 0.85)}" transform="rotate(${f1(ang)} ${f1(t.x)} ${f1(t.y)})">${text}</text></g>`;
    };
    // 外框總尺寸
    const ext = plan.walls.filter((w) => w.kind === 'ext');
    if (ext.length) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const w of ext) { minX = Math.min(minX, w.a.x, w.b.x); maxX = Math.max(maxX, w.a.x, w.b.x); minY = Math.min(minY, w.a.y, w.b.y); maxY = Math.max(maxY, w.a.y, w.b.y); }
      const off = this.px(34);
      out.push(dimLine({ x: minX, y: minY }, { x: maxX, y: minY }, -off - (minY > -200 ? 150 : 0), f1(maxX - minX)));
      out.push(dimLine({ x: minX, y: maxY }, { x: minX, y: minY }, off + 30, f1(maxY - minY)));
    }
    if (sel?.type === 'wall') {
      const w = plan.walls.find((x) => x.id === sel.id);
      if (w) out.push(dimLine(w.a, w.b, w.t / 2 + this.px(18), f1(dist(w.a, w.b)), true));
    }
    if (sel?.type === 'opening') {
      const o = plan.openings.find((x) => x.id === sel.id);
      const e = o && openingEnds(plan, o);
      if (e) {
        out.push(dimLine(e.a, e.b, e.wall.t / 2 + this.px(18), f1(o.w), true));
        out.push(dimLine(e.wall.a, e.a, -(e.wall.t / 2 + this.px(18)), f1(o.pos - o.w / 2)));
        const L = dist(e.wall.a, e.wall.b);
        out.push(dimLine(e.b, e.wall.b, -(e.wall.t / 2 + this.px(18)), f1(L - o.pos - o.w / 2)));
      }
    }
    if (sel?.type === 'item') {
      const it = plan.items.find((x) => x.id === sel.id);
      if (it) {
        const c = itemCorners(it);
        out.push(dimLine(c[0], c[1], this.px(16), f1(it.w), true));
        out.push(dimLine(c[1], c[2], this.px(16), f1(it.d), true));
        // 到最近牆面的距離
        for (const g of this.clearances(it)) out.push(dimLine(g.a, g.b, 0, f1(g.d)));
      }
    }
    out.push('</g>');
    return out.join('');
  }

  // 家具四邊到最近牆面的淨距（僅限正交牆）
  clearances(it) {
    const plan = this.app.plan;
    const rot = ((it.rot || 0) % 360 + 360) % 360;
    if (rot % 90 !== 0) return [];
    const c = itemCorners(it);
    const minX = Math.min(...c.map((p) => p.x)), maxX = Math.max(...c.map((p) => p.x));
    const minY = Math.min(...c.map((p) => p.y)), maxY = Math.max(...c.map((p) => p.y));
    const res = [];
    const probe = (from, dir) => {
      let best = null;
      for (const w of plan.walls) {
        const vert = Math.abs(w.a.x - w.b.x) < 0.5, hor = Math.abs(w.a.y - w.b.y) < 0.5;
        if (dir.x && vert) {
          const y0 = Math.min(w.a.y, w.b.y), y1 = Math.max(w.a.y, w.b.y);
          if (from.y < y0 || from.y > y1) continue;
          const face = w.a.x - Math.sign(dir.x) * w.t / 2;
          const dd = (face - from.x) * Math.sign(dir.x);
          if (dd >= -0.5 && dd < 400 && (!best || dd < best.d)) best = { d: dd, b: { x: face, y: from.y } };
        }
        if (dir.y && hor) {
          const x0 = Math.min(w.a.x, w.b.x), x1 = Math.max(w.a.x, w.b.x);
          if (from.x < x0 || from.x > x1) continue;
          const face = w.a.y - Math.sign(dir.y) * w.t / 2;
          const dd = (face - from.y) * Math.sign(dir.y);
          if (dd >= -0.5 && dd < 400 && (!best || dd < best.d)) best = { d: dd, b: { x: from.x, y: face } };
        }
      }
      if (best && best.d > 2) res.push({ a: from, b: best.b, d: best.d });
    };
    const mx = (minX + maxX) / 2, my = (minY + maxY) / 2;
    probe({ x: minX, y: my }, { x: -1, y: 0 });
    probe({ x: maxX, y: my }, { x: 1, y: 0 });
    probe({ x: mx, y: minY }, { x: 0, y: -1 });
    probe({ x: mx, y: maxY }, { x: 0, y: 1 });
    return res;
  }

  selectionSvg() {
    const plan = this.app.plan;
    const sel = this.app.sel;
    if (!sel) return '';
    const hr = this.px(6.5);
    const handle = (p, kind, extra = '', cls = 'handle') => `<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(hr)}" class="${cls}" data-hit="handle" data-handle="${kind}" ${extra} vector-effect="non-scaling-stroke"/>`;
    const out = ['<g class="selection">'];
    if (sel.type === 'wall') {
      const w = plan.walls.find((x) => x.id === sel.id);
      if (w) out.push(handle(w.a, 'wall-a') + handle(w.b, 'wall-b'));
    } else if (sel.type === 'item') {
      const it = plan.items.find((x) => x.id === sel.id);
      if (it) {
        const c = itemCorners(it);
        out.push(`<polygon points="${pts(c)}" class="sel-outline" vector-effect="non-scaling-stroke"/>`);
        const r = (it.rot || 0) * Math.PI / 180;
        const toW = (x, y) => ({ x: it.x + x * Math.cos(r) - y * Math.sin(r), y: it.y + x * Math.sin(r) + y * Math.cos(r) });
        const rotP = toW(0, -it.d / 2 - this.px(26));
        const top = toW(0, -it.d / 2);
        out.push(`<line x1="${f1(top.x)}" y1="${f1(top.y)}" x2="${f1(rotP.x)}" y2="${f1(rotP.y)}" class="sel-outline" vector-effect="non-scaling-stroke"/>`);
        out.push(handle(rotP, 'item-rot', '', 'handle rot'));
        out.push(handle(toW(it.w / 2, 0), 'item-w', '', 'handle sq'));
        out.push(handle(toW(0, it.d / 2), 'item-d', '', 'handle sq'));
      }
    } else if (sel.type === 'room') {
      const r = plan.rooms.find((x) => x.id === sel.id);
      if (r) r.pts.forEach((p, i) => out.push(handle(p, 'room-v', `data-index="${i}"`)));
    }
    out.push('</g>');
    return out.join('');
  }

  draftSvg(fs) {
    const d = this.draft;
    const out = ['<g class="draft">'];
    if (this.snapMark) {
      const p = this.snapMark;
      out.push(`<circle cx="${f1(p.x)}" cy="${f1(p.y)}" r="${f1(this.px(7))}" class="snap-mark" vector-effect="non-scaling-stroke"/>`);
    }
    if (d?.type === 'wall' && d.pts.length) {
      const all = d.cursor ? [...d.pts, d.cursor] : d.pts;
      out.push(`<polyline points="${pts(all)}" class="draft-wall" stroke-width="${this.app.wallThickness()}"/>`);
      out.push(`<polyline points="${pts(all)}" class="draft-line" vector-effect="non-scaling-stroke"/>`);
      if (d.cursor) {
        const a = d.pts[d.pts.length - 1];
        const m = lerp(a, d.cursor, 0.5);
        out.push(`<text x="${f1(m.x)}" y="${f1(m.y - this.px(10))}" font-size="${f1(fs)}" class="draft-text">${f1(dist(a, d.cursor))}</text>`);
      }
    }
    if (d?.type === 'room' && d.pts.length) {
      const all = d.cursor ? [...d.pts, d.cursor] : d.pts;
      out.push(`<polygon points="${pts(all)}" class="draft-room" vector-effect="non-scaling-stroke"/>`);
    }
    if ((d?.type === 'measure' || d?.type === 'calibrate') && d.a) {
      const b = d.b || d.cursor;
      if (b) {
        out.push(`<line x1="${f1(d.a.x)}" y1="${f1(d.a.y)}" x2="${f1(b.x)}" y2="${f1(b.y)}" class="measure" vector-effect="non-scaling-stroke"/>`);
        const m = lerp(d.a, b, 0.5);
        const label = d.type === 'measure' ? `${f1(dist(d.a, b))} cm` : '校正線';
        out.push(`<text x="${f1(m.x)}" y="${f1(m.y - this.px(10))}" font-size="${f1(fs)}" class="draft-text">${label}</text>`);
      }
      out.push(`<circle cx="${f1(d.a.x)}" cy="${f1(d.a.y)}" r="${f1(this.px(4))}" class="snap-mark"/>`);
    }
    if (this.hover?.type === 'place-opening') {
      const h = this.hover;
      const q = wallQuad(h.wall, h.pos - h.w / 2, h.pos + h.w / 2);
      out.push(`<polygon points="${pts(q)}" class="ghost" vector-effect="non-scaling-stroke"/>`);
    }
    if (this.hover?.type === 'place-item') {
      out.push(`<g opacity="0.55" style="pointer-events:none">${this.itemSvg(this.hover.item, false)}</g>`);
    }
    out.push('</g>');
    return out.join('');
  }

  // ---------- 吸附 ----------
  snapPoint(p, { exclude = [], orthoFrom = null, grid = true } = {}) {
    const plan = this.app.plan;
    const tol = this.px(12);
    let best = null;
    this.snapMark = null;
    for (const w of plan.walls) {
      for (const e of ['a', 'b']) {
        if (exclude.includes(w[e])) continue;
        const dd = dist(w[e], p);
        if (dd < tol && (!best || dd < best.d)) best = { d: dd, p: { ...w[e] }, kind: 'end' };
      }
    }
    if (!best) {
      for (const w of plan.walls) {
        if (exclude.includes(w.a) || exclude.includes(w.b)) continue;
        const pr = projectOnSegment(p, w.a, w.b);
        if (pr.t > 0 && pr.t < 1 && pr.dist < tol && (!best || pr.dist < best.d)) best = { d: pr.dist, p: pr.point, kind: 'on' };
      }
    }
    if (best) { this.snapMark = best.p; return { x: round1(best.p.x), y: round1(best.p.y) }; }
    let q = { ...p };
    if (orthoFrom) {
      const d = sub(q, orthoFrom);
      const ang = Math.abs(Math.atan2(d.y, d.x) * 180 / Math.PI);
      if (ang < 8 || ang > 172) q.y = orthoFrom.y;
      else if (Math.abs(ang - 90) < 8) q.x = orthoFrom.x;
    }
    if (grid && this.app.settings.snap) {
      const g = this.app.settings.snapStep || 5;
      if (!orthoFrom || q.x !== orthoFrom.x) q.x = Math.round(q.x / g) * g;
      if (!orthoFrom || q.y !== orthoFrom.y) q.y = Math.round(q.y / g) * g;
    }
    return { x: round1(q.x), y: round1(q.y) };
  }

  nearestWall(p, maxD) {
    let best = null;
    for (const w of this.app.plan.walls) {
      const pr = projectOnSegment(p, w.a, w.b);
      if (pr.t < 0 || pr.t > 1) continue;
      if (pr.dist <= maxD && (!best || pr.dist < best.dist)) best = { wall: w, pos: pr.t * dist(w.a, w.b), dist: pr.dist };
    }
    return best;
  }

  // ---------- 事件 ----------
  _bind() {
    const svg = this.svg;
    svg.addEventListener('pointerdown', (e) => this.onDown(e));
    svg.addEventListener('pointermove', (e) => this.onMove(e));
    svg.addEventListener('pointerup', (e) => this.onUp(e));
    svg.addEventListener('pointercancel', (e) => this.onUp(e));
    svg.addEventListener('dblclick', (e) => this.onDbl(e));
    svg.addEventListener('contextmenu', (e) => { if (this.draft) { e.preventDefault(); this.finishDraft(); } });
    svg.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
      this.zoomAt(e.clientX, e.clientY, f);
    }, { passive: false });
    window.addEventListener('keydown', (e) => { if (e.code === 'Space' && !isTyping(e)) this.spaceDown = true; });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceDown = false; });
  }

  onDown(e) {
    this.svg.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 2) {
      // 兩指縮放
      const [p1, p2] = [...this.pointers.values()];
      this.drag = { type: 'pinch', d0: Math.hypot(p1.x - p2.x, p1.y - p2.y), s0: this.view.scale, mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 }, view0: { ...this.view } };
      this.draft && this.draft.type !== 'wall' && (this.draft.cursor = null);
      return;
    }
    const w = this.toWorld(e.clientX, e.clientY);
    const tool = this.app.tool;
    if (e.button === 1 || this.spaceDown || e.button === 2) {
      if (e.button === 2 && this.draft) return;
      this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view0: { ...this.view } };
      return;
    }
    const hitEl = e.target.closest?.('[data-hit]');
    const hit = hitEl ? { kind: hitEl.dataset.hit, id: hitEl.dataset.id, handle: hitEl.dataset.handle, index: +hitEl.dataset.index } : null;

    if (tool === 'wall') return this.wallClick(w, e);
    if (tool === 'room') return this.roomClick(w, e);
    if (['door', 'window', 'sliding', 'opening'].includes(tool)) return this.placeOpening(w, tool);
    if (tool === 'item') return this.placeItem(w);
    if (tool === 'measure' || tool === 'calibrate') return this.measureClick(w, tool);
    if (tool === 'underlay') {
      const u = this.app.plan.underlay;
      if (u) this.drag = { type: 'underlay', start: w, m0: [...u.matrix], moved: false };
      return;
    }

    // 選取工具
    if (hit?.kind === 'handle') return this.startHandle(hit, w);
    if (hit?.kind === 'opening') { this.app.setSel({ type: 'opening', id: hit.id }); this.drag = { type: 'opening', id: hit.id, start: w, moved: false }; return; }
    if (hit?.kind === 'item') { this.app.setSel({ type: 'item', id: hit.id }); const it = this.findItem(hit.id); this.drag = { type: 'item', id: hit.id, start: w, x0: it.x, y0: it.y, moved: false }; return; }
    if (hit?.kind === 'wall') return this.startWallDrag(hit.id, w);
    if (hit?.kind === 'room') {
      this.app.setSel({ type: 'room', id: hit.id });
      const r = this.app.plan.rooms.find((x) => x.id === hit.id);
      this.drag = { type: 'room', id: hit.id, start: w, pts0: r.pts.map((p) => ({ ...p })), moved: false };
      return;
    }
    this.app.setSel(null);
    this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, view0: { ...this.view } };
  }

  onMove(e) {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const d = this.drag;
    if (d?.type === 'pinch' && this.pointers.size >= 2) {
      const [p1, p2] = [...this.pointers.values()];
      const dd = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      const mid = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      this.view = { ...d.view0 };
      this.view.scale = Math.min(8, Math.max(0.05, d.s0 * dd / d.d0));
      const s = this.size();
      const w0 = { x: d.view0.cx + (d.mid.x - s.left - s.w / 2) / d.view0.scale, y: d.view0.cy + (d.mid.y - s.top - s.h / 2) / d.view0.scale };
      this.view.cx = w0.x - (mid.x - s.left - s.w / 2) / this.view.scale;
      this.view.cy = w0.y - (mid.y - s.top - s.h / 2) / this.view.scale;
      this.render();
      return;
    }
    const w = this.toWorld(e.clientX, e.clientY);
    if (!d) return this.hoverMove(w, e);
    if (d.type === 'pan') {
      this.view.cx = d.view0.cx - (e.clientX - d.sx) / this.view.scale;
      this.view.cy = d.view0.cy - (e.clientY - d.sy) / this.view.scale;
      this.render();
      return;
    }
    const moved = dist(w, d.start) * this.view.scale > 3;
    if (!d.moved && !moved) return;
    d.moved = true;
    this.dragMove(d, w, e);
    this.app.changed(true);
  }

  onUp(e) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (d?.type === 'pinch') { if (this.pointers.size < 2) this.drag = null; return; }
    this.drag = null;
    this.snapMark = null;
    if (d && d.moved && d.type !== 'pan') this.app.commit();
    else if (d && d.type !== 'pan') this.render();
  }

  onDbl(e) {
    if (this.draft?.type === 'wall' || this.draft?.type === 'room') { this.finishDraft(); return; }
    const hitEl = e.target.closest?.('[data-hit]');
    if (hitEl?.dataset.hit === 'wall' && this.app.tool === 'select') {
      // 雙擊牆：在該處分割
      const w = this.toWorld(e.clientX, e.clientY);
      this.app.splitWall(hitEl.dataset.id, w);
    }
  }

  hoverMove(w, e) {
    const tool = this.app.tool;
    const plan = this.app.plan;
    let changed = false;
    if (tool === 'wall') {
      const from = this.draft?.pts?.[this.draft.pts.length - 1];
      const p = this.snapPoint(w, { orthoFrom: e.altKey ? null : from });
      if (this.draft) this.draft.cursor = p;
      changed = true;
    } else if (tool === 'room' && this.draft) {
      this.draft.cursor = this.snapPoint(w);
      changed = true;
    } else if (['door', 'window', 'sliding', 'opening'].includes(tool)) {
      const nw = this.nearestWall(w, this.px(30) + 20);
      const ow = this.app.defaultOpening(tool).w;
      this.hover = nw ? { type: 'place-opening', wall: nw.wall, pos: Math.max(ow / 2, Math.min(dist(nw.wall.a, nw.wall.b) - ow / 2, nw.pos)), w: ow } : null;
      changed = true;
    } else if (tool === 'item') {
      const k = this.app.placeKind;
      const c = CATALOG[k];
      if (c) this.hover = { type: 'place-item', item: { id: '_ghost', kind: k, x: w.x, y: w.y, w: c.w, d: c.d, rot: 0, risers: c.risers, style: c.style, h: c.h } };
      changed = true;
    } else if ((tool === 'measure' || tool === 'calibrate') && this.draft?.a && !this.draft.b) {
      this.draft.cursor = this.snapPoint(w, { grid: false });
      changed = true;
    }
    if (changed) this.render();
  }

  findItem(id) { return this.app.plan.items.find((x) => x.id === id); }

  // ---------- 拖曳 ----------
  startHandle(hit, w) {
    const plan = this.app.plan;
    const sel = this.app.sel;
    if (hit.handle === 'wall-a' || hit.handle === 'wall-b') {
      const wall = plan.walls.find((x) => x.id === sel.id);
      const end = hit.handle === 'wall-a' ? 'a' : 'b';
      const p0 = { ...wall[end] };
      // 同一點的其他牆端點一起移動
      const linked = [];
      for (const o of plan.walls) for (const e of ['a', 'b']) if (dist(o[e], p0) < 1) linked.push({ wall: o, end: e });
      const roomPts = [];
      for (const r of plan.rooms) for (const p of r.pts) if (dist(p, p0) < 1) roomPts.push(p);
      this.drag = { type: 'wall-end', wall, end, linked, roomPts, start: w, p0, moved: false, ops: this.captureOpenings(linked.map((l) => l.wall)) };
    } else if (hit.handle === 'item-rot' || hit.handle === 'item-w' || hit.handle === 'item-d') {
      const it = this.findItem(sel.id);
      this.drag = { type: hit.handle, id: it.id, start: w, it0: { ...it }, moved: false };
    } else if (hit.handle === 'room-v') {
      const r = plan.rooms.find((x) => x.id === sel.id);
      this.drag = { type: 'room-v', room: r, index: hit.index, start: w, moved: false };
    }
  }

  startWallDrag(id, w) {
    const plan = this.app.plan;
    this.app.setSel({ type: 'wall', id });
    const wall = plan.walls.find((x) => x.id === id);
    const { n } = wallFrame(wall);
    const linked = []; // 需跟著移動的端點
    for (const o of plan.walls) {
      if (o === wall) continue;
      for (const e of ['a', 'b']) {
        const pr = projectOnSegment(o[e], wall.a, wall.b);
        if (pr.t > -0.001 && pr.t < 1.001 && pr.dist < 1) linked.push({ wall: o, end: e, p0: { ...o[e] } });
      }
    }
    const roomPts = [];
    for (const r of plan.rooms) for (const p of r.pts) {
      const pr = projectOnSegment(p, wall.a, wall.b);
      if (pr.t > -0.001 && pr.t < 1.001 && pr.dist < 1) roomPts.push({ p, p0: { ...p } });
    }
    this.drag = {
      type: 'wall', wall, n, start: w, a0: { ...wall.a }, b0: { ...wall.b }, linked, roomPts, moved: false,
      ops: this.captureOpenings([wall, ...linked.map((l) => l.wall)]),
    };
  }

  // 記錄開口的絕對位置，端點移動後重新投影
  captureOpenings(walls) {
    const plan = this.app.plan;
    const set = new Set(walls.map((w) => w.id));
    return plan.openings.filter((o) => set.has(o.wall)).map((o) => {
      const w = plan.walls.find((x) => x.id === o.wall);
      const { u } = wallFrame(w);
      return { o, c: add(w.a, mul(u, o.pos)), w };
    });
  }

  restoreOpenings(ops) {
    for (const { o, c, w } of ops) {
      const pr = projectOnSegment(c, w.a, w.b);
      const L = dist(w.a, w.b);
      o.pos = Math.max(o.w / 2, Math.min(L - o.w / 2, pr.t * L));
    }
  }

  dragMove(d, w, e) {
    const plan = this.app.plan;
    const snapStep = this.app.settings.snap ? (this.app.settings.snapStep || 5) : 0.1;
    const snapV = (v) => Math.round(v / snapStep) * snapStep;
    if (d.type === 'item') {
      const it = this.findItem(d.id);
      it.x = round1(snapV(d.x0 + w.x - d.start.x));
      it.y = round1(snapV(d.y0 + w.y - d.start.y));
      this.snapItemToWalls(it, e);
    } else if (d.type === 'item-rot') {
      const it = this.findItem(d.id);
      let ang = Math.atan2(w.y - it.y, w.x - it.x) * 180 / Math.PI + 90;
      if (!e.shiftKey) ang = Math.round(ang / 15) * 15;
      it.rot = ((Math.round(ang * 10) / 10) % 360 + 360) % 360;
    } else if (d.type === 'item-w' || d.type === 'item-d') {
      const it = this.findItem(d.id);
      const i0 = d.it0;
      const loc = toLocal(i0, w);
      const r = (i0.rot || 0) * Math.PI / 180;
      if (d.type === 'item-w') {
        const nw = Math.max(10, snapV(loc.x + i0.w / 2));
        const shift = (nw - i0.w) / 2;
        it.w = nw; it.x = round1(i0.x + shift * Math.cos(r)); it.y = round1(i0.y + shift * Math.sin(r));
      } else {
        const nd = Math.max(10, snapV(loc.y + i0.d / 2));
        const shift = (nd - i0.d) / 2;
        it.d = nd; it.x = round1(i0.x - shift * Math.sin(r)); it.y = round1(i0.y + shift * Math.cos(r));
      }
    } else if (d.type === 'opening') {
      const o = plan.openings.find((x) => x.id === d.id);
      let wall = plan.walls.find((x) => x.id === o.wall);
      const pr = projectOnSegment(w, wall.a, wall.b);
      if (pr.dist > wall.t / 2 + this.px(40)) {
        const nw = this.nearestWall(w, this.px(24) + 15);
        if (nw && nw.wall !== wall && dist(nw.wall.a, nw.wall.b) > o.w) { o.wall = nw.wall.id; wall = nw.wall; }
      }
      const pr2 = projectOnSegment(w, wall.a, wall.b);
      const L = dist(wall.a, wall.b);
      o.pos = round1(Math.max(o.w / 2, Math.min(L - o.w / 2, snapV(pr2.t * L))));
    } else if (d.type === 'wall') {
      const delta = sub(w, d.start);
      const k = snapV(dot(delta, d.n));
      const mv = mul(d.n, k);
      d.wall.a = { x: round1(d.a0.x + mv.x), y: round1(d.a0.y + mv.y) };
      d.wall.b = { x: round1(d.b0.x + mv.x), y: round1(d.b0.y + mv.y) };
      for (const l of d.linked) l.wall[l.end] = { x: round1(l.p0.x + mv.x), y: round1(l.p0.y + mv.y) };
      for (const r of d.roomPts) { r.p.x = round1(r.p0.x + mv.x); r.p.y = round1(r.p0.y + mv.y); }
      this.restoreOpenings(d.ops);
    } else if (d.type === 'wall-end') {
      const other = d.wall[d.end === 'a' ? 'b' : 'a'];
      const excl = d.linked.map((l) => l.wall[l.end]);
      const p = this.snapPoint(w, { exclude: excl, orthoFrom: e.altKey ? null : other });
      for (const l of d.linked) l.wall[l.end] = { ...p };
      for (const rp of d.roomPts) { rp.x = p.x; rp.y = p.y; }
      this.restoreOpenings(d.ops);
    } else if (d.type === 'room') {
      const dx = snapV(w.x - d.start.x), dy = snapV(w.y - d.start.y);
      const r = plan.rooms.find((x) => x.id === d.id);
      r.pts = d.pts0.map((p) => ({ x: round1(p.x + dx), y: round1(p.y + dy) }));
      if (r.label) r.label = null;
    } else if (d.type === 'room-v') {
      const p = this.snapPoint(w);
      d.room.pts[d.index] = p;
    } else if (d.type === 'underlay') {
      const u = this.app.plan.underlay;
      u.matrix = [...d.m0];
      u.matrix[4] = d.m0[4] + (w.x - d.start.x);
      u.matrix[5] = d.m0[5] + (w.y - d.start.y);
    }
  }

  // 家具靠近牆面時貼齊（正交角度才吸附）
  snapItemToWalls(it, e) {
    if (e.altKey || !this.app.settings.snap) return;
    const rot = ((it.rot || 0) % 360 + 360) % 360;
    if (rot % 90 !== 0) return;
    const tol = this.px(10);
    const c = itemCorners(it);
    const minX = Math.min(...c.map((p) => p.x)), maxX = Math.max(...c.map((p) => p.x));
    const minY = Math.min(...c.map((p) => p.y)), maxY = Math.max(...c.map((p) => p.y));
    let bx = null, by = null;
    for (const w of this.app.plan.walls) {
      if (Math.abs(w.a.x - w.b.x) < 0.5) {
        const y0 = Math.min(w.a.y, w.b.y), y1 = Math.max(w.a.y, w.b.y);
        if (maxY < y0 || minY > y1) continue;
        for (const face of [w.a.x - w.t / 2, w.a.x + w.t / 2]) {
          for (const edge of [minX, maxX]) {
            const dd = face - edge;
            if (Math.abs(dd) < tol && (bx === null || Math.abs(dd) < Math.abs(bx))) bx = dd;
          }
        }
      } else if (Math.abs(w.a.y - w.b.y) < 0.5) {
        const x0 = Math.min(w.a.x, w.b.x), x1 = Math.max(w.a.x, w.b.x);
        if (maxX < x0 || minX > x1) continue;
        for (const face of [w.a.y - w.t / 2, w.a.y + w.t / 2]) {
          for (const edge of [minY, maxY]) {
            const dd = face - edge;
            if (Math.abs(dd) < tol && (by === null || Math.abs(dd) < Math.abs(by))) by = dd;
          }
        }
      }
    }
    if (bx !== null) it.x = round1(it.x + bx);
    if (by !== null) it.y = round1(it.y + by);
  }

  // ---------- 工具 ----------
  wallClick(w, e) {
    const from = this.draft?.pts?.[this.draft.pts.length - 1];
    const p = this.snapPoint(w, { orthoFrom: e.altKey ? null : from });
    if (!this.draft) { this.draft = { type: 'wall', pts: [p], cursor: null }; this.render(); return; }
    const last = this.draft.pts[this.draft.pts.length - 1];
    if (dist(last, p) < 2) { this.finishDraft(); return; }
    this.app.addWall(last, p);
    this.draft.pts.push(p);
    // 點回起點＝封閉
    if (dist(p, this.draft.pts[0]) < 1 && this.draft.pts.length > 2) { this.draft = null; this.app.commit(); return; }
    this.app.changed(true);
  }

  roomClick(w) {
    if (this.draft?.type === 'room') {
      const p = this.snapPoint(w);
      if (this.draft.pts.length > 2 && dist(p, this.draft.pts[0]) < this.px(12)) { this.finishDraft(); return; }
      this.draft.pts.push(p);
      this.render();
      return;
    }
    const plan = this.app.plan;
    const poly = detectRoom(plan.walls, w);
    if (poly && poly.length >= 3) {
      const existing = plan.rooms.find((r) => pointInPolygon(w, r.pts));
      if (existing) { existing.pts = poly; this.app.setSel({ type: 'room', id: existing.id }); this.app.commit(); this.app.toast('已更新房間範圍'); return; }
      const r = { id: uid('r'), name: '房間', kind: 'other', pts: poly };
      plan.rooms.push(r);
      this.app.setSel({ type: 'room', id: r.id });
      this.app.commit();
      this.app.toast('已偵測到封閉區域，可在右側改名稱與地坪');
      return;
    }
    this.app.toast('這裡沒有封閉的牆，改用逐點描繪：點擊各角落，點回起點或雙擊完成');
    this.draft = { type: 'room', pts: [this.snapPoint(w)], cursor: null };
    this.render();
  }

  finishDraft() {
    const d = this.draft;
    this.draft = null;
    this.snapMark = null;
    if (d?.type === 'wall') { this.app.commit(); }
    if (d?.type === 'room' && d.pts.length >= 3) {
      const r = { id: uid('r'), name: '房間', kind: 'other', pts: d.pts };
      this.app.plan.rooms.push(r);
      this.app.setSel({ type: 'room', id: r.id });
      this.app.commit();
    }
    this.render();
  }

  placeOpening(w, type) {
    const nw = this.nearestWall(w, this.px(30) + 20);
    if (!nw) { this.app.toast('請點在牆上放置門窗'); return; }
    const def = this.app.defaultOpening(type);
    const L = dist(nw.wall.a, nw.wall.b);
    if (L < def.w + 4) { this.app.toast('這面牆太短了'); return; }
    const o = { id: uid('d'), wall: nw.wall.id, pos: round1(Math.max(def.w / 2, Math.min(L - def.w / 2, nw.pos))), hinge: 'a', side: 1, ...def };
    this.app.plan.openings.push(o);
    this.hover = null;
    this.app.setSel({ type: 'opening', id: o.id });
    this.app.setTool('select');
    this.app.commit();
  }

  placeItem(w) {
    const k = this.app.placeKind;
    const c = CATALOG[k];
    if (!c) return;
    const snap = this.app.settings.snap ? 5 : 0.1;
    const it = { id: uid('i'), kind: k, x: Math.round(w.x / snap) * snap, y: Math.round(w.y / snap) * snap, w: c.w, d: c.d, h: c.h, rot: 0 };
    if (c.risers) { it.risers = c.risers; it.style = c.style; it.h = this.app.plan.floorHeight; }
    if (k === 'counter') it.top = 'plain';
    if (k === 'duct' || k === 'column') it.h = this.app.plan.wallHeight;
    this.app.plan.items.push(it);
    this.hover = null;
    this.app.setSel({ type: 'item', id: it.id });
    this.app.setTool('select');
    this.app.commit();
  }

  async measureClick(w, tool) {
    const p = this.snapPoint(w, { grid: false });
    if (!this.draft || this.draft.b) { this.draft = { type: tool, a: p, b: null, cursor: null }; this.render(); return; }
    this.draft.b = p;
    this.render();
    if (tool === 'calibrate') {
      const a = this.draft.a, b = p;
      const cur = dist(a, b);
      const real = await this.app.askNumber('這段線在實際尺寸是多少公分？', Math.round(cur));
      this.draft = null;
      if (real && cur > 0) {
        const k = real / cur;
        const u = this.app.plan.underlay;
        const m = u.matrix; // [a b c d e f]：x' = a*px + c*py + e
        // 以 a 點為中心縮放
        u.matrix = [m[0] * k, m[1] * k, m[2] * k, m[3] * k, a.x + (m[4] - a.x) * k, a.y + (m[5] - a.y) * k];
        this.app.setTool('select');
        this.app.commit();
        if (!this.app.plan.walls.length) this.fit();
        this.app.toast(`底圖已縮放 ×${k.toFixed(3)}，現在可以用「牆」工具照著描`);
      } else this.render();
    }
  }

  cancel() {
    if (this.draft) { this.finishDraft(); return true; }
    this.hover = null;
    return false;
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

// 樓梯幾何（本地座標，正面＝+y 為起步端）。2D 與 3D 共用。
export function stairGeometry(it) {
  const w = it.w, d = it.d, hw = w / 2, hd = d / 2;
  const risers = Math.max(3, it.risers || 19);
  const H = it.h || 350;
  const riseH = H / risers;
  const style = it.style || (w > d * 0.55 ? 'U' : 'straight');
  const treads2d = [];
  const steps3d = []; // {x0,x1,y0,y1,top}
  let arrow = [];
  let well = null;
  if (style === 'U') {
    const gap = Math.min(24, w * 0.1);
    const fw = (w - gap) / 2;
    const n1 = Math.ceil(risers / 2), n2 = risers - n1; // 第一跑、第二跑的級數
    const landD = Math.min(Math.max(fw, 90), d * 0.4);
    const run = d - landD;
    const t1 = run / Math.max(1, n1 - 1), t2 = run / Math.max(1, n2);
    const flip = it.flip ? -1 : 1;
    const x1a = flip > 0 ? -hw : hw - fw, x1b = x1a + fw;       // 第一跑（起步）
    const x2a = flip > 0 ? hw - fw : -hw, x2b = x2a + fw;       // 第二跑
    // 第一跑：由 +y 往 -y 上升
    for (let i = 0; i < n1 - 1; i++) {
      const y1 = hd - i * t1, y0 = y1 - t1;
      steps3d.push({ x0: x1a, x1: x1b, y0, y1, top: (i + 1) * riseH });
      treads2d.push([{ x: x1a, y: y0 }, { x: x1b, y: y0 }]);
    }
    // 平台
    steps3d.push({ x0: -hw, x1: hw, y0: -hd, y1: -hd + landD, top: n1 * riseH, landing: true });
    treads2d.push([{ x: -hw, y: -hd + landD }, { x: hw, y: -hd + landD }]);
    // 第二跑：由 -y 往 +y 上升
    for (let i = 0; i < n2 - 1; i++) {
      const y0 = -hd + landD + i * t2, y1 = y0 + t2;
      steps3d.push({ x0: x2a, x1: x2b, y0, y1, top: (n1 + i + 1) * riseH });
      treads2d.push([{ x: x2a, y: y1 }, { x: x2b, y: y1 }]);
    }
    well = { x: flip > 0 ? x1b : x2b, y: -hd + landD, w: gap, h: run };
    const cx1 = (x1a + x1b) / 2, cx2 = (x2a + x2b) / 2;
    arrow = [{ x: cx1, y: hd - 10 }, { x: cx1, y: -hd + landD / 2 }, { x: cx2, y: -hd + landD / 2 }, { x: cx2, y: hd - 12 }];
  } else {
    const t = d / risers;
    for (let i = 0; i < risers; i++) {
      const y1 = hd - i * t, y0 = y1 - t;
      steps3d.push({ x0: -hw, x1: hw, y0, y1, top: (i + 1) * riseH });
      if (i > 0) treads2d.push([{ x: -hw, y: y1 }, { x: hw, y: y1 }]);
    }
    arrow = [{ x: 0, y: hd - 10 }, { x: 0, y: -hd + 12 }];
  }
  return { treads2d, steps3d, arrow, well, riseH, style };
}
