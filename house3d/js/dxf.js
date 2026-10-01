// DXF 匯出（R12 ASCII，AutoCAD 可直接開啟）與匯入（自動辨識牆、門窗、房間、家具圖塊）。
import {
  uid, add, sub, mul, dot, dist, len, norm, wallFrame, wallSegments, wallQuad, wallEndConnected, openingEnds,
  polygonCentroid, pointInPolygon, areaM2, itemCorners, normalizePlan, newPlan, DEFAULTS, ROOM_KINDS,
} from './model.js';
import { CATALOG, itemName, itemHeight } from './catalog.js';
import { stairGeometry } from './editor2d.js';
import { detectAllRooms } from './geometry.js';

// ======================================================================
// 匯出
// ======================================================================
const LAYERS = [
  ['A-WALL', 7], ['A-WALL-PRPT', 8], ['A-DOOR', 3], ['A-GLAZ', 4], ['A-FURN', 30],
  ['A-FIXT', 5], ['A-STRS', 6], ['A-AREA', 9], ['A-ANNO-TEXT', 2], ['A-ANNO-DIMS', 1],
];

function uniEsc(s) {
  let out = '';
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp < 128) out += ch;
    else if (cp <= 0xffff) out += '\\U+' + cp.toString(16).padStart(4, '0');
    else out += '?';
  }
  return out;
}

class DxfWriter {
  constructor() { this.l = []; }
  g(code, v) { this.l.push(String(code).padStart(3, ' '), typeof v === 'number' ? fmt(v) : String(v)); }
  toString() { return this.l.join('\r\n') + '\r\n'; }
}
const fmt = (v) => (Math.round(v * 1000) / 1000).toString();

