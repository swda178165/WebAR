// 用法：node house3d/tests/building.mjs
// 整棟規劃：各種用途組合都能排出每一層；房間有門可進、套房有窗、家具不重疊；
// 一樓從外面到樓梯間不用穿過大空間；DXF 可以完整還原；「用講的改」常見說法能解析成正確的動作。
import assert from 'node:assert/strict';
import { defaultBuilding, normalizeBuilding, floorList, makeFloorPlan, buildingChecks, useOf, unionOutline } from '../js/building.js';
import { defaultSite, analyzeDaylight } from '../js/site.js';
import { exportDXF, dxfToPlan } from '../js/dxf.js';
import { itemCorners, openingEnds, pointInPolygon, projectOnSegment, polygonArea } from '../js/model.js';
import { parse } from '../js/commands.js';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

const site = defaultSite();
site.floors = 3;
const mk = (over = {}) => {
  const b = normalizeBuilding(defaultBuilding());
  for (const [k, v] of Object.entries(over)) b[k] = typeof v === 'object' && !Array.isArray(v) ? { ...b[k], ...v } : v;
  return b;
};

const cases = [
  ['預設：1F 大空間（後巷進）、2F 出租 3 間、3F 自住、頂樓', mk()],
  ['側邊通道、店面、機車 4 台', mk({ shop: { entry: 'side', hall: 'shop', scooters: 4 } })],
  ['工作室、沒有一樓廁所、2 間大套房', mk({ shop: { hall: 'office', toilet: false }, rent: { rooms: 2 } })],
  ['2F、3F 都自住，頂樓 1 間臥室', mk({ uses: { '2F': 'home', '3F': 'home' }, roof: { rooms: 1, back: 'bedroom' } })],
  ['4 層、2F 3F 出租、沒有頂樓', mk({ n: 4, hasRoof: false, uses: { '2F': 'rent', '3F': 'rent', '4F': 'home' } })],
];

const SOLID = ['bed', 'bed_single', 'wardrobe', 'sofa', 'counter', 'fridge', 'toilet', 'basin', 'bathtub', 'shower', 'tv', 'desk', 'table', 'shelf', 'cabinet', 'altar', 'island', 'duct', 'scooter', 'washer'];
const bbox = (it) => { const c = itemCorners(it); return { x0: Math.min(...c.map((p) => p.x)), x1: Math.max(...c.map((p) => p.x)), y0: Math.min(...c.map((p) => p.y)), y1: Math.max(...c.map((p) => p.y)) }; };
const onBoundary = (r, p) => r.pts.some((q, i) => projectOnSegment(p, q, r.pts[(i + 1) % r.pts.length]).dist < 2);

// 房間之間怎麼走：門、開口、沒有牆的共用邊
function graph(p) {
  const G = new Map(p.rooms.map((r) => [r.id, new Set()]));
  G.set('OUT', new Set());
  const link = (a, b) => { G.get(a).add(b); G.get(b).add(a); };
  for (const o of p.openings) {
    if (o.type === 'window') continue;
    const e = openingEnds(p, o);
    if (!e) continue;
    const rs = p.rooms.filter((r) => onBoundary(r, e.c));
    for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) link(rs[i].id, rs[j].id);
    if (e.wall.kind === 'ext') for (const r of rs) link(r.id, 'OUT');
  }
  // 共用邊上沒有牆
  for (let i = 0; i < p.rooms.length; i++) for (let j = i + 1; j < p.rooms.length; j++) {
    const A = p.rooms[i], B = p.rooms[j];
    let open = false;
    for (let k = 0; k < A.pts.length && !open; k++) {
      const a = A.pts[k], b = A.pts[(k + 1) % A.pts.length];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 15; t < L - 15; t += 20) {
        const q = { x: a.x + (b.x - a.x) * t / L, y: a.y + (b.y - a.y) * t / L };
        if (!onBoundary(B, q)) continue;
        if (!p.walls.some((w) => projectOnSegment(q, w.a, w.b).dist < w.t / 2 + 1 && projectOnSegment(q, w.a, w.b).t > 0 && projectOnSegment(q, w.a, w.b).t < 1)) { open = true; break; }
      }
    }
    if (open) link(A.id, B.id);
  }
  return G;
}
const reach = (G, from, to, avoid = new Set()) => {
  const seen = new Set([from]);
  const st = [from];
  while (st.length) { const x = st.pop(); if (x === to) return true; for (const n of G.get(x) || []) if (!seen.has(n) && !avoid.has(n)) { seen.add(n); st.push(n); } }
  return false;
};

