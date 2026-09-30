// 內建平面：由媽媽的 CAD 列印圖（A3＝1/100）手工轉錄。
// 座標原點＝左側外牆中心線與後牆中心線交點；x 向右、y 向前（圖面下方標示「前」）。
// 主要尺寸取自圖面標註：格線 337.5 / 80 / 266.5 / 215 / 266.5 / 384.5（共 1550），寬 300 + 300。
import { uid, DEFAULTS, normalizePlan } from './model.js';
import { CATALOG } from './catalog.js';

function builder(meta) {
  const plan = { id: uid('p'), ...meta, walls: [], openings: [], rooms: [], items: [] };
  const H = meta.wallHeight;

  const W = (ax, ay, bx, by, t = 12, opt = {}) => {
    const w = { id: uid('w'), a: { x: ax, y: ay }, b: { x: bx, y: by }, t, kind: opt.kind || 'int', h: opt.h ?? H };
    plan.walls.push(w);
    return w;
  };
  // center：沿牆方向的絕對座標（水平牆給 x、垂直牆給 y）
  const O = (w, center, width, type = 'door', opt = {}) => {
    const horiz = Math.abs(w.a.y - w.b.y) < 1e-6;
    const pos = horiz ? Math.abs(center - w.a.x) : Math.abs(center - w.a.y);
    const defaults = {
      door: { h: DEFAULTS.doorHeight, sill: 0 },
      sliding: { h: DEFAULTS.slidingHeight, sill: 0 },
      window: { h: DEFAULTS.windowHeight, sill: DEFAULTS.windowSill },
      opening: { h: DEFAULTS.doorHeight, sill: 0 },
      elevator: { h: DEFAULTS.doorHeight, sill: 0 },
    }[type];
    plan.openings.push({ id: uid('d'), wall: w.id, pos, w: width, type, hinge: 'a', side: 1, ...defaults, ...opt });
  };
  // 依外框建立家具；facing＝正面朝向 S(前/+y) N(後) E(右/+x) W(左)
  const I = (kind, x0, y0, x1, y1, facing = 'S', extra = {}) => {
    const ew = x1 - x0, ed = y1 - y0;
    const side = facing === 'E' || facing === 'W';
    const rot = { S: 0, N: 180, E: 270, W: 90 }[facing];
    const it = {
      id: uid('i'), kind, x: (x0 + x1) / 2, y: (y0 + y1) / 2,
      w: side ? ed : ew, d: side ? ew : ed, rot,
      h: extra.h ?? CATALOG[kind]?.h,
      ...extra,
    };
    plan.items.push(it);
    return it;
  };
  const R = (name, kind, pts) => {
    let p = pts;
    if (pts.length === 4 && typeof pts[0] === 'number') {
      const [x0, y0, x1, y1] = pts;
      p = [x0, y0, x1, y0, x1, y1, x0, y1];
    }
    const out = [];
    for (let i = 0; i < p.length; i += 2) out.push({ x: p[i], y: p[i + 1] });
    plan.rooms.push({ id: uid('r'), name, kind, pts: out });
  };
  return { plan, W, O, I, R };
}

