// 檔案存取：下載、壓縮、底圖（圖片/PDF）、向量 PDF 線條擷取。

// 在 Claude Artifact 檢視器裡改走 downloads 能力（它只接受部分副檔名，其餘包成 zip）
const ARTIFACT_OK = /\.(png|jpg|jpeg|webp|gif|svg|json|txt|md|csv|html|pdf|zip)$/i;
let dlCap;
export async function downloadsCap() {
  if (dlCap !== undefined) return dlCap;
  dlCap = null;
  try { if (window.claude?.use) dlCap = await window.claude.use('downloads'); } catch { dlCap = null; }
  return dlCap;
}

export async function saveFile(filename, data, mime = 'application/octet-stream') {
  const cap = await downloadsCap();
  if (cap) {
    let name = filename, payload = data;
    if (!ARTIFACT_OK.test(filename)) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : new Uint8Array(data);
      payload = new Blob([makeZip([{ name: filename, data: bytes }])], { type: 'application/zip' });
      name = filename.replace(/\.[^.]+$/, '') + '.zip';
    }
    try {
      await cap.save({ filename: name, data: payload instanceof Blob || typeof payload === 'string' ? payload : new Blob([payload]) });
      return { ok: true, zipped: name !== filename, name };
    } catch (e) {
      if (e?.code === 'declined') return { ok: false, declined: true };
      if (!['unavailable', 'not_granted', 'capability_disabled', 'capability_removed'].includes(e?.code)) return { ok: false, error: e?.message || String(e) };
    }
  }
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { ok: true, name: filename };
}

// ---- 最小 ZIP（不壓縮）----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b) { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = f.data instanceof Uint8Array ? f.data : enc.encode(String(f.data));
    const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cSize = central.reduce((s, c) => s + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

// ---- 讀檔 ----
export const readAsText = (file) => file.text();
export const readAsBuffer = (file) => file.arrayBuffer();
export function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}

// 圖片縮到最長邊 maxPx，回傳 dataURL 與尺寸
export async function imageToUnderlay(src, maxPx = 2400) {
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('無法讀取圖片')); i.src = src; });
  const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  return { src: c.toDataURL('image/jpeg', 0.85), w, h };
}

// ---- PDF ----
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  const base = new URL('../vendor/pdfjs/', import.meta.url);
  pdfjs = await import(new URL('pdf.min.mjs', base).href);
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
  return pdfjs;
}

export async function openPdf(buffer) {
  const lib = await loadPdfJs();
  const cMapUrl = new URL('../vendor/pdfjs/cmaps/', import.meta.url).href;
  return lib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, cMapUrl, cMapPacked: true }).promise;
}

export async function renderPdfPage(doc, pageNo, maxPx = 2400) {
  const page = await doc.getPage(pageNo);
  const vp1 = page.getViewport({ scale: 1 });
  const scale = Math.min(4, maxPx / Math.max(vp1.width, vp1.height));
  const vp = page.getViewport({ scale });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width); c.height = Math.round(vp.height);
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: g, viewport: vp }).promise;
  return { src: c.toDataURL('image/jpeg', 0.85), w: c.width, h: c.height, pageW: vp1.width, pageH: vp1.height, pxPerPt: scale };
}