for (const [name, b] of cases) {
  const floors = floorList(b, site);
  const plans = {};
  for (const fl of floors) plans[fl.id] = makeFloorPlan(b, fl, site, { plans: [] });
  check(`${name}: 樓層數與高程`, () => {
    assert.equal(floors.filter((f) => !f.roof).length, b.n);
    assert.equal(floors.some((f) => f.roof), b.hasRoof);
    for (const fl of floors) assert.equal(plans[fl.id].elevation, fl.elev, fl.id);
  });
  for (const fl of floors) {
    const p = plans[fl.id];
    const use = useOf(b, fl);
    const tag = `${name} / ${p.name}`;
    check(`${tag}: 封閉房間都有門`, () => {
      const G = graph(p);
      for (const r of p.rooms) {
        if (['void', 'stair', 'elevator', 'balcony'].includes(r.kind)) continue;
        assert.ok(G.get(r.id).size > 0, `${r.name} 進不去`);
      }
    });
    check(`${tag}: 大型家具不重疊`, () => {
      const s = p.items.filter((i) => SOLID.includes(i.kind) && !i.elev);
      for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length; j++) {
        const a = bbox(s[i]), c = bbox(s[j]);
        const ov = Math.min(a.x1, c.x1) - Math.max(a.x0, c.x0), oh = Math.min(a.y1, c.y1) - Math.max(a.y0, c.y0);
        assert.ok(!(ov > 3 && oh > 3), `${s[i].label || s[i].kind} 與 ${s[j].label || s[j].kind} 重疊`);
      }
    });
    if (use === 'rent') {
      check(`${tag}: 每間套房有窗、有自己的浴室`, () => {
        const dl = analyzeDaylight(p, site, { step: 60 });
        const suites = dl.rooms.filter((r) => /套房/.test(r.name) && r.kind === 'bedroom');
        assert.equal(suites.length, b.rent.rooms);
        for (const r of suites) assert.ok(r.windows.length > 0, `${r.name} 沒有窗`);
        assert.ok(p.items.filter((i) => i.kind === 'toilet').length >= b.rent.rooms, '馬桶數');
        assert.ok(p.items.some((i) => i.kind === 'washer'), '共用洗衣機');
      });
    }
    if (use === 'shop') {
      check(`${tag}: 從外面到樓梯、電梯不用經過大空間`, () => {
        const G = graph(p);
        const stair = p.rooms.find((r) => r.kind === 'stair');
        const lift = p.rooms.find((r) => r.kind === 'elevator');
        const hall = p.rooms.filter((r) => r.kind === 'living');
        assert.ok(hall.length, '沒有大空間');
        const avoid = new Set(hall.map((r) => r.id));
        assert.ok(reach(G, 'OUT', stair.id, avoid), '樓梯');
        assert.ok(reach(G, 'OUT', lift.id, avoid), '電梯');
        assert.ok(reach(G, hall[0].id, stair.id), '大空間也能上樓');
        assert.equal(p.items.filter((i) => i.kind === 'scooter').length, Math.min(b.shop.scooters, b.shop.entry === 'side' ? 4 : 7));
      });
    }
    if (use === 'roof') {
      check(`${tag}: 頂樓有屋突、露台與女兒牆`, () => {
        assert.ok(p.rooms.some((r) => r.kind === 'stair'));
        assert.ok(p.rooms.some((r) => r.kind === 'balcony' && /露台/.test(r.name)));
        assert.ok(p.walls.filter((w) => w.kind === 'parapet').length >= 3);
        assert.ok(p.items.some((i) => i.kind === 'rack'), '曬衣架');
      });
    }
    check(`${tag}: DXF 內嵌還原`, () => {
      const back = dxfToPlan(exportDXF(p), 'b.dxf');
      assert.equal(back.embedded, true);
      assert.deepEqual(back.plan.walls, p.walls);
      assert.equal(back.plan.items.length, p.items.length);
    });
  }
  check(`${name}: 法規提醒`, () => {
    const ch = buildingChecks(b, floors, (fl) => plans[fl.id], site);
    if (b.hasRoof) assert.ok(ch.some((c) => c.t === '屋突面積' && c.lvl === 'ok'));
    if (floors.some((f) => useOf(b, f) === 'rent')) assert.ok(ch.some((c) => c.t === '出租隔間數量'));
  });
}

