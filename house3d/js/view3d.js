// 3D 檢視：Three.js。模型以公分建立，根節點縮放 0.01 → 公尺。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import {
  wallFrame, wallSegments, wallExtents, openingEnds, polygonCentroid, areaM2, ROOM_KINDS, planBounds, itemCorners,
} from './model.js';
import { itemHeight, itemElev } from './catalog.js';
import { STYLES } from './styles.js';
import { buildItem, buildPendants } from './furniture3d.js';
import { latOf, sunPosition, sunVector, planFrame, buildingTop, roofLevel, STOREY_H } from './site.js';

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
    this.hemi = hemi;
    this.scene.add(hemi);
    this.sun = new THREE.DirectionalLight(0xfff3e2, 2.3);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
    const fill = new THREE.DirectionalLight(0xdde6ff, 0.45);
    fill.position.set(10, 8, 20);
    this.fill = fill;
    this.scene.add(fill);
    this.shadowOnly = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false });
    this.ctxMats = {
      mass: new THREE.MeshStandardMaterial({ color: 0xcfcac0, roughness: 1 }),
      neighbor: new THREE.MeshStandardMaterial({ color: 0xaeb3b8, roughness: 1, transparent: true, opacity: 0.16, depthWrite: false }),
      edge: new THREE.LineBasicMaterial({ color: 0x7d838a, transparent: true, opacity: 0.55 }),
      road: new THREE.MeshStandardMaterial({ color: 0x6d7074, roughness: 1 }),
      mark: new THREE.MeshBasicMaterial({ color: 0xd94a2b }),
    };
    this.sunSim = { on: false, month: 12, hour: 10 };

    this.ground = new THREE.Mesh(new THREE.CircleGeometry(60, 64), new THREE.MeshStandardMaterial({ color: 0xd8d3c8, roughness: 1 }));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -(SLAB + 1) / 100;
    this.ground.receiveShadow = true;
    this.scene.add(this.ground);

    this.root = new THREE.Group();
    this.root.scale.setScalar(0.01);
    this.scene.add(this.root);

    this.styleKey = 'basic';
    this.mats = makeMaterials('basic');
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

  setStyle(key) {
    const k = STYLES[key] ? key : 'basic';
    if (k === this.styleKey) return;
    disposeMaterials(this.mats);
    this.styleKey = k;
    this.mats = makeMaterials(k);
    if (this.dark !== undefined) this.mats.cap.color.set(this.dark ? 0x1d2024 : 0x3a3e44);
    this.invalidate();
  }

  setTheme(dark) {
    this.dark = dark;
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
    if ((plan.style || 'basic') !== this.styleKey) this.setStyle(plan.style || 'basic');
    this.clearRoot();
    const M = this.mats;
    const cut = this.cutHeight;
    const sunOn = this.sunSim.on;

    // 樓板＋地坪
    for (const r of plan.rooms) {
      if (r.pts.length < 3) continue;
      const shape = new THREE.Shape(r.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      if (r.kind === 'void') {
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(Math.PI / 2);
        const m = new THREE.Mesh(g, M.voidFloor);
        m.position.y = sunOn ? -(plan.elevation || 0) + 2 : -140;
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
    for (const w of plan.walls) this.buildWall(plan, w, cut, sunOn);
    if (sunOn) this.buildContext(plan, cut);

    // 家具
    for (const it of plan.items) {
      const g = buildItem(it, M, cut, plan);
      g.position.set(it.x, itemElev(it), it.y);
      g.rotation.y = -(it.rot || 0) * Math.PI / 180;
      g.traverse((o) => { if (o.isMesh) { o.castShadow = o.userData.noShadow ? false : true; o.receiveShadow = true; o.userData.itemId = it.id; } });
      g.userData.itemId = it.id;
      this.root.add(g);
      this.itemGroups.set(it.id, g);
      if ((it.kind === 'table' || it.kind === 'island') && it.pendant !== false) {
        const pg = buildPendants(plan, it, M, cut);
        if (pg) { g.add(pg); pg.position.y = -itemElev(it); }
      }
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
    this.updateSun();
    if (this.first) { this.first = false; this.setView('iso', true); }
  }

  // ---------- 日照模擬：周邊建物、下方樓層、只投影不顯示的天花板與上半段牆 ----------
  buildContext(plan, cut) {
    const site = this.app.site;
    const fr = planFrame(plan);
    const elev = plan.elevation || 0;
    const H = plan.wallHeight || 300;
    const C = this.ctxMats;
    const add = (geo, mat, x, y, z, { cast = true, recv = true } = {}) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast; m.receiveShadow = recv;
      m.userData.ctx = true;
      this.root.add(m);
      return m;
    };
    const box = (x0, x1, y0, y1, z0, z1, mat, opt) => {
      if (x1 - x0 < 1 || y1 - y0 < 1 || z1 - z0 < 1) return null;
      const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      const m = add(geo, mat, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, opt);
      if (mat === C.neighbor) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), C.edge);
        e.position.copy(m.position);
        e.userData.ctx = true;
        this.root.add(e);
      }
      return m;
    };
    // 外框（扣掉天井）擠出
    const voids = plan.rooms.filter((r) => r.kind === 'void' && r.pts.length >= 3);
    const footprint = (y0, y1, mat, opt) => {
      if (y1 - y0 < 1) return;
      const sh = new THREE.Shape([new THREE.Vector2(fr.minX - 9, fr.minY - 9), new THREE.Vector2(fr.maxX + 9, fr.minY - 9), new THREE.Vector2(fr.maxX + 9, fr.maxY + 9), new THREE.Vector2(fr.minX - 9, fr.maxY + 9)]);
      for (const v of voids) sh.holes.push(new THREE.Path(v.pts.map((p) => new THREE.Vector2(p.x, p.y))));
      const g = new THREE.ExtrudeGeometry(sh, { depth: y1 - y0, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      const m = add(g, mat, 0, y1, 0, opt);
      return m;
    };
    // 下方樓層
    if (elev > 20) footprint(-elev, -SLAB - 0.5, C.mass);
    // 天花板＋上方樓層（不顯示，只擋陽光）
    const top = buildingTop(site) - elev;
    footprint(H, Math.max(H + 15, top), this.shadowOnly, { recv: false });
    // 樓上陽台板＝雨遮
    if (elev + (plan.floorHeight || 350) < roofLevel(site) - 1) {
      for (const r of plan.rooms) {
        if (r.kind !== 'balcony' || r.pts.length < 3) continue;
        const sh = new THREE.Shape(r.pts.map((p) => new THREE.Vector2(p.x, p.y)));
        const g = new THREE.ExtrudeGeometry(sh, { depth: 15, bevelEnabled: false });
        g.rotateX(Math.PI / 2);
        add(g, this.shadowOnly, 0, (plan.floorHeight || 350), 0, { recv: false });
      }
    }
    // 地面、道路與鄰房
    const g0 = -elev;
    const W = 3000;
    for (const side of ['front', 'back', 'left', 'right']) {
      const sd = site.sides[side];
      if (!sd || sd.type === 'open') continue;
      const hgt = Math.max(1, sd.floors || 0) * STOREY_H;
      const dist = sd.type === 'party' ? 0 : Math.max(0.5, sd.dist || 0) * 100;
      const deep = 900;
      if (side === 'front') {
        if (sd.type === 'road') box(fr.minX - W, fr.maxX + W, g0 - 2, g0 + 1, fr.maxY + 180, fr.maxY + dist, C.road, { cast: false });
        box(fr.minX - W, fr.maxX + W, g0, g0 + hgt, fr.maxY + dist, fr.maxY + dist + deep, C.neighbor);
      } else if (side === 'back') {
        box(fr.minX - W, fr.maxX + W, g0, g0 + hgt, fr.minY - dist - deep, fr.minY - dist, C.neighbor);
      } else if (side === 'left') {
        box(fr.minX - dist - 600, fr.minX - dist - (sd.type === 'party' ? 9 : 0), g0, g0 + hgt, fr.minY, fr.maxY, C.neighbor);
      } else {
        box(fr.maxX + dist + (sd.type === 'party' ? 9 : 0), fr.maxX + dist + 600, g0, g0 + hgt, fr.minY, fr.maxY, C.neighbor);
      }
    }
    // 指北針
    const north = sunVector(site, 0, 0);
    const len = Math.hypot(north.x, north.y) || 1;
    const nx = north.x / len, nz = north.y / len;
    const cx = fr.maxX + 140, cz = fr.maxY + 60;
    const arrow = new THREE.Shape([new THREE.Vector2(0, -70), new THREE.Vector2(22, 30), new THREE.Vector2(0, 14), new THREE.Vector2(-22, 30)]);
    const ag = new THREE.ShapeGeometry(arrow);
    ag.rotateX(Math.PI / 2);
    const am = add(ag, C.mark, cx, 3, cz, { cast: false, recv: false });
    am.rotation.y = Math.atan2(-nx, -nz) + Math.PI;
    am.material.side = THREE.DoubleSide;
    void cut;
  }

  updateSun() {
    const plan = this.app.plan;
    if (!plan) return;
    const on = this.sunSim.on;
    this.ground.position.y = on ? -(plan.elevation || 0) / 100 - 0.02 : -(SLAB + 1) / 100;
    if (!on) {
      this.hemi.intensity = 1.35; this.fill.intensity = 0.45; this.sun.intensity = 2.3;
      this.sun.position.set(this.center.x - 9, 22, this.center.z - 12);
      return;
    }
    const site = this.app.site;
    const day = Math.round((this.sunSim.month - 1) * 30.42 + 21);
    const { alt, az } = sunPosition(latOf(site), day, this.sunSim.hour);
    this.sunInfo = { alt, az, day };
    const v = sunVector(site, alt, az);
    const c = this.center;
    const D = 40;
    this.sun.position.set(c.x + v.x * D, Math.max(0.2, v.z) * D, c.z + v.y * D);
    this.sun.target.position.set(c.x, 0, c.z);
    const up = Math.max(0, Math.sin(alt));
    this.sun.intensity = alt > 0 ? 1.2 + 2.6 * Math.min(1, up * 2.2) : 0;
    this.sun.color.setHSL(0.09, alt > 0.35 ? 0.35 : 0.75, 0.62 + 0.2 * Math.min(1, up * 2));
    this.hemi.intensity = alt > 0 ? 0.55 + 0.35 * up : 0.25;
    this.fill.intensity = 0.08;
    const cam = this.sun.shadow.camera;
    const R = Math.max(this.radius, 12);
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 1; cam.far = 120;
    cam.updateProjectionMatrix();
    this.app.onSunUpdate?.(this.sunInfo);
  }

  setSunSim(patch) {
    const was = this.sunSim.on;
    Object.assign(this.sunSim, patch);
    if (was !== this.sunSim.on || patch.rebuild) this.invalidate();
    else this.updateSun();
  }

  buildWall(plan, w, cut, sunOn = false) {
    const M = this.mats;
    const { L, u } = wallFrame(w);
    if (L < 0.5) return;
    const Hfull = w.h ?? plan.wallHeight;
    const H = Math.min(Hfull, cut ?? Infinity);
    const { extA, extB } = wallExtents(plan, w);
    const ang = Math.atan2(u.y, u.x);
    const selected = this.app.sel?.type === 'wall' && this.app.sel.id === w.id;
    const side = selected ? M.wallSel : (w.kind === 'parapet' ? M.parapet : M.wall);
    const mats = [side, side, M.cap, side, side, side];
    const addBox = (s, e, y0, y1, ghost = false) => {
      if (e - s < 0.3 || y1 - y0 < 0.3) return;
      const g = new THREE.BoxGeometry(e - s, y1 - y0, w.t);
      const m = new THREE.Mesh(g, ghost ? this.shadowOnly : mats);
      const mid = (s + e) / 2;
      m.position.set(w.a.x + u.x * mid, (y0 + y1) / 2, w.a.y + u.y * mid);
      m.rotation.y = -ang;
      m.castShadow = true; m.receiveShadow = !ghost;
      m.userData = ghost ? { ghost: true } : { kind: 'wall', id: w.id };
      this.root.add(m);
    };
    // 剖切線以上的牆：日照模擬時保留成看不見、但會擋陽光的量體
    const piece = (s, e, y0, y1) => {
      addBox(s, e, y0, Math.min(y1, H));
      if (sunOn && y1 > H) addBox(s, e, Math.max(y0, H), y1, true);
    };
    for (const sg of wallSegments(plan, w)) {
      const s = sg.s - (sg.s <= 0.01 ? extA : 0), e = sg.e + (sg.e >= L - 0.01 ? extB : 0);
      if (sg.solid) { piece(s, e, -SLAB, Hfull); continue; }
      const o = sg.opening;
      const sill = o.sill || 0, top = sill + (o.h || 210);
      piece(s, e, -SLAB, Math.min(sill, Hfull));
      if (top < Hfull) piece(s, e, top, Hfull);
      if (sill < H) this.buildOpening(plan, o, w, Math.min(top, H), sill, H);
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
    const tag = (m) => { const ns = !!m.userData.noShadow; m.userData = { kind: 'opening', id: o.id, noShadow: ns }; m.castShadow = !ns; return m; };
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
      const glass = new THREE.Mesh(new THREE.BoxGeometry(o.w - 2, hgt - 2, 1.5), selected ? M.accentGlass : o.frosted ? M.glassFrost : M.glass);
      glass.userData.noShadow = true;
      place(glass, o.pos, 0, sill + hgt / 2);
      if (o.shade && w.kind === 'ext') {
        const sgn = this.outSide(plan, w, n);
        const fin = new THREE.Mesh(new THREE.BoxGeometry(o.w + 30, 4, 45), M.metal);
        place(fin, o.pos, sgn * (w.t / 2 + 22), Math.min(top + 8, H - 2));
      }
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

  // 外牆的室外側：+1 表示法線 n 方向是室外
  outSide(plan, w, n) {
    const b = planBounds(plan);
    const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
    return (m.x - c.x) * n.x + (m.y - c.y) * n.y >= 0 ? 1 : -1;
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

function concreteTex(base) {
  return canvasTex((g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 2600; i++) {
      const v = rnd() < 0.5 ? 0 : 255;
      g.fillStyle = `rgba(${v},${v},${v},${0.02 + rnd() * 0.04})`;
      const r = 1 + rnd() * 3;
      g.fillRect(rnd() * s, rnd() * s, r, r);
    }
    g.globalAlpha = 0.05;
    for (let i = 0; i < 6; i++) { g.fillStyle = rnd() < 0.5 ? '#000' : '#fff'; g.beginPath(); g.arc(rnd() * s, rnd() * s, 30 + rnd() * 60, 0, Math.PI * 2); g.fill(); }
    g.globalAlpha = 1;
  }, 256, 180);
}

function marbleTex(base, vein, size = 120) {
  return canvasTex((g, s) => {
    g.fillStyle = base; g.fillRect(0, 0, s, s);
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    g.strokeStyle = vein; g.lineCap = 'round';
    for (let i = 0; i < 7; i++) {
      g.globalAlpha = 0.18 + rnd() * 0.25; g.lineWidth = 0.6 + rnd() * 1.6;
      g.beginPath();
      let x = rnd() * s, y = 0;
      g.moveTo(x, y);
      while (y < s) { x += (rnd() - 0.45) * 26; y += 10 + rnd() * 18; g.lineTo(x, y); }
      g.stroke();
    }
    g.globalAlpha = 0.5; g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 2; g.strokeRect(0, 0, s, s);
    g.globalAlpha = 1;
  }, 256, size);
}

function floorMat(std, f) {
  if (!f) return std(0xe3ddd2);
  if (f.tex === 'wood') return std(0xffffff, { map: woodTex(f.base, f.dark), roughness: 0.7 });
  if (f.tex === 'tile') return std(0xffffff, { map: tileTex(f.base, f.dark, f.size || 60), roughness: 0.55 });
  if (f.tex === 'concrete') return std(0xffffff, { map: concreteTex(f.base), roughness: 0.75 });
  if (f.tex === 'marble') return std(0xffffff, { map: marbleTex(f.base, f.dark, f.size || 120), roughness: 0.25 });
  return std(f.base);
}

function makeMaterials(styleKey = 'basic') {
  const S = STYLES[styleKey] || STYLES.basic;
  const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, ...extra });
  const glow = (color, k = 0.55) => new THREE.MeshStandardMaterial({ color, roughness: 0.9, emissive: new THREE.Color(color), emissiveIntensity: k });
  const repeat1 = (t) => { t.repeat.set(1, 1); return t; };
  const counterTop = S.counterTex === 'marble' ? std(0xffffff, { map: repeat1(marbleTex(S.counterTop, '#b9b0a3', 120)), roughness: 0.25 })
    : S.counterTex === 'concrete' ? std(0xffffff, { map: repeat1(concreteTex(S.counterTop)), roughness: 0.7 })
      : std(S.counterTop, { roughness: 0.4 });
  return {
    wall: std(S.walls, { roughness: 0.95 }),
    wallSel: std(0xf2d95c, { roughness: 0.9 }),
    parapet: std(S.parapet, { roughness: 0.95 }),
    cap: std(0x3a3e44, { roughness: 1 }),
    slabSide: std(0xbdb7ab, { roughness: 1 }),
    voidFloor: new THREE.MeshBasicMaterial({ color: 0x3b4247, side: THREE.DoubleSide }),
    floor: {
      living: floorMat(std, S.floor.living),
      bedroom: floorMat(std, S.floor.bedroom),
      hall: floorMat(std, S.floor.hall),
      kitchen: floorMat(std, S.floor.kitchen),
      bath: floorMat(std, S.floor.bath),
      balcony: floorMat(std, S.floor.balcony),
      stair: std(0xd2cfc8, { roughness: 0.8 }),
      elevator: std(0x9aa1a7, { roughness: 0.4, metalness: 0.5 }),
      storage: floorMat(std, S.floor.hall),
      other: floorMat(std, S.floor.hall),
    },
    door: std(S.door, { roughness: 0.6 }),
    frame: std(S.frame),
    glass: new THREE.MeshPhysicalMaterial({ color: 0xcfe6ee, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.28, depthWrite: false }),
    glassFrost: new THREE.MeshPhysicalMaterial({ color: 0xf4f6f6, roughness: 0.6, transparent: true, opacity: 0.72, depthWrite: false }),
    glassDark: new THREE.MeshStandardMaterial({ color: 0x3d4a50, roughness: 0.1, metalness: 0.3, transparent: true, opacity: 0.55 }),
    mirror: std(0xdfe8ec, { roughness: 0.05, metalness: 0.9 }),
    screen: std(0x1d2733, { roughness: 0.15, metalness: 0.2 }),
    accentGlass: new THREE.MeshPhysicalMaterial({ color: 0xf2d95c, transparent: true, opacity: 0.5, depthWrite: false }),
    alu: std(0x8d949a, { metalness: 0.6, roughness: 0.35 }),
    aluLine: new THREE.LineBasicMaterial({ color: 0x6d747a }),
    steel: std(0xb7bcc1, { metalness: 0.75, roughness: 0.3 }),
    accent: std(0xf2c230, { roughness: 0.6 }),
    selLine: new THREE.LineBasicMaterial({ color: 0xf2a900, linewidth: 2 }),
    wood: std(S.wood, { roughness: 0.6 }),
    woodLight: std(S.woodLight, { roughness: 0.65 }),
    woodDark: std(S.woodDark, { roughness: 0.6 }),
    cabinet: std(S.cabinet, { roughness: 0.6 }),
    white: std(0xfafaf7, { roughness: 0.4 }),
    porcelain: std(0xffffff, { roughness: 0.2 }),
    fabric: std(S.fabric, { roughness: 1 }),
    fabric2: std(S.fabric2, { roughness: 1 }),
    fabric3: std(S.fabric3, { roughness: 1 }),
    sofa: std(S.sofa, { roughness: 1 }),
    rug: std(S.rug, { roughness: 1 }),
    bedding: std(S.bedding, { roughness: 1 }),
    throw: std(S.throw, { roughness: 1 }),
    leather: std(S.leather, { roughness: 0.48, metalness: 0.05 }),
    brass: std(S.brass, { roughness: 0.32, metalness: 0.85 }),
    paper: glow(S.paper, 0.6),
    cane: std(S.cane, { roughness: 0.9 }),
    plaster: std(S.plaster, { roughness: 1 }),
    kitchenFront: std(S.kitchenFront, { roughness: 0.55 }),
    counterTop,
    marble: std(0xffffff, { map: repeat1(marbleTex('#efebe5', '#b8afa2', 120)), roughness: 0.22 }),
    tatami: std(0xffffff, { map: repeat1(tatamiTex()), roughness: 0.9 }),
    altarWood: std(0x5e2419, { roughness: 0.45 }),
    redGlow: glow('#d8402a', 0.8),
    stone: std(S.stone, { roughness: 0.45 }),
    metal: std(S.metal, { roughness: 0.35, metalness: 0.6 }),
    lampShade: new THREE.MeshStandardMaterial({ color: S.lampShade, roughness: 0.9, emissive: new THREE.Color(S.lampShade), emissiveIntensity: 0.35, side: THREE.DoubleSide }),
    dark: std(0x2b2e33, { roughness: 0.5 }),
    black: std(0x151618, { roughness: 0.3 }),
    concrete: std(0xb9b5ad, { roughness: 1 }),
    stainless: std(0xc9ced2, { metalness: 0.8, roughness: 0.25 }),
    plant: std(S.foliage, { roughness: 0.9 }),
    pot: std(S.pot, { roughness: 0.7, metalness: S.pot === S.brass ? 0.7 : 0 }),
    water: std(0xbfdbe6, { roughness: 0.1 }),
  };
}

function tatamiTex() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#cdc28a'; g.fillRect(0, 0, 128, 256);
  g.strokeStyle = 'rgba(90,80,30,0.25)'; g.lineWidth = 1;
  for (let y = 2; y < 256; y += 3) { g.beginPath(); g.moveTo(10, y); g.lineTo(118, y); g.stroke(); }
  g.fillStyle = '#2f3330'; g.fillRect(0, 0, 9, 256); g.fillRect(119, 0, 9, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function disposeMaterials(M) {
  const all = [];
  for (const v of Object.values(M)) {
    if (v && v.isMaterial) all.push(v);
    else if (v && typeof v === 'object') for (const x of Object.values(v)) if (x?.isMaterial) all.push(x);
  }
  for (const m of all) { m.map?.dispose(); m.dispose(); }
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