export function exportDXF(plan, { embed = true } = {}) {
  const X = (p) => p.x, Y = (p) => -p.y; // 圖面 y 向下 → DXF Y 向上
  const ents = [];
  const line = (a, b, layer, thick = 0) => ents.push({ t: 'LINE', a, b, layer, thick });
  const poly = (pts, layer, closed = true) => ents.push({ t: 'POLY', pts, layer, closed });
  const arc = (c, r, a0, a1, layer) => ents.push({ t: 'ARC', c, r, a0, a1, layer });
  const circle = (c, r, layer) => ents.push({ t: 'CIRCLE', c, r, layer });
  const text = (p, h, s, layer, rot = 0) => ents.push({ t: 'TEXT', p, h, s, layer, rot });

  // ---- 牆：兩側面線（扣除與其他牆重疊處），自由端與門窗邊加端線 ----
  const pieces = [];
  for (const w of plan.walls) {
    const { L } = wallFrame(w);
    const cA = wallEndConnected(plan, w, 'a'), cB = wallEndConnected(plan, w, 'b');
    for (const sg of wallSegments(plan, w)) {
      if (!sg.solid) continue;
      const atA = sg.s <= 0.01, atB = sg.e >= L - 0.01;
      const q = wallQuad(w, sg.s, sg.e, atA && cA ? w.t / 2 : 0, atB && cB ? w.t / 2 : 0);
      pieces.push({ w, q, capA: !(atA && cA), capB: !(atB && cB) });
    }
  }
  for (const pc of pieces) {
    const layer = pc.w.kind === 'parapet' ? 'A-WALL-PRPT' : 'A-WALL';
    const h = pc.w.h ?? plan.wallHeight;
    const edges = [[pc.q[0], pc.q[1]], [pc.q[3], pc.q[2]]];
    if (pc.capA) edges.push([pc.q[0], pc.q[3]]);
    if (pc.capB) edges.push([pc.q[1], pc.q[2]]);
    for (const [a, b] of edges) {
      let parts = [[0, 1]];
      for (const other of pieces) {
        if (other === pc) continue;
        parts = subtractInside(parts, a, b, other.q);
        if (!parts.length) break;
      }
      for (const [t0, t1] of parts) {
        if ((t1 - t0) * dist(a, b) < 0.3) continue;
        line(lerpP(a, b, t0), lerpP(a, b, t1), layer, h);
      }
    }
  }

  // ---- 門窗 ----
  for (const o of plan.openings) {
    const e = openingEnds(plan, o);
    if (!e) continue;
    const { wall, u, n } = e;
    const t = wall.t;
    if (o.type === 'door') {
      const hinge = o.hinge === 'b' ? e.b : e.a, other = o.hinge === 'b' ? e.a : e.b;
      const side = o.side >= 0 ? 1 : -1;
      const hf = add(hinge, mul(n, side * t / 2));
      const closed = add(other, mul(n, side * t / 2));
      const open = add(hf, mul(n, side * o.w));
      line(hf, open, 'A-DOOR');
      const a1 = Math.atan2(-(open.y - hf.y), open.x - hf.x) * 180 / Math.PI;
      const a2 = Math.atan2(-(closed.y - hf.y), closed.x - hf.x) * 180 / Math.PI;
      // DXF 弧為逆時針：取較短的 90° 弧
      let s = a1, en = a2;
      if (((en - s) % 360 + 360) % 360 > 180) [s, en] = [a2, a1];
      arc(hf, o.w, s, en, 'A-DOOR');
    } else if (o.type === 'sliding') {
      const pw = o.w * 0.55;
      for (const k of [1, -1]) {
        const off = k * t / 6;
        const start = k > 0 ? e.a : e.b;
        const dir = k > 0 ? u : mul(u, -1);
        const p1 = add(start, mul(n, off - 1.5)), p2 = add(p1, mul(dir, pw));
        const p3 = add(p2, mul(n, 3)), p4 = add(p1, mul(n, 3));
        poly([p1, p2, p3, p4], 'A-DOOR');
      }
    } else if (o.type === 'window') {
      for (const k of [-t / 2, -t / 8, t / 8, t / 2]) line(add(e.a, mul(n, k)), add(e.b, mul(n, k)), 'A-GLAZ');
    } else if (o.type === 'elevator') {
      line(add(e.a, mul(u, o.w * 0.1)), add(e.b, mul(u, -o.w * 0.1)), 'A-DOOR');
    } else {
      for (const k of [-t / 2, t / 2]) ents.push({ t: 'LINE', a: add(e.a, mul(n, k)), b: add(e.b, mul(n, k)), layer: 'A-DOOR', ltype: 'HIDDEN' });
    }
  }

  // ---- 房間 ----
  for (const r of plan.rooms) {
    if (r.pts.length < 3) continue;
    poly(r.pts, 'A-AREA');
    const c = r.label || polygonCentroid(r.pts);
    if (r.name) text(c, 22, r.name, 'A-ANNO-TEXT');
    if (r.kind !== 'void') text({ x: c.x, y: c.y + 30 }, 13, `${areaM2(r.pts).toFixed(2)}m2`, 'A-ANNO-TEXT');
  }

  // ---- 家具／設備 ----
  const fixt = new Set(['toilet', 'basin', 'shower', 'bathtub', 'counter', 'washer', 'laundry', 'fridge', 'ac', 'acout', 'duct', 'elevator']);
  for (const it of plan.items) {
    const layer = it.kind === 'stair' ? 'A-STRS' : fixt.has(it.kind) ? 'A-FIXT' : 'A-FURN';
    const c = itemCorners(it);
    poly(c, layer);
    const r = (it.rot || 0) * Math.PI / 180;
    const T = (x, y) => ({ x: it.x + x * Math.cos(r) - y * Math.sin(r), y: it.y + x * Math.sin(r) + y * Math.cos(r) });
    const hw = it.w / 2, hd = it.d / 2;
    if (it.kind === 'stair') {
      const g = stairGeometry(it);
      for (const tr of g.treads2d) line(T(tr[0].x, tr[0].y), T(tr[1].x, tr[1].y), layer);
      for (let i = 1; i < g.arrow.length; i++) line(T(g.arrow[i - 1].x, g.arrow[i - 1].y), T(g.arrow[i].x, g.arrow[i].y), layer);
    } else if (it.kind === 'bed' || it.kind === 'bed_single') {
      line(T(-hw, -hd + it.d * 0.32), T(hw, -hd + it.d * 0.32), layer);
      const n = it.kind === 'bed' ? 2 : 1, pw = (it.w - 18) / n - (n > 1 ? 3 : 0);
      for (let i = 0; i < n; i++) { const x0 = -hw + 6 + i * (pw + 6); poly([T(x0, -hd + 6), T(x0 + pw, -hd + 6), T(x0 + pw, -hd + 32), T(x0, -hd + 32)], layer); }
    } else if (it.kind === 'duct' || it.kind === 'elevator') {
      line(c[0], c[2], layer); line(c[1], c[3], layer);
    } else if (it.kind === 'toilet') {
      poly([T(-hw, -hd), T(hw, -hd), T(hw, -hd + it.d * 0.28), T(-hw, -hd + it.d * 0.28)], layer);
      const cc = T(0, -hd + it.d * 0.61);
      circle(cc, Math.min(hw, it.d * 0.34) * 0.95, layer);
    } else if (it.kind === 'washer' || (it.kind === 'counter' && it.top === 'stove')) {
      circle(T(0, 0), Math.min(hw, hd) * 0.55, layer);
    } else if (it.kind === 'wardrobe') {
      line(T(-hw, 0), T(hw, 0), layer);
    }
    if (!['chair', 'acout'].includes(it.kind)) {
      text(T(0, 0), Math.max(7, Math.min(14, Math.min(it.w, it.d) * 0.28)), itemName(it), layer, 0);
    }
  }

  // ---- 外框尺寸 ----
  const ext = plan.walls.filter((w) => w.kind === 'ext');
  if (ext.length) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const w of ext) { minX = Math.min(minX, w.a.x, w.b.x); maxX = Math.max(maxX, w.a.x, w.b.x); minY = Math.min(minY, w.a.y, w.b.y); maxY = Math.max(maxY, w.a.y, w.b.y); }
    const y = minY - 190, x = minX - 90;
    line({ x: minX, y }, { x: maxX, y }, 'A-ANNO-DIMS');
    line({ x: minX, y: y - 8 }, { x: minX, y: y + 8 }, 'A-ANNO-DIMS');
    line({ x: maxX, y: y - 8 }, { x: maxX, y: y + 8 }, 'A-ANNO-DIMS');
    text({ x: (minX + maxX) / 2, y: y - 12 }, 16, (maxX - minX).toFixed(1), 'A-ANNO-DIMS');
    line({ x, y: minY }, { x, y: maxY }, 'A-ANNO-DIMS');
    line({ x: x - 8, y: minY }, { x: x + 8, y: minY }, 'A-ANNO-DIMS');
    line({ x: x - 8, y: maxY }, { x: x + 8, y: maxY }, 'A-ANNO-DIMS');
    text({ x: x - 14, y: (minY + maxY) / 2 }, 16, (maxY - minY).toFixed(1), 'A-ANNO-DIMS', 90);
  }
  text({ x: 0, y: (plan.walls.length ? Math.max(...plan.walls.map((w) => Math.max(w.a.y, w.b.y))) : 0) + 260 }, 28, `${plan.name}  (+${plan.elevation ?? 0})  1:100  單位 cm`, 'A-ANNO-TEXT');

  // ---- 輸出 ----
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const touch = (p) => { minX = Math.min(minX, X(p)); maxX = Math.max(maxX, X(p)); minY = Math.min(minY, Y(p)); maxY = Math.max(maxY, Y(p)); };
  for (const e of ents) { if (e.a) { touch(e.a); touch(e.b); } if (e.pts) e.pts.forEach(touch); if (e.c) touch(e.c); if (e.p) touch(e.p); }
  if (!isFinite(minX)) { minX = minY = 0; maxX = maxY = 100; }

  const w = new DxfWriter();
  if (embed) {
    const b64 = b64encode(JSON.stringify({ app: 'house3d', version: 1, plan }));
    w.g(999, 'house3d project data (base64 JSON). Safe to ignore.');
    for (let i = 0; i < b64.length; i += 240) w.g(999, 'H3D:' + b64.slice(i, i + 240));
  }
  w.g(0, 'SECTION'); w.g(2, 'HEADER');
  w.g(9, '$ACADVER'); w.g(1, 'AC1009');
  w.g(9, '$DWGCODEPAGE'); w.g(3, 'ANSI_950');
  w.g(9, '$INSBASE'); w.g(10, 0); w.g(20, 0); w.g(30, 0);
  w.g(9, '$EXTMIN'); w.g(10, minX); w.g(20, minY); w.g(30, 0);
  w.g(9, '$EXTMAX'); w.g(10, maxX); w.g(20, maxY); w.g(30, 0);
  w.g(9, '$LIMMIN'); w.g(10, minX); w.g(20, minY);
  w.g(9, '$LIMMAX'); w.g(10, maxX); w.g(20, maxY);
  w.g(9, '$LTSCALE'); w.g(40, 10);
  w.g(9, '$TEXTSTYLE'); w.g(7, 'CHT');
  w.g(0, 'ENDSEC');

  w.g(0, 'SECTION'); w.g(2, 'TABLES');
  w.g(0, 'TABLE'); w.g(2, 'LTYPE'); w.g(70, 3);
  w.g(0, 'LTYPE'); w.g(2, 'CONTINUOUS'); w.g(70, 0); w.g(3, 'Solid line'); w.g(72, 65); w.g(73, 0); w.g(40, 0);
  w.g(0, 'LTYPE'); w.g(2, 'HIDDEN'); w.g(70, 0); w.g(3, '__ __ __'); w.g(72, 65); w.g(73, 2); w.g(40, 3.75); w.g(49, 2.5); w.g(49, -1.25);
  w.g(0, 'LTYPE'); w.g(2, 'DASHED'); w.g(70, 0); w.g(3, '___ ___'); w.g(72, 65); w.g(73, 2); w.g(40, 7.5); w.g(49, 5); w.g(49, -2.5);
  w.g(0, 'ENDTAB');
  w.g(0, 'TABLE'); w.g(2, 'LAYER'); w.g(70, LAYERS.length + 1);
  w.g(0, 'LAYER'); w.g(2, '0'); w.g(70, 0); w.g(62, 7); w.g(6, 'CONTINUOUS');
  for (const [name, color] of LAYERS) { w.g(0, 'LAYER'); w.g(2, name); w.g(70, 0); w.g(62, color); w.g(6, 'CONTINUOUS'); }
  w.g(0, 'ENDTAB');
  w.g(0, 'TABLE'); w.g(2, 'STYLE'); w.g(70, 2);
  w.g(0, 'STYLE'); w.g(2, 'STANDARD'); w.g(70, 0); w.g(40, 0); w.g(41, 1); w.g(50, 0); w.g(71, 0); w.g(42, 2.5); w.g(3, 'txt'); w.g(4, '');
  w.g(0, 'STYLE'); w.g(2, 'CHT'); w.g(70, 0); w.g(40, 0); w.g(41, 1); w.g(50, 0); w.g(71, 0); w.g(42, 2.5); w.g(3, 'txt'); w.g(4, 'chineset.shx');
  w.g(0, 'ENDTAB');
  w.g(0, 'ENDSEC');

  w.g(0, 'SECTION'); w.g(2, 'ENTITIES');
  for (const e of ents) {
    if (e.t === 'LINE') {
      w.g(0, 'LINE'); w.g(8, e.layer); if (e.ltype) w.g(6, e.ltype);
      w.g(10, X(e.a)); w.g(20, Y(e.a)); w.g(30, 0); w.g(11, X(e.b)); w.g(21, Y(e.b)); w.g(31, 0);
      if (e.thick) w.g(39, e.thick);
    } else if (e.t === 'POLY') {
      w.g(0, 'POLYLINE'); w.g(8, e.layer); w.g(66, 1); w.g(10, 0); w.g(20, 0); w.g(30, 0); w.g(70, e.closed ? 1 : 0);
      for (const p of e.pts) { w.g(0, 'VERTEX'); w.g(8, e.layer); w.g(10, X(p)); w.g(20, Y(p)); w.g(30, 0); }
      w.g(0, 'SEQEND'); w.g(8, e.layer);
    } else if (e.t === 'ARC') {
      w.g(0, 'ARC'); w.g(8, e.layer); w.g(10, X(e.c)); w.g(20, Y(e.c)); w.g(30, 0); w.g(40, e.r); w.g(50, (e.a0 + 360) % 360); w.g(51, (e.a1 + 360) % 360);
    } else if (e.t === 'CIRCLE') {
      w.g(0, 'CIRCLE'); w.g(8, e.layer); w.g(10, X(e.c)); w.g(20, Y(e.c)); w.g(30, 0); w.g(40, e.r);
    } else if (e.t === 'TEXT') {
      w.g(0, 'TEXT'); w.g(8, e.layer); w.g(10, X(e.p)); w.g(20, Y(e.p)); w.g(30, 0); w.g(40, e.h); w.g(1, uniEsc(e.s));
      if (e.rot) w.g(50, e.rot);
      w.g(7, 'CHT'); w.g(72, 1); w.g(11, X(e.p)); w.g(21, Y(e.p)); w.g(31, 0); w.g(73, 2);
    }
  }
  w.g(0, 'ENDSEC');
  w.g(0, 'EOF');
  return w.toString();
}

const lerpP = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

// 從 [t0,t1] 區間中扣掉線段落在凸四邊形「內部」的部分（邊界上不算）
function subtractInside(parts, a, b, quad) {
  const eps = 0.05;
  // 以 Cyrus-Beck 求 a→b 在（內縮 eps 的）凸多邊形內的參數區間
  let tin = 0, tout = 1;
  const d = sub(b, a);
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4, cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  for (let i = 0; i < 4; i++) {
    const p = quad[i], q = quad[(i + 1) % 4];
    const e = sub(q, p);
    let nrm = { x: -e.y, y: e.x };
    const l = len(nrm) || 1;
    nrm = { x: nrm.x / l, y: nrm.y / l };
    if (dot(nrm, sub({ x: cx, y: cy }, p)) < 0) nrm = { x: -nrm.x, y: -nrm.y }; // 內法向量
    const num = dot(nrm, sub(a, p)) - eps;
    const den = dot(nrm, d);
    if (Math.abs(den) < 1e-12) { if (num < 0) return parts; continue; }
    const t = -num / den;
    if (den > 0) tin = Math.max(tin, t); else tout = Math.min(tout, t);
    if (tin >= tout) return parts;
  }
  const out = [];
  for (const [s, e] of parts) {
    if (tout <= s || tin >= e) { out.push([s, e]); continue; }
    if (tin > s) out.push([s, tin]);
    if (tout < e) out.push([tout, e]);
  }
  return out;
}

