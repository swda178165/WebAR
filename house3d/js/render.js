// 擬真效果圖與 360° 環景：用 three-gpu-pathtracer 做光線追蹤（光從窗戶進來、在牆面和地板反彈），
// 環景用等距長方投影（2:1），可以在網頁裡轉著看、用手機陀螺儀看，也能下載成 Facebook／Google 相簿認得的 360 照片。
import * as THREE from 'three';
import { polygonCentroid, pointInPolygon, areaM2, openingEnds, wallFrame } from './model.js';
import { sunPosition, sunVector, latOf } from './site.js';
import { saveFile } from './files.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mobile = () => matchMedia('(max-width: 900px)').matches || matchMedia('(pointer: coarse)').matches;

// 時段：月份、太陽時、天空顏色、曝光
const TIMES = {
  morning: { name: '早上 9 點', hour: 9, month: 4 },
  noon: { name: '中午', hour: 12, month: 4 },
  afternoon: { name: '下午 3 點', hour: 15, month: 4 },
  night: { name: '晚上開燈', night: true },
};

function webgl2OK() {
  try { const c = document.createElement('canvas'); const gl = c.getContext('webgl2'); return !!(gl && gl.getExtension('EXT_color_buffer_float')); } catch { return false; }
}

// 天空：天頂偏藍、地平線亮、地面灰；晚上是深藍
async function makeSky(night) {
  const { ProceduralEquirectTexture } = await import('three-gpu-pathtracer');
  const tex = new ProceduralEquirectTexture(256, 128);
  const dir = new THREE.Vector3();
  const zen = new THREE.Color(night ? 0x0b1530 : 0x5d8fd0), hor = new THREE.Color(night ? 0x2a3550 : 0xe8eef2), gnd = new THREE.Color(night ? 0x0d0f12 : 0x8a8478);
  const k = night ? 0.05 : 1.35;
  tex.generationCallback = (polar, uv, coord, color) => {
    dir.setFromSpherical(polar);
    const y = dir.y;
    if (y >= 0) color.lerpColors(hor, zen, Math.pow(y, 0.55)); else color.lerpColors(hor, gnd, Math.min(1, -y * 4));
    color.multiplyScalar(k);
  };
  tex.update();
  return tex;
}

