// 3D 檢視：Three.js。模型以公分建立，根節點縮放 0.01 → 公尺。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import {
  wallFrame, wallSegments, wallExtents, openingEnds, polygonCentroid, areaM2, ROOM_KINDS, planBounds, itemCorners,
} from './model.js';
import { itemHeight, itemElev, itemName } from './catalog.js';
import { stairGeometry } from './editor2d.js';

const SLAB = 15;

export class View3D {
  constructor(container, app) {
    this.app = app;
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.camera.position.set(12, 16, 26);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('start', () => { this.userMoved = true; });

    const hemi = new THREE.HemisphereLight(0xfbf8f2, 0x9c9486, 1.35);
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e2, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.45);
    fill.position.set(10, 8, 20);
    this.scene.add(fill);

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -(SLAB + 1) / 100;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.root = new THREE.Group();
    this.root.scale.setScalar(0.01);
    this.scene.add(this.root);

    this.mats = makeMaterials();
    this.cutHeight = 160; // null＝完整牆高；預設剖切成「娃娃屋」看得到室內
    this.showLabels = true;
    this.mode = 'orbit';
    this.walk = { keys: new Set() };
    this.itemGroups = new Map();
    this.pending = true;
    this.first = true;

    this._bindPointer();
    this._bindKeys();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(container);
    this.resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  setTheme(dark) {
    this.ground.material.color.set(dark ? 0x2a2d31 : 0xd8d3c8);
    this.mats.cap.color.set(dark ? 0x1d2024 : 0x3a3e44);
    this.invalidate();
  }

  resize() {
    const r = this.container.getBoundingClientRect();
    const w = Math.max(10, r.width), h = Math.max(10, r.height);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = w + 'px';
    this.renderer.domElement.style.height = h + 'px';
    const prev = this.camera.aspect;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    // 使用者還沒動過相機時，視窗比例改變就重新取景（例如手機切換到 3D 分頁）
    if (!this.userMoved && this.mode === 'orbit' && this.center && Math.abs(prev - this.camera.aspect) > 0.05) this.setView(this.lastView || 'iso');
  }

  invalidate() { this.pending = true; }

