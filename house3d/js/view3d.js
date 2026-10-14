// 3D 檢視：Three.js。模型以公分建立，根節點縮放 0.01 → 公尺。
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/OrbitControls.js';
import {
  wallFrame, wallSegments, wallExtents, openingEnds, polygonCentroid, areaM2, ROOM_KINDS, planBounds, itemCorners, pointInPolygon as pointIn,
} from './model.js';
import { itemHeight, itemElev } from './catalog.js';
import { STYLES } from './styles.js';
import { buildItem, buildPendants } from './furniture3d.js';
import { latOf, sunPosition, sunVector, planFrame, buildingTop, roofLevel, STOREY_H } from './site.js';
import { floorList, FRAMES } from './building.js';

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
    this._mats = new Map();
    this.mats = this.matsFor('basic');
    this.out = this.root;
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

  // 各風格的材質（整棟模式會同時用到好幾種，所以留著不丟）
  matsFor(key) {
    const k = STYLES[key] ? key : 'basic';
    if (!this._mats.has(k)) {
      const m = makeMaterials(k);
      if (this.dark !== undefined) m.cap.color.set(this.dark ? 0x1d2024 : 0x3a3e44);
      this._mats.set(k, m);
    }
    return this._mats.get(k);
  }

  setStyle(key) {
    const k = STYLES[key] ? key : 'basic';
    if (k === this.styleKey) return;
    this.styleKey = k;
    this.mats = this.matsFor(k);
    this.invalidate();
  }

  setTheme(dark) {
    this.dark = dark;
    this.ground.material.color.set(dark ? 0x2a2d31 : 0xd8d3c8);
    for (const m of this._mats.values()) m.cap.color.set(dark ? 0x1d2024 : 0x3a3e44);
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
    if (this.paused) return; // 擬真渲染時暫停即時畫面，把顯示卡讓給光線追蹤
    if (this.pending && !this.drag3d) { this.pending = false; this.rebuild(); }
    if (this.mode === 'walk') this.walkStep();
    if (this.ventAnim?.length) {
      const t = performance.now() / 1000;
      for (const a of this.ventAnim) a.obj.position.copy(a.base).addScaledVector(a.dir, (((t * 0.6 + a.phase) % 1) - 0.5) * 50);
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  // ---------- 建模 ----------
  clearRoot() {
    this.ventAnim = [];
    for (const l of this.scene.children.filter((o) => o.userData.renderLight)) this.scene.remove(l);
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
    this.out = this.root;
    if (this.app.bmode && this.app.project.building) {
      this.clearRoot();
      this.buildBuilding();
      this.updateSelection();
      if (this.first) { this.first = false; this.setView('iso', true); }
      return;
    }
    this.bstate = null;
    this.targetY = null;
    const plan = this.app.plan;
    if (!plan) return;
    if ((plan.style || 'basic') !== this.styleKey) this.setStyle(plan.style || 'basic');
    this.clearRoot();
    const rm = this.renderMode;
    const sunOn = this.sunSim.on && !rm;
    const cut = rm?.interior ? null : this.cutHeight;
    this.buildPlanBody(plan, { cut, sunOn, labels: this.showLabels && !rm });
    if (sunOn) this.buildContext(plan, cut);
    if (rm?.interior) { this.buildCeilings(plan, rm); this.buildRenderContext(plan); }
    if (!rm) this.buildVentArrows(plan);
    if (!rm) this.updateSelection();
    this.fitShadows(plan);
    this.updateSun();
    if (this.first) { this.first = false; this.setView('iso', true); }
  }

  // 一層平面的樓板、牆、門窗、家具、標籤。bld：整棟模式的外觀設定（外牆材質、欄杆、樓高）
  buildPlanBody(plan, { cut = null, sunOn = false, labels = false, items = true, bld = null } = {}) {
    const M = this.mats;
    // 樓板＋地坪
    for (const r of plan.rooms) {
      if (r.pts.length < 3) continue;
      const shape = new THREE.Shape(r.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      if (r.kind === 'void') {
        if (bld && (plan.elevation || 0) > 1) continue; // 整棟模式：天井往下看得到一樓的天井地面
        const g = new THREE.ShapeGeometry(shape);
        g.rotateX(Math.PI / 2);
        const m = new THREE.Mesh(g, bld ? M.floor.balcony : M.voidFloor);
        m.position.y = bld ? 1 : sunOn ? -(plan.elevation || 0) + 2 : -140;
        m.receiveShadow = !!bld;
        this.out.add(m);
        continue;
      }
      const g = new THREE.ExtrudeGeometry(shape, { depth: SLAB, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      const floor = M.floor[r.kind] || M.floor.other;
      const mesh = new THREE.Mesh(g, [floor, bld ? bld.F.slab : M.slabSide]);
      mesh.receiveShadow = true;
      mesh.castShadow = !!bld;
      mesh.userData = { kind: 'room', id: r.id };
      this.out.add(mesh);
    }

    // 牆
    for (const w of plan.walls) this.buildWall(plan, w, cut, sunOn, bld);

    // 家具
    if (items) for (const it of plan.items) {
      if (bld && !bld.focus && ['ac', 'rug', 'chair'].includes(it.kind)) continue;
      const g = buildItem(it, M, cut, plan);
      g.position.set(it.x, itemElev(it), it.y);
      g.rotation.y = -(it.rot || 0) * Math.PI / 180;
      g.traverse((o) => { if (o.isMesh) { o.castShadow = o.userData.noShadow ? false : true; o.receiveShadow = true; o.userData.itemId = it.id; } });
      g.userData.itemId = it.id;
      this.out.add(g);
      if (!bld) this.itemGroups.set(it.id, g);
      if ((it.kind === 'table' || it.kind === 'island') && it.pendant !== false) {
        const pg = buildPendants(plan, it, M, cut);
        if (pg) { g.add(pg); pg.position.y = -itemElev(it); }
      }
    }

    // 標籤
    if (labels) {
      for (const r of plan.rooms) {
        if (!r.name || r.pts.length < 3) continue;
        if (bld && r.kind === 'void') continue;
        const c = r.label || polygonCentroid(r.pts);
        const a = areaM2(r.pts);
        const lab = makeLabel(r.name, r.kind === 'void' ? '' : `${a.toFixed(1)}㎡`);
        lab.position.set(c.x, r.kind === 'void' ? -138 : 1.2, c.y);
        this.out.add(lab);
      }
    }
  }

  // 通風模擬開著時：門窗上的風向箭頭（藍進、橘出），天井、樓梯間往上的箭頭；箭頭會沿風向漂動
  buildVentArrows(plan) {
    const vs = this.app.vent;
    if (!vs?.show || !vs.result || vs.planId !== plan.id) return;
    const r = vs.result;
    const g = new THREE.Group();
    const mk = (color) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
    const mats = { in: mk(0x1f6fb2), out: mk(0xd9822b), mid: mk(0x6c9cc4) };
    const UP = new THREE.Vector3(0, 1, 0);
    const arrow = (len, rad, mat) => {
      const a = new THREE.Group();
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(rad, rad, len * 0.62, 10), mat);
      shaft.position.y = len * 0.31;
      const head = new THREE.Mesh(new THREE.ConeGeometry(rad * 2.4, len * 0.38, 14), mat);
      head.position.y = len * 0.81;
      a.add(shaft, head);
      return a;
    };
    for (const ed of r.edges) {
      if (!ed.at || ed.kind === 'leak') continue;
      const q = Math.abs(ed.Q) * 3600;
      if (q < 15) continue;
      const len = Math.max(45, Math.min(130, 30 * Math.log2(1 + q / 15)));
      const rad = Math.max(3, Math.min(9, len * 0.06));
      let d, cls, y;
      if (ed.kind === 'top') {
        if (ed.Q <= 0) continue;
        d = UP.clone(); cls = 'out'; y = (plan.wallHeight || 300) * 0.45;
      } else {
        if (!ed.dir) continue;
        const s = ed.Q >= 0 ? 1 : -1;
        d = new THREE.Vector3(ed.dir.x * s, 0, ed.dir.y * s).normalize();
        cls = ed.kind === 'win' ? (ed.Q < 0 ? 'in' : 'out') : 'mid';
        y = ed.z * 100 - (r.elev || 0);
      }
      const a = arrow(len, rad, mats[cls]);
      a.quaternion.setFromUnitVectors(UP, d);
      a.position.set(ed.at.x - d.x * len / 2, ed.kind === 'top' ? y : y - d.y * len / 2, ed.at.y - d.z * len / 2);
      g.add(a);
      this.ventAnim.push({ obj: a, base: a.position.clone(), dir: d, phase: Math.random() });
    }
    g.traverse((o) => { if (o.isMesh) { o.userData.ownMaterial = true; o.renderOrder = 5; } });
    this.root.add(g);
  }

  // ---------- 整棟外觀 ----------
  buildBuilding() {
    const app = this.app;
    const b = app.project.building;
    const site = app.site;
    const floors = floorList(b, site);
    const focus = floors.some((f) => f.id === b.focus) ? b.focus : 'all';
    const fi = floors.findIndex((f) => f.id === focus);
    const F = this.facadeMats(b.facade);
    const base0 = this.matsFor('basic');
    let top = 0, roofPlan = null, topFull = null;
    const shown = [];
    for (let i = 0; i < floors.length; i++) {
      const fl = floors[i];
      if (fi >= 0 && i > fi) break;
      const p = app.floorPlan(fl);
      if (!p) continue;
      const g = new THREE.Group();
      g.position.y = fl.elev;
      g.userData.floor = fl.id;
      this.root.add(g);
      this.out = g;
      const isFocus = fl.id === focus;
      const base = this.matsFor(p.style || 'basic');
      this.mats = { ...base, alu: F.frame, aluLine: F.frameLine, ...(isFocus ? {} : { glass: F.glass }) };
      this.buildPlanBody(p, {
        cut: isFocus ? (this.cutHeight ?? null) : null, labels: isFocus && this.showLabels && !this.renderMode,
        items: isFocus || fl.level === 1 || !!fl.roof,
        bld: { F, rail: b.facade.rail, awning: !!b.facade.awning, elev: fl.elev, focus: isFocus },
      });
      g.traverse((o) => { o.userData.floor = fl.id; });
      shown.push({ fl, p });
      top = Math.max(top, fl.elev + (fl.roof ? (p.floorHeight || 350) : (p.floorHeight || 350)));
      if (fl.roof) roofPlan = { fl, p };
      else topFull = { fl, p };
    }
    this.mats = base0;
    this.out = this.root;
    const allShown = fi < 0;
    // 屋頂：頂樓房間上方，或沒有頂樓時蓋在最上面一層
    if (allShown) {
      if (roofPlan) this.buildRoofTop(roofPlan.p, roofPlan.fl.elev + (roofPlan.p.floorHeight || 350), b.facade, F, true);
      else if (topFull) this.buildRoofTop(topFull.p, topFull.fl.elev + (topFull.p.floorHeight || 350), b.facade, F, false);
      if (b.facade.grille && b.facade.grille !== 'none') this.buildGrille(floors, top, F);
    }
    if (roofPlan && allShown) top += b.facade.roof === 'pitched' ? 170 : 180;
    this.buildNeighbors(site, F);
    if (!this.renderMode) this.buildFloorTags(shown, focus);
    // 取景
    const minY = -131, maxY = 1722;
    const cx = 3, cz = (minY + maxY) / 200;
    const h = Math.max(3, top / 100);
    this.center = new THREE.Vector3(cx, 0, cz);
    this.targetY = fi >= 0 ? (floors[fi].elev + 120) / 100 : h * 0.45;
    this.size = { w: 6.6, d: (maxY - minY) / 100, h, y0: 0 };
    this.radius = Math.max(9, h / 2 + 4);
    const cam = this.sun.shadow.camera;
    const R = Math.max(12, h * 0.75 + 4);
    cam.left = -R; cam.right = R; cam.top = R; cam.bottom = -R; cam.near = 0.5; cam.far = 120;
    cam.updateProjectionMatrix();
    this.sun.position.set(cx - 14, h + 18, cz - 10);
    this.sun.target.position.set(cx, h / 3, cz);
    this.ground.position.set(cx, -(SLAB + 1) / 100, cz);
    this.hemi.intensity = 1.35; this.fill.intensity = 0.45; this.sun.intensity = 2.3;
    this.bstate = { floors, focus, top };
  }

  // ---------- 擬真渲染用：天花板、室內燈、窗外的環境 ----------
  buildCeilings(plan, rm) {
    const H = plan.wallHeight || 300;
    const mat = this._ceilMat || (this._ceilMat = new THREE.MeshStandardMaterial({ color: 0xf4f2ec, roughness: 0.95 }));
    const lampMat = this._lampMat || (this._lampMat = new THREE.MeshStandardMaterial({ color: 0xfff2dc, emissive: new THREE.Color(0xffe2b8), emissiveIntensity: 6 }));
    for (const r of plan.rooms) {
      if (r.kind === 'void' || r.pts.length < 3) continue;
      const sh = new THREE.Shape(r.pts.map((p) => new THREE.Vector2(p.x, p.y)));
      const g = new THREE.ExtrudeGeometry(sh, { depth: 12, bevelEnabled: false });
      g.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(g, mat);
      m.position.y = H + 12;
      m.userData.ceiling = true;
      this.out.add(m);
      if (rm?.night && !['balcony', 'stair', 'elevator'].includes(r.kind)) {
        // 晚上：每個房間天花板一盞崁燈（點光源＋發光燈罩）
        const c = polygonCentroid(r.pts);
        const a = areaM2(r.pts);
        const disc = new THREE.Mesh(new THREE.CylinderGeometry(7, 7, 1.5, 20), lampMat);
        disc.position.set(c.x, H - 1, c.y);
        this.out.add(disc);
        const pl = new THREE.PointLight(0xffd6a0, Math.min(60, 10 + a * 2.2), 0, 2);
        pl.position.set(c.x / 100, (H - 20) / 100 + (this.out.position?.y || 0) / 100, c.y / 100);
        pl.userData.renderLight = true;
        this.scene.add(pl);
      }
    }
  }

  buildRenderContext(plan) {
    const site = this.app.site;
    const elev = plan.elevation || 0;
    const fr = planFrame(plan);
    const grey = this._ctxOpaque || (this._ctxOpaque = new THREE.MeshStandardMaterial({ color: 0xc9c6bf, roughness: 0.95 }));
    const box = (x0, x1, y0, y1, z0, z1) => {
      if (x1 - x0 < 1 || y1 - y0 < 1 || z1 - z0 < 1) return;
      const m = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), grey);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.userData.ctx = true;
      this.out.add(m);
    };
    const g0 = -elev - SLAB;
    // 樓下的量體
    if (elev > 20) box(fr.minX - 9, fr.maxX + 9, g0, -SLAB - 1, fr.minY - 9, fr.maxY + 9);
    const W = 2400;
    for (const side of ['front', 'back', 'left', 'right']) {
      const sd = site.sides[side];
      if (!sd || sd.type === 'open') continue;
      const hgt = Math.max(1, sd.floors || 0) * STOREY_H;
      const dist = sd.type === 'party' ? 0 : Math.max(0.5, sd.dist || 0) * 100;
      if (side === 'front') box(fr.minX - W, fr.maxX + W, g0, g0 + hgt, fr.maxY + dist + 180, fr.maxY + dist + 1080);
      else if (side === 'back') box(fr.minX - W, fr.maxX + W, g0, g0 + hgt, fr.minY - dist - 900, fr.minY - dist - 131);
      else if (side === 'left') box(fr.minX - dist - 900, fr.minX - dist - 10, g0, g0 + hgt, fr.minY, fr.maxY);
      else box(fr.maxX + dist + 10, fr.maxX + dist + 900, g0, g0 + hgt, fr.minY, fr.maxY);
    }
    this.ground.position.y = g0 / 100 - 0.01;
  }

  // 外觀材質（依外牆、顏色、窗框、欄杆組合快取）
  facadeMats(f) {
    const key = JSON.stringify(f);
    if (this._facade?.key === key) return this._facade.F;
    if (this._facade) disposeMaterials(this._facade.F);
    const std = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra });
    const fc = FRAMES[f.frame]?.[1] || '#26292d';
    const F = {
      wall: std(0xffffff, { map: facadeTex(f.wall, f.color), roughness: f.wall === 'stone' ? 0.5 : 0.92 }),
      slab: std(new THREE.Color(f.color).multiplyScalar(0.82), { roughness: 0.95 }),
      frame: std(fc, { metalness: f.frame === 'wood' ? 0 : 0.45, roughness: f.frame === 'wood' ? 0.7 : 0.4 }),
      frameLine: new THREE.LineBasicMaterial({ color: fc }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0x8fa6b0, roughness: 0.06, metalness: 0.35, transparent: true, opacity: 0.62, depthWrite: false }),
      railGlass: new THREE.MeshPhysicalMaterial({ color: 0xd3e6ec, roughness: 0.05, transparent: true, opacity: 0.3, depthWrite: false }),
      grille: f.grille === 'alu' ? std(0x5a5e63, { metalness: 0.6, roughness: 0.35 }) : std(0xffffff, { map: slatTex(), roughness: 0.7 }),
      roof: std(f.wall === 'tile' ? 0x7a3b2a : 0x3e4247, { roughness: 0.8 }),
      tank: std(0xd8dbde, { metalness: 0.35, roughness: 0.4 }),
      dark: std(0x2b2e33, { roughness: 0.6 }),
    };
    this._facade = { key, F };
    return F;
  }

  // 屋頂：平屋頂（樓板＋女兒牆＋水塔）、斜屋頂、花架
  buildRoofTop(p, y, f, F, isRoofPlan) {
    const g = new THREE.Group();
    g.position.y = y;
    this.root.add(g);
    const enclosed = p.rooms.filter((r) => !['balcony', 'void'].includes(r.kind) && r.pts.length > 2);
    const bx = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const r of enclosed) for (const q of r.pts) { bx.x0 = Math.min(bx.x0, q.x); bx.x1 = Math.max(bx.x1, q.x); bx.y0 = Math.min(bx.y0, q.y); bx.y1 = Math.max(bx.y1, q.y); }
    if (!isFinite(bx.x0)) return;
    const pad = 9;
    // 樓板
    for (const r of enclosed) {
      const sh = new THREE.Shape(r.pts.map((q) => new THREE.Vector2(q.x, q.y)));
      const geo = new THREE.ExtrudeGeometry(sh, { depth: SLAB + 3, bevelEnabled: false });
      geo.rotateX(Math.PI / 2);
      const m = new THREE.Mesh(geo, F.slab);
      m.position.y = SLAB;
      m.castShadow = m.receiveShadow = true;
      g.add(m);
    }
    const add = (geo, mat, x, yy, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, yy, z); m.castShadow = m.receiveShadow = true; g.add(m); return m; };
    if (f.roof === 'pitched') {
      const w = bx.x1 - bx.x0 + 2 * pad + 40, d = bx.y1 - bx.y0 + 2 * pad + 40;
      const rise = Math.tan(24 * Math.PI / 180) * w / 2;
      const geo = gableGeometry(w, d, rise);
      add(geo, F.roof, (bx.x0 + bx.x1) / 2, SLAB, (bx.y0 + bx.y1) / 2);
      // 山牆
      const tri = new THREE.Shape([new THREE.Vector2(-w / 2 + 20, 0), new THREE.Vector2(w / 2 - 20, 0), new THREE.Vector2(0, rise - 8)]);
      for (const z of [bx.y0 - pad, bx.y1 + pad]) {
        const tg = new THREE.ExtrudeGeometry(tri, { depth: 12, bevelEnabled: false });
        worldUV(tg, 0, y + SLAB);
        add(tg, F.wall, (bx.x0 + bx.x1) / 2, SLAB, z - 6);
      }
    } else {
      // 女兒牆
      const H = 60;
      for (const [x0, z0, x1, z1] of [[bx.x0, bx.y0, bx.x1, bx.y0], [bx.x0, bx.y1, bx.x1, bx.y1], [bx.x0, bx.y0, bx.x0, bx.y1], [bx.x1, bx.y0, bx.x1, bx.y1]]) {
        const L = Math.hypot(x1 - x0, z1 - z0) + 18;
        const geo = new THREE.BoxGeometry(x0 === x1 ? 15 : L, H, x0 === x1 ? L : 15);
        worldUV(geo, 0, y + SLAB + H / 2);
        add(geo, F.wall, (x0 + x1) / 2, SLAB + H / 2, (z0 + z1) / 2);
      }
      // 水塔（放在樓梯間上方）
      const tx = Math.min(bx.x1 - 90, 480), tz = Math.max(bx.y0 + 90, 200);
      add(new THREE.BoxGeometry(150, 30, 150), F.dark, tx, SLAB + 15, tz);
      const tank = add(new THREE.CylinderGeometry(58, 58, 130, 28), F.tank, tx, SLAB + 30 + 65, tz);
      void tank;
      add(new THREE.CylinderGeometry(60, 52, 14, 28), F.tank, tx, SLAB + 30 + 137, tz);
      if (f.roof === 'pergola' && isRoofPlan) this.buildPergola(p, y, F);
    }
  }

  buildPergola(p, y, F) {
    const terr = p.rooms.filter((r) => r.kind === 'balcony' && r.pts.length > 2);
    if (!terr.length) return;
    let best = null;
    for (const r of terr) { const a = areaM2(r.pts); if (!best || a > best.a) best = { r, a }; }
    const xs = best.r.pts.map((q) => q.x), ys = best.r.pts.map((q) => q.y);
    const x0 = Math.max(Math.min(...xs), 190) + 20, x1 = Math.max(...xs) - 30, z0 = Math.min(...ys) + 30, z1 = Math.min(Math.max(...ys) - 40, z0 + 360);
    const g = new THREE.Group();
    g.position.y = y - (p.floorHeight || 350);
    this.root.add(g);
    const mat = F.grille;
    const add = (w, h, d, x, yy, z) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, yy, z); m.castShadow = true; g.add(m); };
    for (const x of [x0, x1]) for (const z of [z0, z1]) add(10, 250, 10, x, 125, z);
    for (const z of [z0, z1]) add(x1 - x0 + 30, 12, 8, (x0 + x1) / 2, 254, z);
    for (let x = x0; x <= x1 + 0.1; x += 30) add(5, 10, z1 - z0 + 40, x, 265, (z0 + z1) / 2);
  }

  // 正面格柵：沿右側陽台外緣，從二樓到屋頂
  buildGrille(floors, top, F) {
    const f2 = floors.find((f) => f.level === 2);
    if (!f2) return;
    const y0 = f2.elev - SLAB, y1 = top + 60;
    const g = new THREE.Group();
    this.root.add(g);
    for (let x = 300; x <= 470; x += 12) {
      const geo = new THREE.BoxGeometry(4, y1 - y0, 9);
      const m = new THREE.Mesh(geo, F.grille);
      m.position.set(x, (y0 + y1) / 2, 1722 + 12);
      m.castShadow = true;
      g.add(m);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(186, 8, 14), F.grille);
    beam.position.set(385, y1, 1734);
    g.add(beam);
  }

  // 周邊：左右鄰房、後巷對面、馬路
  buildNeighbors(site, F) {
    const C = { ...this.ctxMats, neighbor: this.ctxMats.neighborLight || (this.ctxMats.neighborLight = new THREE.MeshStandardMaterial({ color: 0xb4b8bc, roughness: 1, transparent: true, opacity: 0.09, depthWrite: false })) };
    const box = (x0, x1, y0, y1, z0, z1, mat) => {
      if (x1 - x0 < 1 || y1 - y0 < 1 || z1 - z0 < 1) return;
      const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
      const m = new THREE.Mesh(geo, mat);
      m.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
      m.receiveShadow = true;
      m.castShadow = mat !== C.neighbor;
      m.userData.ctx = true;
      this.root.add(m);
      if (mat === C.neighbor) {
        const e = new THREE.LineSegments(new THREE.EdgesGeometry(geo), C.edge);
        e.position.copy(m.position);
        this.root.add(e);
      }
    };
    const W = 2400;
    for (const side of ['front', 'back', 'left', 'right']) {
      const sd = site.sides[side];
      if (!sd || sd.type === 'open') continue;
      const hgt = Math.max(1, sd.floors || 0) * STOREY_H;
      const dist = sd.type === 'party' ? 0 : Math.max(0.5, sd.dist || 0) * 100;
      if (side === 'front') {
        if (sd.type === 'road') box(-W, 600 + W, -2, 1, 1722 + 120, 1550 + dist, C.road);
        box(-W, 600 + W, 0, hgt, 1550 + dist, 1550 + dist + 900, C.neighbor);
      } else if (side === 'back') box(-W, 600 + W, 0, hgt, -dist - 900, -dist, C.neighbor);
      else if (side === 'left') box(-dist - 1200, -dist - (sd.type === 'party' ? 10 : 0), 0, hgt, 0, 1550, C.neighbor);
      else box(600 + dist + (sd.type === 'party' ? 10 : 0), 600 + dist + 1200, 0, hgt, 0, 1550, C.neighbor);
    }
    void F;
  }

  // 每層的名稱牌（跟著鏡頭轉）
  buildFloorTags(shown, focus) {
    for (const { fl, p } of shown) {
      const c = document.createElement('canvas');
      const label = fl.label;
      const sub = (p.name || '').replace(/^(\dF|頂樓)\s*/, '');
      c.width = 512; c.height = 128;
      const g = c.getContext('2d');
      g.fillStyle = fl.id === focus ? 'rgba(239,200,31,0.95)' : 'rgba(31,35,40,0.82)';
      const r = 24;
      g.beginPath(); g.moveTo(r, 4); g.arcTo(508, 4, 508, 124, r); g.arcTo(508, 124, 4, 124, r); g.arcTo(4, 124, 4, 4, r); g.arcTo(4, 4, 508, 4, r); g.fill();
      g.fillStyle = fl.id === focus ? '#1f2328' : '#fff';
      g.font = '700 52px "Noto Sans TC", sans-serif';
      g.textBaseline = 'middle';
      g.fillText(label, 26, 64);
      g.font = '500 34px "Noto Sans TC", sans-serif';
      g.fillText(sub.slice(0, 11), 26 + g.measureText(label).width * 1.55 + 10, 66);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.scale.set(360, 90, 1);
      sp.position.set(810, fl.elev + 175, 1660);
      sp.renderOrder = 5;
      sp.userData = { floor: fl.id, ownMaterial: true, tag: true };
      sp.material.userData = {};
      this.root.add(sp);
    }
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
      this.out.add(m);
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
        this.out.add(e);
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

  buildWall(plan, w, cut, sunOn = false, bld = null) {
    const M = this.mats;
    const { L, u, n } = wallFrame(w);
    if (L < 0.5) return;
    // 整棟模式：外牆做到上一層樓板底，立面才連續；女兒牆依外觀設定做成玻璃或鐵件欄杆
    let Hfull = w.h ?? plan.wallHeight;
    if (bld && w.kind === 'ext') Hfull = Math.max(Hfull, (plan.floorHeight || 350) - SLAB);
    if (bld && w.kind === 'parapet' && bld.rail !== 'solid') return this.buildRail(plan, w, bld);
    const H = Math.min(Hfull, cut ?? Infinity);
    const { extA, extB } = wallExtents(plan, w);
    const ang = Math.atan2(u.y, u.x);
    const selected = this.app.sel?.type === 'wall' && this.app.sel.id === w.id && !bld;
    const side = selected ? M.wallSel : (w.kind === 'parapet' ? M.parapet : M.wall);
    const mats = [side, side, M.cap, side, side, side];
    const facade = bld && (w.kind === 'ext' || w.kind === 'parapet') ? bld.F.wall : null;
    if (facade) {
      const out = this.outwardSign(plan, w, n);
      mats[0] = mats[1] = facade;
      mats[out > 0 ? 4 : 5] = facade;
      if (w.kind === 'parapet') { mats[2] = facade; mats[out > 0 ? 5 : 4] = facade; }
    }
    const addBox = (s, e, y0, y1, ghost = false) => {
      if (e - s < 0.3 || y1 - y0 < 0.3) return;
      const g = new THREE.BoxGeometry(e - s, y1 - y0, w.t);
      const mid = (s + e) / 2;
      if (facade && !ghost) worldUV(g, mid, (y0 + y1) / 2 + (bld.elev || 0));
      const m = new THREE.Mesh(g, ghost ? this.shadowOnly : mats);
      m.position.set(w.a.x + u.x * mid, (y0 + y1) / 2, w.a.y + u.y * mid);
      m.rotation.y = -ang;
      m.castShadow = true; m.receiveShadow = !ghost;
      m.userData = ghost ? { ghost: true } : { kind: 'wall', id: w.id };
      this.out.add(m);
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
      if (sill < H) this.buildOpening(plan, o, w, Math.min(top, H), sill, H, bld);
    }
  }

  // 牆的哪一側是室外：往法線方向一點點，看是不是落在室內房間裡
  outwardSign(plan, w, n) {
    const m = { x: (w.a.x + w.b.x) / 2, y: (w.a.y + w.b.y) / 2 };
    const off = (w.t || 12) / 2 + 6;
    const indoor = (p) => plan.rooms.some((r) => !['balcony', 'void'].includes(r.kind) && r.pts.length > 2 && pointIn(p, r.pts));
    const a = indoor({ x: m.x + n.x * off, y: m.y + n.y * off }), b = indoor({ x: m.x - n.x * off, y: m.y - n.y * off });
    if (a && !b) return -1;
    if (b && !a) return 1;
    return this.outSide(plan, w, n);
  }

  // 欄杆：矮牆基座＋玻璃或鐵件直條＋扶手
  buildRail(plan, w, bld) {
    const { L, u } = wallFrame(w);
    const { extA, extB } = wallExtents(plan, w);
    const ang = Math.atan2(u.y, u.x);
    const F = bld.F;
    const box = (s, e, y0, y1, t, mat, off = 0) => {
      const g = new THREE.BoxGeometry(e - s, y1 - y0, t);
      if (mat === F.wall) worldUV(g, (s + e) / 2, (y0 + y1) / 2 + (bld.elev || 0));
      const m = new THREE.Mesh(g, mat);
      const mid = (s + e) / 2;
      m.position.set(w.a.x + u.x * mid - u.y * off, (y0 + y1) / 2, w.a.y + u.y * mid + u.x * off);
      m.rotation.y = -ang;
      m.castShadow = mat !== F.railGlass; m.receiveShadow = true;
      m.userData = { kind: 'wall', id: w.id };
      this.out.add(m);
      return m;
    };
    const s0 = -extA, e0 = L + extB;
    const H = w.h ?? 110;
    box(s0, e0, -SLAB, 20, w.t, F.wall);
    box(s0, e0, H - 5, H, Math.max(5, w.t * 0.6), F.frame);
    if (bld.rail === 'glass') {
      box(0, L, 20, H - 5, 1.6, F.railGlass);
      for (let s = 0; s <= L + 0.1; s += Math.max(60, L / Math.max(1, Math.round(L / 150)))) box(s - 2, s + 2, 20, H - 5, 4, F.frame);
    } else {
      const n = Math.max(2, Math.round(L / 12));
      for (let i = 0; i <= n; i++) { const s = (i / n) * L; box(s - 1, s + 1, 20, H - 5, 2, F.frame); }
    }
  }

  buildOpening(plan, o, w, top, sill, H, bld = null) {
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
      this.out.add(tag(m));
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
      this.out.add(tag(leaf));
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
    // 鐵捲門：外側上方的捲箱與兩側導軌
    if (o.shutter && (w.kind === 'ext' || bld)) {
      const sgn = this.outwardSign(plan, w, n);
      const off = sgn * (w.t / 2 + 14);
      const boxM = new THREE.Mesh(new THREE.BoxGeometry(o.w + 16, 30, 28), M.metal || M.alu);
      place(boxM, o.pos, off, Math.min(top + 15, H - 1));
      for (const k of [-1, 1]) place(new THREE.Mesh(new THREE.BoxGeometry(5, hgt, 8), M.alu), o.pos + k * (o.w / 2 + 3), off * 0.6, sill + hgt / 2);
    }
    // 整棟外觀：窗戶上方雨遮
    if (bld?.awning && w.kind === 'ext' && o.type === 'window' && !o.shade) {
      const sgn = this.outwardSign(plan, w, n);
      const aw = new THREE.Mesh(new THREE.BoxGeometry(o.w + 30, 5, 48), bld.F.frame);
      place(aw, o.pos, sgn * (w.t / 2 + 24), Math.min(top + 12, H - 3));
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
      const p = new THREE.Vector3(sx * w / 2, sy * h - (this.bstate ? this.targetY || 0 : 0), sz * d / 2);
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
      const bm = !!this.bstate;
      const dir = kind === 'top' ? new THREE.Vector3(0, 1, 0.0015) : kind === 'front' ? (bm ? new THREE.Vector3(0.07, 0.22, 1) : new THREE.Vector3(0.18, 0.42, 1)) : (bm ? new THREE.Vector3(0.75, 0.8, 1) : new THREE.Vector3(0.8, 1.15, 0.95));
      const target = new THREE.Vector3(c.x, this.bstate && this.targetY ? this.targetY : kind === 'front' ? 1.0 : 0.6, c.z);
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
    const pickFloor = (e) => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      for (const h of ray.intersectObjects(this.root.children, true)) {
        if (h.object.userData.ctx) continue;
        if (h.object.userData.floor) return h.object.userData.floor;
      }
      return null;
    };
    el.addEventListener('dblclick', (e) => {
      if (!this.app.bmode) return;
      const f = pickFloor(e);
      if (f) this.app.openFloor(f);
    });
    el.addEventListener('pointerdown', (e) => {
      this.downAt = { x: e.clientX, y: e.clientY };
      if (this.app.bmode) return;
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
      if (this.app.bmode) { this.app.focusFloor(pickFloor(e)); return; }
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

// 方塊的 UV 換成世界尺寸（1 單位＝1 公尺），外牆材質跨牆段、跨樓層才會連續
function worldUV(g, along0, y0) {
  const pos = g.attributes.position, nor = g.attributes.normal, uv = g.attributes.uv;
  if (!uv || !nor) return;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i));
    let u, v;
    if (ny > 0.5) { u = x + along0; v = z; } else if (nx > 0.5) { u = z; v = y + y0; } else { u = x + along0; v = y + y0; }
    uv.setXY(i, u / 100, v / 100);
  }
  uv.needsUpdate = true;
}

// 斜屋頂（脊線沿深度方向）
function gableGeometry(w, d, rise) {
  const hw = w / 2, hd = d / 2;
  const P = [[-hw, 0, -hd], [0, rise, -hd], [0, rise, hd], [-hw, 0, hd], [hw, 0, -hd], [hw, 0, hd]];
  const tris = [[0, 1, 2], [0, 2, 3], [4, 5, 2], [4, 2, 1], [0, 3, 5], [0, 5, 4]];
  const pos = [], uvs = [];
  for (const t of tris) for (const k of t) { pos.push(...P[k]); uvs.push(P[k][0] / 100, P[k][2] / 100); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.computeVertexNormals();
  return g;
}

// 外牆材質貼圖：每張代表 tw×th 公分
function facadeTex(kind, color) {
  const mk = (tw, th, draw, size = 256) => {
    const c = document.createElement('canvas');
    c.width = size; c.height = Math.round(size * th / tw);
    draw(c.getContext('2d'), c.width, c.height);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(100 / tw, 100 / th);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const shade = (hex, k) => { const c = new THREE.Color(hex); c.offsetHSL(0, 0, k); return '#' + c.getHexString(); };
  if (kind === 'tile') return mk(120, 70, (g, W, H) => {
    // 二丁掛：22.7×6 cm 磚、1 cm 灰縫、半磚錯縫
    g.fillStyle = '#d9d2c4'; g.fillRect(0, 0, W, H);
    const rows = 10, bw = W / 5, rh = H / rows;
    for (let r = 0; r < rows; r++) for (let i = -1; i < 6; i++) {
      const x = i * bw + (r % 2 ? bw / 2 : 0);
      g.fillStyle = shade(color, (rnd() - 0.5) * 0.08);
      g.fillRect(x + 2, r * rh + 2, bw - 4, rh - 4);
    }
  });
  if (kind === 'stone') return mk(120, 120, (g, W, H) => {
    g.fillStyle = '#9d968b'; g.fillRect(0, 0, W, H);
    for (const [x, y, w, h] of [[0, 0, W / 2, H], [W / 2, 0, W / 2, H / 2], [W / 2, H / 2, W / 2, H / 2]]) {
      g.fillStyle = shade(color, (rnd() - 0.5) * 0.06);
      g.fillRect(x + 1, y + 1, w - 2, h - 2);
      g.strokeStyle = 'rgba(120,110,95,0.18)'; g.lineWidth = 1;
      for (let k = 0; k < 3; k++) { g.beginPath(); let xx = x + rnd() * w, yy = y; g.moveTo(xx, yy); while (yy < y + h) { xx += (rnd() - 0.5) * 18; yy += 12; g.lineTo(xx, yy); } g.stroke(); }
    }
  });
  if (kind === 'concrete') return mk(180, 90, (g, W, H) => {
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 3000; i++) { const v = rnd() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${0.03 + rnd() * 0.05})`; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1 + rnd() * 2); }
    g.strokeStyle = 'rgba(0,0,0,0.18)'; g.lineWidth = 1.2; g.strokeRect(0.5, 0.5, W - 1, H - 1);
    g.fillStyle = 'rgba(0,0,0,0.35)';
    for (const fx of [1 / 6, 1 / 2, 5 / 6]) for (const fy of [1 / 4, 3 / 4]) { g.beginPath(); g.arc(fx * W, fy * H, 2.6, 0, Math.PI * 2); g.fill(); }
  });
  if (kind === 'terrazzo') return mk(60, 60, (g, W, H) => {
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 1400; i++) { const k = rnd(); g.fillStyle = k < 0.33 ? 'rgba(60,58,54,0.55)' : k < 0.66 ? 'rgba(250,248,242,0.7)' : 'rgba(150,120,90,0.45)'; g.beginPath(); g.arc(rnd() * W, rnd() * H, 0.8 + rnd() * 1.8, 0, Math.PI * 2); g.fill(); }
  });
  return mk(200, 200, (g, W, H) => {
    g.fillStyle = color; g.fillRect(0, 0, W, H);
    for (let i = 0; i < 900; i++) { const v = rnd() < 0.5 ? 0 : 255; g.fillStyle = `rgba(${v},${v},${v},${0.015 + rnd() * 0.02})`; g.fillRect(rnd() * W, rnd() * H, 2, 2); }
  }, 128);
}

function slatTex() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#9a6e45'; g.fillRect(0, 0, 64, 256);
  g.strokeStyle = 'rgba(60,35,15,0.35)';
  for (let i = 0; i < 9; i++) { g.beginPath(); g.moveTo(4 + i * 7, 0); g.bezierCurveTo(10 + i * 7, 80, i * 7, 170, 6 + i * 7, 256); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
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