// 以 JPEG 輸出，並加上 GPano XMP（360 照片）
async function jpegBlob(canvas, pano) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!pano) return blob;
  const buf = new Uint8Array(await blob.arrayBuffer());
  const W = canvas.width, H = canvas.height;
  const xmp = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/" GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True" GPano:CroppedAreaImageWidthPixels="${W}" GPano:CroppedAreaImageHeightPixels="${H}" GPano:FullPanoWidthPixels="${W}" GPano:FullPanoHeightPixels="${H}" GPano:CroppedAreaLeftPixels="0" GPano:CroppedAreaTopPixels="0"/></rdf:RDF></x:xmpmeta>`;
  const head = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0');
  const body = new TextEncoder().encode(xmp);
  const len = 2 + head.length + body.length;
  const seg = new Uint8Array(2 + len);
  seg[0] = 0xff; seg[1] = 0xe1; seg[2] = len >> 8; seg[3] = len & 0xff;
  seg.set(head, 4); seg.set(body, 4 + head.length);
  const out = new Uint8Array(buf.length + seg.length);
  out.set(buf.subarray(0, 2), 0);
  out.set(seg, 2);
  out.set(buf.subarray(2), 2 + seg.length);
  return new Blob([out], { type: 'image/jpeg' });
}

// 光線追蹤：回傳畫好的 canvas；signal 中止就停在目前的樣子。
// 自動曝光（室內外亮度差很多）＋保邊降噪，取樣不多時也比較乾淨。
async function pathTrace({ scene, camera, width, height, maxSamples, exposure, target = 0.46, onProgress, signal }) {
  const { WebGLPathTracer, DenoiseMaterial } = await import('three-gpu-pathtracer');
  const { FullScreenQuad } = await import('three/examples/jsm/postprocessing/Pass.js');
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const renderer = new THREE.WebGLRenderer({ canvas, preserveDrawingBuffer: true, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setSize(width, height, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const pt = new WebGLPathTracer(renderer);
  pt.renderDelay = 0; pt.minSamples = 1; pt.fadeDuration = 0;
  pt.rasterizeScene = false; pt.dynamicLowRes = false; pt.renderToCanvas = false;
  pt.bounces = 5; pt.filterGlossyFactor = 1;
  pt.textureSize.set(mobile() ? 512 : 1024, mobile() ? 512 : 1024);
  const t = width * height > 1.5e6 ? 3 : width * height > 6e5 ? 2 : 1;
  pt.tiles.set(t, t);
  const dn = new DenoiseMaterial({ blending: THREE.NoBlending, premultipliedAlpha: renderer.getContextAttributes().premultipliedAlpha });
  const quad = new FullScreenQuad(dn);
  const show = (n) => {
    // 取樣越多，降噪越輕
    dn.uniforms.sigma.value = n < 16 ? 5 : n < 64 ? 4.5 : n < 200 ? 3.5 : 2.5;
    dn.uniforms.threshold.value = n < 16 ? 0.4 : n < 64 ? 0.3 : n < 200 ? 0.2 : 0.12;
    dn.uniforms.kSigma.value = 1.5;
    dn.uniforms.map.value = pt.target.texture;
    renderer.setRenderTarget(null);
    quad.render(renderer);
  };
  // 量畫面平均亮度，調整曝光
  const probe = document.createElement('canvas');
  probe.width = 48; probe.height = Math.max(8, Math.round(48 * height / width));
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  const meter = () => {
    pctx.drawImage(canvas, 0, 0, probe.width, probe.height);
    const d = pctx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0, n = 0;
    for (let i = 0; i < d.length; i += 4) { sum += (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255; n++; }
    return sum / n;
  };
  onProgress?.(0, canvas, '準備模型（第一次比較久）…');
  await new Promise((r) => setTimeout(r, 30));
  pt.setScene(scene, camera);
  let last = 0, nextMeter = 2;
  while (pt.samples < maxSamples && !signal?.aborted) {
    pt.renderSample();
    if (pt.samples >= nextMeter && nextMeter <= 24) {
      show(pt.samples);
      const m = meter();
      const k = Math.max(0.3, Math.min(3.5, Math.pow(target / Math.max(0.02, m), 1.5)));
      renderer.toneMappingExposure = Math.max(0.3, Math.min(40, renderer.toneMappingExposure * k));
      nextMeter = nextMeter * 2;
    }
    const now = performance.now();
    if (now - last > 150) { show(pt.samples); onProgress?.(pt.samples, canvas); last = now; }
    await new Promise((r) => requestAnimationFrame(r));
  }
  show(pt.samples);
  onProgress?.(pt.samples, canvas);
  // 複製到一般 canvas，釋放 WebGL
  const out = document.createElement('canvas');
  out.width = width; out.height = height;
  out.getContext('2d').drawImage(canvas, 0, 0);
  // 0.0.23 的 dispose() 會碰到不存在的 _renderQuad，自己逐一釋放
  try { pt._quad?.dispose(); pt._quad?.material?.dispose(); pt._pathTracer?.dispose(); pt._lowResPathTracer?.dispose(); } catch { /* 已釋放 */ }
  quad.dispose(); dn.dispose();
  renderer.dispose();
  renderer.forceContextLoss?.();
  return { canvas: out, samples: pt.samples, exposure: renderer.toneMappingExposure };
}

export const RenderUI = {
  // 準備場景：室內（有天花板）或外觀；設定太陽、天空
  async prepRender({ interior, time }) {
    const v = this.view;
    const T = TIMES[time] || TIMES.afternoon;
    v.renderMode = { interior, night: !!T.night };
    v.rebuild();
    const scene = v.scene;
    const saved = { env: scene.environment, bg: scene.background, sun: v.sun.intensity, fill: v.fill.intensity, sunPos: v.sun.position.clone(), sunTgt: v.sun.target.position.clone(), sunColor: v.sun.color.clone() };
    // 透明玻璃在光線追蹤裡會擋掉大部分天光，先拿掉（清玻璃本來就幾乎看不到）
    const hidden = [];
    const glow = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const m = o.material;
      if (!Array.isArray(m) && m?.transparent && m.opacity < 0.7 && !m.map) { o.visible = false; hidden.push(o); }
      // 白天把燈罩的自發光關掉：小面積發光體會在光線追蹤裡變成一顆顆亮點
      for (const mm of Array.isArray(m) ? m : [m]) if (mm?.emissiveIntensity > 0 && !glow.has(mm)) { glow.set(mm, mm.emissiveIntensity); mm.emissiveIntensity = T.night ? Math.min(mm.emissiveIntensity, 1.2) : 0; }
    });
    const sky = await makeSky(!!T.night);
    scene.environment = sky;
    scene.background = sky;
    v.fill.intensity = 0;
    // 室內白天：每扇對外窗放一片朝室內的面光源（天光入口），光線追蹤收斂快很多
    const portals = [];
    if (interior && !T.night && !this.bmode) portals.push(...this.windowPortals(this.plan));
    for (const l of portals) scene.add(l);
    if (T.night) v.sun.intensity = 0;
    else {
      const site = this.site;
      const { alt, az } = sunPosition(latOf(site), Math.round((T.month - 1) * 30.42 + 21), T.hour);
      const s = sunVector(site, alt, az);
      const c = v.center || new THREE.Vector3(3, 0, 8);
      v.sun.position.set(c.x + s.x * 40, Math.max(0.15, s.z) * 40, c.z + s.y * 40);
      v.sun.target.position.copy(c);
      v.sun.target.updateMatrixWorld();
      v.sun.color.set(0xfff1dc);
      v.sun.intensity = alt > 0 ? 3.2 : 0;
    }
    return () => {
      for (const l of portals) { scene.remove(l); l.dispose?.(); }
      for (const o of hidden) o.visible = true;
      for (const [mm, v] of glow) mm.emissiveIntensity = v;
      scene.environment = saved.env; scene.background = saved.bg;
      v.sun.intensity = saved.sun; v.fill.intensity = saved.fill; v.sun.position.copy(saved.sunPos); v.sun.target.position.copy(saved.sunTgt); v.sun.color.copy(saved.sunColor);
      sky.dispose();
      v.renderMode = null;
      v.invalidate();
    };
  },

  windowPortals(plan) {
    const out = [];
    const voids = plan.rooms.filter((r) => r.kind === 'void' && r.pts.length > 2);
    for (const o of plan.openings) {
      if (!['window', 'sliding', 'opening'].includes(o.type)) continue;
      const e = openingEnds(plan, o);
      if (!e) continue;
      const w = e.wall;
      const { n } = wallFrame(w);
      const mid = e.c;
      const faceVoid = voids.some((r) => [1, -1].some((k) => pointInPolygon({ x: mid.x + n.x * k * (w.t / 2 + 8), y: mid.y + n.y * k * (w.t / 2 + 8) }, r.pts)));
      if (w.kind !== 'ext' && !faceVoid) continue;
      const out1 = this.view.outwardSign(plan, w, n);
      const inward = { x: -n.x * out1, y: -n.y * out1 };
      const sill = o.sill || 0, h = Math.min(o.h || 120, (plan.wallHeight || 300) - sill);
      if (h < 20 || o.w < 20) continue;
      const l = new THREE.RectAreaLight(0xe9f1ff, faceVoid ? 1.2 : 2.2, o.w / 100, h / 100);
      const p = new THREE.Vector3((mid.x + inward.x * (w.t / 2 + 2)) / 100, (sill + h / 2) / 100, (mid.y + inward.y * (w.t / 2 + 2)) / 100);
      l.position.copy(p);
      l.lookAt(p.x + inward.x, p.y, p.z + inward.y);
      l.userData.renderLight = true;
      out.push(l);
    }
    return out;
  },

  // ---------- 效果圖 ----------
  openRender() {
    if (!webgl2OK()) return this.toast('這台裝置的瀏覽器不支援光線追蹤，改用「匯出 → PNG」存目前畫面', 5000);
    const st = this._renderOpt ||= { time: 'afternoon', quality: mobile() ? 'fast' : 'normal' };
    const walk = this.view.mode === 'walk';
    const html = `<div class="rnd"><div class="rnd-top"><h2>擬真效果圖</h2><button class="linkish" data-x="close">關閉</button></div>
      <p class="note">用光線追蹤算出真實的光影：光從窗戶照進來、在牆面和地板反彈。${walk ? '用你在「漫遊」看到的角度。' : '用 3D 目前的角度；想要從房間裡面看，先按 3D 下方「漫遊」走進去再按效果圖。'}越久越清楚，隨時可以按「夠了」。</p>
      <div class="rnd-opts"><div class="seg mini" data-rt>${Object.entries(TIMES).map(([k, t]) => `<button type="button" data-v="${k}" class="${st.time === k ? 'on' : ''}">${t.name}</button>`).join('')}</div>
        <div class="seg mini" data-rq>${[['fast', '快速'], ['normal', '標準'], ['high', '高畫質']].map(([k, n]) => `<button type="button" data-v="${k}" class="${st.quality === k ? 'on' : ''}">${n}</button>`).join('')}</div></div>
      <div class="rnd-view" id="rndView"><div class="rnd-msg">準備中…</div></div>
      <div class="rnd-bar"><div class="bar"><span id="rndBar" style="width:0%"></span></div><small id="rndInfo"></small></div>
      <div class="row"><button class="btn" data-x="again">重新算</button><button class="btn" data-x="stop">夠了</button><button class="btn primary" data-x="save" disabled>下載圖片</button></div></div>`;
    this.modal(html, (card, close) => {
      card.classList.add('wide');
      let ctl = null, result = null;
      const run = async () => {
        ctl?.abort();
        const my = new AbortController();
        ctl = my;
        card.querySelector('[data-x=save]').disabled = true;
        const view = card.querySelector('#rndView');
        const box = view.getBoundingClientRect();
        const Q = window.__h3dRenderTest || { fast: [0.6, 96], normal: [1, 256], high: [1.6, 600] }[st.quality];
        const aspect = walk || !this.view ? this.view.camera.aspect : this.view.camera.aspect;
        let W = Math.round(Math.min(1600, Math.max(480, box.width)) * Q[0]);
        W = Math.min(W, mobile() ? 1100 : 2400);
        const H = Math.round(W / Math.max(0.5, Math.min(2.2, aspect)));
        const cam = this.view.camera.clone();
        cam.aspect = W / H; cam.updateProjectionMatrix();
        this.view.paused = true;
        const restore = await this.prepRender({ interior: walk, time: st.time });
        const t0 = performance.now();
        try {
          const res = await pathTrace({
            scene: this.view.scene, camera: cam, width: W, height: H, maxSamples: Q[1], exposure: TIMES[st.time].night ? 1.6 : walk ? 1.9 : 1.0, signal: my.signal,
            onProgress: (n, c, msg) => {
              if (my !== ctl) return;
              if (!view.contains(c)) { view.innerHTML = ''; c.className = 'rnd-canvas'; view.appendChild(c); }
              card.querySelector('#rndBar').style.width = Math.min(100, (n / Q[1]) * 100) + '%';
              card.querySelector('#rndInfo').textContent = msg || `${Math.floor(n)} / ${Q[1]} 次取樣・${((performance.now() - t0) / 1000).toFixed(0)} 秒`;
            },
          });
          if (my === ctl) {
            result = res.canvas;
            view.innerHTML = ''; res.canvas.className = 'rnd-canvas'; view.appendChild(res.canvas);
            card.querySelector('#rndInfo').textContent = `完成：${Math.floor(res.samples)} 次取樣，${((performance.now() - t0) / 1000).toFixed(0)} 秒。${res.samples < Q[1] ? '（提早停止，畫面會有一點顆粒）' : ''}`;
            card.querySelector('[data-x=save]').disabled = false;
          }
        } catch (e) {
          console.error(e);
          view.innerHTML = `<div class="rnd-msg">這台裝置算不出來（${esc(e.message || e)}）。可以改用「匯出 → PNG」存目前畫面。</div>`;
        } finally {
          restore();
          this.view.paused = false;
        }
      };
      card.querySelectorAll('[data-rt] button').forEach((b) => b.onclick = () => { st.time = b.dataset.v; card.querySelectorAll('[data-rt] button').forEach((x) => x.classList.toggle('on', x === b)); run(); });
      card.querySelectorAll('[data-rq] button').forEach((b) => b.onclick = () => { st.quality = b.dataset.v; card.querySelectorAll('[data-rq] button').forEach((x) => x.classList.toggle('on', x === b)); run(); });
      card.querySelector('[data-x=again]').onclick = () => run();
      card.querySelector('[data-x=stop]').onclick = () => ctl?.abort();
      card.querySelector('[data-x=close]').onclick = () => { ctl?.abort(); close(); };
      card.querySelector('[data-x=save]').onclick = async () => {
        if (!result) return;
        const name = `${(this.bmode ? '整棟外觀' : this.plan.name).replace(/[\\/:*?"<>|]/g, '_')}-效果圖.jpg`;
        const r = await saveFile(name, await jpegBlob(result, false), 'image/jpeg');
        if (r?.ok) this.toast(`已存成 ${r.name}`);
      };
      requestAnimationFrame(() => run());
      this._renderClose = () => ctl?.abort();
    }).then(() => { this._renderClose?.(); this.view.paused = false; });
  },

  // ---------- 360° 環景 ----------
  panoSpot(plan) {
    // 漫遊中：用目前位置；否則用客廳／最大的房間中心
    const v = this.view;
    if (!this.bmode && v.mode === 'walk') {
      const p = { x: v.camera.position.x * 100, y: v.camera.position.z * 100 };
      const room = plan.rooms.find((r) => r.pts.length > 2 && pointInPolygon(p, r.pts));
      const dir = new THREE.Vector3(); v.camera.getWorldDirection(dir);
      return { x: p.x, y: p.y, yaw: Math.atan2(-dir.x, -dir.z), room };
    }
    const rooms = plan.rooms.filter((r) => r.pts.length > 2 && !['void', 'stair', 'elevator', 'bath', 'balcony'].includes(r.kind));
    const room = rooms.find((r) => /客|起居|大空間/.test(r.name || '')) || rooms.sort((a, b) => areaM2(b.pts) - areaM2(a.pts))[0];
    if (!room) return null;
    return { ...this.freeSpot(plan, room), yaw: 0, room };
  },

  // 房間裡找一個不在家具裡的點（離家具與牆都有距離）
  freeSpot(plan, room) {
    const c = polygonCentroid(room.pts);
    const boxes = plan.items.filter((i) => !['rug', 'ac', 'lamp'].includes(i.kind) && (i.h ?? 80) > 30).map((i) => ({ x: i.x, y: i.y, r: Math.max(i.w, i.d) / 2 + 30 }));
    let best = { x: c.x, y: c.y, s: -Infinity };
    const xs = room.pts.map((p) => p.x), ys = room.pts.map((p) => p.y);
    for (let x = Math.min(...xs) + 40; x <= Math.max(...xs) - 40; x += 20) for (let y = Math.min(...ys) + 40; y <= Math.max(...ys) - 40; y += 20) {
      const p = { x, y };
      if (!pointInPolygon(p, room.pts)) continue;
      let s = -Math.hypot(x - c.x, y - c.y) / 100;
      for (const b of boxes) { const d = Math.hypot(b.x - x, b.y - y) - b.r; if (d < 0) s -= 10; else s += Math.min(d, 60) / 200; }
      if (s > best.s) best = { x, y, s };
    }
    return best;
  },

  openPano(roomId = null) {
    if (!webgl2OK()) return this.toast('這台裝置的瀏覽器不支援光線追蹤', 5000);
    if (this.bmode) {
      const f = this.building?.focus;
      if (!f || f === 'all') return this.toast('先選一層（在左邊點「3D 剖開」或說「剖開二樓」），再做那一層的 360° 環景', 5000);
      this.openFloor(f);
    }
    const plan = this.plan;
    let spot = this.panoSpot(plan);
    if (roomId) { const room = plan.rooms.find((r) => r.id === roomId); if (room) spot = { ...this.freeSpot(plan, room), yaw: 0, room }; }
    if (!spot) return this.toast('這個平面沒有可以站的房間');
    const st = this._panoOpt ||= { time: 'afternoon' };
    const rooms = plan.rooms.filter((r) => r.pts.length > 2 && r.name && !['void', 'stair', 'elevator'].includes(r.kind));
    const html = `<div class="rnd pano"><div class="rnd-top"><h2>360° 環景・${esc(spot.room?.name || '')}</h2><button class="linkish" data-x="close">關閉</button></div>
      <p class="note">站在房間中間轉一圈看。拖曳轉方向、兩指或滾輪放大；手機可以按「用手機轉著看」。也可以下載成 360 照片傳到 Facebook 或 Google 相簿。</p>
      <div class="rnd-opts"><div class="chips" data-rooms>${rooms.map((r) => `<button type="button" class="chip${r.id === spot.room?.id ? ' on' : ''}" data-room="${r.id}">${esc(r.name)}</button>`).join('')}</div>
        <div class="seg mini" data-rt>${Object.entries(TIMES).map(([k, t]) => `<button type="button" data-v="${k}" class="${st.time === k ? 'on' : ''}">${t.name}</button>`).join('')}</div></div>
      <div class="rnd-view pano-view" id="panoView"><div class="rnd-msg">準備中…</div></div>
      <div class="rnd-bar"><div class="bar"><span id="rndBar" style="width:0%"></span></div><small id="rndInfo"></small></div>
      <div class="row"><button class="btn" data-x="gyro" hidden>📱 用手機轉著看</button><button class="btn" data-x="stop">夠了</button><button class="btn primary" data-x="save" disabled>下載 360 照片</button></div></div>`;
    let viewer = null;
    this.modal(html, (card, close) => {
      card.classList.add('wide');
      let ctl = null, result = null;
      const run = async () => {
        ctl?.abort();
        const my = new AbortController();
        ctl = my;
        viewer?.dispose(); viewer = null;
        card.querySelector('[data-x=save]').disabled = true;
        const view = card.querySelector('#panoView');
        const T0 = window.__h3dRenderTest;
        const W = T0 ? 256 : mobile() ? 1536 : 2560, H = W / 2;
        const S = T0 ? T0[1] : mobile() ? 128 : 256;
        const { EquirectCamera } = await import('three-gpu-pathtracer');
        const cam = new EquirectCamera();
        cam.position.set(spot.x / 100, (plan.elevation ? 0 : 0) + 1.5, spot.y / 100);
        cam.rotation.set(0, spot.yaw || 0, 0);
        this.view.paused = true;
        const restore = await this.prepRender({ interior: true, time: st.time });
        const t0 = performance.now();
        try {
          const res = await pathTrace({
            scene: this.view.scene, camera: cam, width: W, height: H, maxSamples: S, exposure: TIMES[st.time].night ? 1.6 : 1.9, signal: my.signal,
            onProgress: (n, c, msg) => {
              if (my !== ctl) return;
              if (!view.contains(c)) { view.innerHTML = ''; c.className = 'rnd-canvas flat'; view.appendChild(c); }
              card.querySelector('#rndBar').style.width = Math.min(100, (n / S) * 100) + '%';
              card.querySelector('#rndInfo').textContent = msg || `${Math.floor(n)} / ${S} 次取樣・${((performance.now() - t0) / 1000).toFixed(0)} 秒（算完會變成可以轉著看）`;
            },
          });
          if (my === ctl) {
            result = res.canvas;
            view.innerHTML = '';
            viewer = panoViewer(view, res.canvas);
            card.querySelector('#rndInfo').textContent = `完成：${Math.floor(res.samples)} 次取樣，${((performance.now() - t0) / 1000).toFixed(0)} 秒。拖曳轉方向。`;
            card.querySelector('[data-x=save]').disabled = false;
            const gy = card.querySelector('[data-x=gyro]');
            gy.hidden = !('DeviceOrientationEvent' in window) || !matchMedia('(pointer: coarse)').matches;
            gy.onclick = async () => { const ok = await viewer.gyro(); gy.textContent = ok ? (viewer.gyroOn ? '✋ 改用手指拖' : '📱 用手機轉著看') : '這台手機不能用陀螺儀'; };
          }
        } catch (e) {
          console.error(e);
          view.innerHTML = `<div class="rnd-msg">這台裝置算不出來（${esc(e.message || e)}）。</div>`;
        } finally {
          restore();
          this.view.paused = false;
        }
      };
      card.querySelectorAll('[data-room]').forEach((b) => b.onclick = () => {
        const room = plan.rooms.find((r) => r.id === b.dataset.room);
        spot = { ...this.freeSpot(plan, room), yaw: 0, room };
        card.querySelectorAll('[data-room]').forEach((x) => x.classList.toggle('on', x === b));
        card.querySelector('h2').textContent = `360° 環景・${room.name}`;
        run();
      });
      card.querySelectorAll('[data-rt] button').forEach((b) => b.onclick = () => { st.time = b.dataset.v; card.querySelectorAll('[data-rt] button').forEach((x) => x.classList.toggle('on', x === b)); run(); });
      card.querySelector('[data-x=stop]').onclick = () => ctl?.abort();
      card.querySelector('[data-x=close]').onclick = () => { ctl?.abort(); close(); };
      card.querySelector('[data-x=save]').onclick = async () => {
        if (!result) return;
        const name = `${this.plan.name.replace(/[\\/:*?"<>|]/g, '_')}-${spot.room?.name || ''}-360.jpg`;
        const r = await saveFile(name, await jpegBlob(result, true), 'image/jpeg');
        if (r?.ok) this.toast(`已存成 ${r.name}：上傳到 Facebook 會自動變成可以轉的 360 照片`, 6000);
      };
      requestAnimationFrame(() => run());
      this._panoClose = () => ctl?.abort();
    }).then(() => { this._panoClose?.(); viewer?.dispose(); this.view.paused = false; });
  },
};