  tick() {
    if (this.pending && !this.drag3d) { this.pending = false; this.rebuild(); }
    if (this.mode === 'walk') this.walkStep();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- 建模 ----------
  clearRoot() {
    this.root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.userData.ownMaterial) {
        (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => { m.map?.dispose(); m.dispose(); });
      }
    });
    this.root.clear();
    this.itemGroups.clear();
  }

  rebuild() {
    const plan = this.app.plan;
    if (!plan) return;
    this.clearRoot();
    const M = this.mats;
    const cut = this.cutHeight;

    // 樓板＋地坪
    for (const r of plan.rooms) {
      if (r.pts.length < 3) continue;
      const shape = new THREE.Shape(r.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      if (r.kind === 'void') {
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(Math.PI / 2);
        const m = new THREE.Mesh(g, M.voidFloor);
        m.position.y = -140;
        this.root.add(m);
        continue;
      }
      const g = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      const floor = M.floor[r.kind] || M.floor.other;
      const mesh = new THREE.Mesh(g, [floor, M.slabSide]);
      mesh.receiveShadow = true;
      mesh.userData = { kind: 'room', id: r.id };
      this.root.add(mesh);
    }

    // 牆
    for (const w of plan.walls) this.buildWall(plan, w, cut);

    // 家具
    for (const it of plan.items) {
      const g = buildItem(it, M, cut, plan);
      g.position.set(it.x, itemElev(it), it.y);
      g.rotation.y = -(it.rot || 0) * Math.PI / 180;
      g.traverse((o) => { if (o.isMesh) { o.castShadow = o.userData.noShadow ? false : true; o.receiveShadow = true; o.userData.itemId = it.id; } });
      g.userData.itemId = it.id;
      this.root.add(g);
      this.itemGroups.set(it.id, g);
    }

    // 標籤
    if (this.showLabels) {
      for (const r of plan.rooms) {
        if (!r.name || r.pts.length < 3) continue;
        const c = r.label || polygonCentroid(r.pts);
        const a = areaM2(r.pts);
        const lab = makeLabel(r.name, r.kind === 'void' ? '' : `${a.toFixed(1)}㎡`);
        lab.position.set(c.x, r.kind === 'void' ? -138 : 1.2, c.y);
        this.root.add(lab);
      }
    }

    this.updateSelection();
    this.fitShadows(plan);
    if (this.first) { this.first = false; this.setView('iso', true); }
  }

  buildWall(plan, w, cut) {
    const M = this.mats;
    const { L, u } = wallFrame(w);
    if (L < 0.5) return;
    const H = Math.min(w.h ?? plan.wallHeight, cut ?? Infinity);
    const { extA, extB } = wallExtents(plan, w);
    const ang = Math.atan2(u.y, u.x);
    const selected = this.app.sel?.type === 'wall' && this.app.sel.id === w.id;
    const side = selected ? M.wallSel : (w.kind === 'parapet' ? M.parapet : M.wall);
    const mats = [side, side, M.cap, side, side, side];
    const addBox = (s, e, y0, y1) => {
      if (e - s < 0.3 || y1 - y0 < 0.3) return;
      const g = new THREE.BoxGeometry(e - s, y1 - y0, w.t);
      const m = new THREE.Mesh(g, mats);
      const mid = (s + e) / 2;
      m.position.set(w.a.x + u.x * mid, (y0 + y1) / 2, w.a.y + u.y * mid);
      m.rotation.y = -ang;
      m.castShadow = true; m.receiveShadow = true;
      m.userData = { kind: 'wall', id: w.id };
      this.root.add(m);
    };
    for (const sg of wallSegments(plan, w)) {
      const s = sg.s - (sg.s <= 0.01 ? extA : 0), e = sg.e + (sg.e >= L - 0.01 ? extB : 0);
      if (sg.solid) { addBox(s, e, -SLAB, H); continue; }
      const o = sg.opening;
      const sill = o.sill || 0, top = sill + (o.h || 210);
      addBox(s, e, -SLAB, Math.min(sill, H));
      if (top < H) addBox(s, e, top, H);
      this.buildOpening(plan, o, w, Math.min(top, H), sill, H);
    }
  }

  buildOpening(plan, o, w, top, sill, H) {
    const M = this.mats;
    const e = openingEnds(plan, o);
    if (!e) return;
    const { u, n } = e;
    const ang = Math.atan2(u.y, u.x);
    const hgt = Math.max(0, top - sill);
    if (hgt < 1) return;
    const selected = this.app.sel?.type === 'opening' && this.app.sel.id === o.id;
    const tag = (m) => { m.userData = { kind: 'opening', id: o.id }; m.castShadow = true; return m; };
    const place = (m, along, off, y) => {
      m.position.set(w.a.x + u.x * along + n.x * off, y, w.a.y + u.y * along + n.y * off);
      m.rotation.y = -ang;
      this.root.add(tag(m));
    };
    if (o.type === 'door') {
      const hingeAlong = o.hinge === 'b' ? o.pos + o.w / 2 : o.pos - o.w / 2;
      const dirAlong = o.hinge === 'b' ? -1 : 1;
      const side = o.side >= 0 ? 1 : -1;
      const open = 70 * Math.PI / 180;
      const g = new THREE.BoxGeometry(o.w - 2, hgt - 1, 4);
      g.translate((o.w - 2) / 2, 0, 0);
      const leaf = new THREE.Mesh(g, selected ? M.accent : M.door);
      const hp = { x: w.a.x + u.x * hingeAlong + n.x * side * (w.t / 2), y: w.a.y + u.y * hingeAlong + n.y * side * (w.t / 2) };
      // 門片方向：沿牆 dirAlong 旋轉 open 角度朝 side 側
      const vx = u.x * dirAlong, vy = u.y * dirAlong;
      const c = Math.cos(open), s = Math.sin(open);
      const dx = vx * c + n.x * side * s, dy = vy * c + n.y * side * s;
      leaf.position.set(hp.x, sill + hgt / 2, hp.y);
      leaf.rotation.y = -Math.atan2(dy, dx);
      this.root.add(tag(leaf));
      // 門框
      const fr = new THREE.BoxGeometry(o.w, 4, w.t + 1);
      const fm = new THREE.Mesh(fr, M.frame);
      place(fm, o.pos, 0, top - 2);
    } else if (o.type === 'sliding') {
      const pw = o.w * 0.53;
      for (const k of [-1, 1]) {
        const along = o.pos + k * (o.w / 2 - pw / 2);
        const off = k * w.t / 6;
        const glass = new THREE.Mesh(new THREE.BoxGeometry(pw, hgt - 2, 1.5), selected ? M.accentGlass : M.glass);
        glass.userData.noShadow = true;
        place(glass, along, off, sill + hgt / 2);
        const fr = new THREE.Mesh(new THREE.BoxGeometry(pw, hgt - 2, 3), M.alu);
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(fr.geometry), M.aluLine);
        place(edges, along, off, sill + hgt / 2);
        fr.geometry.dispose();
      }
    } else if (o.type === 'window') {
      const glass = new THREE.Mesh(new THREE.BoxGeometry(o.w - 2, hgt - 2, 1.5), selected ? M.accentGlass : M.glass);
      place(glass, o.pos, 0, sill + hgt / 2);
      const box = new THREE.BoxGeometry(o.w - 1, hgt - 1, 4);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), M.aluLine);
      place(edges, o.pos, 0, sill + hgt / 2);
      box.dispose();
      const mid = new THREE.Mesh(new THREE.BoxGeometry(3, hgt - 2, 4), M.alu);
      place(mid, o.pos, 0, sill + hgt / 2);
    } else if (o.type === 'elevator') {
      for (const k of [-1, 1]) {
        const p = new THREE.Mesh(new THREE.BoxGeometry(o.w / 2 - 1, hgt - 1, 3), selected ? M.accent : M.steel);
        place(p, o.pos + k * o.w / 4, -(w.t / 2 - 2) * 0, sill + hgt / 2);
      }
    }
  }

  fitShadows(plan) {
    const b = planBounds(plan);
    const cx = (b.minX + b.maxX) / 200, cz = (b.minY + b.maxY) / 200;
    const R = Math.max(b.maxX - b.minX, b.maxY - b.minY) / 200 + 2;
    const cam = this.sun.shadow.camera;
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 0.5; cam.far = 80;
    cam.updateProjectionMatrix();
    this.sun.position.set(cx - 9, 22, cz - 12);
    this.sun.target.position.set(cx, 0, cz);
    this.ground.position.x = cx; this.ground.position.z = cz;
    this.center = new THREE.Vector3(cx, 0, cz);
    this.radius = R;
    this.size = { w: (b.maxX - b.minX) / 100, d: (b.maxY - b.minY) / 100, h: (plan.wallHeight || 300) / 100 };
  }

  // 讓整棟房子剛好進入畫面的相機距離
  fitDistance(dir) {
    const { w, d, h } = this.size || { w: 6, d: 17, h: 3 };
    const vf = this.camera.fov * Math.PI / 180;
    const hf = 2 * Math.atan(Math.tan(vf / 2) * this.camera.aspect);
    // 以包圍盒八個角投影到相機平面估算
    const f = dir.clone().normalize();
    const up = Math.abs(f.y) > 0.99 ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(up, f).normalize();
    const camUp = new THREE.Vector3().crossVectors(f, right).normalize();
    let need = 0;
    for (const sx of [-1, 1]) for (const sy of [0, 1]) for (const sz of [-1, 1]) {
      const p = new THREE.Vector3(sx * w / 2, sy * h, sz * d / 2);
      const x = Math.abs(p.dot(right)), y = Math.abs(p.dot(camUp)), z = p.dot(f);
      need = Math.max(need, x / Math.tan(hf / 2) + z, y / Math.tan(vf / 2) + z);
    }
    return need * 1.0 + 0.3;
  }

  updateSelection() {
    if (this.selHelper) {
      this.selHelper.parent?.remove(this.selHelper);
      this.selHelper.geometry.dispose();
      this.selHelper = null;
    }
    const sel = this.app.sel;
    if (sel?.type !== 'item') return;
    const g = this.itemGroups.get(sel.id);
    const it = this.app.plan.items.find((x) => x.id === sel.id);
    if (!g || !it) return;
    const h = Math.min(itemHeight(it), this.cutHeight ?? Infinity) + 4;
    const box = new THREE.BoxGeometry(it.w + 6, h, it.d + 6);
    const helper = new THREE.LineSegments(new THREE.EdgesGeometry(box), this.mats.selLine);
    box.dispose();
    helper.position.set(0, h / 2 - 2, 0);
    g.add(helper);
    this.selHelper = helper;
  }

  // ---------- 相機 ----------
  setView(kind, instant = false) {
    this.lastView = kind === 'walk' ? this.lastView : kind;
    this.userMoved = false;
    const c = this.center || new THREE.Vector3(3, 0, 8);
    const R = this.radius || 10;
    this.mode = kind === 'walk' ? 'walk' : 'orbit';
    this.controls.enableZoom = kind !== 'walk';
    this.controls.enablePan = kind !== 'walk';
    this.controls.rotateSpeed = kind === 'walk' ? -0.35 : 1;
    this.controls.minDistance = kind === 'walk' ? 0.01 : 1;
    this.controls.maxDistance = kind === 'walk' ? 0.02 : 120;
    this.controls.maxPolarAngle = kind === 'walk' ? Math.PI * 0.85 : Math.PI * 0.495;
    this.controls.minPolarAngle = kind === 'walk' ? Math.PI * 0.15 : 0;
    if (kind === 'walk') {
      const start = this.walkStart();
      this.camera.position.set(start.x, 1.6, start.z);
      this.controls.target.set(start.x, 1.6, start.z - 0.015);
    } else {
      const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.0015) : kind === 'front' ? new THREE.Vector3(0.18, 0.42, 1) : new THREE.Vector3(0.8, 1.15, 0.95);
      const target = new THREE.Vector3(c.x, kind === 'front' ? 1.0 : 0.6, c.z);
      const D = this.fitDistance(dir);
      this.camera.position.copy(target).addScaledVector(dir.normalize(), D);
      this.controls.target.copy(target);
    }
    this.controls.update();
  }

  walkStart() {
    const plan = this.app.plan;
    const sel = this.app.sel;
    let room = sel?.type === 'room' ? plan.rooms.find((r) => r.id === sel.id) : null;
    if (!room) room = plan.rooms.find((r) => r.kind === 'hall') || plan.rooms.find((r) => r.kind === 'living') || plan.rooms[0];
    const p = room ? polygonCentroid(room.pts) : { x: 300, y: 700 };
    return { x: p.x / 100, z: p.y / 100 };
  }

  walkStep() {
    const k = this.walk.keys;
    if (!k.size) return;
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    dir.y = 0; dir.normalize();
    const right = new THREE.Vector3(-dir.z, 0, dir.x);
    const v = new THREE.Vector3();
    if (k.has('f')) v.add(dir);
    if (k.has('b')) v.sub(dir);
    if (k.has('r')) v.add(right);
    if (k.has('l')) v.sub(right);
    if (!v.lengthSq()) return;
    v.normalize().multiplyScalar(0.045);
    this.camera.position.add(v);
    this.controls.target.add(v);
  }

  _bindKeys() {
    const map = { KeyW: 'f', ArrowUp: 'f', KeyS: 'b', ArrowDown: 'b', KeyA: 'l', ArrowLeft: 'l', KeyD: 'r', ArrowRight: 'r' };
    window.addEventListener('keydown', (e) => {
      if (this.mode !== 'walk' || !map[e.code]) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) return;
      this.walk.keys.add(map[e.code]);
      e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { if (map[e.code]) this.walk.keys.delete(map[e.code]); });
    window.addEventListener('blur', () => this.walk.keys.clear());
  }

  // ---------- 3D 點選與拖曳 ----------
  _bindPointer() {
    const el = this.renderer.domElement;
    const ray = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const pick = (e) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const hits = ray.intersectObjects(this.root.children, true);
      for (const h of hits) {
        let o = h.object;
        while (o && !o.userData.itemId && !o.userData.kind && o.parent) o = o.parent;
        if (o?.userData.itemId) return { type: 'item', id: o.userData.itemId, point: h.point };
        if (o?.userData.kind === 'wall' || o?.userData.kind === 'opening') return { type: o.userData.kind, id: o.userData.id, point: h.point };
        if (o?.userData.kind === 'room') return { type: 'room', id: o.userData.id, point: h.point };
      }
      return null;
    };
    const floorPoint = (e, y = 0) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -y / 100);
      const p = new THREE.Vector3();
      return ray.ray.intersectPlane(plane, p) ? { x: p.x * 100, y: p.z * 100 } : null;
    };
    el.addEventListener('pointerdown', (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      if (this.mode === 'walk' || e.button !== 0) return;
      const h = pick(e);
      if (h?.type === 'item') {
        const it = this.app.plan.items.find((x) => x.id === h.id);
        const fp = floorPoint(e, itemElev(it));
        if (!fp || it.kind === 'stair' || it.kind === 'elevator') { this.app.setSel({ type: 'item', id: h.id }); return; }
        this.app.setSel({ type: 'item', id: h.id });
        this.drag3d = { id: h.id, start: fp, x0: it.x, y0: it.y, moved: false, elev: itemElev(it) };
        this.controls.enabled = false;
        el.setPointerCapture(e.pointerId);
      }
    });
    el.addEventListener('pointermove', (e) => {
      const d = this.drag3d;
      if (!d) return;
      const fp = floorPoint(e, d.elev);
      if (!fp) return;
      const it = this.app.plan.items.find((x) => x.id === d.id);
      const snap = this.app.settings.snap ? 5 : 0.5;
      it.x = Math.round((d.x0 + fp.x - d.start.x) / snap) * snap;
      it.y = Math.round((d.y0 + fp.y - d.start.y) / snap) * snap;
      d.moved = true;
      const g = this.itemGroups.get(it.id);
      if (g) g.position.set(it.x, itemElev(it), it.y);
      this.app.changed(true, { skip3d: true });
    });
    const up = (e) => {
      const d = this.drag3d;
      this.controls.enabled = true;
      if (d) {
        this.drag3d = null;
        if (d.moved) this.app.commit();
        return;
      }
      if (!this.downAt || Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 4 || this.mode === 'walk') return;
      const h = pick(e);
      if (h && h.type !== 'room') this.app.setSel({ type: h.type, id: h.id });
      else if (h?.type === 'room') this.app.setSel({ type: 'room', id: h.id });
      else this.app.setSel(null);
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  snapshotPNG() {
    const bg = getComputedStyle(this.container).getPropertyValue('--sky-bottom').trim() || '#f3f0e9';
    this.renderer.setClearColor(new THREE.Color(bg), 1);
    this.renderer.render(this.scene, this.camera);
    return new Promise((res) => this.renderer.domElement.toBlob((b) => { this.renderer.setClearColor(0x000000, 0); res(b); }, 'image/png'));
  }

  async exportGLB() {
    const { GLTFExporter } = await import('three/addons/GLTFExporter.js');
    const exp = new GLTFExporter();
    const clone = this.root.clone(true);
    return new Promise((res, rej) => exp.parse(clone, (r) => res(r), rej, { binary: true }));
  }
}