function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function b64decode(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// ======================================================================
// 讀檔與解析
// ======================================================================
export function decodeDXF(buffer) {
  const bytes = new Uint8Array(buffer);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 20000)));
  if (head.startsWith('AutoCAD Binary DXF')) throw new Error('這是二進位 DXF，請在 AutoCAD 另存為「ASCII DXF」。');
  const ver = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*(AC\d+)/.exec(head)?.[1] || '';
  const cp = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1] || '';
  const verNum = parseInt(ver.slice(2), 10) || 0;
  let enc = 'utf-8';
  if (verNum && verNum < 1021) {
    if (/950/.test(cp)) enc = 'big5';
    else if (/936/.test(cp)) enc = 'gbk';
    else if (/932/.test(cp)) enc = 'shift_jis';
    else enc = 'windows-1252';
  }
  try { return new TextDecoder(enc).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

export function extractEmbeddedPlan(text) {
  if (!text.includes('H3D:')) return null;
  const chunks = [];
  const re = /^\s*999\s*\r?\n(H3D:[^\r\n]*)/gm;
  let m;
  while ((m = re.exec(text))) chunks.push(m[1].slice(4));
  if (!chunks.length) return null;
  try {
    const data = JSON.parse(b64decode(chunks.join('')));
    return data?.plan ? normalizePlan(data.plan) : null;
  } catch { return null; }
}

function decodeText(s) {
  return String(s)
    .replace(/\\U\+([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/\\M\+[0-9a-fA-F]([0-9a-fA-F]{4})/g, (_, h) => { try { return new TextDecoder('big5').decode(new Uint8Array([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2), 16)])); } catch { return ''; } })
    .replace(/%%[cC]/g, 'Ø').replace(/%%[dD]/g, '°').replace(/%%[pP]/g, '±')
    .replace(/\\P/g, ' ').replace(/\{\\[^;{}]*;/g, '').replace(/\\[A-Za-z][^;\\{}]*;/g, '').replace(/[{}]/g, '')
    .replace(/\\~/g, ' ').trim();
}

export function parseDXF(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = parseInt(lines[i].trim(), 10);
    if (Number.isNaN(code)) { i -= 1; continue; }
    pairs.push([code, lines[i + 1]]);
  }
  const res = { header: {}, blocks: {}, entities: [], layers: {} };
  let i = 0;
  const next = () => pairs[i++];
  while (i < pairs.length) {
    const [c, v] = next();
    if (c !== 0 || v.trim() !== 'SECTION') continue;
    const [, name] = next();
    const sec = name.trim();
    if (sec === 'HEADER') {
      let key = null;
      while (i < pairs.length) {
        const [cc, vv] = pairs[i];
        if (cc === 0 && vv.trim() === 'ENDSEC') { i++; break; }
        i++;
        if (cc === 9) key = vv.trim();
        else if (key && res.header[key] === undefined) res.header[key] = vv.trim();
      }
    } else if (sec === 'TABLES') {
      while (i < pairs.length) {
        const [cc, vv] = pairs[i];
        if (cc === 0 && vv.trim() === 'ENDSEC') { i++; break; }
        i++;
        if (cc === 0 && vv.trim() === 'LAYER') {
          const rec = {};
          while (i < pairs.length && pairs[i][0] !== 0) { rec[pairs[i][0]] = pairs[i][1].trim(); i++; }
          if (rec[2]) res.layers[rec[2]] = { color: +rec[62] || 7, off: (+rec[62] || 0) < 0, frozen: ((+rec[70] || 0) & 1) === 1 };
        }
      }
    } else if (sec === 'BLOCKS') {
      let cur = null;
      while (i < pairs.length) {
        const [cc, vv] = pairs[i];
        if (cc === 0 && vv.trim() === 'ENDSEC') { i++; break; }
        if (cc === 0 && vv.trim() === 'BLOCK') {
          i++;
          const rec = readGroups();
          cur = { name: rec.get(2)?.[0]?.trim() || rec.get(3)?.[0]?.trim(), base: { x: +(rec.get(10)?.[0] || 0), y: +(rec.get(20)?.[0] || 0) }, entities: [] };
          if (cur.name) res.blocks[cur.name] = cur;
          continue;
        }
        if (cc === 0 && vv.trim() === 'ENDBLK') { i++; readGroups(); cur = null; continue; }
        if (cc === 0) { const e = readEntity(); if (e && cur) cur.entities.push(e); continue; }
        i++;
      }
    } else if (sec === 'ENTITIES') {
      while (i < pairs.length) {
        const [cc, vv] = pairs[i];
        if (cc === 0 && vv.trim() === 'ENDSEC') { i++; break; }
        if (cc === 0) { const e = readEntity(); if (e) res.entities.push(e); continue; }
        i++;
      }
    } else {
      while (i < pairs.length && !(pairs[i][0] === 0 && pairs[i][1].trim() === 'ENDSEC')) i++;
      i++;
    }
  }
  return res;

  function readGroups() {
    const m = new Map();
    while (i < pairs.length && pairs[i][0] !== 0) {
      const [cc, vv] = pairs[i++];
      if (!m.has(cc)) m.set(cc, []);
      m.get(cc).push(vv);
    }
    return m;
  }
  function readEntity() {
    const type = pairs[i][1].trim();
    i++;
    const raw = [];
    while (i < pairs.length && pairs[i][0] !== 0) raw.push(pairs[i++]);
    const get = (code, d = 0) => { const p = raw.find((r) => r[0] === code); return p ? p[1] : d; };
    const num = (code, d = 0) => { const v = parseFloat(get(code, d)); return Number.isFinite(v) ? v : d; };
    const layer = String(get(8, '0')).trim();
    const e = { type, layer };
    if (type === 'LINE') {
      Object.assign(e, { a: { x: num(10), y: num(20) }, b: { x: num(11), y: num(21) } });
    } else if (type === 'LWPOLYLINE') {
      const pts = [];
      let bulge = [];
      for (const [cc, vv] of raw) {
        if (cc === 10) { pts.push({ x: parseFloat(vv), y: 0 }); bulge.push(0); }
        else if (cc === 20 && pts.length) pts[pts.length - 1].y = parseFloat(vv);
        else if (cc === 42 && pts.length) bulge[bulge.length - 1] = parseFloat(vv);
      }
      Object.assign(e, { pts, bulge, closed: (num(70) & 1) === 1 });
    } else if (type === 'POLYLINE') {
      const pts = [], bulge = [];
      const flags = num(70);
      while (i < pairs.length && pairs[i][0] === 0 && pairs[i][1].trim() === 'VERTEX') {
        i++;
        const vr = [];
        while (i < pairs.length && pairs[i][0] !== 0) vr.push(pairs[i++]);
        const vf = (c) => parseFloat(vr.find((r) => r[0] === c)?.[1] ?? 0);
        const vflags = vf(70);
        if (vflags & 16) continue; // spline 控制點
        pts.push({ x: vf(10), y: vf(20) });
        bulge.push(vf(42) || 0);
      }
      if (i < pairs.length && pairs[i][1].trim() === 'SEQEND') { i++; while (i < pairs.length && pairs[i][0] !== 0) i++; }
      Object.assign(e, { type: 'LWPOLYLINE', pts, bulge, closed: (flags & 1) === 1, is3d: (flags & (8 | 16 | 64)) !== 0 });
      if (flags & (16 | 64)) return null; // 3D 網格
    } else if (type === 'ARC' || type === 'CIRCLE') {
      Object.assign(e, { c: { x: num(10), y: num(20) }, r: num(40), a0: num(50, 0), a1: num(51, 360) });
    } else if (type === 'TEXT' || type === 'MTEXT' || type === 'ATTRIB') {
      let s = '';
      if (type === 'MTEXT') { for (const [cc, vv] of raw) if (cc === 3) s += vv; s += get(1, ''); } else s = get(1, '');
      const has11 = raw.some((r) => r[0] === 11) && (num(72) || num(73));
      Object.assign(e, { type: 'TEXT', p: has11 && type !== 'MTEXT' ? { x: num(11), y: num(21) } : { x: num(10), y: num(20) }, h: num(40, 10), text: decodeText(s), rot: num(50) });
    } else if (type === 'INSERT') {
      Object.assign(e, { name: String(get(2, '')).trim(), p: { x: num(10), y: num(20) }, sx: num(41, 1) || 1, sy: num(42, 1) || 1, rot: num(50), cols: num(70, 1) || 1, rows: num(71, 1) || 1, cs: num(44), rs: num(45) });
    } else if (type === 'SOLID' || type === '3DFACE') {
      Object.assign(e, { pts: [{ x: num(10), y: num(20) }, { x: num(11), y: num(21) }, { x: num(13), y: num(23) }, { x: num(12), y: num(22) }] });
    } else return { type, layer, skip: true };
    const lt = get(6, ''); if (lt) e.ltype = String(lt).trim();
    return e;
  }
}

// 將 INSERT 展開成世界座標的線段、弧、文字
function flatten(dxf, maxDepth = 5) {
  const out = { segs: [], arcs: [], texts: [], inserts: [], closed: [] };
  const apply = (T, p) => ({ x: T[0] * p.x + T[2] * p.y + T[4], y: T[1] * p.x + T[3] * p.y + T[5] });
  const compose = (A, B) => [A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1], A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3], A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5]];
  const I = [1, 0, 0, 1, 0, 0];
  const walk = (ents, T, depth, ctx) => {
    for (const e of ents) {
      if (e.skip) continue;
      const layer = e.layer === '0' && ctx.layer ? ctx.layer : e.layer;
      const L = dxf.layers[layer];
      if (L && (L.off || L.frozen)) continue;
      const tag = { layer, block: ctx.block, insert: ctx.insert };
      if (e.type === 'LINE') out.segs.push({ a: apply(T, e.a), b: apply(T, e.b), ...tag, ltype: e.ltype });
      else if (e.type === 'LWPOLYLINE') {
        const n = e.pts.length;
        const P = e.pts.map((p) => apply(T, p));
        for (let k = 0; k < (e.closed ? n : n - 1); k++) {
          const a = P[k], b = P[(k + 1) % n];
          const bu = e.bulge[k] || 0;
          if (Math.abs(bu) > 0.05) {
            const ch = dist(a, b), ang = 4 * Math.atan(Math.abs(bu)), r = ch / (2 * Math.sin(ang / 2));
            const mid = lerpP(a, b, 0.5);
            const nn = norm({ x: -(b.y - a.y), y: b.x - a.x });
            const sgn = bu > 0 ? 1 : -1;
            const h = Math.sqrt(Math.max(0, r * r - (ch / 2) ** 2));
            const c = add(mid, mul(nn, sgn * h * (ang > Math.PI ? -1 : 1)));
            out.arcs.push({ c, r, p0: a, p1: b, ...tag });
          } else out.segs.push({ a, b, ...tag });
        }
        if (e.closed && n >= 3) out.closed.push({ pts: P, ...tag });
      } else if (e.type === 'ARC' || e.type === 'CIRCLE') {
        const c = apply(T, e.c);
        const sc = Math.sqrt(Math.abs(T[0] * T[3] - T[1] * T[2])) || 1;
        const mir = T[0] * T[3] - T[1] * T[2] < 0;
        if (e.type === 'CIRCLE') { out.arcs.push({ c, r: e.r * sc, full: true, ...tag }); continue; }
        const pa = (deg) => apply(T, { x: e.c.x + e.r * Math.cos(deg * Math.PI / 180), y: e.c.y + e.r * Math.sin(deg * Math.PI / 180) });
        let sweep = ((e.a1 - e.a0) % 360 + 360) % 360;
        const p0 = pa(e.a0), p1 = pa(e.a1), pm = pa(e.a0 + sweep / 2);
        out.arcs.push({ c, r: e.r * sc, p0: mir ? p1 : p0, p1: mir ? p0 : p1, pm, sweep, ...tag });
      } else if (e.type === 'TEXT') {
        if (e.text) out.texts.push({ p: apply(T, e.p), h: e.h, text: e.text, ...tag });
      } else if (e.type === 'SOLID') {
        out.closed.push({ pts: e.pts.map((p) => apply(T, p)), solid: true, ...tag });
      } else if (e.type === 'INSERT') {
        const blk = dxf.blocks[e.name];
        if (!blk || depth >= maxDepth) continue;
        const r = e.rot * Math.PI / 180;
        const cos = Math.cos(r), sin = Math.sin(r);
        for (let cI = 0; cI < Math.min(e.cols, 50); cI++) for (let rI = 0; rI < Math.min(e.rows, 50); rI++) {
          const off = { x: cI * e.cs, y: rI * e.rs };
          const local = [e.sx * cos, e.sx * sin, -e.sy * sin, e.sy * cos, 0, 0];
          const tr = compose([1, 0, 0, 1, e.p.x + off.x * cos - off.y * sin, e.p.y + off.x * sin + off.y * cos], compose(local, [1, 0, 0, 1, -blk.base.x, -blk.base.y]));
          const W = compose(T, tr);
          const insIdx = ctx.insert ?? out.inserts.length;
          if (depth === 0) out.inserts.push({ name: e.name, layer, T: W, rot: e.rot, sx: e.sx, sy: e.sy, blk });
          walk(blk.entities, W, depth + 1, { layer, block: ctx.block || e.name, insert: insIdx });
        }
      }
    }
  };
  walk(dxf.entities, I, 0, {});
  return out;
}

