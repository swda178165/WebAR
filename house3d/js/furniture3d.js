// 3D 家具：同一種家具依風格（或家具自己指定的款式）建出不同造型。
// 本地座標：寬＝X、深＝Z、正面朝 +Z、Y 向上，單位公分；原點在家具底面中心。
import * as THREE from 'three';
import { itemHeight } from './catalog.js';
import { variantOf, STYLES } from './styles.js';
import { stairGeometry } from './editor2d.js';
import { openingEnds, projectOnSegment } from './model.js';

const UP = new THREE.Vector3(0, 1, 0);
const PI = Math.PI;

// ---------- 幾何小工具 ----------
function kit(g) {
  const add = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); g.add(m); return m; };
  const K = {
    add,
    box(w, h, d, x, y, z, mat) {
      if (!(w > 0 && h > 0 && d > 0)) return null;
      return add(new THREE.BoxGeometry(w, h, d), mat, x, y + h / 2, z);
    },
    // 圓角方塊（用倒角擠出）
    rbox(w, h, d, r, x, y, z, mat) {
      if (!(w > 0 && h > 0 && d > 0)) return null;
      r = Math.max(0.2, Math.min(r, w / 2 - 0.15, h / 2 - 0.15, d / 2 - 0.15));
      const sw = Math.max(0.2, w - 2 * r), sh = Math.max(0.2, h - 2 * r);
      const geo = new THREE.ExtrudeGeometry(roundRect(sw, sh, Math.min(0.6, sw / 2, sh / 2)), {
        depth: Math.max(0.1, d - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: 3, curveSegments: 4,
      });
      geo.translate(0, 0, -Math.max(0.1, d - 2 * r) / 2);
      return add(geo, mat, x, y + h / 2, z);
    },
    cyl(rx, h, rz, x, y, z, mat, seg = 24) {
      if (!(h > 0)) return null;
      const m = add(new THREE.CylinderGeometry(1, 1, h, seg), mat, x, y + h / 2, z);
      m.scale.set(rx, 1, rz);
      return m;
    },
    // 上下不同半徑的圓柱（rTop 在上）
    cone(rTop, rBot, h, x, y, z, mat, seg = 24, open = false) {
      if (!(h > 0)) return null;
      return add(new THREE.CylinderGeometry(rTop, rBot, h, seg, 1, open), mat, x, y + h / 2, z);
    },
    // 兩點之間的圓桿；r 在 p 端、r2 在 q 端
    rod(p, q, r, mat, seg = 10, r2 = r) {
      const a = new THREE.Vector3(...p), b = new THREE.Vector3(...q);
      const dir = b.clone().sub(a);
      const L = dir.length();
      if (L < 0.05) return null;
      const m = new THREE.Mesh(new THREE.CylinderGeometry(r2, r, L, seg), mat);
      m.position.copy(a).addScaledVector(dir, 0.5);
      m.quaternion.setFromUnitVectors(UP, dir.normalize());
      g.add(m);
      return m;
    },
    // 錐形腳：頂端在 (x,h,z)，腳底往外撇 (sx,sz)
    leg(x, z, h, rTop, rBot, mat, sx = 0, sz = 0) { return K.rod([x + sx, 0, z + sz], [x, h, z], rBot, mat, 10, rTop); },
    sphere(rx, ry, rz, x, y, z, mat, seg = 18) {
      const m = add(new THREE.SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.7))), mat, x, y, z);
      m.scale.set(rx, ry, rz);
      return m;
    },
    // 半球（開口朝下）
    dome(r, x, y, z, mat, seg = 24) { return add(new THREE.SphereGeometry(r, seg, 10, 0, PI * 2, 0, PI / 2), mat, x, y, z); },
    lathe(profile, x, y, z, mat, seg = 32, sx = 1) {
      const m = add(new THREE.LatheGeometry(profile.map(([r, yy]) => new THREE.Vector2(Math.max(0.01, r), yy)), seg), mat, x, y, z);
      if (sx !== 1) m.scale.set(sx, 1, sx);
      return m;
    },
    // 水平圓弧板：圓心 (cx,cz)、半徑 rIn–rOut、角度 a0→a1（a=-π/2 指向後方 -Z），由 y 往上 h
    arcSlab(rIn, rOut, a0, a1, y, h, cx, cz, mat, n = 28) {
      const pts = [];
      for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + rOut * Math.cos(a), cz + rOut * Math.sin(a)]); }
      for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * i / n; pts.push([cx + rIn * Math.cos(a), cz + rIn * Math.sin(a)]); }
      return K.slabXZ(pts, y, h, mat);
    },
    // 任意平面多邊形（x,z）往上擠出
    slabXZ(pts, y, h, mat, bevel = 0) {
      const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
      const geo = new THREE.ExtrudeGeometry(shape, bevel
        ? { depth: Math.max(0.1, h - 2 * bevel), bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel * 0.9, bevelSegments: 3, curveSegments: 6 }
        : { depth: h, bevelEnabled: false, curveSegments: 6 });
      geo.rotateX(-PI / 2);
      return add(geo, mat, 0, y + (bevel ? bevel : 0), 0);
    },
    // 水平圓環的一段，弧長 arc 以正後方（-Z）為中心
    ring(R, tube, arc, x, y, z, mat) {
      const geo = new THREE.TorusGeometry(R, tube, 8, 36, arc);
      geo.rotateX(-PI / 2);
      geo.rotateY(PI / 2 - arc / 2);
      return add(geo, mat, x, y, z);
    },
    tube(points, r, mat, seg = 40) {
      const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
      return add(new THREE.TubeGeometry(curve, seg, r, 8, false), mat, 0, 0, 0);
    },
  };
  return K;
}

function roundRect(w, h, r) {
  const s = new THREE.Shape();
  const x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

// 依家具 id 產生固定的亂數（同一件家具每次重建長得一樣）
function rng(id = 'x') {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  let s = (h >>> 0) || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 2246822507) ^ Math.imul(s ^ (s >>> 13), 3266489909), (s >>> 0) / 4294967296));
}

const seats = (w, inner, per = 70) => {
  const n = Math.max(1, Math.round(inner / per));
  const cw = inner / n;
  return Array.from({ length: n }, (_, i) => ({ x: -inner / 2 + cw * (i + 0.5), w: cw }));
};

// ---------- 主函式 ----------
export function buildItem(it, M, cut, plan) {
  const g = new THREE.Group();
  const K = kit(g);
  const w = it.w, d = it.d, hw = w / 2, hd = d / 2;
  const H = itemHeight(it);
  const styleKey = plan?.style || 'basic';
  const S = STYLES[styleKey] || STYLES.basic;
  const v = variantOf(it, styleKey);
  const clipH = (h) => Math.min(h, cut ?? Infinity);
  const ctx = { g, K, M, it, w, d, hw, hd, H, v, S, styleKey, cut, clipH, plan, rand: rng(it.id) };
  const fn = BUILDERS[it.kind];
  if (fn) fn(ctx);
  else K.box(w, clipH(H), d, 0, 0, 0, M.stone);
  return g;
}

// 床頭枕頭
function pillows(c, y, zBack, mat, { h = 11, depth = 32, r = 4, inset = 9 } = {}) {
  const n = c.it.kind === 'bed' ? 2 : 1;
  const pw = (c.w - inset * 2 - (n - 1) * 6) / n;
  for (let i = 0; i < n; i++) c.K.rbox(pw, h, depth, r, -c.hw + inset + pw / 2 + i * (pw + 6), y, zBack + depth / 2, mat);
}

// 書與小擺飾
function books(c, x0, x1, y, depth, z, maxH = 26) {
  const { K, M, rand } = c;
  const mats = [M.fabric2, M.fabric3, M.fabric, M.woodDark, M.throw, M.bedding];
  let x = x0 + 2;
  while (x < x1 - 4) {
    const r = rand();
    if (r < 0.18) { x += 6 + rand() * 10; continue; }
    if (r < 0.28 && x < x1 - 16) { K.lathe([[0, 0], [4, 0], [5.5, 5], [5, 11], [2.5, 15], [2.8, 18], [0, 18]], x + 6, y, z, M.pot, 16); x += 15; continue; }
    const bw = 2 + rand() * 3, bh = Math.min(maxH, 16 + rand() * 10);
    K.box(bw, bh, depth * (0.7 + rand() * 0.2), x + bw / 2, y, z, mats[Math.floor(rand() * mats.length)]);
    x += bw + 0.3;
  }
}

function tableLamp(c, x, y, z) {
  const { K, M, v, S } = c;
  const fam = S.furn?.lamp || 'basic';
  if (fam === 'akari') { K.cyl(0.6, 4, 0.6, x, y, z, M.metal, 6); K.sphere(11, 13, 11, x, y + 17, z, M.paper); return; }
  if (fam === 'tripod') { K.lathe([[0, 0], [6, 0], [6.5, 6], [2, 10], [1.2, 24], [0, 24]], x, y, z, M.wood, 16); K.cone(8, 11, 13, x, y + 24, z, M.lampShade, 20, true); return; }
  if (fam === 'pleat') { K.lathe([[0, 0], [7, 0], [9, 7], [7, 15], [2, 19], [0, 19]], x, y, z, M.plaster, 18); K.cone(6, 12, 14, x, y + 19, z, M.lampShade, 16, true); return; }
  if (fam === 'task') { K.cyl(7, 1.5, 7, x, y, z, M.metal); K.rod([x, y, z], [x, y + 30, z - 4], 0.8, M.metal); K.dome(7, x, y + 26, z + 2, M.metal); K.sphere(3, 3, 3, x, y + 25, z + 2, M.paper, 10); return; }
  if (fam === 'arc') { K.cyl(6, 2, 6, x, y, z, M.marble); K.cyl(0.8, 26, 0.8, x, y + 2, z, M.brass, 8); K.sphere(9, 9, 9, x, y + 34, z, M.paper); return; }
  void v;
  K.cyl(6, 2, 6, x, y, z, M.metal); K.cyl(0.8, 24, 0.8, x, y + 2, z, M.metal, 8); K.cone(7, 10, 13, x, y + 22, z, M.lampShade, 20, true);
}