// ---------- 材質 ----------
function canvasTex(draw, size = 256, repeat = 100) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1 / repeat, 1 / repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function woodTex(base, dark) {
  return canvasTex((g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    const rows = 8;
    for (let i = 0; i < rows; i++) {
      const y = (i * s) / rows;
      g.fillStyle = `rgba(0,0,0,${0.02 + (i % 3) * 0.018})`;
      g.fillRect(0, y, s, s / rows);
      g.strokeStyle = dark; g.globalAlpha = 0.35; g.lineWidth = 1.2;
      g.beginPath(); g.moveTo(0, y); g.lineTo(s, y); g.stroke();
      const off = ((i * 97) % 5) * (s / 5);
      g.beginPath(); g.moveTo(off, y); g.lineTo(off, y + s / rows); g.stroke();
      g.globalAlpha = 0.1;
      for (let k = 0; k < 5; k++) { g.beginPath(); const yy = y + (k + 0.5) * s / rows / 5; g.moveTo(0, yy); g.bezierCurveTo(s * 0.3, yy + 1.5, s * 0.6, yy - 1.5, s, yy); g.stroke(); }
      g.globalAlpha = 1;
    }
  }, 256, 160);
}

function tileTex(base, grout, size = 60) {
  return canvasTex((g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    g.strokeStyle = grout; g.lineWidth = 3;
    g.strokeRect(0, 0, s, s);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(4, 4, s / 2, s / 2);
  }, 128, size);
}

