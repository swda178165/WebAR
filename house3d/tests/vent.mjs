// 用法：node house3d/tests/vent.mjs
// 通風模擬：氣流網路守恆、對流比單面通風強、風向反過來流向也反過來、天井封頂與關門會變差、
// 法規（第 43 條）與二氧化碳的判斷；天井採光的修正（走廊天井窗保留、各面牆高、D/H）；「用講的改」的通風說法。
import assert from 'node:assert/strict';
import { defaultBuilding, normalizeBuilding, floorList, makeFloorPlan, shaftHeights } from '../js/building.js';
import { defaultSite, analyzeDaylight, makeEnv, voidDH, effective, buildingTop, roofLevel } from '../js/site.js';
import { analyzeVent, ventSummary, cityWind, windTravel, windSide, CO2 } from '../js/vent.js';
import { normalizePlan } from '../js/model.js';
import { builtinPlans } from '../js/plans.js';
import { parse } from '../js/commands.js';

let failed = 0;
const check = (name, fn) => {
  try { fn(); console.log('ok  ', name); } catch (e) { failed++; console.log('FAIL', name, '\n     ', e.message); }
};

const site0 = () => { const s = defaultSite(); s.floors = 3; return s; };
const b = normalizeBuilding(defaultBuilding());
const site = site0();
const floors = floorList(b, site);
const plans = Object.fromEntries(floors.map((fl) => [fl.id, makeFloorPlan(b, fl, site, { plans: [] })]));
site.derived = shaftHeights(plans.RF, site);

// 一個 4×6 m 的房間，前後（或只有前面）開窗
function box({ back = true, front = true } = {}) {
  const ext = (ax, ay, bx, by) => ({ id: `w${ax}${ay}${bx}${by}`, a: { x: ax, y: ay }, b: { x: bx, y: by }, t: 18, kind: 'ext', h: 300 });
  const walls = [ext(0, 0, 400, 0), ext(400, 0, 400, 600), ext(400, 600, 0, 600), ext(0, 600, 0, 0)];
  const openings = [];
  if (back) openings.push({ id: 'wb', wall: walls[0].id, pos: 200, w: 150, type: 'window', sill: 90, h: 120 });
  if (front) openings.push({ id: 'wf', wall: walls[2].id, pos: 200, w: 150, type: 'window', sill: 90, h: 120 });
  return normalizePlan({ name: '測試', elevation: 465, wallHeight: 300, floorHeight: 350, walls, openings, rooms: [{ id: 'r1', name: '臥室', kind: 'bedroom', pts: [{ x: 0, y: 0 }, { x: 400, y: 0 }, { x: 400, y: 600 }, { x: 0, y: 600 }] }], items: [] });
}

check('每一層都能解，質量守恆（每個節點進出相等）', () => {
  for (const fl of floors) {
    const r = analyzeVent(plans[fl.id], site);
    assert.ok(r.residual < 1e-5, `${fl.id} 殘差 ${r.residual}`);
    for (const n of r.nodes) {
      let net = 0;
      for (const ed of r.edges) { if (ed.a === n.i) net -= ed.Q; if (ed.b === n.i) net += ed.Q; }
      // 排風機是固定抽出
      const fan = r.rooms.find((x) => x.id === n.id)?.fan || 0;
      assert.ok(Math.abs(net - fan / 3600) < 1e-4, `${fl.id} ${n.name} 不守恆 ${net}`);
    }
    for (const x of r.rooms) assert.ok(Number.isFinite(x.ach) && x.ach >= 0, `${fl.id} ${x.name} ACH ${x.ach}`);
  }
});

check('各種設定都收斂（內建平面＋整棟各層 × 季節 × 房門 × 天井頂 × 周圍 × 風向）', () => {
  const all = [...Object.values(plans), ...builtinPlans()];
  let worst = 0, runs = 0;
  for (const p of all) for (const season of ['summer', 'winter']) for (const doors of ['open', 'closed']) for (const top of ['open', 'sealed']) for (const terrain of ['city', 'open']) for (const wind of [0, 90, 180, 270]) {
    const r = analyzeVent(p, { ...site, lw: { top, wall: 'normal' }, vent: { season, doors, terrain, wind } });
    worst = Math.max(worst, r.residual);
    runs++;
  }
  assert.ok(worst < 1e-7, `最大殘差 ${worst}（${runs} 次）`);
});