// 平放的小擺飾（茶几、櫃子上）
function decor(c, x, y, z) {
  const { K, M } = c;
  K.box(24, 3, 17, x - 6, y, z, M.fabric2);
  K.box(21, 2.5, 15, x - 6, y + 3, z, M.fabric3);
  K.lathe([[0, 0], [4, 0], [6, 4], [5, 10], [2, 14], [2.4, 17], [0, 17]], x + 12, y, z - 2, M.pot, 16);
}

// ---------- 各家具 ----------
const BUILDERS = {
  bed: bedBuilder,
  bed_single: bedBuilder,

  sofa(c) {
    const { K, M, w, d, hw, hd, v } = c;
    if (v === 'lowwood') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(4, 14, 4, sx * (hw - 4), 0, sz * (hd - 4), M.wood);
      K.box(w, 6, d, 0, 14, 0, M.wood);
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 3.5);
        for (const sz of [-1, 1]) K.box(5, 36, 5, x, 20, sz * (hd - 5), M.wood);
        K.box(7, 3, d, x, 56, 0, M.wood);
        for (const yy of [30, 42]) K.box(2.5, 2.5, d - 10, x, yy, 0, M.wood);
      }
      K.box(w - 12, 26, 4, 0, 20, -hd + 2, M.wood);
      const list = seats(w, w - 14, 68);
      for (const s of list) {
        K.rbox(s.w - 1.5, 14, d - 12, 4, s.x, 20, 4, M.sofa);
        K.rbox(s.w - 2.5, 38, 14, 6, s.x, 32, -hd + 11, M.sofa).rotation.x = -0.12;
      }
      K.rbox(38, 34, 10, 5, -hw + 32, 33, -hd + 23, M.fabric3).rotation.x = -0.22;
      return;
    }
    if (v === 'tapered') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 9), sz * (hd - 9), 17, 1.9, 1.2, M.wood, sx * 2.5, sz * 2.5);
      K.rbox(w, 18, d, 2, 0, 16, 0, M.sofa);
      for (const sx of [-1, 1]) K.rbox(13, 28, d, 3, sx * (hw - 6.5), 30, 0, M.sofa);
      K.rbox(w, 42, 14, 3, 0, 30, -hd + 7, M.sofa);
      const list = seats(w, w - 26, 66);
      for (const s of list) {
        K.rbox(s.w - 1.5, 12, d - 22, 3, s.x, 34, 7, M.sofa);
        K.rbox(s.w - 2, 36, 12, 4, s.x, 44, -hd + 19, M.sofa).rotation.x = -0.1;
      }
      K.rbox(40, 36, 11, 5, -hw + 34, 45, -hd + 29, M.throw).rotation.x = -0.2;
      K.rbox(38, 34, 11, 5, hw - 34, 45, -hd + 29, M.fabric).rotation.x = -0.2;
      return;
    }
    if (v === 'cloud') {
      K.rbox(w, 32, d, 9, 0, 0, 0, M.sofa);
      K.rbox(w, 34, 28, 13, 0, 22, -hd + 14, M.sofa);
      for (const sx of [-1, 1]) K.rbox(26, 28, d - 6, 12, sx * (hw - 13), 22, 3, M.sofa);
      for (const s of seats(w, w - 52, 90)) K.rbox(s.w - 1, 14, d - 40, 7, s.x, 28, 10, M.fabric);
      K.rbox(44, 38, 15, 8, -hw + 52, 36, -hd + 36, M.fabric2).rotation.x = -0.25;
      K.rbox(40, 34, 14, 8, hw - 50, 36, -hd + 36, M.fabric3).rotation.x = -0.25;
      return;
    }
    if (v === 'chesterfield') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(5, 10, 5, sx * (hw - 7), 0, sz * (hd - 7), M.metal);
      K.rbox(w, 30, d, 3, 0, 10, 0, M.leather);
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 11);
        K.rbox(22, 22, d, 3, x, 40, 0, M.leather);
        K.rod([x, 62, -hd + 1], [x, 62, hd - 1], 11, M.leather, 20);
      }
      K.rbox(w - 40, 32, 18, 3, 0, 40, -hd + 9, M.leather);
      K.rod([-hw + 22, 71, -hd + 9], [hw - 22, 71, -hd + 9], 9, M.leather, 20);
      for (let row = 0; row < 2; row++) for (let x = -hw + 32 + (row % 2) * 10; x < hw - 28; x += 20) K.sphere(1.3, 1.3, 0.8, x, 52 + row * 10, -hd + 18.2, M.dark, 8);
      for (const s of seats(w, w - 44, 70)) K.rbox(s.w - 1, 10, d - 26, 3, s.x, 40, 6, M.leather);
      return;
    }
    if (v === 'curved') {
      const s = Math.min(26, d * 0.3);
      const R = (hw * hw + s * s) / (2 * s);
      const cz = -hd + R;
      const aEnd = Math.asin(Math.min(1, hw / R));
      const a0 = -PI / 2 - aEnd, a1 = -PI / 2 + aEnd;
      K.arcSlab(R - 17, R, a0, a1, 6, 72, 0, cz, M.sofa);
      const back = [], front = [];
      const n = 28, dz = d - s - 6;
      for (let i = 0; i <= n; i++) {
        const a = a0 + (a1 - a0) * i / n;
        const p = [(R - 15) * Math.cos(a), cz + (R - 15) * Math.sin(a)];
        back.push(p);
        front.push([p[0] * 0.97, p[1] + dz]);
      }
      const seat = [...back, ...front.reverse()];
      K.slabXZ(seat, 6, 34, M.sofa, 3);
      K.slabXZ(seat.map(([x, z]) => [x * 0.98, z]), 40, 8, M.sofa, 3);
      for (const t of [0.12, 0.5, 0.88]) {
        const a = a0 + (a1 - a0) * t;
        const x = (R - 30) * Math.cos(a), z = cz + (R - 30) * Math.sin(a);
        K.cyl(2.2, 6, 2.2, x, 0, z + 8, M.brass, 12);
      }
      K.rbox(42, 34, 12, 6, -hw * 0.45, 46, -hd + s * 0.6 + 22, M.throw).rotation.x = -0.2;
      K.rbox(40, 32, 12, 6, hw * 0.4, 46, -hd + s * 0.6 + 22, M.fabric).rotation.x = -0.2;
      return;
    }
    K.box(w, 42, d, 0, 0, 0, M.sofa);
    K.box(w, 38, 18, 0, 42, -hd + 9, M.sofa);
    K.box(16, 20, d, -hw + 8, 42, 0, M.sofa);
    K.box(16, 20, d, hw - 8, 42, 0, M.sofa);
    K.box(w - 34, 10, d - 22, 0, 42, 9, M.fabric);
  },

  armchair(c) {
    const { K, M, w, d, hw, hd, v } = c;
    const r = Math.min(hw, hd);
    if (v === 'lounge') {
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 3);
        K.box(4, 56, 4, x, 0, hd - 5, M.wood);
        K.box(4, 56, 4, x, 0, -hd + 5, M.wood);
        K.box(6, 3, d, x, 56, 0, M.wood);
      }
      K.box(w - 8, 4, d - 10, 0, 22, 0, M.wood);
      K.rbox(w - 12, 12, d - 16, 4, 0, 26, 4, M.sofa);
      K.rbox(w - 12, 42, 10, 4, 0, 34, -hd + 11, M.sofa).rotation.x = -0.22;
      K.box(w - 8, 4, 4, 0, 72, -hd + 5, M.wood);
      return;
    }
    if (v === 'shell') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 13), sz * (hd - 13), 34, 1.6, 1.1, M.wood, sx * 4, sz * 4);
      K.rbox(w - 8, 8, d - 12, 4, 0, 33, 2, M.fabric3);
      K.arcSlab(r - 12, r - 5, -PI + 0.3, -0.3, 37, 42, 0, 2, M.fabric3);
      K.rbox(w - 20, 6, d - 22, 3, 0, 40, 5, M.fabric);
      return;
    }
    if (v === 'tub') {
      K.cyl(hw, 38, hd, 0, 0, 0, M.fabric, 36);
      K.arcSlab(r - 13, r, -PI - 0.55, 0.55, 30, 36, 0, 0, M.fabric);
      K.cyl(r - 12, 8, r - 12, 0, 37, 3, M.fabric, 32);
      return;
    }
    if (v === 'sling') {
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 3);
        K.rod([x, 0, hd - 4], [x, 58, hd - 7], 1.3, M.metal);
        K.rod([x, 0, -hd + 4], [x, 82, -hd + 2], 1.3, M.metal);
        K.rod([x, 58, hd - 7], [x, 58, -hd + 6], 1.3, M.metal);
        K.rod([x, 8, hd - 4], [x, 8, -hd + 4], 1.1, M.metal);
      }
      K.rod([-hw + 3, 30, hd - 9], [hw - 3, 30, hd - 9], 1.1, M.metal);
      K.rod([-hw + 3, 78, -hd + 3], [hw - 3, 78, -hd + 3], 1.1, M.metal);
      K.box(w - 10, 2.5, d - 18, 0, 28, 3, M.leather).rotation.x = 0.15;
      K.box(w - 10, 46, 2.5, 0, 34, -hd + 8, M.leather).rotation.x = -0.28;
      return;
    }
    if (v === 'club') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(1.6, 10, 1.6, sx * (hw - 10), 0, sz * (hd - 10), M.brass, 12);
      K.rbox(w - 4, 30, d - 4, 6, 0, 10, 0, M.fabric3);
      K.arcSlab(r - 14, r - 1, -PI - 0.3, 0.3, 30, 44, 0, 2, M.fabric3);
      K.rbox(w - 28, 9, d - 28, 4, 0, 38, 7, M.fabric3);
      return;
    }
    K.box(w, 40, d, 0, 0, 0, M.fabric3);
    K.box(w, 42, 15, 0, 40, -hd + 7.5, M.fabric3);
    K.box(12, 20, d, -hw + 6, 40, 0, M.fabric3);
    K.box(12, 20, d, hw - 6, 40, 0, M.fabric3);
    K.box(w - 26, 8, d - 20, 0, 40, 6, M.fabric);
  },

  coffee(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    if (v === 'roundwood') {
      K.cyl(hw, 4, hd, 0, 32, 0, M.wood, 48);
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) K.cyl(2.6, 32, 2.6, sx * hw * 0.48, 0, sz * hd * 0.48, M.wood, 12);
      K.cyl(hw * 0.68, 2, hd * 0.68, 0, 10, 0, M.wood, 40);
      decor(c, 0, 36, 0);
      return;
    }
    if (v === 'tripod') {
      K.cyl(hw, 3, hd, 0, 39, 0, M.white, 48);
      for (const a of [PI / 2, PI / 2 + 2.094, PI / 2 + 4.189]) K.leg(Math.cos(a) * hw * 0.6, Math.sin(a) * hd * 0.6, 39, 1.8, 1.1, M.wood, Math.cos(a) * 5, Math.sin(a) * 5);
      decor(c, 0, 42, 0);
      return;
    }
    if (v === 'block') {
      K.box(w - 14, 4, d - 14, 0, 0, 0, M.dark);
      K.rbox(w, 30, d, 6, 0, 4, 0, M.stone);
      decor(c, 0, 34, 0);
      return;
    }
    if (v === 'steel') {
      K.box(w, 4, d, 0, 38, 0, M.wood);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(3, 38, 3, sx * (hw - 2), 0, sz * (hd - 2), M.metal);
      for (const sz of [-1, 1]) K.box(w - 4, 3, 2, 0, 35, sz * (hd - 2), M.metal);
      K.box(w - 6, 1.5, d - 6, 0, 10, 0, M.metal);
      decor(c, 0, 42, 0);
      return;
    }
    if (v === 'drum') {
      K.cyl(hw * 0.62, 33, hd * 0.62, 0, 0, 0, M.brass, 40);
      K.cyl(hw, 4, hd, 0, 33, 0, M.marble, 48);
      decor(c, 0, 37, 0);
      return;
    }
    K.box(w, 4, d, 0, H - 4, 0, M.wood);
    K.box(w - 10, 2, d - 10, 0, 12, 0, M.wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(4, H - 4, 4, sx * (hw - 5), 0, sz * (hd - 5), M.metal);
  },

  table(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    if (v === 'slab') {
      K.box(w, 4, d, 0, 71, 0, M.wood);
      for (const sx of [-1, 1]) K.box(5, 71, d - 16, sx * (hw - 22), 0, 0, M.wood);
      K.box(w - 44, 5, 4, 0, 12, 0, M.wood);
      return;
    }
    if (v === 'oval') {
      K.cyl(hw, 3, hd, 0, 72, 0, M.white, 56);
      K.cyl(hw - 4, 3, hd - 4, 0, 69, 0, M.wood, 48);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * hw * 0.58, sz * hd * 0.5, 70, 2.3, 1.5, M.wood, sx * 4, sz * 3);
      return;
    }
    if (v === 'plinth') {
      K.box(w, 7, d, 0, 68, 0, M.wood);
      for (const sx of [-1, 1]) K.box(16, 68, d - 26, sx * (hw - 30), 0, 0, M.stone);
      return;
    }
    if (v === 'trestle') {
      K.box(w, 5, d, 0, 70, 0, M.wood);
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 16);
        for (const sz of [-1, 1]) K.box(4, 70, 4, x, 0, sz * (hd - 9), M.metal);
        K.box(4, 4, d - 14, x, 66, 0, M.metal);
        K.box(4, 4, d - 14, x, 3, 0, M.metal);
        K.rod([x, 7, -hd + 11], [x, 63, hd - 11], 1.1, M.metal);
      }
      K.box(w - 34, 4, 4, 0, 30, 0, M.metal);
      return;
    }
    if (v === 'pedestal') {
      K.rbox(w, 3.5, d, 1.5, 0, 71.5, 0, M.marble);
      const xs = w >= 150 ? [-w / 4.2, w / 4.2] : [0];
      for (const x of xs) {
        K.lathe([[0, 0], [22, 0], [22, 2.5], [9, 9], [6, 58], [17, 71.5], [0, 71.5]], x, 0, 0, M.woodDark, 36);
        K.cyl(22.5, 1.2, 22.5, x, 0, 0, M.brass, 36);
      }
      return;
    }
    K.box(w, 4, d, 0, H - 4, 0, M.wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(5, H - 4, 5, sx * (hw - 5.5), 0, sz * (hd - 5.5), M.woodDark);
  },

  chair(c) {
    const { K, M, w, d, hw, hd, v } = c;
    if (v === 'wishbone') {
      const rr = Math.max(14, hw - 6);
      for (const sx of [-1, 1]) {
        K.cyl(1.6, 43, 1.6, sx * (hw - 6), 0, hd - 6, M.wood, 10);
        K.rod([sx * (hw - 7), 0, -hd + 7], [sx * rr * 0.72, 70, -rr * 0.7], 1.7, M.wood, 10, 1.3);
        K.rod([0, 45, -hd + 8], [sx * rr * 0.42, 70, -rr * 0.9], 1.1, M.wood);
      }
      K.rbox(w - 8, 4, d - 10, 1.5, 0, 42, 1, M.cane);
      K.ring(rr, 1.5, PI * 1.25, 0, 70, 0, M.wood);
      return;
    }
    if (v === 'shell') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 13), sz * (hd - 13), 40, 1.4, 1.1, M.wood, sx * 5, sz * 5);
      K.rod([-hw + 9, 16, -hd + 9], [hw - 9, 16, hd - 9], 0.4, M.metal, 6);
      K.rod([hw - 9, 16, -hd + 9], [-hw + 9, 16, hd - 9], 0.4, M.metal, 6);
      K.rbox(w - 6, 5, d - 10, 2.5, 0, 40, 2, M.white);
      const rr = hw - 3;
      K.arcSlab(rr - 2.5, rr, -PI + 0.4, -0.4, 43, 35, 0, 3, M.white);
      return;
    }
    if (v === 'jeanneret') {
      for (const sx of [-1, 1]) {
        const x = sx * (hw - 4);
        K.rod([x, 0, hd - 4], [x, 43, -hd + 12], 2.1, M.woodDark);
        K.rod([x, 0, -hd + 4], [x, 43, hd - 10], 2.1, M.woodDark);
        K.rod([x, 43, -hd + 12], [x, 82, -hd + 6], 2, M.woodDark);
        K.rod([x, 62, -hd + 8], [x, 62, hd - 6], 1.8, M.woodDark);
        K.rod([x, 43, hd - 10], [x, 62, hd - 6], 1.8, M.woodDark);
      }
      K.box(w - 10, 3, d - 14, 0, 42, 2, M.cane);
      K.box(w - 10, 26, 2.5, 0, 52, -hd + 9, M.cane).rotation.x = -0.18;
      return;
    }
    if (v === 'tolix') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 9), sz * (hd - 9), 44, 1.5, 1.5, M.metal, sx * 5, sz * 5);
      K.box(w - 10, 2, d - 10, 0, 44, 2, M.metal);
      K.arcSlab(hw - 7, hw - 6, -PI + 0.5, -0.5, 46, 32, 0, 4, M.metal);
      return;
    }
    if (v === 'velvet') {
      for (const sx of [-1, 1]) {
        K.cyl(1.3, 38, 1.3, sx * (hw - 6), 0, hd - 6, M.brass, 10);
        K.leg(sx * (hw - 6), -hd + 7, 38, 1.3, 1.1, M.brass, 0, -4);
      }
      K.rbox(w - 4, 10, d - 6, 3, 0, 38, 1, M.sofa);
      K.arcSlab(hw - 9, hw - 2, -PI + 0.3, -0.3, 44, 42, 0, 5, M.sofa);
      return;
    }
    K.box(w - 8, 5, d - 8, 0, 43, 0, M.wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(3.5, 43, 3.5, sx * (hw - 5.75), 0, sz * (hd - 5.75), M.woodDark);
    K.box(w - 8, 40, 3, 0, 48, -hd + 5.5, M.wood);
  },

  desk(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    const lamp = () => tableLamp(c, hw - 16, 75, -hd + 14);
    if (v === 'oak') {
      K.box(w, 3, d, 0, 72, 0, M.wood);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(3.5, 72, 3.5, sx * (hw - 4), 0, sz * (hd - 4), M.wood);
      K.box(w * 0.38, 10, d - 8, hw - w * 0.19 - 5, 62, 0, M.wood);
      K.box(w * 0.38 - 2, 0.6, 0.5, hw - w * 0.19 - 5, 66, hd - 3.8, M.woodDark);
      lamp(); books(c, -hw + 4, -hw + 30, 75, 20, -hd + 12, 22);
      return;
    }
    if (v === 'white') {
      K.box(w, 3, d, 0, 72, 0, M.white);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 7), sz * (hd - 7), 72, 1.9, 1.3, M.wood, sx * 3, sz * 2);
      K.box(w * 0.45, 9, d - 10, 0, 63, -1, M.white);
      lamp();
      return;
    }
    if (v === 'slab') {
      K.box(w, 5, d, 0, 70, 0, M.wood);
      K.box(38, 70, d - 4, -hw + 19, 0, 0, M.plaster);
      K.box(5, 70, d - 4, hw - 2.5, 0, 0, M.wood);
      lamp();
      return;
    }
    if (v === 'hairpin') {
      K.box(w, 4, d, 0, 71, 0, M.wood);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const x = sx * (hw - 6), z = sz * (hd - 7);
        K.rod([x, 71, z - 6], [x, 0, z], 0.8, M.metal, 6);
        K.rod([x, 71, z + 6], [x, 0, z], 0.8, M.metal, 6);
      }
      lamp(); books(c, -hw + 4, -hw + 34, 75, 20, -hd + 12, 22);
      return;
    }
    if (v === 'brass') {
      K.box(w, 3.5, d, 0, 71.5, 0, M.wood);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 5), sz * (hd - 5), 71.5, 1.3, 1, M.brass, 0, 0);
      K.box(w * 0.5, 0.5, d * 0.5, 0, 75, 3, M.leather);
      lamp();
      return;
    }
    K.box(w, 4, d, 0, H - 4, 0, M.woodLight);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(5, H - 4, 5, sx * (hw - 5.5), 0, sz * (hd - 5.5), M.woodDark);
  },

  nightstand(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    const r = Math.min(hw, hd);
    let top = H;
    if (v === 'cube') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(3, 6, 3, sx * (hw - 3), 0, sz * (hd - 3), M.wood);
      K.box(w, H - 6, d, 0, 6, 0, M.wood);
      K.box(w - 6, (H - 6) * 0.36, 0.6, 0, 6 + (H - 6) * 0.52, hd + 0.3, M.woodDark);
    } else if (v === 'roundleg') {
      K.cyl(r, 2.5, r, 0, H - 2.5, 0, M.white, 36);
      K.cyl(r * 0.85, 2, r * 0.85, 0, H * 0.38, 0, M.white, 36);
      for (const a of [PI / 2, PI / 2 + 2.094, PI / 2 + 4.189]) K.leg(Math.cos(a) * r * 0.6, Math.sin(a) * r * 0.6, H - 2.5, 1.5, 1, M.wood, Math.cos(a) * 3, Math.sin(a) * 3);
    } else if (v === 'stone') {
      K.lathe([[0, 0], [r * 0.85, 0], [r * 0.9, H * 0.15], [r * 0.82, H * 0.9], [r * 0.9, H - 1], [0, H - 1]], 0, 0, 0, M.stone, 36);
    } else if (v === 'crate') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(2.2, H, 2.2, sx * (hw - 1.1), 0, sz * (hd - 1.1), M.metal);
      K.box(w - 2, 2.5, d - 2, 0, 12, 0, M.wood);
      K.box(w - 2, 2.5, d - 2, 0, H - 2.5, 0, M.wood);
      K.box(w - 6, 14, d - 6, 0, 14.5, 0, M.woodDark);
    } else if (v === 'marble') {
      K.cyl(r * 0.92, 2, r * 0.92, 0, 0, 0, M.brass, 36);
      K.cyl(r * 0.88, H - 5, r * 0.88, 0, 2, 0, M.woodDark, 36);
      K.cyl(r, 3, r, 0, H - 3, 0, M.marble, 36);
    } else {
      K.box(w, H, d, 0, 0, 0, M.woodLight);
      top = H;
    }
    if (c.it.lamp !== false) tableLamp(c, 0, top, -1);
  },

  wardrobe: cabinetBuilder,
  cabinet: cabinetBuilder,

  tv(c) {
    const { K, M, w, d, hw, hd, v } = c;
    const screen = (y) => {
      const sw = Math.min(w * 0.85, 140);
      K.box(sw, 74, 4, 0, y, -hd + 3, M.black);
      K.box(sw - 3, 71, 0.4, 0, y + 1.5, -hd + 5.1, M.screen);
    };
    if (v === 'slat') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(3, 10, 3, sx * (hw - 4), 0, sz * (hd - 4), M.wood);
      K.box(w, 32, d, 0, 10, 0, M.wood);
      for (let x = -hw + 3; x < hw - 2; x += 4) K.box(1.6, 28, 1.2, x + 0.8, 12, hd + 0.6, M.woodLight);
      screen(78); decor(c, -hw * 0.6, 42, 0);
      return;
    }
    if (v === 'whiteleg') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 8), sz * (hd - 7), 16, 1.6, 1.1, M.wood, sx * 2, sz * 2);
      K.box(w, 34, d, 0, 16, 0, M.white);
      for (const x of [-w / 6, w / 6]) K.box(0.6, 30, 0.5, x, 18, hd + 0.2, M.dark);
      screen(80); decor(c, hw * 0.55, 50, 0);
      return;
    }
    if (v === 'ledge') {
      K.box(w, 20, d, 0, 24, 0, M.plaster);
      screen(80); decor(c, -hw * 0.55, 44, 0);
      return;
    }
    if (v === 'pipe') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(1.4, 52, 1.4, sx * (hw - 3), 0, sz * (hd - 3), M.metal, 8);
      for (const y of [4, 24, 46]) K.box(w, 3, d, 0, y, 0, M.wood);
      books(c, -hw + 6, -hw + 50, 27, d * 0.8, 0, 18);
      screen(80);
      return;
    }
    if (v === 'fluted') {
      K.box(w - 4, 6, d - 4, 0, 0, 0, M.brass);
      K.box(w, 42, d - 1, 0, 6, -0.5, M.wood);
      for (let x = -hw + 2; x < hw - 1; x += 3.2) K.cyl(1.3, 40, 0.8, x + 1.6, 7, hd - 0.6, M.wood, 8);
      K.box(w + 1, 2.5, d + 1, 0, 48, 0, M.marble);
      screen(80); decor(c, -hw * 0.6, 50.5, 0);
      return;
    }
    K.box(w, 45, d, 0, 0, 0, M.woodDark);
    K.box(Math.min(w * 0.85, 140), 70, 5, 0, 60, -hd + 8, M.black);
    K.box(20, 15, 12, 0, 45, -hd + 8, M.dark);
  },

  lamp(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    if (v === 'akari') {
      for (const a of [0, 2.094, 4.189]) K.rod([Math.cos(a) * 11, 0, Math.sin(a) * 11], [0, 36, 0], 0.5, M.metal, 6);
      K.cyl(0.5, 6, 0.5, 0, 36, 0, M.metal, 6);
      K.lathe([[0, 0], [11, 1], [16, 14], [17.5, 52], [16, 96], [11, 107], [0, 108]], 0, 40, 0, M.paper, 32);
      return;
    }
    if (v === 'tripod') {
      for (const a of [PI / 2, PI / 2 + 2.094, PI / 2 + 4.189]) K.rod([Math.cos(a) * hw * 0.85, 0, Math.sin(a) * hd * 0.85], [0, 118, 0], 1.2, M.wood, 8, 0.8);
      K.cone(17, 20, 28, 0, 112, 0, M.lampShade, 32, true);
      K.sphere(4, 4, 4, 0, 118, 0, M.paper, 10);
      return;
    }
    if (v === 'pleat') {
      K.lathe([[0, 0], [11, 0], [17, 10], [18, 24], [12, 38], [4, 46], [3, 50], [0, 50]], 0, 0, 0, M.plaster, 32);
      K.cyl(0.7, 74, 0.7, 0, 50, 0, M.brass, 8);
      K.lathe(pleatProfile(), 0, 118, 0, M.lampShade, 24);
      K.sphere(4, 4, 4, 0, 126, 0, M.paper, 10);
      return;
    }
    if (v === 'task') {
      K.cyl(14, 2, 14, 0, 0, 0, M.metal, 28);
      K.cyl(1.1, 148, 1.1, 0, 2, 0, M.metal, 8);
      K.rod([0, 150, 0], [0, 158, 28], 1.1, M.metal, 8);
      const sh = K.cone(4, 14, 16, 0, 140, 34, M.metal, 24, true);
      if (sh) sh.rotation.x = 0.35;
      K.sphere(4, 4, 4, 0, 143, 34, M.paper, 10);
      return;
    }
    if (v === 'arc') {
      const z0 = -hd + 13;
      K.box(26, 8, 26, 0, 0, z0, M.marble);
      K.tube([[0, 8, z0], [0, 120, z0 - 8], [0, 205, z0 + 40], [0, 190, z0 + 105], [0, 168, z0 + 120]], 1.2, M.brass, 48);
      K.dome(19, 0, 150, z0 + 120, M.brass);
      K.sphere(6, 6, 6, 0, 150, z0 + 120, M.paper, 12);
      return;
    }
    void w; void d;
    K.cyl(hw * 0.6, 3, hd * 0.6, 0, 0, 0, M.metal, 20);
    K.cyl(1.2, H - 35, 1.2, 0, 3, 0, M.metal, 8);
    K.cyl(hw * 0.75, 32, hd * 0.75, 0, H - 34, 0, M.lampShade, 24);
  },

  rug(c) {
    const { K, M, w, d, hw, hd, v } = c;
    if (v === 'organic') {
      const pts = [];
      const n = 40;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * PI * 2;
        const wob = 1 + 0.04 * Math.sin(a * 3 + 0.7) + 0.03 * Math.cos(a * 5);
        const cx = Math.cos(a), sz = Math.sin(a);
        const p = 3.2; // 超橢圓：介於圓角矩形與橢圓之間
        pts.push([Math.sign(cx) * Math.pow(Math.abs(cx), 2 / p) * hw * wob, Math.sign(sz) * Math.pow(Math.abs(sz), 2 / p) * hd * wob]);
      }
      const m = K.slabXZ(pts, 0, 1.4, M.rug);
      if (m) m.userData.noShadow = true;
      return;
    }
    const mat = v === 'plain' ? M.rug : rugMaterial(M, v);
    const m = K.box(w, 1.3, d, 0, 0, 0, mat);
    if (m) m.userData.noShadow = true;
  },

  shelf(c) {
    const { K, M, w, d, hw, hd, v, clipH, H } = c;
    const h = clipH(H);
    const shelvesAt = (step, from = 0) => { const ys = []; for (let y = from; y < h - 4; y += step) ys.push(y); return ys; };
    if (v === 'grid') {
      K.box(w, h, 2, 0, 0, -hd + 1, M.woodLight);
      for (const x of [-hw + 1.5, -w / 6, w / 6, hw - 1.5]) K.box(3, h, d, x, 0, 0, M.wood);
      for (const y of shelvesAt(40)) {
        K.box(w, 3, d, 0, y, 0, M.wood);
        if (y > 0) { books(c, -hw + 3, -w / 6 - 2, y + 3, d * 0.8, 0, 30); books(c, w / 6 + 2, hw - 3, y + 3, d * 0.8, 0, 30); }
      }
      if (h > 4) K.box(w, 3, d, 0, h - 3, 0, M.wood);
      return;
    }
    if (v === 'white') {
      for (const sx of [-1, 1]) K.box(2.5, h, d, sx * (hw - 1.25), 0, 0, M.white);
      for (const y of shelvesAt(36, 6)) { K.box(w - 5, 2.5, d, 0, y, 0, M.wood); books(c, -hw + 4, hw - 4, y + 2.5, d * 0.8, 0, 28); }
      return;
    }
    if (v === 'niche') {
      K.box(w, h, 4, 0, 0, -hd + 2, M.plaster);
      for (const sx of [-1, 1]) K.box(7, h, d, sx * (hw - 3.5), 0, 0, M.plaster);
      for (const y of shelvesAt(48)) {
        K.box(w, 6, d, 0, y, 0, M.plaster);
        if (y > 0) {
          K.lathe([[0, 0], [6, 0], [10, 8], [9, 18], [4, 24], [4.5, 28], [0, 28]], -hw + 22, y + 6, 0, M.pot, 20);
          K.sphere(7, 6, 7, 0, y + 12, 0, M.stone, 16);
          books(c, hw - 30, hw - 9, y + 6, d * 0.7, 0, 24);
        }
      }
      if (h > 6) K.box(w, 6, d, 0, h - 6, 0, M.plaster);
      return;
    }
    if (v === 'pipe') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(1.6, h, 1.6, sx * (hw - 3), 0, sz * (hd - 3), M.metal, 8);
      for (const y of shelvesAt(42, 4)) { K.box(w, 3.5, d, 0, y, 0, M.wood); books(c, -hw + 6, hw - 6, y + 3.5, d * 0.8, 0, 30); }
      return;
    }
    if (v === 'brassframe') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(1.6, h, 1.6, sx * (hw - 0.8), 0, sz * (hd - 0.8), M.brass);
      for (const y of shelvesAt(40, 2)) {
        K.box(w, 2, d, 0, y, 0, M.woodDark);
        if (y > 0) { books(c, -hw + 4, -6, y + 2, d * 0.8, 0, 28); K.lathe([[0, 0], [5, 0], [8, 10], [6, 20], [2, 24], [0, 24]], hw - 20, y + 2, 0, M.brass, 20); }
      }
      return;
    }
    K.box(w, h, 3, 0, 0, -hd + 1.5, M.woodLight);
    K.box(2.5, h, d, -hw + 1.25, 0, 0, M.woodLight);
    K.box(2.5, h, d, hw - 1.25, 0, 0, M.woodLight);
    for (let y = 0; y < h - 5; y += 38) {
      K.box(w, 2.5, d, 0, y, 0, M.woodLight);
      if (y > 0) for (let k = 0; k < Math.floor(w / 18); k++) if ((k * 7 + y) % 5 > 1) K.box(3 + (k % 3), 24 + (k % 4) * 3, d * 0.75, -hw + 8 + k * 16, y + 2.5, 0, [M.fabric2, M.fabric3, M.fabric][k % 3]);
    }
  },

  bench(c) {
    const { K, M, w, d, hw, hd, v, H } = c;
    if (v === 'slat') {
      for (const sx of [-1, 1]) K.box(4, H - 4, d - 4, sx * (hw - 8), 0, 0, M.wood);
      const n = Math.max(3, Math.round(d / 9));
      for (let i = 0; i < n; i++) K.box(w, 4, d / n - 1.2, 0, H - 4, -hd + (i + 0.5) * d / n, M.wood);
      return;
    }
    if (v === 'woodbench') {
      K.box(w, 4, d, 0, H - 4, 0, M.wood);
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 8), sz * (hd - 7), H - 4, 1.8, 1.3, M.wood, sx * 3, sz * 2);
      return;
    }
    if (v === 'stone') { K.rbox(w, H - 2, d, 3, 0, 0, 0, M.stone); return; }
    if (v === 'steel') {
      K.box(w, 4, d, 0, H - 4, 0, M.wood);
      for (const sx of [-1, 1]) { const x = sx * (hw - 6); K.box(3, H - 4, 3, x, 0, -hd + 3, M.metal); K.box(3, H - 4, 3, x, 0, hd - 3, M.metal); K.box(3, 3, d - 2, x, 0, 0, M.metal); }
      return;
    }
    if (v === 'velvet') {
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.cyl(1.4, H - 14, 1.4, sx * (hw - 6), 0, sz * (hd - 6), M.brass, 10);
      K.rbox(w, 14, d, 4, 0, H - 14, 0, M.sofa);
      return;
    }
    K.box(w, 5, d, 0, H - 5, 0, M.wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(4, H - 5, 4, sx * (hw - 6), 0, sz * (hd - 6), M.metal);
  },

  plant(c) {
    const { K, M, hw, hd, v, H, rand } = c;
    const r = Math.min(hw, hd);
    if (v === 'olive') {
      K.lathe([[0, 0], [r * 0.6, 0], [r * 0.75, 4], [r * 0.8, 28], [r * 0.7, 32], [0, 32]], 0, 0, 0, M.pot, 28);
      K.rod([0, 30, 0], [2, H * 0.62, 1], 1.8, M.woodDark, 8, 1.2);
      for (let i = 0; i < 9; i++) {
        const a = rand() * PI * 2, rr = 6 + rand() * r * 0.6;
        K.sphere(9 + rand() * 6, 7 + rand() * 4, 9 + rand() * 6, Math.cos(a) * rr, H * 0.66 + rand() * H * 0.28, Math.sin(a) * rr, M.plant, 10);
      }
      return;
    }
    if (v === 'fig') {
      K.cyl(r * 0.62, 30, r * 0.62, 0, 0, 0, M.pot, 28);
      K.rod([0, 28, 0], [1, H, 0], 1, M.woodDark, 6);
      for (let i = 0; i < 13; i++) {
        const y = 45 + (i / 13) * (H - 45), a = i * 2.4;
        const leaf = K.sphere(11, 1.4, 8, Math.cos(a) * 9, y, Math.sin(a) * 9, M.plant, 12);
        leaf.rotation.set(0.5 * Math.sin(a), -a, 0.6);
      }
      return;
    }
    if (v === 'branch') {
      K.lathe([[0, 0], [r * 0.45, 0], [r * 0.85, 12], [r * 0.9, 26], [r * 0.6, 44], [r * 0.25, 54], [r * 0.3, 60], [0, 60]], 0, 0, 0, M.pot, 32);
      for (let i = 0; i < 4; i++) {
        const a = rand() * PI * 2, top = [Math.cos(a) * (12 + rand() * 18), H + 10 + rand() * 30, Math.sin(a) * (12 + rand() * 18)];
        K.rod([0, 56, 0], top, 0.7, M.woodDark, 5, 0.3);
        for (let k = 0; k < 6; k++) { const t = 0.4 + k * 0.1; K.sphere(2.6, 1.2, 2, top[0] * t + (rand() - 0.5) * 6, 56 + (top[1] - 56) * t, top[2] * t + (rand() - 0.5) * 6, M.plant, 6); }
      }
      return;
    }
    if (v === 'monstera') {
      K.cyl(r * 0.72, 32, r * 0.72, 0, 0, 0, M.pot, 28);
      for (let i = 0; i < 8; i++) {
        const a = i * 0.785 + rand() * 0.3, rr = 14 + rand() * 16, y = 52 + rand() * (H - 60);
        const p = [Math.cos(a) * rr, y, Math.sin(a) * rr];
        K.rod([0, 30, 0], p, 0.6, M.plant, 5);
        const leaf = K.sphere(15, 1.3, 12, p[0], p[1], p[2], M.plant, 14);
        leaf.rotation.set(0.3, -a, 0.45);
      }
      return;
    }
    if (v === 'palm') {
      K.cyl(r * 0.7, 36, r * 0.7, 0, 0, 0, M.pot, 28);
      for (let i = 0; i < 7; i++) {
        const a = i * 0.9 + rand() * 0.3, rr = 6 + rand() * 12, top = H - 30 + rand() * 40;
        const p = [Math.cos(a) * rr, top, Math.sin(a) * rr];
        K.rod([0, 34, 0], p, 0.7, M.plant, 5);
        const leaf = K.sphere(4, 26, 1.4, p[0] + Math.cos(a) * 3, p[1] + 20, p[2] + Math.sin(a) * 3, M.plant, 12);
        leaf.rotation.set(0, -a + PI / 2, 0.25);
      }
      return;
    }
    K.cyl(hw * 0.7, 35, hd * 0.7, 0, 0, 0, M.pot);
    K.sphere(hw, (H - 35) / 2, hd, 0, 35 + (H - 35) / 2, 0, M.plant, 20);
  },

  counter(c) {
    const { K, M, w, d, hw, hd, it, S, cut } = c;
    const handle = S.furn?.handle || 'none';
    K.box(w, 74, d - 3, 0, 8, -1.5, M.kitchenFront);
    K.box(w, 8, d - 8, 0, 0, -4, M.dark);
    K.box(w, 4, d, 0, 82, 0, M.counterTop);
    const doors = Math.max(1, Math.round(w / 45));
    for (let i = 1; i < doors; i++) K.box(0.6, 72, 0.4, -hw + (i * w) / doors, 9, hd - 1.3, M.dark);
    for (let i = 0; i < doors; i++) {
      const x = -hw + ((i + 0.5) * w) / doors;
      if (handle === 'knob') K.sphere(1.6, 1.6, 1.4, x, 72, hd - 1, M.wood, 10);
      else if (handle === 'bar') K.box(14, 1.2, 1.6, x, 72, hd - 0.5, M.metal);
      else if (handle === 'brass') K.box(Math.min(30, w / doors - 10), 1, 1.4, x, 74, hd - 0.4, M.brass);
    }
    if (handle === 'groove') K.box(w, 1.2, 0.5, 0, 78, hd - 1.2, M.dark);
    if (it.top === 'sink') { K.box(Math.min(w - 16, 60), 1, d - 22, 0, 86.2, 2, M.stainless); K.rod([0, 86, -hd + 8], [0, 112, -hd + 10], 1, M.stainless); K.rod([0, 112, -hd + 10], [0, 108, -hd + 22], 1, M.stainless); }
    if (it.top === 'stove') {
      K.box(Math.min(w - 10, 76), 1, d - 16, 0, 86, 0, M.black);
      for (const k of [-1, 1]) K.cyl(9, 2, 9, k * Math.min(w, 76) * 0.24, 86.5, 0, M.dark, 18);
    }
    // 上櫃／抽油煙機（背牆有窗就不做上櫃）
    if (it.upper === false || backWindow(c)) return;
    const top = Math.min(cut ?? Infinity, 225);
    if (top <= 152) return;
    if (it.top === 'stove') {
      const hw2 = Math.min(w, 80);
      K.box(hw2, Math.min(14, top - 152), 50, 0, 152, -hd + 25, S.furn?.handle === 'brass' ? M.brass : M.stainless);
      if (top > 166) K.box(32, top - 166, 24, 0, 166, -hd + 12, M.kitchenFront);
      return;
    }
    K.box(w, top - 152, 34, 0, 152, -hd + 17, M.kitchenFront);
    for (let i = 1; i < doors; i++) K.box(0.6, top - 154, 0.4, -hw + (i * w) / doors, 153, -hd + 34.2, M.dark);
  },

  island(c) {
    const { K, M, w, d, hw, hd, S } = c;
    K.box(w, 78, d - 26, 0, 8, -13, M.kitchenFront);
    K.box(w - 4, 8, d - 32, 0, 0, -13, M.dark);
    if (S.counterTex === 'marble') {
      K.box(w + 4, 4, d, 0, 86, 0, M.counterTop);
      for (const sx of [-1, 1]) K.box(4, 86, d, sx * (hw + 2), 0, 0, M.counterTop);
    } else K.box(w + 4, 4, d, 0, 86, 0, M.counterTop);
    const n = Math.max(1, Math.floor(w / 55));
    for (let i = 0; i < n; i++) stool(c, -hw + (i + 0.5) * w / n, hd + 2);
  },

  stool(c) { stool(c, 0, 0); },

  fridge(c) {
    const { K, M, w, d, hw, hd, clipH, H, S } = c;
    const h = clipH(H);
    const steel = ['bar', 'brass'].includes(S.furn?.handle);
    K.box(w, h, d, 0, 0, 0, steel ? M.stainless : M.white);
    K.box(w - 2, 0.6, 0.6, 0, h * 0.62, hd + 0.3, M.dark);
    K.box(2, Math.min(40, h * 0.25), 3, hw - 8, h * 0.68, hd + 1.5, steel ? M.dark : M.stainless);
  },

  tatami(c) {
    const { K, M, w, d, hw, hd, H } = c;
    const ph = H < 15 ? 1 : Math.max(10, H - 4);
    K.box(w, ph, d, 0, 0, 0, M.woodLight);
    const lift = w >= d;
    const L = lift ? w : d, S2 = lift ? d : w;
    const n = Math.max(1, Math.round(L / 90));
    const mw = L / n;
    for (let i = 0; i < n; i++) {
      const a = -L / 2 + (i + 0.5) * mw;
      if (lift) K.box(mw - 0.8, 4, Math.min(S2, 182) - 0.8, a, ph, 0, M.tatami);
      else K.box(Math.min(S2, 182) - 0.8, 4, mw - 0.8, 0, ph, a, M.tatami);
    }
    const drawers = Math.max(1, Math.round(w / 90));
    for (let i = 0; i < drawers; i++) K.box(w / drawers - 6, 1, 0.5, -hw + (i + 0.5) * w / drawers, ph * 0.5, hd + 0.2, M.woodDark);
  },

  lowtable(c) {
    const { K, M, w, d, hw, hd, H } = c;
    K.box(w, 3.5, d, 0, H - 3.5, 0, M.wood);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(4, H - 3.5, 4, sx * (hw - 6), 0, sz * (hd - 6), M.wood);
    for (const sx of [-1, 1]) K.rbox(48, 6, 48, 3, sx * (hw + 10), 0, 0, M.fabric3);
  },

  altar(c) {
    const { K, M, w, d, hw, hd, v } = c;
    const backD = Math.min(d, 60), frontD = Math.max(30, d - backD - 4);
    const zb = -hd + backD / 2, zf = hd - frontD / 2;
    if (v === 'modern') {
      K.box(w, 92, backD, 0, 8, zb, M.wood);
      K.box(w - 6, 8, backD - 6, 0, 0, zb, M.dark);
      K.box(w * 0.42, 54, 32, 0, 100, -hd + 16, M.woodLight);
      K.box(w * 0.42 - 8, 46, 0.6, 0, 104, -hd + 32.2, M.paper);
      for (const sx of [-1, 1]) K.lathe([[0, 0], [4, 0], [4, 16], [3, 18], [0, 18]], sx * w * 0.32, 100, zb + 8, M.paper, 16);
      K.box(w * 0.8, 70, frontD, 0, 0, zf, M.wood);
      K.cyl(7, 8, 7, 0, 70, zf, M.brass, 24);
      return;
    }
    // 傳統：頂桌＋下桌，暗紅木雕
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(6, 104, 6, sx * (hw - 3), 0, zb + sz * (backD / 2 - 3), M.altarWood);
    K.box(w + 6, 5, backD + 4, 0, 104, zb, M.altarWood);
    K.box(w - 8, 22, 3, 0, 80, -hd + backD - 1.5, M.altarWood);
    K.box(w - 18, 14, 0.6, 0, 84, -hd + backD + 0.2, M.brass);
    K.box(w * 0.4, 62, 36, 0, 109, -hd + 18, M.altarWood);
    K.box(w * 0.4 - 10, 44, 0.6, 0, 114, -hd + 36.2, M.brass);
    for (const sx of [-1, 1]) { K.cyl(4, 16, 4, sx * w * 0.32, 109, zb + 10, M.redGlow, 16); K.sphere(5, 5, 5, sx * w * 0.32, 128, zb + 10, M.redGlow, 12); }
    const fw = w * 0.86;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(5, 82, 5, sx * (fw / 2 - 3), 0, zf + sz * (frontD / 2 - 3), M.altarWood);
    K.box(fw + 4, 4, frontD + 2, 0, 82, zf, M.altarWood);
    K.box(fw - 8, 16, 2, 0, 64, hd - 1, M.altarWood);
    K.cyl(8, 9, 8, 0, 86, zf, M.brass, 24);
    for (const sx of [-1, 1]) K.lathe([[0, 0], [3.5, 0], [5, 6], [3, 14], [2, 22], [0, 22]], sx * fw * 0.3, 86, zf, M.porcelain, 16);
  },

  // 以下沿用原本的設備造型
  toilet(c) {
    const { K, M, w, d, hd } = c;
    K.box(w, 36, d * 0.26, 0, 38, -hd + d * 0.13, M.porcelain);
    K.cyl(w * 0.42, 40, d * 0.34, 0, 0, -hd + d * 0.26 + d * 0.34, M.porcelain, 28);
    K.cyl(w * 0.44, 3, d * 0.36, 0, 40, -hd + d * 0.26 + d * 0.34, M.white, 28);
  },
  basin(c) {
    const { K, M, w, d, hd, S } = c;
    K.box(w, 78, d, 0, 0, 0, S.furn?.handle === 'brass' ? M.wood : M.kitchenFront);
    K.box(w + 2, 5, d + 2, 0, 78, 0, M.counterTop);
    K.cyl(w * 0.3, 2, d * 0.28, 0, 83, 2, M.water);
    const mirror = K.box(Math.min(w, 60), 75, 2, 0, 110, -hd + 1, M.mirror);
    if (mirror) mirror.userData.noShadow = true;
  },
  shower(c) {
    const { K, M, w, d, hd, clipH } = c;
    K.box(w, 4, d, 0, 0, 0, M.stone);
    if (clipH(195) > 20) {
      const gl = K.box(w, clipH(195) - 4, 1, 0, 4, hd - 0.5, M.glass);
      if (gl) gl.userData.noShadow = true;
    }
    K.cyl(8, 2, 8, 0, Math.min(190, clipH(190) - 3), -hd + 10, M.stainless);
  },
  bathtub(c) {
    const { K, M, w, d } = c;
    K.box(w, 50, d, 0, 0, 0, M.porcelain);
    K.box(w - 14, 2, d - 14, 0, 44, 0, M.water);
  },
  washer(c) {
    const { K, M, w, d, hd } = c;
    K.box(w, 88, d, 0, 0, 0, M.white);
    K.cyl(Math.min(w, d) * 0.33, 1, Math.min(w, d) * 0.33, 0, 88, 3, M.dark);
    K.box(w, 10, 8, 0, 88, -hd + 4, M.white);
  },
  laundry(c) {
    const { K, M, w, d, hw, hd } = c;
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.box(4, 60, 4, sx * (hw - 4), 0, sz * (hd - 4), M.stainless);
    K.box(w, 25, d, 0, 60, 0, M.stainless);
    K.box(w - 8, 1, d - 8, 0, 85.1, 0, M.water);
  },
  ac(c) {
    const { K, M, w, d, hd, H } = c;
    K.box(w, H, d, 0, 0, 0, M.white);
    K.box(w - 10, 3, 2, 0, 4, hd, M.dark);
  },
  acout(c) {
    const { K, M, w, d, hd, H } = c;
    K.box(w, H, d, 0, 0, 0, M.white);
    const fan = K.cyl(H * 0.34, 2, H * 0.34, w * 0.1, H / 2, hd, M.dark);
    if (fan) fan.rotation.x = Math.PI / 2;
  },
  ledge(c) {
    const { K, M, w, d, hd } = c;
    K.box(w, 10, d, 0, -10, 0, M.concrete);
    K.box(w, 12, 4, 0, 0, hd - 2, M.concrete);
  },
  duct(c) { c.K.box(c.w, c.clipH(c.H), c.d, 0, 0, 0, c.M.concrete); },
  column(c) { c.K.box(c.w, c.clipH(c.H), c.d, 0, 0, 0, c.M.concrete); },
  elevator(c) {
    const { K, M, w, d, hw, hd, clipH, H } = c;
    const h = clipH(Math.min(H, 240));
    K.box(w, 4, d, 0, 0, 0, M.steel);
    K.box(w, h, 3, 0, 0, -hd + 1.5, M.steel);
    K.box(3, h, d, -hw + 1.5, 0, 0, M.steel);
    K.box(3, h, d, hw - 1.5, 0, 0, M.steel);
    K.box(w * 0.3, 3, 1, 0, 95, -hd + 3, M.dark);
  },
  box(c) { c.K.box(c.w, c.H, c.d, 0, 0, 0, c.M.stone); },
  // 機車：車頭朝 +z（正面）
  scooter(c) {
    const { K, M, w, d, hd, rand } = c;
    const paint = [M.white, M.dark, M.fabric2, M.accent || M.fabric3][Math.floor(rand() * 4)];
    for (const z of [hd - 30, -hd + 30]) { const t = K.cyl(28, 9, 28, 0, 0, z, M.black, 20); if (t) { t.rotation.z = Math.PI / 2; t.position.set(0, 28, z); } }
    K.rbox(w * 0.55, 18, d * 0.48, 5, 0, 26, -10, paint);
    K.rbox(w * 0.5, 10, d * 0.36, 4, 0, 44, -22, M.black);
    K.rbox(w * 0.62, 62, 16, 6, 0, 22, hd - 42, paint);
    K.rod([0, 84, hd - 40], [0, 100, hd - 34], 2.4, M.metal);
    K.rod([-w * 0.42, 102, hd - 34], [w * 0.42, 102, hd - 34], 1.6, M.metal);
    K.sphere(7, 6, 4, 0, 92, hd - 30, M.porcelain, 12);
    K.box(w * 0.5, 4, 26, 0, 22, -hd + 34, M.metal);
  },
  // 曬衣架：兩端 A 字腳、三根橫桿
  rack(c) {
    const { K, M, hw, hd, H } = c;
    for (const x of [-hw + 3, hw - 3]) { K.rod([x, 0, -hd + 2], [x, H, 0], 1.4, M.stainless); K.rod([x, 0, hd - 2], [x, H, 0], 1.4, M.stainless); }
    for (const [y, z] of [[H, 0], [H - 30, -hd * 0.38], [H - 30, hd * 0.38]]) K.rod([-hw + 3, y, z], [hw - 3, y, z], 1.1, M.stainless);
    for (let x = -hw + 25; x < hw - 20; x += 32) K.box(26, 46, 1.5, x, H - 50, 0, [M.bedding, M.fabric2, M.throw, M.fabric3][Math.abs(Math.round(x)) % 4]);
  },
  tank(c) {
    const { K, M, w, d, H } = c;
    K.box(w, 24, d, 0, 0, 0, M.dark);
    K.cyl(w * 0.46, H - 34, d * 0.46, 0, 24, 0, M.stainless, 28);
    K.cone(w * 0.42, w * 0.47, 10, 0, H - 10, 0, M.stainless, 28);
  },
  stair(c) {
    const sg = stairGeometry(c.it);
    for (const s of sg.steps3d) c.K.box(s.x1 - s.x0, s.top, s.y1 - s.y0, (s.x0 + s.x1) / 2, 0, (s.y0 + s.y1) / 2, c.M.stone);
  },
};

