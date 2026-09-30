// 用法：node house3d/tests/dxf-roundtrip.mjs
// 把內建方案匯出成 DXF，再分別用「內嵌資料還原」與「純幾何辨識」匯入，檢查結果。
import assert from 'node:assert/strict';
import { builtinPlans } from '../js/plans.js';
import { exportDXF, dxfToPlan, parseDXF } from '../js/dxf.js';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

for (const plan of builtinPlans()) {
  const withData = exportDXF(plan);
  const plain = exportDXF(plan, { embed: false });

  check(`${plan.name}: DXF 結構完整`, () => {
    const d = parseDXF(plain);
    assert.ok(d.entities.length > 200, 'entities ' + d.entities.length);
    assert.ok(plain.trimEnd().endsWith('EOF'));
    assert.ok(d.entities.some((e) => e.type === 'TEXT' && e.text === '浴室'), '中文文字應可解碼');
  });

  check(`${plan.name}: 內嵌資料完整還原`, () => {
    const r = dxfToPlan(withData, 'x.dxf');
    assert.equal(r.embedded, true);
    assert.deepEqual(r.plan.walls, plan.walls);
    assert.deepEqual(r.plan.openings, plan.openings);
    assert.equal(r.plan.items.length, plan.items.length);
  });

  check(`${plan.name}: 純幾何辨識`, () => {
    const r = dxfToPlan(plain, 'x.dxf');
    const p = r.plan;
    assert.equal(r.embedded, false);
    assert.ok(Math.abs(p.walls.length - plan.walls.length) <= 5, `walls ${p.walls.length} vs ${plan.walls.length}`);
    assert.equal(p.openings.length, plan.openings.length, 'openings');
    const byType = (ops) => ops.map((o) => o.type).filter((t) => t !== 'elevator' && t !== 'sliding').sort().join(',');
    assert.equal(byType(p.openings), byType(plan.openings.filter((o) => o.type !== 'elevator')), 'door/window types');
    const names = new Set(p.rooms.map((r) => r.name));
    for (const n of ['浴室', '天井', '電梯', '前陽台', '後陽台']) assert.ok(names.has(n), 'room ' + n);
    assert.ok(p.rooms.length >= 9, 'rooms ' + p.rooms.length);
    assert.ok(p.items.some((i) => i.kind === 'stair'), 'stair');
    assert.ok(p.items.filter((i) => i.kind === 'bed').length >= 1, 'bed');
  });
}

if (failed) { console.log(`\n${failed} 項失敗`); process.exit(1); }
console.log('\n全部通過');