check('前後都開窗的房間比只有一面開窗的通風好', () => {
  const s = site0();
  s.vent = { wind: 180 };
  const both = analyzeVent(box(), s).rooms[0];
  const one = analyzeVent(box({ back: false }), s).rooms[0];
  assert.equal(both.type, 'cross');
  assert.equal(one.type, 'single');
  assert.ok(both.ach > one.ach * 1.5, `${both.ach} vs ${one.ach}`);
  assert.deepEqual(both.sides.sort(), ['back', 'front']);
});

check('風從前面吹：前窗進風、後窗出風；風向反過來流向也反過來', () => {
  const s = site0();
  s.vent = { wind: 180, season: 'summer' }; // 正面朝南、南風
  const r1 = analyzeVent(box(), s);
  const f1 = r1.edges.find((e) => e.o?.id === 'wf'), b1 = r1.edges.find((e) => e.o?.id === 'wb');
  assert.ok(f1.Q < 0 && b1.Q > 0, `南風：前 ${f1.Q} 後 ${b1.Q}`);
  s.vent = { wind: 0, season: 'summer' };
  const r2 = analyzeVent(box(), s);
  const f2 = r2.edges.find((e) => e.o?.id === 'wf'), b2 = r2.edges.find((e) => e.o?.id === 'wb');
  assert.ok(f2.Q > 0 && b2.Q < 0, `北風：前 ${f2.Q} 後 ${b2.Q}`);
  assert.equal(windSide(s, { wind: 180 }), 'front');
  assert.equal(windSide(s, { wind: 0 }), 'back');
  const tv = windTravel(s, { wind: 180 });
  assert.ok(tv.y < -0.99, '南風在平面上往後（-y）吹');
});

check('天井封頂、房門關上，通風都會變差', () => {
  const p = plans['2F'];
  const open = analyzeVent(p, site);
  const s2 = { ...site, lw: { top: 'sealed', wall: 'normal' } };
  const sealed = analyzeVent(p, s2);
  const lwUp = (r) => r.shafts.find((x) => x.kind === 'lw').up;
  assert.ok(lwUp(sealed) < lwUp(open) * 0.2, `天井往上 ${lwUp(open)} → ${lwUp(sealed)}`);
  const closed = analyzeVent(p, { ...site, vent: { doors: 'closed' } });
  assert.ok(closed.avgAch < open.avgAch * 0.6, `平均 ${open.avgAch} → 關門 ${closed.avgAch}`);
  const corr = (r) => r.rooms.find((x) => x.name === '公共走廊');
  assert.ok(corr(closed).q < corr(open).q * 0.3);
});

check('第 43 條：沒有窗的茶水間不足、無窗浴室靠排風機、開放式客餐廳合併計算', () => {
  const r = analyzeVent(plans['2F'], site);
  const k = r.rooms.find((x) => x.name === '共用茶水洗衣');
  assert.equal(k.legal.ok, false);
  const bathC = r.rooms.find((x) => x.name === '套房 C 浴室');
  assert.ok(bathC.fan > 0 && bathC.type === 'fan' || bathC.type === 'cross', `浴室 ${bathC.type}`);
  assert.ok(bathC.fan >= 20 * bathC.area - 1, '排風量至少 20 m³/h·㎡');
  for (const s of ['套房 A', '套房 B', '套房 C']) assert.ok(r.rooms.find((x) => x.name === s).legal.ok, s);
  const r3 = analyzeVent(plans['3F'], site);
  const grouped = r3.rooms.filter((x) => x.legal?.with?.length);
  assert.ok(grouped.length >= 2, '3F 開放空間有合併計算');
});

check('冷氣房關窗睡覺：兩人臥室 CO₂ 超過 1000，裝全熱交換器後降到 1000 以下', () => {
  const r = analyzeVent(plans['3F'], site);
  const m = r.rooms.find((x) => x.iaq && x.iaq.people === 2);
  assert.ok(m, '找到兩人臥室');
  assert.ok(m.iaq.co2 > 2000, `關窗 ${m.iaq.co2}`);
  const e = analyzeVent(plans['3F'], { ...site, vent: { erv: true } }).rooms.find((x) => x.id === m.id);
  assert.ok(e.iaq.co2 < CO2.limit, `全熱交換 ${e.iaq.co2}`);
  assert.ok(m.iaq.need >= 40 && m.iaq.need <= 60, `需要 ${m.iaq.need} m³/h`);
  assert.ok(r.tips.some((t) => t.k === 'erv'));
});