// ======================================================================
// 由幾何辨識平面（DXF 與向量 PDF 共用）
// ======================================================================
const WALL_LAYER = /wall|牆|墙|壁|a-wall|^rc$|磚|砖|brick|conc/i;
const NON_WALL_LAYER = /dim|標註|标注|尺寸|text|文字|hatch|填充|axis|軸|轴|grid|furn|家具|傢俱|設備|equip|door|門|门|window|win|窗|stair|梯|elev|defpoints|title|圖框|图框|frame|note|標示|符號|symbol|land|景|plant|植|site|基地|地界|border/i;
const DOOR_NAME = /door|門|门|^dr|d\d/i;
const NOT_EVIDENCE = /area|room|空間|面積|dim|標註|标注|尺寸|text|文字|hatch|填充|axis|軸|轴|grid|furn|家具|傢俱|fixt|設備|equip|stair|strs|梯|title|圖框|frame|defpoints/i;
const WINDOW_NAME = /window|win|窗|^w\d/i;

export function unitScaleFromHeader(header, extentSize) {
  const u = parseInt(header?.$INSUNITS ?? '0', 10);
  const map = { 1: 2.54, 2: 30.48, 4: 0.1, 5: 1, 6: 100, 14: 10 };
  if (map[u]) return { scale: map[u], guessed: false };
  if (extentSize > 8000) return { scale: 0.1, guessed: true };
  if (extentSize < 80) return { scale: 100, guessed: true };
  return { scale: 1, guessed: true };
}

export function dxfToPlan(text, fileName = 'DXF') {
  const embedded = extractEmbeddedPlan(text);
  if (embedded) return { plan: embedded, report: '已還原本工具匯出的原始資料（未經修改）。', embedded: true };
  const dxf = parseDXF(text);
  const flat = flatten(dxf);
  return planFromGeometry(flat, { header: dxf.header, name: fileName.replace(/\.[^.]+$/, '') });
}