function bedBuilder(c) {
  const { K, M, w, d, hw, hd, v } = c;
  if (v === 'platform') {
    K.box(w - 20, 5, d - 20, 0, 0, 0, M.woodDark);
    K.box(w, 14, d, 0, 5, 0, M.wood);
    K.box(w, 4, 5, 0, 57, -hd + 2.5, M.wood);
    for (let x = -hw + 3; x <= hw - 3; x += 8.5) K.box(3.2, 38, 2.6, x, 19, -hd + 2.5, M.woodLight);
    K.rbox(w - 14, 18, d - 18, 3, 0, 19, 4, M.bedding);
    K.rbox(w - 12, 5, d * 0.62, 2.4, 0, 35, hd - d * 0.31 - 6, M.fabric);
    pillows(c, 37, -hd + 8, M.bedding, { inset: 11 });
    K.box(w - 12, 2.5, 34, 0, 40, hd - 30, M.throw);
    return;
  }
  if (v === 'upholstered') {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) K.leg(sx * (hw - 7), sz * (hd - 7), 14, 2, 1.4, M.wood);
    K.rbox(w, 22, d - 6, 3, 0, 12, 3, M.sofa);
    K.rbox(w, 112, 10, 4, 0, 8, -hd + 5, M.sofa);
    const n = Math.max(3, Math.round(w / 45));
    for (let i = 0; i < n; i++) K.rbox(w / n - 1.5, 96, 6, 3, -hw + (i + 0.5) * w / n, 18, -hd + 12, M.sofa);
    K.rbox(w - 8, 18, d - 24, 4, 0, 34, 6, M.bedding);
    K.rbox(w - 4, 6, d * 0.6, 3, 0, 49, hd - d * 0.3 - 4, M.white);
    pillows(c, 52, -hd + 16, M.white);
    K.rbox(40, 30, 10, 5, 0, 54, -hd + 40, M.throw).rotation.x = -0.35;
    K.box(w - 2, 2, 38, 0, 55, hd - 26, M.throw);
    return;
  }
  if (v === 'floor') {
    K.box(w - 30, 7, d - 30, 0, 0, 0, M.dark);
    K.rbox(w, 16, d, 2, 0, 7, 0, M.wood);
    K.rbox(w, 62, 16, 4, 0, 7, -hd + 8, M.plaster);
    K.rbox(w - 12, 20, d - 30, 7, 0, 23, 7, M.bedding);
    K.rbox(w - 6, 8, d * 0.64, 6, 0, 38, hd - d * 0.32 - 4, M.fabric).rotation.y = 0.02;
    K.rbox(w - 10, 6, 24, 5, 0, 43, -hd + d * 0.36, M.fabric);
    pillows(c, 40, -hd + 18, M.bedding, { h: 15, depth: 36, r: 7, inset: 10 });
    return;
  }
  if (v === 'iron') {
    for (const sx of [-1, 1]) {
      const x = sx * (hw - 3);
      K.rod([x, 0, -hd + 3], [x, 106, -hd + 3], 2.4, M.metal);
      K.rod([x, 0, hd - 3], [x, 56, hd - 3], 2.4, M.metal);
      K.rod([x, 28, -hd + 3], [x, 28, hd - 3], 1.6, M.metal);
      K.sphere(3, 3, 3, x, 107, -hd + 3, M.metal, 10);
    }
    for (const y of [46, 78, 102]) K.rod([-hw + 3, y, -hd + 3], [hw - 3, y, -hd + 3], 1.5, M.metal);
    for (const y of [30, 52]) K.rod([-hw + 3, y, hd - 3], [hw - 3, y, hd - 3], 1.5, M.metal);
    for (const t of [-1 / 3, 1 / 3]) K.rod([t * w, 46, -hd + 3], [t * w, 102, -hd + 3], 1.2, M.metal);
    K.box(w - 8, 4, d - 8, 0, 26, 0, M.woodDark);
    K.rbox(w - 8, 20, d - 12, 3, 0, 30, 0, M.bedding);
    K.rbox(w - 4, 6, d * 0.6, 3, 0, 47, hd - d * 0.3 - 5, M.fabric2);
    pillows(c, 50, -hd + 8, M.bedding);
    K.box(w - 6, 2.5, 30, 0, 53, hd - 24, M.throw);
    return;
  }
  if (v === 'tufted') {
    K.box(w - 8, 6, d - 8, 0, 0, 0, M.brass);
    K.rbox(w, 28, d - 8, 3, 0, 6, 4, M.sofa);
    K.rbox(w + 12, 128, 16, 6, 0, 6, -hd + 8, M.sofa);
    for (let row = 0; row < 4; row++) for (let x = -hw + 10 + (row % 2) * 10; x < hw - 6; x += 20) K.sphere(1.6, 1.6, 1, x, 58 + row * 18, -hd + 16.2, M.dark, 8);
    K.rbox(w - 10, 20, d - 26, 4, 0, 34, 6, M.bedding);
    K.rbox(w - 6, 6, d * 0.6, 3, 0, 51, hd - d * 0.3 - 6, M.bedding);
    pillows(c, 54, -hd + 18, M.white);
    const n = c.it.kind === 'bed' ? 2 : 1;
    for (let i = 0; i < n; i++) K.rbox(38, 30, 10, 5, n === 1 ? 0 : (i ? 1 : -1) * w * 0.18, 57, -hd + 44, M.throw).rotation.x = -0.3;
    K.box(w + 2, 2.5, 42, 0, 56, hd - 34, M.throw);
    return;
  }
  K.box(w, 28, d, 0, 0, 0, M.woodLight);
  K.box(w - 4, 20, d - 6, 0, 28, 2, M.fabric);
  K.box(w, 90, 6, 0, 0, -hd + 3, M.wood);
  const n = c.it.kind === 'bed' ? 2 : 1;
  const pw = (w - 18) / n - (n > 1 ? 3 : 0);
  for (let i = 0; i < n; i++) K.box(pw, 10, 30, -hw + 9 + pw / 2 + i * (pw + 6), 48, -hd + 26, M.white);
  K.box(w - 2, 4, d * 0.6, 0, 47, hd - d * 0.3, M.fabric2);
}