function makeMaterials() {
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
  return {
    wall: std(0xf4f1ea, { roughness: 0.95 }),
    wallSel: std(0xf2d95c, { roughness: 0.9 }),
    parapet: std(0xe9e4d9, { roughness: 0.95 }),
    cap: std(0x3a3e44, { roughness: 1 }),
    slabSide: std(0xbdb7ab, { roughness: 1 }),
    voidFloor: new THREE.MeshBasicMaterial({ color: 0x3b4247, side: THREE.DoubleSide }),
    floor: {
      living: std(0xffffff, { map: woodTex('#caa27a', '#7b5a3a'), roughness: 0.7 }),
      bedroom: std(0xffffff, { map: woodTex('#d8b994', '#8a6a47'), roughness: 0.72 }),
      hall: std(0xffffff, { map: woodTex('#cfae88', '#80613f'), roughness: 0.72 }),
      kitchen: std(0xffffff, { map: tileTex('#e3e3de', '#b9b8b1', 60), roughness: 0.55 }),
      bath: std(0xffffff, { map: tileTex('#d7e1e6', '#a9b7bf', 30), roughness: 0.5 }),
      balcony: std(0xffffff, { map: tileTex('#caa491', '#9b7968', 30), roughness: 0.8 }),
      stair: std(0xd2cfc8, { roughness: 0.8 }),
      elevator: std(0x9aa1a7, { roughness: 0.4, metalness: 0.5 }),
      storage: std(0xd6d2c9),
      other: std(0xe3ddd2),
    },
    door: std(0xb88a5b, { roughness: 0.6 }),
    frame: std(0xe7e2d8),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xcfe6ee, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false }),
    accentGlass: new THREE.MeshPhysicalMaterial({ color: 0xf2d95c, transparent: true, opacity: 0.5, depthWrite: false }),
    alu: std(0x8d949a, { metalness: 0.6, roughness: 0.35 }),
    aluLine: new THREE.LineBasicMaterial({ color: 0x6d747a }),
    steel: std(0xb7bcc1, { metalness: 0.75, roughness: 0.3 }),
    accent: std(0xf2c230, { roughness: 0.6 }),
    selLine: new THREE.LineBasicMaterial({ color: 0xf2a900, linewidth: 2 }),
    wood: std(0xc49a6c, { roughness: 0.6 }),
    woodLight: std(0xe1c9a5, { roughness: 0.65 }),
    woodDark: std(0x7a5a3f, { roughness: 0.6 }),
    white: std(0xfafaf7, { roughness: 0.4 }),
    porcelain: std(0xffffff, { roughness: 0.2 }),
    fabric: std(0xe8e4dc, { roughness: 1 }),
    fabric2: std(0x8ea4a8, { roughness: 1 }),
    fabric3: std(0xb9876a, { roughness: 1 }),
    sofa: std(0x7d8f86, { roughness: 1 }),
    stone: std(0xdad6ce, { roughness: 0.45 }),
    dark: std(0x2b2e33, { roughness: 0.5 }),
    black: std(0x151618, { roughness: 0.3 }),
    concrete: std(0xb9b5ad, { roughness: 1 }),
    stainless: std(0xc9ced2, { metalness: 0.8, roughness: 0.25 }),
    plant: std(0x5d8a57, { roughness: 1 }),
    pot: std(0xb56d4b, { roughness: 0.9 }),
    water: std(0xbfdbe6, { roughness: 0.1 }),
  };
}