export function planFromGeometry(flat, { header = {}, name = '匯入平面', scale: forcedScale = null } = {}) {
  // --- 單位 ---
  const all = flat.segs;
  if (!all.length) throw new Error('檔案中找不到線條。');
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of all) for (const p of [s.a, s.b]) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  // 用中位數範圍避免遠處雜訊
  const us = forcedScale ? { scale: forcedScale, guessed: false } : unitScaleFromHeader(header, Math.max(maxX - minX, maxY - minY));
  const k = us.scale;
  const T = (p) => ({ x: p.x * k, y: -p.y * k });
  const segs = flat.segs.map((s) => ({ ...s, a: T(s.a), b: T(s.b) })).filter((s) => dist(s.a, s.b) > 1);
  const arcs = flat.arcs.map((a) => ({ ...a, c: T(a.c), r: a.r * k, p0: a.p0 && T(a.p0), p1: a.p1 && T(a.p1), pm: a.pm && T(a.pm) }));
  const texts = flat.texts.map((t) => ({ ...t, p: T(t.p), h: t.h * k }));

  // --- 牆候選線 ---
  const layers = [...new Set(segs.map((s) => s.layer))];
  const wallLayers = layers.filter((l) => WALL_LAYER.test(l));
  let cand = segs.filter((s) => s.insert === undefined && (wallLayers.length ? wallLayers.includes(s.layer) : !NON_WALL_LAYER.test(s.layer)));
  if (cand.length < 8) cand = segs.filter((s) => (wallLayers.length ? wallLayers.includes(s.layer) : !NON_WALL_LAYER.test(s.layer)));
  if (cand.length < 8) cand = segs;
  cand = cand.filter((s) => dist(s.a, s.b) >= 8);
  if (flat.pdf) {
    // PDF 沒有圖層：排除家具小矩形，並優先使用最粗的筆寬（CAD 出圖通常牆線最粗）
    cand = cand.filter((s) => !(s.rect && s.rect.min * k > 45 && s.rect.max * k < 450));
    const byW = new Map();
    let total = 0;
    for (const s of cand) { const w = Math.round((s.w || 0) * 100) / 100; const L = dist(s.a, s.b); byW.set(w, (byW.get(w) || 0) + L); total += L; }
    const widths = [...byW.keys()].sort((x, y) => y - x);
    let acc = 0, thr = widths[widths.length - 1];
    for (const w of widths) { acc += byW.get(w); thr = w; if (acc >= total * 0.2) break; }
    if (widths.length > 1 && thr > widths[widths.length - 1] * 1.3) {
      const heavy = cand.filter((s) => (s.w || 0) >= thr - 1e-6);
      if (heavy.length >= 12) cand = heavy;
    }
  }
  const candLayers = new Set(cand.map((s) => s.layer));

  const walls = pairWalls(cand);
  if (!walls.length) throw new Error('辨識不到牆體（找不到 8–45 cm 間距的平行雙線）。可改把檔案當底圖描繪。');
  const merged = mergeCollinear(walls);
  // 門窗：門弧、窗線與同一直線上的缺口
  const candSet = new Set(cand);
  const { walls: W2, openings } = findOpenings(merged, arcs, segs, candSet);
  joinEnds(W2);
  // 牆應該彼此相連成網；孤立的小段（家具、文字筆畫）捨棄
  const keep = connectedWalls(W2);
  for (let i = W2.length - 1; i >= 0; i--) if (!keep.has(W2[i])) W2.splice(i, 1);
  for (let i = openings.length - 1; i >= 0; i--) if (!W2.some((w) => w.id === openings[i].wall)) openings.splice(i, 1);
  if (!W2.length) throw new Error('辨識不到相連的牆體。可改把檔案當底圖描繪。');
  // 端點調整後，依開口的絕對位置重算 pos
  for (const o of openings) {
    const w = W2.find((x) => x.id === o.wall);
    const L = dist(w.a, w.b);
    const u = norm(sub(w.b, w.a));
    o.pos = Math.round(Math.max(o.w / 2, Math.min(L - o.w / 2, dot(sub(o._c, w.a), u))) * 10) / 10;
    delete o._c;
  }

  // 平移到原點附近
  let bx = Infinity, by = Infinity;
  for (const w of W2) { bx = Math.min(bx, w.a.x, w.b.x); by = Math.min(by, w.a.y, w.b.y); }
  const shift = (p) => ({ x: Math.round((p.x - bx) * 10) / 10, y: Math.round((p.y - by) * 10) / 10 });
  const plan = newPlan(name);
  plan.walls = W2.map((w) => ({ id: w.id, a: shift(w.a), b: shift(w.b), t: Math.round(w.t * 10) / 10, kind: w.t >= 16 ? 'ext' : 'int', h: DEFAULTS.wallHeight }));
  plan.openings = openings;
  const shiftedTexts = texts.map((t) => ({ ...t, p: shift(t.p) }));

  // --- 房間 ---
  const polys = detectAllRooms(plan.walls);
  for (const pts of polys) {
    const inside = shiftedTexts.filter((t) => pointInPolygon(t.p, pts) && isRoomName(t.text));
    inside.sort((a, b) => b.h - a.h);
    const nm = inside[0]?.text || '';
    plan.rooms.push({ id: uid('r'), name: nm, kind: guessRoomKind(nm), pts });
  }

  // --- 家具圖塊 ---
  const items = [];
  const byInsert = new Map();
  for (const sg of flat.segs) if (sg.insert !== undefined) { if (!byInsert.has(sg.insert)) byInsert.set(sg.insert, { segs: [], arcs: [] }); byInsert.get(sg.insert).segs.push(sg); }
  for (const ar of flat.arcs) if (ar.insert !== undefined) { if (!byInsert.has(ar.insert)) byInsert.set(ar.insert, { segs: [], arcs: [] }); byInsert.get(ar.insert).arcs.push(ar); }
  flat.inserts.forEach((ins, idx) => {
    if (ins.name.startsWith('*')) return;
    if (DOOR_NAME.test(ins.name) || WINDOW_NAME.test(ins.name) || /dim|標註|axis|軸/i.test(ins.layer)) return;
    const own = byInsert.get(idx);
    if (!own || (!own.segs.length && !own.arcs.length)) return;
    // 取圖塊本地外框
    const inv = invert(ins.T);
    let lx0 = Infinity, ly0 = Infinity, lx1 = -Infinity, ly1 = -Infinity;
    const touch = (p) => { const q = applyT(inv, p); lx0 = Math.min(lx0, q.x); lx1 = Math.max(lx1, q.x); ly0 = Math.min(ly0, q.y); ly1 = Math.max(ly1, q.y); };
    own.segs.forEach((s) => { touch(s.a); touch(s.b); });
    own.arcs.forEach((a) => { touch({ x: a.c.x - a.r, y: a.c.y }); touch({ x: a.c.x + a.r, y: a.c.y }); touch({ x: a.c.x, y: a.c.y - a.r }); touch({ x: a.c.x, y: a.c.y + a.r }); });
    const sx = Math.hypot(ins.T[0], ins.T[1]), sy = Math.hypot(ins.T[2], ins.T[3]);
    const w = (lx1 - lx0) * sx * k, d = (ly1 - ly0) * sy * k;
    if (!(w > 8 && d > 8 && w < 700 && d < 700)) return;
    const cw = applyT(ins.T, { x: (lx0 + lx1) / 2, y: (ly0 + ly1) / 2 });
    const c = shift(T(cw));
    const kind = guessItemKind(ins.name + ' ' + ins.layer);
    const rot = -(Math.atan2(ins.T[1], ins.T[0]) * 180 / Math.PI);
    items.push({ id: uid('i'), kind, x: c.x, y: c.y, w: Math.round(w), d: Math.round(d), rot: ((Math.round(rot) % 360) + 360) % 360, label: kind === 'box' ? ins.name : undefined, h: CATALOG[kind]?.h });
  });
  // 有文字標示的矩形（例如「衣櫃」「桌子」框）
  const closedT = (flat.closed || []).filter((c) => c.insert === undefined).map((c) => ({ ...c, pts: c.pts.map(T) }));
  for (const r of rectItems(closedT, texts, (l) => !flat.pdf && candLayers.has(l))) {
    const c = shift(r.c);
    const it = { id: uid('i'), kind: r.kind, x: c.x, y: c.y, w: Math.round(r.w), d: Math.round(r.d), rot: ((Math.round(r.rot) % 360) + 360) % 360, h: CATALOG[r.kind]?.h };
    if (r.kind === 'box' || r.label !== CATALOG[r.kind]?.name) it.label = r.label;
    if (r.kind === 'counter') it.top = /爐|炉|stove/i.test(r.label) ? 'stove' : /水|sink/i.test(r.label) ? 'sink' : 'plain';
    if (r.kind === 'stair') Object.assign(it, { risers: 19, style: r.w > r.d * 0.55 && r.d > r.w * 0.55 ? 'U' : 'straight', h: DEFAULTS.floorHeight });
    if (r.kind === 'duct' || r.kind === 'column') it.h = DEFAULTS.wallHeight;
    items.push(it);
  }
  // 樓梯：等距平行線群（已有樓梯框的就不重複）
  for (const st of findStairs(segs.filter((s) => !candLayers.has(s.layer)))) {
    const c = shift(st.c);
    if (items.some((it) => it.kind === 'stair' && Math.abs(it.x - c.x) < it.w / 2 + 20 && Math.abs(it.y - c.y) < it.d / 2 + 20)) continue;
    items.push({ id: uid('i'), kind: 'stair', x: c.x, y: c.y, w: Math.round(st.w), d: Math.round(st.d), rot: st.rot, risers: Math.max(3, st.n + 1), style: 'straight', h: DEFAULTS.floorHeight });
  }
  plan.items = items;

  const report = `辨識出 ${plan.walls.length} 面牆、${plan.openings.length} 個門窗、${plan.rooms.length} 個房間、${items.length} 件家具／設備。` +
    (us.guessed ? `（檔案未標示單位，推測 1 單位 = ${k === 1 ? '1 cm' : k === 0.1 ? '1 mm' : k === 100 ? '1 m' : k + ' cm'}）` : '');
  return { plan: normalizePlan(plan), report, embedded: false, shift: { x: bx, y: by } };
}

function isRoomName(s) {
  if (!s || s.length > 12) return false;
  if (/^[\d.,\s±+\-x×*/()㎡m²坪%]+$/i.test(s)) return false;
  if (/\d{2,}\s*v$/i.test(s)) return false;
  if (/hdmi|wif|網路|插座|110v|220v/i.test(s)) return false;
  return /[一-鿿]|[a-z]{3,}/i.test(s);
}

export function guessRoomKind(n) {
  if (!n) return 'other';
  if (/天井|挑空/.test(n)) return 'void';
  if (/電梯|电梯|elev|lift/i.test(n)) return 'elevator';
  if (/梯|stair/i.test(n)) return 'stair';
  if (/浴|廁|厕|衛|卫|bath|wc|toilet/i.test(n)) return 'bath';
  if (/廚|厨|kitchen/i.test(n)) return 'kitchen';
  if (/陽台|阳台|露台|balcony/i.test(n)) return 'balcony';
  if (/臥|卧|房|bed/i.test(n)) return 'bedroom';
  if (/客|餐|廳|厅|living|dining/i.test(n)) return 'living';
  if (/儲|储|倉|store|storage/i.test(n)) return 'storage';
  if (/走道|玄關|玄关|廊|hall|corridor/i.test(n)) return 'hall';
  return 'other';
}