function cabinetBuilder(c) {
  const { K, M, w, d, hw, hd, v, clipH, H, it } = c;
  const h = clipH(H);
  const doors = Math.max(1, Math.round(w / (it.kind === 'wardrobe' ? 50 : 45)));
  const dw = w / doors;
  const xi = (i) => -hw + (i + 0.5) * dw;
  if (v === 'grooved') {
    K.box(w, h, d - 2, 0, 0, -1, M.cabinet);
    K.box(w - 4, Math.min(6, h), d - 6, 0, 0, -3, M.dark);
    for (let i = 0; i < doors; i++) K.box(dw - 0.8, Math.max(0, h - 8), 1.5, xi(i), 7, hd - 0.75, M.woodLight);
    for (let i = 0; i < doors; i++) if (h > 40) K.box(1.2, Math.min(36, h * 0.22), 0.5, xi(i) + (i % 2 ? -1 : 1) * (dw / 2 - 4), h * 0.42, hd + 0.1, M.dark);
    return;
  }
  if (v === 'knob') {
    K.box(w, h, d, 0, 0, 0, M.cabinet);
    for (let i = 1; i < doors; i++) K.box(0.6, h - 8, 0.4, -hw + i * dw, 6, hd + 0.2, M.dark);
    for (let i = 0; i < doors; i++) if (h > 50) K.sphere(2.2, 2.2, 1.6, xi(i) + (i % 2 ? -1 : 1) * (dw / 2 - 5), Math.min(h - 10, h * 0.48), hd + 1.2, M.wood, 10);
    return;
  }
  if (v === 'plaster') {
    K.box(w, h, d, 0, 0, 0, M.plaster);
    for (let i = 1; i < doors; i++) K.box(1, h - 2, 0.4, -hw + i * dw, 1, hd + 0.2, M.dark);
    if (h > 12) K.box(w, 1, 0.4, 0, 8, hd + 0.2, M.dark);
    return;
  }
  if (v === 'steelglass') {
    K.box(w, h, d - 2, 0, 0, -1, M.woodDark);
    for (let i = 0; i < doors; i++) {
      const x = xi(i);
      K.box(dw - 6, Math.max(0, h - 14), 0.6, x, 8, hd - 0.4, M.glassDark);
      for (const y of [h * 0.34, h * 0.67]) if (y < h - 4) K.box(dw, 1.6, 1.4, x, y, hd, M.metal);
      K.box(1.6, Math.max(0, h - 4), 1.4, -hw + i * dw + 0.8, 2, hd, M.metal);
    }
    K.box(1.6, Math.max(0, h - 4), 1.4, hw - 0.8, 2, hd, M.metal);
    if (h > 4) { K.box(w, 2, 1.4, 0, 2, hd, M.metal); K.box(w, 2, 1.4, 0, h - 2, hd, M.metal); }
    return;
  }
  if (v === 'fluted') {
    K.box(w, h, d - 2, 0, 0, -1, M.wood);
    if (h > 12) for (let x = -hw + 1.6; x < hw - 1; x += 3.2) K.cyl(1.35, h - 10, 0.8, x, 8, hd - 1.4, M.wood, 8);
    for (let i = 0; i < doors; i++) if (h > 60) K.box(1.2, Math.min(h * 0.38, 70), 1.6, xi(i) + (i % 2 ? -1 : 1) * (dw / 2 - 4), h * 0.3, hd + 0.4, M.brass);
    return;
  }
  K.box(w, h, d, 0, 0, 0, M.cabinet);
  for (let i = 1; i < doors; i++) K.box(0.8, h - 10, 0.6, -hw + i * dw, 5, hd + 0.3, M.woodDark);
  if (it.kind === 'wardrobe') for (let i = 0; i < doors; i++) K.box(2, Math.min(40, h * 0.3), 2, xi(i) + (i % 2 ? -8 : 8), h * 0.45, hd + 1, M.dark);
  else if (h > 120) K.box(w, 1, 0.8, 0, Math.min(h - 2, 100), hd + 0.4, M.woodDark);
}