check('方塊合併外框', () => {
  const pts = unionOutline([[0, 0, 100, 50], [100, 0, 150, 100]]);
  assert.equal(pts.length, 6);
  assert.equal(polygonArea(pts), 100 * 50 + 50 * 100);
  assert.ok(pointInPolygon({ x: 120, y: 80 }, pts));
});

check('舊資料（roof 是布林值）', () => {
  const b = normalizeBuilding({ n: 3, roof: false, uses: {} });
  assert.equal(b.hasRoof, false);
  assert.equal(typeof b.roof, 'object');
});

// ---- 用講的改 ----
const rooms = [{ id: 'r1', name: '主臥' }, { id: 'r2', name: '客餐廳' }, { id: 'r3', name: '小孩房 1' }];
const T = [
  ['主臥大一點', { type: 'resizeRoom', room: '主臥', delta: 30 }],
  ['客廳小一點', { type: 'resizeRoom', room: '客餐廳', delta: -30 }],
  ['主臥加大五十公分', { type: 'resizeRoom', room: '主臥', delta: 50 }],
  ['多一間小孩房', { type: 'program', inc: { kids: 1 } }],
  ['改成三房兩衛', { type: 'program', set: { bedrooms: 3, baths: 2 } }],
  ['不要和室', { type: 'program', set: { tatami: false } }],
  ['二樓改自住', { type: 'floorUse', floor: '2F', use: 'home' }],
  ['三樓也出租', { type: 'floorUse', floor: '3F', use: 'rent' }],
  ['機車停六台', { type: 'building', set: { 'shop.scooters': 6 } }],
  ['樓梯從後面巷子進', { type: 'building', set: { 'shop.entry': 'back' } }],
  ['蓋四層', { type: 'building', set: { n: 4 } }],
  ['頂樓做神明廳', { type: 'building', set: { 'roof.front': 'altar' } }],
  ['外牆換清水模', { type: 'building', set: { 'facade.wall': 'concrete' } }],
  ['窗框改白色', { type: 'building', set: { 'facade.frame': 'white' } }],
  ['屋頂改斜屋頂', { type: 'building', set: { 'facade.roof': 'pitched' } }],
  ['外觀換日式', { type: 'facadePreset', preset: 'japan' }],
  ['換成北歐風', { type: 'style', style: 'nordic' }],
  ['沙發換成雲朵沙發', { type: 'variant', kind: 'sofa', variant: 'cloud' }],
  ['主臥加一張書桌', { type: 'addItem', kind: 'desk', room: '主臥' }],
  ['拿掉客廳的電視', { type: 'removeItem', kind: 'tv', room: '客餐廳' }],
  ['做一張效果圖', { type: 'view', what: 'render' }],
  ['360環景', { type: 'view', what: 'pano' }],
  ['剖開二樓', { type: 'view', what: 'focus:2F' }],
  ['復原', { type: 'undo' }],
];
for (const [s, want] of T) {
  check(`用講的改：「${s}」`, () => {
    const { actions } = parse(s, { rooms });
    const a = actions[0];
    assert.ok(a, '沒有解析出動作');
    for (const [k, v] of Object.entries(want)) {
      if (typeof v === 'object') for (const [k2, v2] of Object.entries(v)) assert.deepEqual(a[k]?.[k2], v2, `${k}.${k2}`);
      else assert.equal(a[k], v, k);
    }
  });
}
check('用講的改：一句話兩件事', () => {
  const { actions } = parse('二樓改自住，然後主臥大一點', { rooms });
  assert.deepEqual(actions.map((a) => a.type), ['floorUse', 'resizeRoom']);
});
check('用講的改：聽不懂的留給 Claude', () => {
  const { actions, unknown } = parse('隨便講講', { rooms });
  assert.equal(actions.length, 0);
  assert.equal(unknown.length, 1);
});

if (failed) { console.log(`\n${failed} 項失敗`); process.exit(1); }
console.log('\n全部通過');