function guessItemKind(n) {
  const rules = [
    [/樓梯|楼梯|stair/i, 'stair'], [/電梯|电梯|elev|lift/i, 'elevator'], [/管道/, 'duct'], [/ac\s*版|冷氣版|空調版/i, 'ledge'],
    [/冷氣室內機|室內機|室内机/, 'ac'], [/冷氣|室外機|空調|aircon/i, 'acout'],
    [/馬桶|马桶|toilet|wc|closestool/i, 'toilet'], [/洗臉|洗脸|面盆|洗手|basin|lav/i, 'basin'], [/浴缸|bathtub|tub/i, 'bathtub'],
    [/淋浴|shower/i, 'shower'], [/單人床|单人床|single/i, 'bed_single'], [/床|bed/i, 'bed'], [/衣櫃|衣柜|wardrobe|closet/i, 'wardrobe'],
    [/沙發|沙发|sofa/i, 'sofa'], [/電視|电视|tv/i, 'tv'], [/餐桌|dining|table/i, 'table'], [/書桌|书桌|桌|desk/i, 'desk'], [/椅|chair/i, 'chair'],
    [/冰箱|fridge|refrig/i, 'fridge'], [/洗衣台|洗衣槽/, 'laundry'], [/洗衣|washer|washing/i, 'washer'],
    [/爐|炉|stove|cook|水區|水槽|sink|備料|流理|廚具|kitchen/i, 'counter'],
    [/植|plant|tree/i, 'plant'], [/柱|column/i, 'column'],
  ];
  for (const [re, k] of rules) if (re.test(n)) return k;
  return 'box';
}

const applyT = (T, p) => ({ x: T[0] * p.x + T[2] * p.y + T[4], y: T[1] * p.x + T[3] * p.y + T[5] });
function invert(T) {
  const det = T[0] * T[3] - T[1] * T[2] || 1;
  const a = T[3] / det, b = -T[1] / det, c = -T[2] / det, d = T[0] / det;
  return [a, b, c, d, -(a * T[4] + c * T[5]), -(b * T[4] + d * T[5])];
}

// 平行雙線 → 牆
function pairWalls(segs, minT = 6, maxT = 45) {
  const S = segs.filter((s) => dist(s.a, s.b) >= 20).map((s, i) => {
    const d = sub(s.b, s.a), L = len(d);
    let u = mul(d, 1 / L);
    if (u.x < -1e-9 || (Math.abs(u.x) < 1e-9 && u.y < 0)) u = mul(u, -1);
    const n = { x: -u.y, y: u.x };
    const ta = dot(s.a, u), tb = dot(s.b, u);
    return { i, s, u, n, L, t0: Math.min(ta, tb), t1: Math.max(ta, tb), off: dot(s.a, n), ang: Math.atan2(u.y, u.x) };
  });
  // 依角度分桶、桶內依偏移排序，只比對偏移差在牆厚範圍內的線（避免 O(n²)）
  const BW = 0.02;
  const buckets = new Map();
  for (const x of S) { const k = Math.round(x.ang / BW); if (!buckets.has(k)) buckets.set(k, []); buckets.get(k).push(x); }
  for (const list of buckets.values()) list.sort((p, q) => p.off - q.off);
  const partners = new Map();
  const consider = (A, B) => {
    if (A === B || Math.abs(B.ang - A.ang) > 0.035) return;
    const gap = B.off - A.off;
    const t = Math.abs(gap);
    if (t < minT || t > maxT) return;
    const o0 = Math.max(A.t0, B.t0), o1 = Math.min(A.t1, B.t1);
    if (o1 - o0 < Math.min(20, 0.5 * Math.min(A.L, B.L))) return;
    const rec = { A, B, t, o0, o1 };
    if (!partners.has(A.i)) partners.set(A.i, []);
    if (!partners.has(B.i)) partners.set(B.i, []);
    partners.get(A.i).push({ ...rec, other: B, sign: Math.sign(gap) });
    partners.get(B.i).push({ ...rec, other: A, sign: -Math.sign(gap) });
  };
  for (const [k, list] of buckets) {
    for (const kk of [k, k + 1]) {
      const other = buckets.get(kk);
      if (!other) continue;
      let lo = 0;
      for (const A of list) {
        while (lo < other.length && other[lo].off < A.off - maxT) lo++;
        for (let j = lo; j < other.length && other[j].off <= A.off + maxT; j++) {
          const B = other[j];
          if (kk === k && B.i <= A.i) continue; // 同桶只算一次
          consider(A, B);
        }
      }
    }
  }
  // 樓梯踏步、剖面線等「等距多條」排除：兩側都有相同間距夥伴
  const series = new Set();
  for (const [i, list] of partners) {
    const pos = list.filter((r) => r.sign > 0), neg = list.filter((r) => r.sign < 0);
    for (const p of pos) for (const q of neg) if (Math.abs(p.t - q.t) < 2.5 && p.t < 40) { series.add(i); }
  }
  // 由近到遠配對；同一條線的同一側已被較近夥伴佔用的區段不再重複使用
  const all = [];
  for (const [i, list] of partners) for (const r of list) if (r.A.i === i) all.push(r);
  all.sort((p, q) => p.t - q.t);
  const cover = new Map(); // key: segIndex|side → [[t0,t1]...]
  const free = (key, a, b) => {
    let parts = [[a, b]];
    for (const [c0, c1] of cover.get(key) || []) {
      const nx = [];
      for (const [p0, p1] of parts) {
        if (c1 <= p0 || c0 >= p1) { nx.push([p0, p1]); continue; }
        if (c0 > p0) nx.push([p0, c0]);
        if (c1 < p1) nx.push([c1, p1]);
      }
      parts = nx;
    }
    return parts;
  };
  const mark = (key, a, b) => { if (!cover.has(key)) cover.set(key, []); cover.get(key).push([a, b]); };
  const walls = [];
  for (const r of all) {
    if (series.has(r.A.i) || series.has(r.B.i)) continue;
    const sA = r.B.off > r.A.off ? 1 : -1;
    const kA = r.A.i + '|' + sA, kB = r.B.i + '|' + -sA;
    const fa = free(kA, r.o0, r.o1);
    const pieces = [];
    for (const [p0, p1] of fa) for (const [q0, q1] of free(kB, p0, p1)) if (q1 - q0 >= 12) pieces.push([q0, q1]);
    const u = r.A.u, n = r.A.n;
    const mid = (r.A.off + r.B.off) / 2;
    for (const [q0, q1] of pieces) {
      mark(kA, q0, q1); mark(kB, q0, q1);
      walls.push({ a: add(mul(u, q0), mul(n, mid)), b: add(mul(u, q1), mul(n, mid)), t: r.t, u, n, off: mid });
    }
  }
  return walls;
}

// 同線合併（容許 <3cm 的縫）
function mergeCollinear(walls) {
  const groups = [];
  for (const w of walls) {
    const ang = Math.atan2(w.u.y, w.u.x);
    let g = groups.find((G) => Math.abs(G.ang - ang) < 0.02 && Math.abs(G.off - w.off) < 3 && Math.abs(G.t - w.t) < 4);
    if (!g) { g = { ang, off: w.off, t: w.t, u: w.u, n: w.n, spans: [] }; groups.push(g); }
    g.spans.push([dot(w.a, g.u), dot(w.b, g.u), w.t]);
  }
  const out = [];
  for (const g of groups) {
    g.spans.sort((p, q) => p[0] - q[0]);
    const merged = [];
    for (const sp of g.spans) {
      const last = merged[merged.length - 1];
      if (last && sp[0] <= last[1] + 3) { last[1] = Math.max(last[1], sp[1]); last[2] = Math.max(last[2], sp[2]); }
      else merged.push([...sp]);
    }
    g.merged = merged;
    out.push(g);
  }
  return out;
}