// 三個方案共用的外殼：外牆、前後陽台、AC 版、樓梯、電梯、天井、左後浴室與左前臥室
function shell(b, opt) {
  const { W, O, I, R } = b;
  const ext = { kind: 'ext' };
  const par = { kind: 'parapet', h: DEFAULTS.parapet };

  // 外牆（厚 18）
  const back = W(0, 0, 600, 0, 18, ext);
  O(back, opt.backDoor ?? 262, 180, 'sliding');
  W(0, 0, 0, 1550, 18, ext);
  W(600, 0, 600, 1550, 18, ext);
  const front = W(0, 1550, 600, 1550, 18, ext);
  O(front, 207, 160, 'sliding');
  O(front, 386, 150, 'sliding');

  // 後陽台
  W(0, -131, 0, 0, 18, ext);
  W(0, -131, 354, -131, 12, par);
  W(354, -131, 354, 0, 15, ext);
  R('後陽台', 'balcony', [0, -131, 354, 0]);

  // 前陽台（兩個 3.26㎡）
  W(118, 1550, 118, 1722, 12, par);
  W(296, 1550, 296, 1722, 12, par);
  W(472, 1550, 472, 1722, 12, par);
  W(118, 1722, 472, 1722, 12, par);
  R('前陽台', 'balcony', [118, 1550, 296, 1722]);
  R('前陽台', 'balcony', [296, 1550, 472, 1722]);

  // AC 版與室外機
  I('ledge', 360, -80, 600, -9, 'S', { label: 'AC版' });
  I('acout', 430, -62, 510, -30, 'N');
  I('ledge', 0, 1559, 112, 1650, 'S', { label: 'AC版' });
  I('acout', 16, 1590, 96, 1622, 'S');
  I('ledge', 478, 1559, 600, 1650, 'S', { label: 'AC版' });
  I('acout', 500, 1590, 580, 1622, 'S');

  // 樓梯（U 型，每階 24、上 19 階）＋ 樓梯間隔牆
  W(361, 0, 361, 350, 12);
  I('stair', 368, 9, 592, 352, 'S', { risers: 19, style: 'U', h: opt.floorHeight, label: '樓梯' });
  R('樓梯間', 'stair', [361, 0, 600, 483]);

  // 電梯（車廂 185×170，門朝樓梯間）
  W(382, 483, 382, 677, 15);
  const eTop = W(382, 483, 600, 483, 15);
  O(eTop, 468, 100, 'elevator');
  W(382, 677, 600, 677, 15);
  I('elevator', 398, 492, 583, 662, 'N', { label: '電梯' });
  R('電梯', 'elevator', [382, 483, 600, 677]);

  // 天井（162×200，開向天空）
  W(0, 684, 178, 684, 12);
  const lw = W(178, 684, 178, 899, 12);
  O(lw, 791, 160, 'window', { sill: 100, h: 120 });
  W(0, 899, 178, 899, 12);
  R('天井', 'void', [0, 684, 178, 899]);

  // 左後浴室（165×253）
  const bath2 = W(178, 899, 178, 1152, 12);
  O(bath2, 1107, 80, 'door', { hinge: 'b', side: 1 });
  W(0, 1152, 178, 1152, 12);
  R('浴室', 'bath', [0, 899, 178, 1152]);
  I('duct', 9, 906, 58, 955, 'S', { h: opt.wallHeight });
  I('shower', 62, 906, 172, 990, 'S');
  I('toilet', 8, 995, 78, 1040, 'E');
  I('basin', 8, 1060, 58, 1122, 'E');

  // 左前臥室：走道門 + 中央隔間
  const py = opt.passageY;
  const pw = W(178, py, 300, py, 12);
  O(pw, 243, 95, 'door', { hinge: 'b', side: 1 });
  W(300, py, 300, 1550, 12);
  R('臥室', 'bedroom', [0, 1152, 178, 1152, 178, py, 300, py, 300, 1550, 0, 1550]);
  I('wardrobe', 28, 1158, 178, 1218, 'S', { label: '衣櫃' });
  I('desk', 8, 1268, 88, 1348, 'E', { label: '桌子' });
  I('bed', 15, 1358, 203, 1510, 'E');
  I('ac', 160, 1522, 250, 1542, 'N');

  return { back, front };
}

function bathTopLeft(b, doorCenter, doorW) {
  const { W, O, I, R } = b;
  W(0, 417.5, 178, 417.5, 12);
  const w = W(178, 417.5, 178, 684, 12);
  O(w, doorCenter, doorW, 'sliding', { h: DEFAULTS.doorHeight });
  R('浴室', 'bath', [0, 417.5, 178, 684]);
  I('basin', 10, 435, 60, 500, 'E');
  I('toilet', 8, 523, 78, 568, 'E');
  I('duct', 10, 588, 58, 655, 'S', { h: 300 });
}

function rightBedroom(b) {
  const { W, O, I, R } = b;
  const w = W(300, 1152, 600, 1152, 12);
  O(w, 352, 90, 'door', { hinge: 'a', side: 1 });
  R('臥室', 'bedroom', [300, 1152, 600, 1550]);
  I('wardrobe', 422, 1158, 572, 1218, 'S', { label: '衣櫃' });
  I('desk', 512, 1268, 592, 1348, 'W', { label: '桌子' });
  I('bed', 397, 1358, 585, 1510, 'W');
  I('ac', 350, 1522, 440, 1542, 'N');
}