function stool(c, x, z) {
  const { K, M, S } = c;
  const fam = S.furn?.chair || 'basic';
  if (fam === 'tolix' || fam === 'velvet') {
    for (const a of [0.785, 2.356, 3.927, 5.498]) K.leg(x + Math.cos(a) * 12, z + Math.sin(a) * 12, 64, 1, 1, fam === 'velvet' ? M.brass : M.metal, Math.cos(a) * 4, Math.sin(a) * 4);
    K.cyl(17, 5, 17, x, 64, z, fam === 'velvet' ? M.sofa : M.metal, 24);
    return;
  }
  for (const a of [0.785, 2.356, 3.927, 5.498]) K.leg(x + Math.cos(a) * 11, z + Math.sin(a) * 11, 64, 1.4, 1.1, M.wood, Math.cos(a) * 4, Math.sin(a) * 4);
  K.cyl(16, 4, 16, x, 64, z, fam === 'shell' ? M.white : M.wood, 24);
}

function pleatProfile() {
  const p = [];
  for (let i = 0; i <= 10; i++) { const t = i / 10; p.push([22 - 12 * t + (i % 2 ? 0.8 : 0), t * 26]); }
  return p;
}

// 檯面後方是否有窗（有的話不做上櫃）
function backWindow(c) {
  const { it, plan } = c;
  if (!plan) return false;
  const r = (it.rot || 0) * PI / 180, cs = Math.cos(r), sn = Math.sin(r);
  // 本地 (0, -d/2) → 世界
  const bx = it.x - (-it.d / 2) * sn, by = it.y + (-it.d / 2) * cs;
  for (const o of plan.openings) {
    if (o.type !== 'window' && o.type !== 'sliding') continue;
    const e = openingEnds(plan, o);
    if (!e) continue;
    const pr = projectOnSegment({ x: bx, y: by }, e.a, e.b);
    if (pr.dist < e.wall.t / 2 + 12 && pr.t > -it.w / 2 / Math.max(1, o.w) && pr.t < 1 + it.w / 2 / Math.max(1, o.w)) return true;
  }
  return false;
}