function findOpenings(groups, arcs, segs, candSet) {
  // --- 證據一：門弧（閉合位置的半徑沿著牆線）---
  for (const g of groups) { g.ev = []; g.lines = []; }
  const coverage = (g, s0, e0) => g.merged.reduce((acc, [m0, m1]) => acc + Math.max(0, Math.min(m1, e0) - Math.max(m0, s0)), 0) / Math.max(1, e0 - s0);
  // 與該線上既有牆段的距離（0＝相接）；太遠代表只是剛好共線的別面牆
  const proximity = (g, s0, e0) => g.merged.reduce((m, [m0, m1]) => Math.min(m, Math.max(0, m0 - e0, s0 - m1)), Infinity);
  const intT = groups.map((g) => g.t).filter((t) => t < 16).sort((x, y) => x - y);
  const defT = intT.length ? intT[Math.floor(intT.length / 2)] : 12;
  for (const a of arcs) {
    if (a.full || !a.p0 || !a.p1 || a.r < 45 || a.r > 140) continue;
    const v0 = norm(sub(a.p0, a.c)), v1 = norm(sub(a.p1, a.c));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(v0, v1)))) * 180 / Math.PI;
    if (ang < 60 || ang > 120) continue;
    // 候選：半徑沿某面牆；門關起來的位置應落在「缺口」上（牆覆蓋率低），打開的門片通常靠著牆
    const cands = [];
    for (const [q, other] of [[a.p0, a.p1], [a.p1, a.p0]]) {
      const dq = norm(sub(q, a.c));
      const mid = lerpP(a.c, q, 0.5);
      for (const g of groups) {
        if (Math.abs(dot(dq, g.u)) < 0.96) continue;
        if (Math.abs(dot(mid, g.n) - g.off) > g.t / 2 + 6) continue;
        const tc = dot(a.c, g.u), tq = dot(q, g.u);
        const s0 = Math.min(tc, tq), e0 = Math.max(tc, tq);
        const prox = proximity(g, s0, e0);
        if (prox > 40) continue;
        cands.push({ g, q, other, s: s0, e: e0, hingeStart: tc < tq, cov: coverage(g, s0, e0), prox });
      }
    }
    cands.sort((x, y) => (x.cov - y.cov) || (x.prox - y.prox));
    let pick = cands[0] && cands[0].cov <= 0.5 ? cands[0] : null;
    if (!pick) {
      // 門所在的牆太短沒被辨識：用「沒有靠牆」的那個半徑建立一段牆
      const leaning = cands[0]?.q;
      const q = leaning === a.p0 ? a.p1 : leaning === a.p1 ? a.p0 : a.p1;
      const other = q === a.p0 ? a.p1 : a.p0;
      let u = norm(sub(q, a.c));
      if (u.x < -1e-9 || (Math.abs(u.x) < 1e-9 && u.y < 0)) u = mul(u, -1);
      const n = { x: -u.y, y: u.x };
      const openDir = dot(sub(other, a.c), n) >= 0 ? 1 : -1;
      const off = dot(a.c, n) - openDir * defT / 2;
      const angG = Math.atan2(u.y, u.x);
      let g = groups.find((G) => Math.abs(G.ang - angG) < 0.02 && Math.abs(G.off - off) < 4);
      if (!g) { g = { ang: angG, off, t: defT, u, n, merged: [], ev: [], lines: [], synthetic: true }; groups.push(g); }
      const tc = dot(a.c, g.u), tq = dot(q, g.u);
      pick = { g, q, other, s: Math.min(tc, tq), e: Math.max(tc, tq), hingeStart: tc < tq };
    }
    pick.g.ev.push({ s: pick.s, e: pick.e, type: 'door', hingeStart: pick.hingeStart, side: dot(sub(pick.other, a.c), pick.g.n) >= 0 ? 1 : -1 });
  }
  // --- 證據二：牆帶內的平行短線（窗框、推拉門片）---
  const arcPts = [];
  for (const a of arcs) if (!a.full) arcPts.push(a.c, ...(a.p0 ? [a.p0, a.p1] : []));
  const onArc = (p) => arcPts.some((q) => Math.abs(q.x - p.x) < 1 && Math.abs(q.y - p.y) < 1);
  const loose = [];
  for (const sg of segs) {
    if (candSet.has(sg) || NOT_EVIDENCE.test(sg.layer)) continue;
    if (onArc(sg.a) || onArc(sg.b)) continue; // 門片線
    const d = sub(sg.b, sg.a), L = len(d);
    if (L < 25) continue;
    const u = mul(d, 1 / L);
    const m = lerpP(sg.a, sg.b, 0.5);
    let attached = false;
    for (const g of groups) {
      if (Math.abs(dot(u, g.u)) < 0.995) continue;
      if (Math.abs(dot(m, g.n) - g.off) > g.t / 2 + 3) continue;
      const t0 = dot(sg.a, g.u), t1 = dot(sg.b, g.u);
      g.lines.push({ s: Math.min(t0, t1), e: Math.max(t0, t1), layer: sg.layer, dashed: /hidden|dash|虛|虚/i.test(sg.ltype || '') });
      attached = true;
      break;
    }
    if (!attached && L >= 40) loose.push(sg);
  }
  for (const g of groups) {
    g.lines.sort((p, q) => p.s - q.s);
    const clusters = [];
    for (const ln of g.lines) {
      const c = clusters[clusters.length - 1];
      if (c && ln.s <= c.e + 3) { c.e = Math.max(c.e, ln.e); c.list.push(ln); } else clusters.push({ s: ln.s, e: ln.e, list: [ln] });
    }
    for (const c0 of clusters) {
      // 只取沒有被實牆覆蓋的最大一段
      let free = [[c0.s, c0.e]];
      for (const [s0, e0] of g.merged) {
        const nx = [];
        for (const [p0, p1] of free) {
          if (e0 <= p0 + 2 || s0 >= p1 - 2) { nx.push([p0, p1]); continue; }
          if (s0 > p0) nx.push([p0, s0]);
          if (e0 < p1) nx.push([e0, p1]);
        }
        free = nx;
      }
      free.sort((p, q) => (q[1] - q[0]) - (p[1] - p[0]));
      if (!free.length) continue;
      const c = { s: free[0][0], e: free[0][1], list: c0.list.filter((x) => x.e > free[0][0] + 2 && x.s < free[0][1] - 2) };
      const w = c.e - c.s;
      if (w < 40 || w > 400 || !c.list.length) continue;
      if (proximity(g, c.s, c.e) > 40) continue;
      if (g.ev.some((ev) => ev.e > c.s + 5 && ev.s < c.e - 5)) continue;
      const layers = c.list.map((x) => x.layer).join(' ');
      const partial = c.list.filter((x) => x.e - x.s < w * 0.8).length;
      let type = 'window';
      if (c.list.every((x) => x.dashed)) type = 'opening';
      else if (DOOR_NAME.test(layers) && !WINDOW_NAME.test(layers)) type = 'sliding';
      else if (!WINDOW_NAME.test(layers) && partial >= 2) type = 'sliding';
      g.ev.push({ s: c.s, e: c.e, type });
    }
  }
  // --- 證據三：整面幾乎都是窗、兩側牆段太短沒被辨識 → 由窗線本身建立一段牆 ---
  const L2 = loose.map((sg) => {
    let u = norm(sub(sg.b, sg.a));
    if (u.x < -1e-9 || (Math.abs(u.x) < 1e-9 && u.y < 0)) u = mul(u, -1);
    const n = { x: -u.y, y: u.x };
    const t0 = dot(sg.a, u), t1 = dot(sg.b, u);
    return { sg, u, n, off: dot(sg.a, n), s: Math.min(t0, t1), e: Math.max(t0, t1), ang: Math.atan2(u.y, u.x) };
  });
  const usedL = new Set();
  for (let i = 0; i < L2.length; i++) {
    if (usedL.has(i)) continue;
    const A = L2[i];
    const grp = [i];
    for (let j = i + 1; j < L2.length; j++) {
      const B = L2[j];
      if (usedL.has(j) || Math.abs(B.ang - A.ang) > 0.01 || Math.abs(B.off - A.off) > 45) continue;
      const ov = Math.min(A.e, B.e) - Math.max(A.s, B.s);
      if (ov < 0.6 * Math.min(A.e - A.s, B.e - B.s)) continue;
      grp.push(j);
    }
    if (grp.length < 2) continue;
    const offs = grp.map((k) => L2[k].off);
    const spread = Math.max(...offs) - Math.min(...offs);
    if (spread < 6 || spread > 45) continue;
    // 窗框線彼此只差幾公分；間距大（例如 24 cm 的踏步）就不是窗
    const so = [...offs].sort((x, y) => x - y);
    if (so.some((v, k) => k > 0 && v - so[k - 1] > 15)) continue;
    grp.forEach((k) => usedL.add(k));
    const s0 = Math.min(...grp.map((k) => L2[k].s)), e0 = Math.max(...grp.map((k) => L2[k].e));
    const layers = grp.map((k) => L2[k].sg.layer).join(' ');
    const partial = grp.filter((k) => L2[k].e - L2[k].s < (e0 - s0) * 0.8).length;
    let type = 'window';
    if (grp.every((k) => /hidden|dash/i.test(L2[k].sg.ltype || ''))) type = 'opening';
    else if ((DOOR_NAME.test(layers) && !WINDOW_NAME.test(layers)) || (!WINDOW_NAME.test(layers) && partial >= 2)) type = 'sliding';
    groups.push({ ang: A.ang, off: (Math.max(...offs) + Math.min(...offs)) / 2, t: spread, u: A.u, n: A.n, merged: [], ev: [{ s: s0, e: e0, type }], lines: [], synthetic: true });
  }

  // --- 串接：牆段與開口段依序合併成整面牆 ---
  const walls = [];
  const openings = [];
  for (const g of groups) {
    const P = (t) => add(mul(g.u, t), mul(g.n, g.off));
    const spans = [
      ...g.merged.map(([s0, e0]) => ({ s: s0, e: e0, wall: true })),
      ...g.ev.map((ev) => ({ ...ev, wall: false })),
    ].sort((p, q) => p.s - q.s);
    let run = null;
    const flush = () => {
      const doorOnly = run && !run.hasWall && (run.ops.some((o) => o.type === 'door') || (g.synthetic && run.ops.length));
      if (run && (run.hasWall || doorOnly)) { if (doorOnly) run.wall.soft = true; walls.push(run.wall); }
      else if (run) run.ops.forEach((o) => openings.splice(openings.indexOf(o), 1));
      run = null;
    };
    for (const sp of spans) {
      if (run) {
        const gap = sp.s - run.end;
        if (gap <= 3) { /* 相接 */ }
        else if (gap < 35) { /* 小縫補起來 */ }
        else if (sp.wall && run.lastWall && gap <= 130) {
          const o = mkOpening(run.wall, P((run.end + sp.s) / 2), gap, { type: 'opening' });
          openings.push(o); run.ops.push(o);
        } else { flush(); }
      }
      if (!run) run = { wall: { id: uid('w'), a: P(sp.s), b: P(sp.e), t: g.t }, end: sp.s, hasWall: false, ops: [] };
      if (!sp.wall) {
        const width = sp.e - sp.s;
        const extra = sp.type === 'door' ? { hinge: sp.hingeStart ? 'a' : 'b', side: sp.side } : {};
        const o = mkOpening(run.wall, P((sp.s + sp.e) / 2), width, { type: sp.type, ...extra });
        openings.push(o); run.ops.push(o);
      } else run.hasWall = true;
      run.lastWall = sp.wall;
      if (sp.e > run.end) { run.end = sp.e; run.wall.b = P(sp.e); }
    }
    flush();
  }
  return { walls, openings };
}