// ---------- 家具建模（本地：寬＝X、深＝Z、正面＝+Z） ----------
function buildItem(it, M, cut, plan) {
  const g = new THREE.Group();
  const w = it.w, d = it.d, hw = w / 2, hd = d / 2;
  const H = itemHeight(it);
  const box = (bw, bh, bd, x, y, z, mat) => {
    if (bw <= 0 || bh <= 0 || bd <= 0) return null;
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    m.position.set(x, y + bh / 2, z);
    g.add(m);
    return m;
  };
  const cyl = (rx, h, rz, x, y, z, mat, seg = 24) => {
    const m = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, h, seg), mat);
    m.scale.set(rx, 1, rz);
    m.position.set(x, y + h / 2, z);
    g.add(m);
    return m;
  };
  const legs = (lw, lh, inset, mat) => {
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(lw, lh, lw, sx * (hw - inset - lw / 2), 0, sz * (hd - inset - lw / 2), mat);
  };
  const clipH = (h) => Math.min(h, cut ?? Infinity);
  switch (it.kind) {
    case 'bed':
    case 'bed_single': {
      box(w, 28, d, 0, 0, 0, M.woodLight);
      box(w - 4, 20, d - 6, 0, 28, 2, M.fabric);
      box(w, 90, 6, 0, 0, -hd + 3, M.wood);
      const n = it.kind === 'bed' ? 2 : 1;
      const pw = (w - 18) / n - (n > 1 ? 3 : 0);
      for (let i = 0; i < n; i++) box(pw, 10, 30, -hw + 9 + pw / 2 + i * (pw + 6), 48, -hd + 26, M.white);
      box(w - 2, 4, d * 0.6, 0, 47, hd - d * 0.3, M.fabric2);
      break;
    }
    case 'wardrobe': {
      const h = clipH(H);
      box(w, h, d, 0, 0, 0, M.woodLight);
      const doors = Math.max(1, Math.round(w / 50));
      for (let i = 1; i < doors; i++) box(0.8, h - 10, 0.6, -hw + (i * w) / doors, 5, hd + 0.3, M.woodDark);
      for (let i = 0; i < doors; i++) box(2, Math.min(40, h * 0.3), 2, -hw + ((i + 0.5) * w) / doors + (i % 2 ? -8 : 8), h * 0.45, hd + 1, M.dark);
      break;
    }
    case 'desk':
    case 'table':
      box(w, 4, d, 0, H - 4, 0, it.kind === 'table' ? M.wood : M.woodLight);
      legs(5, H - 4, 3, M.woodDark);
      break;
    case 'nightstand':
    case 'box':
      box(w, H, d, 0, 0, 0, it.kind === 'box' ? M.stone : M.woodLight);
      break;
    case 'chair':
      box(w - 8, 5, d - 8, 0, 43, 0, M.wood);
      legs(3.5, 43, 5, M.woodDark);
      box(w - 8, 40, 3, 0, 48, -hd + 5.5, M.wood);
      break;
    case 'sofa':
      box(w, 42, d, 0, 0, 0, M.sofa);
      box(w, 38, 18, 0, 42, -hd + 9, M.sofa);
      box(16, 20, d, -hw + 8, 42, 0, M.sofa);
      box(16, 20, d, hw - 8, 42, 0, M.sofa);
      box(w - 34, 10, d - 22, 0, 42, 9, M.fabric);
      break;
    case 'tv':
      box(w, 45, d, 0, 0, 0, M.woodDark);
      box(Math.min(w * 0.85, 140), 70, 5, 0, 60, -hd + 8, M.black);
      box(20, 15, 12, 0, 45, -hd + 8, M.dark);
      break;
    case 'toilet': {
      box(w, 36, d * 0.26, 0, 38, -hd + d * 0.13, M.porcelain);
      cyl(w * 0.42, 40, d * 0.34, 0, 0, -hd + d * 0.26 + d * 0.34, M.porcelain, 28);
      cyl(w * 0.44, 3, d * 0.36, 0, 40, -hd + d * 0.26 + d * 0.34, M.white, 28);
      break;
    }
    case 'basin':
      box(w, 78, d, 0, 0, 0, M.woodLight);
      box(w + 2, 5, d + 2, 0, 78, 0, M.stone);
      cyl(w * 0.3, 2, d * 0.28, 0, 83, 2, M.water);
      box(Math.min(w, 60), 75, 2, 0, 110, -hd + 1, M.glass);
      break;
    case 'shower':
      box(w, 4, d, 0, 0, 0, M.stone);
      if (clipH(195) > 20) {
        const gl = box(w, clipH(195) - 4, 1, 0, 4, hd - 0.5, M.glass);
        if (gl) gl.userData.noShadow = true;
      }
      cyl(8, 2, 8, 0, Math.min(190, clipH(190) - 3), -hd + 10, M.stainless);
      break;
    case 'bathtub':
      box(w, 50, d, 0, 0, 0, M.porcelain);
      box(w - 14, 2, d - 14, 0, 44, 0, M.water);
      break;
    case 'counter': {
      box(w, 82, d - 2, 0, 0, -1, M.white);
      box(w, 4, d, 0, 82, 0, M.stone);
      box(w, 8, d - 6, 0, 0, -3, M.dark);
      if (it.top === 'sink') box(Math.min(w - 16, 60), 1, d - 22, 0, 86.2, 2, M.stainless);
      if (it.top === 'stove') {
        box(Math.min(w - 10, 76), 1, d - 16, 0, 86, 0, M.black);
        for (const k of [-1, 1]) cyl(9, 2, 9, k * Math.min(w, 76) * 0.24, 86.5, 0, M.dark, 18);
      }
      break;
    }
    case 'fridge': {
      const h = clipH(H);
      box(w, h, d, 0, 0, 0, M.white);
      box(w - 2, 0.6, 0.6, 0, h * 0.62, hd + 0.3, M.dark);
      box(2, Math.min(40, h * 0.25), 3, hw - 8, h * 0.68, hd + 1.5, M.stainless);
      break;
    }
    case 'washer':
      box(w, 88, d, 0, 0, 0, M.white);
      cyl(Math.min(w, d) * 0.33, 1, Math.min(w, d) * 0.33, 0, 88, 3, M.dark);
      box(w, 10, 8, 0, 88, -hd + 4, M.white);
      break;
    case 'laundry':
      legs(4, 60, 2, M.stainless);
      box(w, 25, d, 0, 60, 0, M.stainless);
      box(w - 8, 1, d - 8, 0, 85.1, 0, M.water);
      break;
    case 'ac':
      box(w, H, d, 0, 0, 0, M.white);
      box(w - 10, 3, 2, 0, 4, hd, M.dark);
      break;
    case 'acout':
      box(w, H, d, 0, 0, 0, M.white);
      cyl(H * 0.34, 2, H * 0.34, w * 0.1, H / 2, hd, M.dark).rotation.x = Math.PI / 2;
      break;
    case 'ledge':
      box(w, 10, d, 0, -10, 0, M.concrete);
      box(w, 12, 4, 0, 0, hd - 2, M.concrete);
      break;
    case 'duct':
    case 'column':
      box(w, clipH(H), d, 0, 0, 0, M.concrete);
      break;
    case 'elevator': {
      const h = clipH(Math.min(H, 240));
      box(w, 4, d, 0, 0, 0, M.steel);
      box(w, h, 3, 0, 0, -hd + 1.5, M.steel);
      box(3, h, d, -hw + 1.5, 0, 0, M.steel);
      box(3, h, d, hw - 1.5, 0, 0, M.steel);
      box(w * 0.3, 3, 1, 0, 95, -hd + 3, M.dark);
      break;
    }
    case 'plant':
      cyl(hw * 0.7, 35, hd * 0.7, 0, 0, 0, M.pot);
      { const s = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), M.plant); s.scale.set(hw, (H - 35) / 2, hd); s.position.set(0, 35 + (H - 35) / 2, 0); g.add(s); }
      break;
    case 'stair': {
      const sg = stairGeometry(it);
      for (const s of sg.steps3d) {
        const top = s.top;
        const m = box(s.x1 - s.x0, top, s.y1 - s.y0, (s.x0 + s.x1) / 2, 0, (s.y0 + s.y1) / 2, M.stone);
        if (m) m.material = M.stone;
      }
      break;
    }
    default:
      box(w, H, d, 0, 0, 0, M.stone);
  }
  return g;
}

function makeLabel(title, sub) {
  const c = document.createElement('canvas');
  const scale = 2;
  const ctx = c.getContext('2d');
  const font = '600 44px "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
  ctx.font = font;
  const tw = Math.max(ctx.measureText(title).width, sub ? 150 : 0);
  c.width = Math.ceil(tw + 40) * scale;
  c.height = (sub ? 110 : 66) * scale;
  ctx.scale(scale, scale);
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(40,38,34,0.88)';
  ctx.fillText(title, c.width / scale / 2, 8);
  if (sub) {
    ctx.font = '500 30px "IBM Plex Mono", ui-monospace, monospace';
    ctx.fillStyle = 'rgba(40,38,34,0.62)';
    ctx.fillText(sub, c.width / scale / 2, 62);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const hcm = sub ? 44 : 27; // 文字在地板上的高度（cm）
  const wcm = (c.width / c.height) * hcm;
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(wcm, hcm), mat);
  m.rotation.x = -Math.PI / 2;
  m.userData.ownMaterial = true;
  m.renderOrder = 2;
  return m;
}