// ---------- 地毯花紋材質（依款式快取在材質表裡） ----------
function rugMaterial(M, v) {
  M._rug ||= {};
  if (M._rug[v]) return M._rug[v];
  const base = '#' + M.rug.color.getHexString();
  const c = document.createElement('canvas');
  c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 512, 512);
  const dark = shade(base, -0.18), light = shade(base, 0.12);
  if (v === 'jute') {
    for (let y = 0; y < 512; y += 6) { g.fillStyle = y % 12 ? dark : light; g.globalAlpha = 0.35; g.fillRect(0, y, 512, 3); }
    g.globalAlpha = 1; g.strokeStyle = dark; g.lineWidth = 14; g.strokeRect(14, 14, 484, 484);
  } else if (v === 'stripe') {
    g.fillStyle = shade(base, -0.35);
    for (let x = 40; x < 512; x += 88) g.fillRect(x, 0, 10, 512);
    g.fillStyle = '#' + M.throw.color.getHexString();
    g.fillRect(250, 0, 6, 512);
  } else if (v === 'vintage') {
    g.fillStyle = shade(base, -0.25); g.fillRect(0, 0, 512, 512);
    g.strokeStyle = shade(base, 0.25); g.lineWidth = 10; g.strokeRect(24, 24, 464, 464); g.lineWidth = 3; g.strokeRect(44, 44, 424, 424);
    g.fillStyle = shade('#8a3b2a', 0); g.globalAlpha = 0.55;
    g.beginPath(); g.ellipse(256, 256, 120, 170, 0, 0, PI * 2); g.fill();
    g.fillStyle = shade(base, 0.2); g.globalAlpha = 0.6;
    g.beginPath(); g.ellipse(256, 256, 50, 80, 0, 0, PI * 2); g.fill();
    g.globalAlpha = 0.18; g.fillStyle = '#000';
    for (let i = 0; i < 400; i++) g.fillRect(Math.random() * 512, Math.random() * 512, 6, 2);
    g.globalAlpha = 1;
  } else if (v === 'border') {
    g.strokeStyle = '#' + M.brass.color.getHexString(); g.lineWidth = 8; g.strokeRect(30, 30, 452, 452);
    g.strokeStyle = shade(base, -0.2); g.lineWidth = 3; g.strokeRect(48, 48, 416, 416);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, map: t, roughness: 1 });
  M._rug[v] = mat;
  return mat;
}

