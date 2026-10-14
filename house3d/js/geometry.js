// 房間自動偵測：把牆柵格化後從點擊處做 flood fill，再描出邊界多邊形。
import { projectOnSegment, polygonArea } from './model.js';

const CELL = 5; // cm

export function rasterizeWalls(walls, pad = 40) {
  if (!walls.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const w of walls) {
    minX = Math.min(minX, w.a.x, w.b.x); maxX = Math.max(maxX, w.a.x, w.b.x);
    minY = Math.min(minY, w.a.y, w.b.y); maxY = Math.max(maxY, w.a.y, w.b.y);
  }
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const nx = Math.ceil((maxX - minX) / CELL), ny = Math.ceil((maxY - minY) / CELL);
  const grid = new Uint8Array(nx * ny);
  for (const w of walls) {
    const r = w.t / 2 + CELL * 0.75;
    const x0 = Math.max(0, Math.floor((Math.min(w.a.x, w.b.x) - r - minX) / CELL));
    const x1 = Math.min(nx - 1, Math.ceil((Math.max(w.a.x, w.b.x) + r - minX) / CELL));
    const y0 = Math.max(0, Math.floor((Math.min(w.a.y, w.b.y) - r - minY) / CELL));
    const y1 = Math.min(ny - 1, Math.ceil((Math.max(w.a.y, w.b.y) + r - minY) / CELL));
    for (let j = y0; j <= y1; j++) {
      for (let i = x0; i <= x1; i++) {
        const p = { x: minX + (i + 0.5) * CELL, y: minY + (j + 0.5) * CELL };
        if (projectOnSegment(p, w.a, w.b).dist <= r) grid[j * nx + i] = 1;
      }
    }
  }
  return { grid, nx, ny, minX, minY };
}

export function floodRegion(r, seed) {
  const { grid, nx, ny, minX, minY } = r;
  const si = Math.floor((seed.x - minX) / CELL), sj = Math.floor((seed.y - minY) / CELL);
  if (si < 0 || sj < 0 || si >= nx || sj >= ny) return null;
  if (grid[sj * nx + si]) return null;
  const fill = new Uint8Array(nx * ny);
  const stack = [sj * nx + si];
  fill[stack[0]] = 1;
  let count = 0;
  while (stack.length) {
    const k = stack.pop();
    count++;
    const i = k % nx, j = (k - i) / nx;
    if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) return null; // 漏到外面
    for (const nk of [k - 1, k + 1, k - nx, k + nx]) {
      if (!grid[nk] && !fill[nk]) { fill[nk] = 1; stack.push(nk); }
    }
  }
  return { fill, count };
}

// 由填色格子描出外輪廓（沿格線），回傳 cm 座標多邊形
export function traceRegion(r, fill) {
  const { nx, ny, minX, minY } = r;
  const edges = new Map();
  const key = (i, j) => i + ',' + j;
  const put = (k, v) => { const l = edges.get(k); if (l) l.push(v); else edges.set(k, [v]); };
  const at = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && fill[j * nx + i];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      if (!fill[j * nx + i]) continue;
      // 每格四邊依螢幕順時針方向加入（只加與非區域相鄰的邊）
      if (!at(i, j - 1)) put(key(i, j), [i + 1, j]);
      if (!at(i + 1, j)) put(key(i + 1, j), [i + 1, j + 1]);
      if (!at(i, j + 1)) put(key(i + 1, j + 1), [i, j + 1]);
      if (!at(i - 1, j)) put(key(i, j + 1), [i, j]);
    }
  }
  const loops = [];
  while (edges.size) {
    const [startKey] = edges.keys();
    let [ci, cj] = startKey.split(',').map(Number);
    const loop = [];
    let guard = 0;
    while (guard++ < 200000) {
      const k = key(ci, cj);
      const list = edges.get(k);
      if (!list) break;
      const nxt = list.pop();
      if (!list.length) edges.delete(k);
      loop.push({ x: ci, y: cj });
      [ci, cj] = nxt;
      if (key(ci, cj) === startKey) break;
    }
    if (loop.length > 2) loops.push(loop);
  }
  if (!loops.length) return null;
  let best = loops[0], bestA = 0;
  for (const l of loops) { const a = polygonArea(l); if (a > bestA) { bestA = a; best = l; } }
  let pts = removeCollinear(best);
  pts = rdp(pts, 1.1);
  pts = removeCollinear(pts);
  return pts.map((p) => ({ x: Math.round((minX + p.x * CELL) * 10) / 10, y: Math.round((minY + p.y * CELL) * 10) / 10 }));
}

function removeCollinear(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(cross) > 1e-9) out.push(b);
  }
  return out;
}

export function rdp(pts, eps) {
  if (pts.length < 4) return pts;
  // 封閉多邊形：以最遠兩點切開
  let i0 = 0, i1 = 0, dmax = -1;
  for (let i = 0; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[0].x, pts[i].y - pts[0].y);
    if (d > dmax) { dmax = d; i1 = i; }
  }
  const a = pts.slice(i0, i1 + 1), b = pts.slice(i1).concat([pts[0]]);
  const sa = rdpOpen(a, eps), sb = rdpOpen(b, eps);
  return sa.slice(0, -1).concat(sb.slice(0, -1));
}

function rdpOpen(pts, eps) {
  if (pts.length < 3) return pts;
  const a = pts[0], b = pts[pts.length - 1];
  let idx = -1, dmax = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = projectOnSegment(pts[i], a, b).dist;
    if (d > dmax) { dmax = d; idx = i; }
  }
  if (dmax > eps) {
    const l = rdpOpen(pts.slice(0, idx + 1), eps), r = rdpOpen(pts.slice(idx), eps);
    return l.slice(0, -1).concat(r);
  }
  return [a, b];
}

export function detectRoom(walls, seed) {
  const r = rasterizeWalls(walls);
  if (!r) return null;
  const f = floodRegion(r, seed);
  if (!f) return null;
  return traceRegion(r, f.fill);
}

// 找出所有封閉區域（DXF 匯入用），回傳多邊形清單
export function detectAllRooms(walls, minArea = 1.2e4) {
  const r = rasterizeWalls(walls);
  if (!r) return [];
  const { grid, nx, ny, minX, minY } = r;
  const seen = new Uint8Array(nx * ny);
  const out = [];
  for (let j = 1; j < ny - 1; j++) {
    for (let i = 1; i < nx - 1; i++) {
      const k = j * nx + i;
      if (grid[k] || seen[k]) continue;
      const f = floodRegion(r, { x: minX + (i + 0.5) * CELL, y: minY + (j + 0.5) * CELL });
      // 標記已處理（含外部）
      const stack = [k]; seen[k] = 1;
      while (stack.length) {
        const c = stack.pop();
        for (const nk of [c - 1, c + 1, c - nx, c + nx]) {
          if (nk < 0 || nk >= nx * ny || grid[nk] || seen[nk]) continue;
          seen[nk] = 1; stack.push(nk);
        }
      }
      if (!f || f.count * CELL * CELL < minArea) continue;
      const pts = traceRegion(r, f.fill);
      if (pts && pts.length >= 3) out.push(pts);
    }
  }
  return out;
}