// 擷取向量線條（單位：pt，y 向上），供牆體辨識
export async function extractPdfVectors(doc, pageNo) {
  const lib = await loadPdfJs();
  const OPS = lib.OPS;
  const page = await doc.getPage(pageNo);
  const ops = await page.getOperatorList();
  const segs = [], arcs = [], closed = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  const stack = [];
  const mulM = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const ap = (x, y) => ({ x: ctm[0] * x + ctm[2] * y + ctm[4], y: ctm[1] * x + ctm[3] * y + ctm[5] });
  const width = () => lw * Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) || 0.1;
  // 封閉的小矩形（家具、設備）要標記，避免被當成牆
  const markRect = (pts, list) => {
    if (pts.length !== 4) return;
    const e1 = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y }, e2 = { x: pts[2].x - pts[1].x, y: pts[2].y - pts[1].y };
    const L1 = Math.hypot(e1.x, e1.y), L2 = Math.hypot(e2.x, e2.y);
    if (!L1 || !L2 || Math.abs(e1.x * e2.x + e1.y * e2.y) > 0.05 * L1 * L2) return;
    const rect = { min: Math.min(L1, L2), max: Math.max(L1, L2) };
    list.forEach((sg) => (sg.rect = rect));
    closed.push({ pts, layer: 'pdf' });
  };
  // 路徑在繪製（stroke/fill）時才確定筆寬；只做裁切（endPath）的路徑丟掉
  let pending = [];
  const STROKE = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const FILL = new Set([OPS.fill, OPS.eoFill]);
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (STROKE.has(fn) || FILL.has(fn)) { const w = width(); for (const sg of pending) { sg.w = w; if (FILL.has(fn)) sg.fill = true; } pending = []; continue; }
    if (fn === OPS.endPath) { const drop = new Set(pending); for (let k = segs.length - 1; k >= 0 && drop.size; k--) if (drop.has(segs[k])) { drop.delete(segs[k]); segs.splice(k, 1); } pending = []; continue; }
    if (fn === OPS.save) stack.push([ctm.slice(), lw]);
    else if (fn === OPS.restore) { const st = stack.pop(); if (st) [ctm, lw] = st; }
    else if (fn === OPS.transform) ctm = mulM(ctm, args);
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.paintFormXObjectBegin) { stack.push([ctm.slice(), lw]); if (args?.[0]) ctm = mulM(ctm, args[0]); }
    else if (fn === OPS.paintFormXObjectEnd) { const st = stack.pop(); if (st) [ctm, lw] = st; }
    else if (fn === OPS.constructPath) {
      const [sub, a] = args;
      let j = 0, cur = null, start = null;
      let poly = [], polySegs = [];
      const w = width();
      const add = (p, q) => { const sg = { a: p, b: q, layer: 'pdf', w }; segs.push(sg); polySegs.push(sg); pending.push(sg); };
      const endSub = () => {
        if (poly.length === 5 && Math.hypot(poly[4].x - poly[0].x, poly[4].y - poly[0].y) < 0.01) markRect(poly.slice(0, 4), polySegs);
      };
      for (const op of sub) {
        if (op === OPS.moveTo) { endSub(); cur = ap(a[j], a[j + 1]); start = cur; poly = [cur]; polySegs = []; j += 2; }
        else if (op === OPS.lineTo) { const p = ap(a[j], a[j + 1]); j += 2; if (cur) add(cur, p); cur = p; poly.push(p); }
        else if (op === OPS.curveTo) {
          const p1 = ap(a[j], a[j + 1]), p2 = ap(a[j + 2], a[j + 3]), p3 = ap(a[j + 4], a[j + 5]); j += 6;
          if (cur) { const arc = bezierToArc(cur, p1, p2, p3); if (arc) arcs.push(arc); }
          cur = p3; poly = [];
        } else if (op === OPS.curveTo2 || op === OPS.curveTo3) { const p = ap(a[j + 2], a[j + 3]); j += 4; cur = p; poly = []; }
        else if (op === OPS.rectangle) {
          const x = a[j], y = a[j + 1], rw = a[j + 2], rh = a[j + 3]; j += 4;
          const q = [ap(x, y), ap(x + rw, y), ap(x + rw, y + rh), ap(x, y + rh)];
          polySegs = [];
          for (let k = 0; k < 4; k++) add(q[k], q[(k + 1) % 4]);
          markRect(q, polySegs);
          cur = q[0]; start = q[0]; poly = [];
        } else if (op === OPS.closePath) {
          if (cur && start) add(cur, start);
          if (poly.length === 5 && Math.hypot(poly[4].x - poly[0].x, poly[4].y - poly[0].y) < 0.01) poly.pop();
          markRect(poly, polySegs);
          cur = start; poly = [];
        }
      }
      endSub();
    }
  }
  const tc = await page.getTextContent();
  const texts = tc.items.filter((t) => t.str && t.str.trim()).map((t) => ({ p: { x: t.transform[4], y: t.transform[5] }, h: Math.hypot(t.transform[2], t.transform[3]), text: t.str.trim(), layer: 'pdf' }));
  return { segs, arcs, texts, inserts: [], closed, pdf: true };
}

// 四分之一圓的 Bezier → 圓弧（圓心取兩端點法線交點）
function bezierToArc(p0, p1, p2, p3) {
  const t0 = { x: p1.x - p0.x, y: p1.y - p0.y }, t1 = { x: p3.x - p2.x, y: p3.y - p2.y };
  const n0 = { x: -t0.y, y: t0.x }, n1 = { x: -t1.y, y: t1.x };
  const cross = n0.x * n1.y - n0.y * n1.x;
  if (Math.abs(cross) < 1e-9) return null;
  const d = { x: p3.x - p0.x, y: p3.y - p0.y };
  const s = (d.x * n1.y - d.y * n1.x) / cross;
  const c = { x: p0.x + n0.x * s, y: p0.y + n0.y * s };
  const r0 = Math.hypot(p0.x - c.x, p0.y - c.y), r1 = Math.hypot(p3.x - c.x, p3.y - c.y);
  if (!r0 || Math.abs(r0 - r1) / r0 > 0.08) return null;
  const pm = { x: 0.125 * p0.x + 0.375 * p1.x + 0.375 * p2.x + 0.125 * p3.x, y: 0.125 * p0.y + 0.375 * p1.y + 0.375 * p2.y + 0.125 * p3.y };
  return { c, r: (r0 + r1) / 2, p0, p1: p3, pm, layer: 'pdf' };
}