// ---------- 環景檢視器 ----------
function panoViewer(container, img) {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  container.appendChild(renderer.domElement);
  renderer.domElement.className = 'pano-canvas';
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
  const tex = new THREE.CanvasTexture(img);
  tex.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.SphereGeometry(10, 64, 32);
  geo.scale(-1, 1, 1);
  scene.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex })));
  let lon = 0, lat = 0, raf = 0;
  const st = { gyroOn: false, alpha0: null };
  const size = () => { const r = container.getBoundingClientRect(); renderer.setSize(r.width, r.height); camera.aspect = r.width / Math.max(1, r.height); camera.updateProjectionMatrix(); };
  const ro = new ResizeObserver(size); ro.observe(container); size();
  const euler = new THREE.Euler(), q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5)), zee = new THREE.Vector3(0, 0, 1);
  let orient = null;
  const onOrient = (e) => { orient = e; };
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (st.gyroOn && orient && orient.alpha !== null) {
      const D = Math.PI / 180;
      if (st.alpha0 === null) st.alpha0 = orient.alpha - lon / D;
      euler.set(orient.beta * D, (orient.alpha - st.alpha0) * D, -orient.gamma * D, 'YXZ');
      camera.quaternion.setFromEuler(euler);
      camera.quaternion.multiply(q1);
      camera.quaternion.multiply(q0.setFromAxisAngle(zee, -((screen.orientation?.angle || window.orientation || 0) * D)));
    } else {
      lat = Math.max(-85, Math.min(85, lat));
      const phi = THREE.MathUtils.degToRad(90 - lat), th = THREE.MathUtils.degToRad(lon);
      camera.lookAt(Math.sin(phi) * Math.sin(th) * -1, Math.cos(phi), Math.sin(phi) * Math.cos(th) * -1);
    }
    renderer.render(scene, camera);
  };
  loop();
  // 拖曳、縮放
  const el = renderer.domElement;
  el.style.touchAction = 'none';
  const ptrs = new Map();
  let start = null, pinch = null;
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, e); start = { x: e.clientX, y: e.clientY, lon, lat }; if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinch = { d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), fov: camera.fov }; } });
  el.addEventListener('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return;
    ptrs.set(e.pointerId, e);
    if (ptrs.size === 2 && pinch) { const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); camera.fov = Math.max(35, Math.min(95, pinch.fov * pinch.d / Math.max(1, d))); camera.updateProjectionMatrix(); return; }
    if (!start || st.gyroOn) return;
    const k = camera.fov / el.clientHeight;
    lon = start.lon - (e.clientX - start.x) * k;
    lat = start.lat + (e.clientY - start.y) * k;
  });
  const up = (e) => { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) start = null; };
  el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
  el.addEventListener('wheel', (e) => { e.preventDefault(); camera.fov = Math.max(35, Math.min(95, camera.fov + e.deltaY * 0.04)); camera.updateProjectionMatrix(); }, { passive: false });
  return {
    get gyroOn() { return st.gyroOn; },
    async gyro() {
      if (st.gyroOn) { st.gyroOn = false; window.removeEventListener('deviceorientation', onOrient); return true; }
      try { if (typeof DeviceOrientationEvent.requestPermission === 'function' && (await DeviceOrientationEvent.requestPermission()) !== 'granted') return false; } catch { return false; }
      st.alpha0 = null; st.gyroOn = true;
      window.addEventListener('deviceorientation', onOrient);
      return true;
    },
    dispose() { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('deviceorientation', onOrient); tex.dispose(); geo.dispose(); renderer.dispose(); renderer.forceContextLoss?.(); el.remove(); },
  };
}
export { pathTrace as _pathTrace, makeSky as _makeSky, jpegBlob as _jpegBlob };