function mkOpening(wall, c, w, { type, hinge = 'a', side = 1 }) {
  const d = {
    door: { h: DEFAULTS.doorHeight, sill: 0 }, sliding: { h: DEFAULTS.slidingHeight, sill: 0 },
    window: { h: DEFAULTS.windowHeight, sill: DEFAULTS.windowSill }, opening: { h: DEFAULTS.doorHeight, sill: 0 },
  }[type];
  return { id: uid('d'), wall: wall.id, _c: c, w: Math.round(w), type, hinge, side, ...d };
}

function connectedWalls(walls) {
  const parent = walls.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (w, o) => {
    const tol = Math.max(w.t, o.t) / 2 + 3;
    for (const p of [w.a, w.b]) {
      const d = sub(o.b, o.a), L2 = dot(d, d) || 1;
      const t = Math.max(0, Math.min(1, dot(sub(p, o.a), d) / L2));
      if (dist(p, add(o.a, mul(d, t))) <= tol) return true;
    }
    return false;
  };
  for (let i = 0; i < walls.length; i++) for (let j = i + 1; j < walls.length; j++) {
    if (touch(walls[i], walls[j]) || touch(walls[j], walls[i])) parent[find(i)] = find(j);
  }
  const lenOf = new Map();
  walls.forEach((w, i) => { const r = find(i); lenOf.set(r, (lenOf.get(r) || 0) + dist(w.a, w.b)); });
  const maxLen = Math.max(...lenOf.values());
  const keep = new Set();
  walls.forEach((w, i) => { const L = lenOf.get(find(i)); if (L >= Math.max(250, maxLen * 0.12)) keep.add(w); });
  return keep;
}

// 牆端延伸到相鄰牆中心線交點（L 角、T 接）
function joinEnds(walls) {
  for (let pass = 0; pass < 2; pass++) {
    for (const w of walls) {
      for (const end of ['a', 'b']) {
        const P = w[end];
        const dw = norm(sub(w.b, w.a));
        let best = null;
        for (const o of walls) {
          if (o === w) continue;
          const dO = norm(sub(o.b, o.a));
          const cross = dw.x * dO.y - dw.y * dO.x;
          if (Math.abs(cross) < 0.3) continue;
          // 交點
          const r = sub(o.a, w.a);
          const t = (r.x * dO.y - r.y * dO.x) / cross;
          const X = add(w.a, mul(dw, t));
          const moveD = dist(X, P);
          if (moveD > Math.max(w.t, o.t) * 0.9 + 14 + (w.soft ? 16 : 0)) continue;
          const Lo = dist(o.a, o.b);
          const to = dot(sub(X, o.a), dO);
          if (to < -o.t / 2 - w.t - 4 || to > Lo + o.t / 2 + w.t + 4) continue;
          if (!best || moveD < best.d) best = { d: moveD, X, o, to, Lo };
        }
        if (best) {
          w[end] = { ...best.X };
          const o = best.o;
          if (best.to < 0 || dist(o.a, best.X) < Math.max(o.t, w.t)) { if (dist(o.a, best.X) < Math.max(o.t, w.t) + 4) o.a = { ...best.X }; }
          if (best.to > best.Lo || dist(o.b, best.X) < Math.max(o.t, w.t)) { if (dist(o.b, best.X) < Math.max(o.t, w.t) + 4) o.b = { ...best.X }; }
        }
      }
    }
  }
}

// 等距平行短線群（踏步）→ 樓梯外框（只取連續等距的一段）
function findStairs(segs) {
  const S = segs.filter((s) => { const L = dist(s.a, s.b); return L > 60 && L < 200; }).map((s) => {
    const d = sub(s.b, s.a), L = len(d);
    let u = mul(d, 1 / L);
    if (u.x < -1e-9 || (Math.abs(u.x) < 1e-9 && u.y < 0)) u = mul(u, -1);
    const n = { x: -u.y, y: u.x };
    return { u, n, L, off: dot(s.a, n), t0: Math.min(dot(s.a, u), dot(s.b, u)), t1: Math.max(dot(s.a, u), dot(s.b, u)), ang: Math.atan2(u.y, u.x) };
  });
  const used = new Set();
  const out = [];
  for (let i = 0; i < S.length; i++) {
    if (used.has(i)) continue;
    const A = S[i];
    const grp = S.map((B, j) => j).filter((j) => !used.has(j) && Math.abs(S[j].ang - A.ang) < 0.03 && Math.abs(S[j].t0 - A.t0) < 8 && Math.abs(S[j].t1 - A.t1) < 8);
    if (grp.length < 6) continue;
    grp.sort((p, q) => S[p].off - S[q].off);
    // 去除重疊線並找連續等距段
    const uniq = [];
    for (const k of grp) if (!uniq.length || S[k].off - S[uniq[uniq.length - 1]].off > 1) uniq.push(k);
    let best = null;
    let start = 0;
    for (let k = 1; k <= uniq.length; k++) {
      const step = k < uniq.length ? S[uniq[k]].off - S[uniq[k - 1]].off : Infinity;
      const prev = k > 1 ? S[uniq[k - 1]].off - S[uniq[k - 2]].off : step;
      const ok = step >= 18 && step <= 40 && (k === start + 1 || Math.abs(step - prev) < 3);
      if (!ok) {
        const run = uniq.slice(start, k);
        if (run.length >= 6 && (!best || run.length > best.length)) best = run;
        start = k;
      }
    }
    if (!best) continue;
    best.forEach((k) => used.add(k));
    const offs = best.map((k) => S[k].off);
    const step = (offs[offs.length - 1] - offs[0]) / (offs.length - 1);
    const u = A.u, n = A.n;
    const t0 = Math.min(...best.map((k) => S[k].t0)), t1 = Math.max(...best.map((k) => S[k].t1));
    const o0 = offs[0] - step, o1 = offs[offs.length - 1];
    const c = add(mul(u, (t0 + t1) / 2), mul(n, (o0 + o1) / 2));
    const rot = -(Math.atan2(u.y, u.x) * 180 / Math.PI);
    out.push({ c, w: t1 - t0, d: o1 - o0, n: best.length, rot: ((Math.round(rot) % 360) + 360) % 360 });
  }
  return out;
}

// 封閉矩形（非牆圖層）＋內含文字 → 家具
function rectItems(closed, texts, wallLayerTest) {
  const rects = [];
  for (const c of closed) {
    if (wallLayerTest(c.layer) || /area|room|空間|面積|dim|標註|frame|圖框|title/i.test(c.layer)) continue;
    let P = c.pts;
    if (P.length === 5 && dist(P[0], P[4]) < 0.5) P = P.slice(0, 4);
    if (P.length !== 4) continue;
    const e1 = sub(P[1], P[0]), e2 = sub(P[2], P[1]);
    const L1 = len(e1), L2 = len(e2);
    if (Math.abs(dot(e1, e2)) > 0.05 * L1 * L2) continue;
    if (dist(P[2], P[3]) - L1 > 1 || Math.abs(dist(P[3], P[0]) - L2) > 1) continue;
    if (Math.min(L1, L2) < 15 || Math.max(L1, L2) > 420) continue;
    const cx = (P[0].x + P[2].x) / 2, cy = (P[0].y + P[2].y) / 2;
    rects.push({ c: { x: cx, y: cy }, w: L1, d: L2, rot: Math.atan2(e1.y, e1.x) * 180 / Math.PI, pts: P, area: L1 * L2 });
  }
  // 只留最外層（去掉枕頭、水箱等內部小框）
  rects.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const r of rects) {
    if (kept.some((k) => pointInPolygon(r.c, k.pts) && k.area > r.area * 1.2)) continue;
    const t = texts.filter((x) => pointInPolygon(x.p, r.pts)).sort((a, b) => b.h - a.h)[0];
    if (!t) continue;
    const kind = guessItemKind(t.text);
    kept.push({ ...r, kind, label: t.text });
  }
  return kept;
}

export { flatten as flattenDXF };