function laundry(b) {
  const { I } = b;
  I('washer', 6, -124, 66, -64, 'S');
  I('laundry', 135, -124, 185, -79, 'S', { label: '不銹鋼洗衣台' });
  I('laundry', 125, 1557, 175, 1602, 'S', { label: '不銹鋼洗衣台' });
  I('washer', 125, 1655, 185, 1715, 'N');
}

export function planA() {
  const meta = { name: '方案 A', note: '客餐廳在後側，右側開放式廚房，前方兩間臥室（藍筆圈起的右側浴室照原圖保留）。室內 87.84㎡（26.57坪）', elevation: 465, floorHeight: 350, wallHeight: 300 };
  const b = builder(meta);
  const { W, O, I, R } = b;
  shell(b, { ...meta, passageY: 955 });
  bathTopLeft(b, 467, 85);

  R('客餐廳', 'living', [0, 0, 361, 417.5]);
  I('ac', 210, 9, 310, 29, 'S');
  I('fridge', 300, 8, 355, 63, 'S', { label: '小冰箱', h: 85 });
  I('table', 25, 228, 205, 318, 'S', { label: '餐桌' });
  for (const x of [30, 88, 146]) I('chair', x, 150, x + 58, 204, 'S');
  for (const x of [30, 90, 150]) I('chair', x, 340, x + 58, 395, 'N');

  R('走道', 'hall', [178, 417.5, 361, 417.5, 361, 483, 382, 483, 382, 957, 416, 957, 416, 1152, 300, 1152, 300, 955, 178, 955]);
  I('desk', 184, 578, 244, 757, 'E', { label: '桌子' });

  R('廚房', 'kitchen', [382, 677, 600, 957]);
  I('counter', 385, 684.5, 465, 744.5, 'S', { top: 'sink', label: '水區' });
  I('counter', 465, 684.5, 531, 744.5, 'S', { label: '備料' });
  I('counter', 531, 684.5, 591, 744.5, 'S', { label: '備料' });
  I('counter', 531, 744.5, 591, 844.5, 'W', { top: 'stove', label: '瓦斯爐' });
  I('counter', 531, 844.5, 591, 893, 'W', { label: '備料' });
  I('duct', 545, 897, 591, 951, 'S', { h: 300 });

  W(416, 957, 600, 957, 12);
  const b3 = W(416, 957, 416, 1152, 12);
  O(b3, 1012, 85, 'sliding', { h: DEFAULTS.doorHeight });
  R('浴室', 'bath', [416, 957, 600, 1152]);
  I('basin', 542, 995, 591, 1052, 'W');
  I('toilet', 521, 1075, 591, 1122, 'W');

  rightBedroom(b);
  laundry(b);
  return finish(b.plan, 'a');
}

export function planB() {
  const meta = { name: '方案 B', note: '廚房與餐桌移到後側，中段為客廳，右側改為儲藏室；前方兩間臥室。室內 87.84㎡（26.57坪）', elevation: 465, floorHeight: 350, wallHeight: 300 };
  const b = builder(meta);
  const { W, O, I, R } = b;
  shell(b, { ...meta, passageY: 955 });

  R('廚房／餐廳', 'kitchen', [0, 0, 361, 358]);
  I('ac', 210, 9, 310, 29, 'S');
  I('counter', 9, 9, 70, 69, 'S', { label: '備料' });
  I('counter', 70, 9, 160, 69, 'S', { label: '檯面' });
  I('counter', 160, 9, 260, 69, 'S', { top: 'stove', label: '瓦斯爐' });
  I('counter', 9, 69, 69, 169, 'E', { top: 'sink', label: '水區' });
  I('fridge', 295, 9, 355, 69, 'S', { label: '小冰箱', h: 85 });
  I('table', 23, 212, 203, 302, 'S', { label: '餐桌' });
  for (const x of [90, 148]) I('chair', x, 155, x + 58, 207, 'S');
  for (const x of [30, 88, 146]) I('chair', x, 308, x + 58, 360, 'N');

  R('客廳', 'living', [0, 358, 361, 684]);
  I('duct', 8, 612, 62, 678, 'S', { h: 300 });

  R('走道', 'hall', [178, 684, 361, 684, 361, 483, 382, 483, 382, 677, 416, 677, 416, 1152, 300, 1152, 300, 955, 178, 955]);

  const st = W(416, 677, 416, 899, 10);
  O(st, 745, 80, 'door', { hinge: 'a', side: -1 });
  W(416, 899, 600, 899, 12);
  R('儲藏室', 'storage', [416, 677, 600, 899]);

  const b3 = W(416, 899, 416, 1152, 12);
  O(b3, 1105, 80, 'door', { hinge: 'b', side: -1 });
  R('浴室', 'bath', [416, 899, 600, 1152]);
  I('duct', 535, 905, 591, 958, 'S', { h: 300 });
  I('shower', 424, 905, 530, 990, 'S');
  I('basin', 542, 995, 591, 1052, 'W');
  I('toilet', 521, 1075, 591, 1122, 'W');

  rightBedroom(b);
  laundry(b);
  return finish(b.plan, 'b');
}

