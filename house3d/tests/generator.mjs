// 用法：node house3d/tests/generator.mjs
// 用幾組不同的需求跑自動規劃，檢查每個方案：房間數對、每個房間有門可進、床／馬桶／爐子都有擺、大型家具不互相重疊、DXF 可以完整還原。
import assert from 'node:assert/strict';
import { generate, defaultProgram } from '../js/generator.js';
import { defaultSite, analyzeDaylight } from '../js/site.js';
import { exportDXF, dxfToPlan } from '../js/dxf.js';
import { itemCorners } from '../js/model.js';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

const site = defaultSite();
const openSite = JSON.parse(JSON.stringify(site));
openSite.sides.right = { type: 'lane', dist: 4, floors: 3 };
openSite.front = 90;

const cases = [
  ['預設 2 房', defaultProgram(), site],
  ['3 房', { ...defaultProgram(), kids: 2 }, site],
  ['長輩同住', { ...defaultProgram(), kids: 0, elder: true, accessible: true }, site],
  ['神明廳＋和室', { ...defaultProgram(), kids: 0, altar: true, tatami: true, baths: 1, masterBath: false }, site],
  ['右側有巷子、朝東', { ...defaultProgram(), kids: 1, study: true, kitchen: 'closed', island: false, style: 'luxe' }, openSite],
  ['4F 書房', { ...defaultProgram(), elevation: 1165, kids: 0, study: true, storage: true, style: 'industrial' }, site],
];

const bbox = (it) => {
  const c = itemCorners(it);
  return { x0: Math.min(...c.map((p) => p.x)), x1: Math.max(...c.map((p) => p.x)), y0: Math.min(...c.map((p) => p.y)), y1: Math.max(...c.map((p) => p.y)) };
};
const SOLID = ['bed', 'bed_single', 'wardrobe', 'sofa', 'counter', 'fridge', 'toilet', 'basin', 'bathtub', 'shower', 'tv', 'desk', 'table', 'shelf', 'cabinet', 'altar', 'island', 'duct'];

for (const [name, pg, st] of cases) {
  const res = await generate(pg, st);
  check(`${name}: 有產生方案`, () => assert.ok(res.results.length >= 1, res.msgs.join(' ')));
  for (const r of res.results) {
    const p = r.built.plan;
    const tag = `${name} / ${p.name}`;
    check(`${tag}: 房間與設備`, () => {
      const prog = res.program;
      const beds = p.rooms.filter((x) => x.kind === 'bedroom' && !/書房|和室/.test(x.name)).length;
      const want = (prog.master ? 1 : 0) + (prog.elder ? 1 : 0) + prog.kids + (prog.guest ? 1 : 0);
      assert.equal(beds, want, 'bedrooms');
      assert.equal(p.rooms.filter((x) => x.kind === 'bath').length, prog.baths, 'baths');
      assert.equal(p.items.filter((i) => i.kind === 'bed' || i.kind === 'bed_single').length >= want, true, 'beds placed');
      assert.ok(p.items.filter((i) => i.kind === 'toilet').length >= prog.baths, 'toilets');
      if (prog.kitchen !== 'none') assert.ok(p.items.some((i) => i.kind === 'counter' && i.top === 'stove'), 'stove');
    });
    check(`${tag}: 每個封閉房間都有門`, () => {
      for (const room of p.rooms) {
        if (['balcony', 'void', 'stair', 'elevator', 'hall', 'living'].includes(room.kind) || room.name === '玄關') continue;
        if (room.kind === 'kitchen' && res.program.kitchen === 'open') continue;
        const has = p.openings.some((o) => {
          if (o.type === 'window') return false;
          const w = p.walls.find((x) => x.id === o.wall);
          const L = Math.hypot(w.b.x - w.a.x, w.b.y - w.a.y);
          const c = { x: w.a.x + (w.b.x - w.a.x) * o.pos / L, y: w.a.y + (w.b.y - w.a.y) * o.pos / L };
          return room.pts.some((q, i) => { const n = room.pts[(i + 1) % room.pts.length]; const dx = n.x - q.x, dy = n.y - q.y; const t = Math.max(0, Math.min(1, ((c.x - q.x) * dx + (c.y - q.y) * dy) / (dx * dx + dy * dy))); return Math.hypot(c.x - q.x - dx * t, c.y - q.y - dy * t) < 2; });
        });
        assert.ok(has, room.name + ' 沒有門');
      }
    });
    check(`${tag}: 大型家具不重疊`, () => {
      const solid = p.items.filter((i) => SOLID.includes(i.kind) && !i.elev);
      for (let i = 0; i < solid.length; i++) for (let j = i + 1; j < solid.length; j++) {
        const a = bbox(solid[i]), b = bbox(solid[j]);
        const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oh = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        assert.ok(!(ov > 3 && oh > 3), `${solid[i].kind} 與 ${solid[j].kind} 重疊 ${ov.toFixed(0)}×${oh.toFixed(0)}`);
      }
    });
    check(`${tag}: 臥室都能採光`, () => {
      const dl = analyzeDaylight(p, st, { step: 50 });
      for (const room of dl.rooms) if (room.kind === 'bedroom' && !/書房|和室/.test(room.name)) assert.ok(room.windows.length > 0, room.name + ' 沒有窗');
    });
    check(`${tag}: DXF 內嵌還原`, () => {
      const back = dxfToPlan(exportDXF(p), 'g.dxf');
      assert.equal(back.embedded, true);
      assert.deepEqual(back.plan.walls, p.walls);
      assert.equal(back.plan.items.length, p.items.length);
    });
  }
}

if (failed) { console.log(`\n${failed} 項失敗`); process.exit(1); }
console.log('\n全部通過');