check('整棟摘要與建議', () => {
  for (const fl of floors) {
    const r = analyzeVent(plans[fl.id], site);
    const s = ventSummary(r);
    assert.ok(Number.isFinite(s.avgAch) && s.hab >= 0 && s.cross <= s.hab);
    assert.ok(r.tips.length > 0);
  }
  assert.equal(cityWind('taichung', 'winter'), 0);
  assert.equal(cityWind('kaohsiung', 'summer'), 270);
});

check('出租層走廊對天井的窗會保留（自動開窗不會拿掉走道的窗）', () => {
  const p = plans['2F'];
  const r = analyzeDaylight(p, site, { step: 40 });
  const corr = r.rooms.find((x) => x.name === '公共走廊');
  assert.ok(corr.windows.length >= 1 && corr.sides.includes('lightwell'), `走廊 ${JSON.stringify(corr.sides)}`);
  assert.ok(corr.df > 0.2);
});

check('天井：各面牆高（鄰房、頂樓房間）與 D/H', () => {
  assert.ok(site.derived.lwTops.y0 > buildingTop(site), '頂樓浴室那一面比較高');
  assert.ok(site.derived.stairTop > roofLevel(site));
  const env = makeEnv(plans['2F'], site);
  const lw = env.voids[0];
  assert.equal(lw.tops.x0, 5 * 330, '左側共同壁：鄰房 5 層');
  const wins = env.wins.filter((w) => w.kind === 'void');
  const toNeighbour = wins.find((w) => voidDH(w).facing === 'x0');
  assert.ok(toNeighbour && voidDH(toNeighbour).ratio < 0.25 && !effective(toNeighbour), '2F 朝鄰房牆的天井窗不算有效採光');
  const s2 = { ...site, sides: { ...site.sides, left: { type: 'open', dist: 0, floors: 0 } } };
  const env2 = makeEnv(plans['2F'], s2);
  const w2 = env2.wins.find((w) => w.kind === 'void' && voidDH(w).facing === 'x0');
  assert.ok(voidDH(w2).ratio > voidDH(toNeighbour).ratio, '鄰房不在時 D/H 變大');
  const sLight = { ...site, lw: { top: 'open', wall: 'light' } };
  const d0 = analyzeDaylight(plans['2F'], site, { step: 40 }).rooms.find((x) => x.name === '公共走廊').df;
  const d1 = analyzeDaylight(plans['2F'], sLight, { step: 40 }).rooms.find((x) => x.name === '公共走廊').df;
  assert.ok(d1 > d0 * 1.2, `刷白 ${d0} → ${d1}`);
});

const cases = [
  ['看通風', { type: 'view', what: 'vent' }],
  ['風怎麼走', { type: 'view', what: 'vent' }],
  ['天井加頂蓋', { type: 'vent', set: { lwTop: 'louver' } }],
  ['天井封起來', { type: 'vent', set: { lwTop: 'sealed' } }],
  ['天井刷白', { type: 'vent', set: { lwWall: 'light' } }],
  ['房門都關上', { type: 'vent', set: { doors: 'closed' } }],
  ['裝全熱交換器', { type: 'vent', set: { erv: true } }],
  ['不要全熱交換器', { type: 'vent', set: { erv: false } }],
  ['樓梯間頂端加高窗', { type: 'vent', set: { stairVent: true } }],
  ['窗戶都改用推射窗', { type: 'vent', set: { window: 'casement' } }],
  ['風從西南吹', { type: 'vent', set: { wind: 225 } }],
  ['東北季風的時候通風', { type: 'vent', set: { wind: 45, season: 'winter' } }],
  ['天井也照不到光嗎', { type: 'view', what: 'daylight' }],
  ['廚房關起來', { type: 'program' }],
  ['北歐風', { type: 'style' }],
];
check('「用講的改」通風說法', () => {
  for (const [t, want] of cases) {
    const a = parse(t, {}).actions[0];
    assert.ok(a, `${t}：沒有解析`);
    assert.equal(a.type, want.type, `${t}：${JSON.stringify(a)}`);
    if (want.what) assert.equal(a.what, want.what, t);
    if (want.set) assert.deepEqual(a.set, want.set, `${t}：${JSON.stringify(a.set)}`);
  }
});

console.log(failed ? `\n${failed} 項失敗` : '\n全部通過');
process.exit(failed ? 1 : 0);