export function planC() {
  const meta = { name: '方案 C · 4F', note: '4F 平面：後側臥室、中段客廳＋餐廳，右前方為廚房（片牆開口為推測，可自行調整）。室內 87.84㎡（26.57坪）', elevation: 1165, floorHeight: 350, wallHeight: 300 };
  const b = builder(meta);
  const { W, O, I, R } = b;
  shell(b, { ...meta, passageY: 1000, backDoor: 258 });
  bathTopLeft(b, 560, 80);

  // 後臥室
  const bw = W(172, 352, 361, 352, 12);
  O(bw, 303, 95, 'door', { hinge: 'b', side: -1 });
  W(172, 352, 172, 417.5, 12);
  R('臥室', 'bedroom', [0, 0, 361, 0, 361, 352, 172, 352, 172, 417.5, 0, 417.5]);
  I('ac', 200, 9, 300, 29, 'S');
  I('bed', 40, 52, 228, 202, 'E');
  I('desk', 6, 206, 86, 286, 'E', { label: '桌子' });
  I('wardrobe', 6, 290, 66, 412, 'E', { label: '衣櫃' });

  R('走道', 'hall', [172, 352, 361, 352, 361, 483, 382, 483, 382, 684, 178, 684, 178, 417.5, 172, 417.5]);

  R('客廳', 'living', [178, 684, 382, 684, 382, 677, 600, 677, 600, 900, 178, 900]);
  I('sofa', 184, 680, 256, 892, 'E', { label: '椅子' });
  I('tv', 548, 730, 591, 870, 'W', { label: '電視（預留）' });

  R('餐廳', 'living', [178, 900, 600, 900, 600, 1225, 300, 1225, 300, 1000, 178, 1000]);
  I('duct', 540, 897, 591, 955, 'S', { h: 300 });
  I('table', 380, 980, 560, 1068, 'S', { label: '餐桌' });
  for (const x of [384, 442]) I('chair', x, 906, x + 58, 958, 'S');
  for (const x of [388, 446, 504]) I('chair', x, 1090, x + 58, 1143, 'N');

  const kw = W(300, 1225, 600, 1225, 10);
  O(kw, 450, 90, 'opening');
  R('廚房', 'kitchen', [300, 1225, 600, 1550]);
  I('fridge', 305, 1247, 385, 1357, 'E', { label: '冰箱' });
  I('counter', 531, 1268, 591, 1348, 'W', { top: 'sink', label: '水區' });
  I('counter', 531, 1348, 591, 1423, 'W', { label: '備料' });
  I('counter', 531, 1423, 591, 1523, 'W', { top: 'stove', label: '瓦斯爐' });
  I('ac', 360, 1522, 450, 1542, 'N');
  return finish(b.plan, 'c');
}

// 底圖：掃描頁裁切後的影像像素 → 公分 仿射矩陣（依圖面格線圓圈校正）
const UNDERLAYS = {
  a: { src: 'assets/plan-a.jpg', w: 827, h: 1719, matrix: [1.239618, 0, 0.002648, 1.227596, -265.281036, -231.156396] },
  b: { src: 'assets/plan-b.jpg', w: 918, h: 1891, matrix: [1.123596, 0, -0.005893, 1.115947, -260.690219, -231.001004] },
  c: { src: 'assets/plan-c.jpg', w: 883, h: 1830, matrix: [1.174225, -0.013621, -0.008785, 1.16006, -261.136227, -231.050502] },
};

function finish(plan, key) {
  plan.underlay = { ...UNDERLAYS[key], opacity: 0.45, visible: false };
  return normalizePlan(plan);
}

export function builtinPlans() {
  return [planA(), planB(), planC()];
}