function shade(hex, k) {
  const c = new THREE.Color(hex);
  if (k > 0) c.lerp(new THREE.Color(1, 1, 1), k); else c.multiplyScalar(1 + k);
  return '#' + c.getHexString();
}

// ---------- 吊燈（餐桌、中島上方，依風格） ----------
export function buildPendants(plan, it, M, cut) {
  const fam = STYLES[plan.style || 'basic']?.furn?.pendant || 'basic';
  const ceil = plan.wallHeight || 300;
  const g = new THREE.Group();
  const K = kit(g);
  const tableTop = it.kind === 'island' ? 90 : 75;
  const bottom = tableTop + 70;
  if ((cut ?? Infinity) < bottom + 6) return null;
  const top = Math.min(ceil, cut ?? Infinity);
  const multi = fam === 'dome' || fam === 'globe' || it.w >= 170 && fam !== 'drum';
  const xs = multi ? (fam === 'globe' ? [-it.w * 0.28, 0, it.w * 0.28] : [-it.w * 0.24, it.w * 0.24]) : [0];
  const cord = (x, y) => K.rod([x, y, 0], [x, top, 0], 0.35, M.black, 5);
  if (fam === 'globe') {
    K.box(it.w * 0.66, 1.6, 1.6, 0, bottom + 24, 0, M.brass);
    cord(0, bottom + 25);
    for (const x of xs) { K.rod([x, bottom + 24, 0], [x, bottom + 14, 0], 0.5, M.brass, 6); K.sphere(10, 10, 10, x, bottom + 6, 0, M.paper, 18); }
  } else {
    for (const x of xs) {
      if (fam === 'lantern') { K.sphere(24, 20, 24, x, bottom + 20, 0, M.paper, 24); cord(x, bottom + 40); }
      else if (fam === 'ph') {
        K.cone(5, 22, 7, x, bottom + 18, 0, M.white, 32, true); K.cone(5, 15, 6, x, bottom + 11, 0, M.white, 32, true); K.cone(3, 9, 5, x, bottom + 5, 0, M.white, 32, true);
        K.sphere(4, 4, 4, x, bottom + 10, 0, M.paper, 10); cord(x, bottom + 25);
      } else if (fam === 'drum') { K.cone(32, 32, 22, x, bottom + 4, 0, M.lampShade, 40, true); K.sphere(5, 5, 5, x, bottom + 14, 0, M.paper, 10); cord(x, bottom + 26); }
      else if (fam === 'dome') { K.dome(16, x, bottom + 6, 0, M.metal); K.sphere(4, 4, 4, x, bottom + 6, 0, M.paper, 10); cord(x, bottom + 22); }
      else { K.cone(4, 16, 18, x, bottom, 0, M.white, 28, true); K.sphere(4, 4, 4, x, bottom + 4, 0, M.paper, 10); cord(x, bottom + 18); }
    }
  }
  g.traverse((o) => { if (o.isMesh) { o.castShadow = false; o.userData.itemId = it.id; } });
  return g;
}

