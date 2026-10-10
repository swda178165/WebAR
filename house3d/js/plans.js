// 內建平面：由媽媽的 CAD 列印圖（A3＝1/100）手工轉錄。
// 座標原點＝左側外牆中心線與後牆中心線交點；x 向右、y 向前（圖面下方標示「前」）。
// 主要尺寸取自圖面標註：格線 337.5 / 80 / 266.5 / 215 / 266.5 / 384.5（共 1550），寬 300 + 300。
import { uid, DEFAULTS, normalizePlan } from './model.js';
import { CATALOG } from './catalog.js';

export function builder(meta) {
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

// 固定不動的結構：外牆、前後陽台、AC 版、樓梯、電梯、天井
export function core(b, opt) {
  const { W, O, I, R } = b;
  const ext = { kind: 'ext' };
  const par = { kind: 'parapet', h: DEFAULTS.parapet };

  // 外牆（厚 18）
  const back = W(0, 0, 600, 0, 18, ext);
  for (const [c, w] of opt.backDoors || [[opt.backDoor ?? 262, 180]]) O(back, c, w, 'sliding');
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
  const lwTop = W(0, 684, 178, 684, 12);
  const lw = W(178, 684, 178, 899, 12);
  const lwBot = W(0, 899, 178, 899, 12);
  const win = opt.lightwell || {};
  O(lw, 791, win.right?.w ?? 160, 'window', { sill: win.right?.sill ?? 100, h: win.right?.h ?? 120 });
  if (win.top) O(lwTop, win.top.c, win.top.w, 'window', { sill: win.top.sill, h: win.top.h });
  if (win.bottom) O(lwBot, win.bottom.c, win.bottom.w, 'window', { sill: win.bottom.sill, h: win.bottom.h });
  R('天井', 'void', [0, 684, 178, 899]);
  return { back, front };
}

// 原圖三個方案共用：核心結構 + 左後浴室與左前臥室
function shell(b, opt) {
  const { W, O, I, R } = b;
  const { back, front } = core(b, opt);

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
  const meta = { key: 'a', name: '方案 A', note: '客餐廳在後側，右側開放式廚房，前方兩間臥室（藍筆圈起的右側浴室照原圖保留）。室內 87.84㎡（26.57坪）', elevation: 465, floorHeight: 350, wallHeight: 300 };
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
  const meta = { key: 'b', name: '方案 B', note: '廚房與餐桌移到後側，中段為客廳，右側改為儲藏室；前方兩間臥室。室內 87.84㎡（26.57坪）', elevation: 465, floorHeight: 350, wallHeight: 300 };
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
  const meta = { key: 'c', name: '方案 C · 4F', note: '4F 平面：後側臥室、中段客廳＋餐廳，右前方為廚房（片牆開口為推測，可自行調整）。室內 87.84㎡（26.57坪）', elevation: 1165, floorHeight: 350, wallHeight: 300 };
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


// ======================================================================
// 優化提案：在不動外牆、樓梯、電梯、天井與三個管道間的前提下重新配置
// ======================================================================
export const DUCT_RECTS = [[10, 588, 58, 655], [9, 906, 58, 955], [543, 897, 591, 955]];
export const DUCTS = (I) => {
  I('duct', 10, 588, 58, 655, 'S', { h: 300 });
  I('duct', 9, 906, 58, 955, 'S', { h: 300 });
  I('duct', 543, 897, 591, 955, 'S', { h: 300 });
};

// 後段主臥套房：臥室＋衣櫃＋可從臥室直接進出的主浴（L1 管道旁、面天井開高窗）
function masterSuiteBack(b, { doorType = 'door' } = {}) {
  const { W, O, I, R } = b;
  const mw = W(178, 352, 361, 352, 12);
  O(mw, 305, 90, doorType, doorType === 'door' ? { hinge: 'b', side: -1 } : { h: DEFAULTS.doorHeight });
  W(178, 352, 178, 684, 12);
  const bt = W(0, 417.5, 178, 417.5, 12);
  O(bt, 136, 70, 'sliding', { h: DEFAULTS.doorHeight });
  R('主臥', 'bedroom', [0, 0, 361, 0, 361, 352, 178, 352, 178, 417.5, 0, 417.5]);
  R('主浴', 'bath', [0, 417.5, 178, 684]);
  I('ac', 200, 9, 290, 29, 'S');
  I('bed', 9, 70, 197, 252, 'E', { w: 182, label: '雙人床 6×6.2尺' });
  I('nightstand', 9, 22, 49, 67, 'E');
  I('nightstand', 9, 255, 49, 300, 'E');
  I('rug', 110, 45, 270, 277, 'E');
  I('wardrobe', 295, 15, 355, 215, 'W', { label: '衣櫃' });
  I('wardrobe', 9, 351, 96, 411, 'N', { label: '衣櫃' });
  I('basin', 9, 425, 57, 505, 'E', { label: '洗手台' });
  I('toilet', 9, 515, 79, 560, 'E');
  I('shower', 64, 566, 172, 678, 'N', { label: '淋浴（乾濕分離）' });
}

export function laundryBack(I) {
  I('washer', 6, -124, 66, -64, 'S');
  I('laundry', 135, -124, 185, -79, 'S', { label: '洗衣台' });
}

function kitchenL(I) {
  I('fridge', 384, 686.5, 454, 756.5, 'S', { label: '冰箱' });
  I('counter', 454, 686.5, 531, 746.5, 'S', { top: 'sink', label: '水槽' });
  I('counter', 531, 686.5, 591, 746.5, 'S', { label: '備料' });
  I('counter', 531, 746.5, 591, 826, 'W', { label: '備料' });
  I('counter', 531, 826, 591, 897, 'W', { top: 'stove', label: '瓦斯爐' });
}

function entry(I, { bench = true } = {}) {
  I('cabinet', 184, 430, 224, 610, 'E', { label: '玄關鞋櫃', h: 210 });
  if (bench) I('bench', 184, 615, 222, 678, 'E', { label: '穿鞋椅' });
}

export function planD() {
  const meta = {
    key: 'd', name: '提案 D · 三房', style: 'nordic', elevation: 465, floorHeight: 350, wallHeight: 300,
    note: '三房兩廳兩衛：後段主臥套房、中段客餐廚、前段兩間小孩房。適合有小孩的家庭。',
    brief: [
      '主臥放在後段：離馬路最遠最安靜，有後陽台；主浴緊鄰左側管道間，從臥室直接進出，面天井開高窗通風。',
      '中段做成「客餐廚一體」：餐桌貼著天井大窗借光，廚房 L 型沿電梯牆與右牆，瓦斯爐靠右側管道間排油煙。',
      '前段兩間各約 2.9 坪的小孩房，各有一個陽台、衣櫃、書桌與單人床；房門開在同一面牆，不會門對門。',
      '入口設玄關鞋櫃與穿鞋椅；從電梯出來看不到爐灶（避開「開門見灶」）。',
      '共用浴室保留浴缸、緊鄰左下管道間；浴室門不對餐桌、不對床。',
    ],
  };
  const b = builder(meta);
  const { W, O, I, R } = b;
  core(b, { ...meta, lightwell: { right: { w: 190, sill: 50, h: 180 }, top: { c: 118, w: 80, sill: 150, h: 60 }, bottom: { c: 118, w: 80, sill: 150, h: 60 } } });
  DUCTS(I);
  masterSuiteBack(b);
  laundryBack(I);

  R('玄關', 'hall', [178, 352, 361, 352, 361, 483, 382, 483, 382, 684, 178, 684]);
  entry(I);

  R('餐廳', 'living', [178, 684, 382, 684, 382, 957, 178, 957]);
  I('table', 210, 765, 370, 855, 'S', { w: 160, label: '餐桌' });
  for (const x of [225, 300]) { I('chair', x, 710, x + 55, 760, 'S'); I('chair', x, 860, x + 55, 910, 'N'); }

  R('廚房', 'kitchen', [382, 677, 600, 677, 600, 957, 382, 957]);
  kitchenL(I);

  // 共用浴室（浴缸）
  const b2 = W(178, 899, 178, 1231, 12);
  O(b2, 945, 80, 'sliding', { h: DEFAULTS.doorHeight });
  R('浴室', 'bath', [0, 899, 178, 1231]);
  I('toilet', 9, 965, 79, 1010, 'E');
  I('basin', 9, 1022, 57, 1092, 'E', { label: '洗手台' });
  I('bathtub', 9, 1148, 172, 1223, 'N');

  R('客廳', 'living', [178, 957, 600, 957, 600, 1231, 178, 1231]);
  I('tv', 184, 1000, 224, 1180, 'E', { label: '電視櫃' });
  I('rug', 330, 1000, 495, 1200, 'W');
  I('sofa', 501, 995, 591, 1205, 'W', { label: '三人沙發' });
  I('coffee', 396, 1045, 456, 1155, 'W');
  I('plant', 184, 1185, 222, 1223);

  // 前段兩間小孩房
  const fw = W(0, 1231, 600, 1231, 12);
  O(fw, 250, 85, 'door', { hinge: 'b', side: 1 });
  O(fw, 350, 85, 'door', { hinge: 'a', side: 1 });
  W(300, 1231, 300, 1550, 12);
  R('小孩房', 'bedroom', [0, 1231, 300, 1550]);
  R('小孩房', 'bedroom', [300, 1231, 600, 1550]);
  I('wardrobe', 9, 1237, 195, 1297, 'S', { label: '衣櫃' });
  I('bed_single', 9, 1325, 115, 1513, 'S');
  I('desk', 239, 1310, 294, 1410, 'W', { label: '書桌' });
  I('chair', 184, 1335, 234, 1390, 'E');
  I('ac', 160, 1519, 250, 1541, 'N');
  I('wardrobe', 405, 1237, 591, 1297, 'S', { label: '衣櫃' });
  I('bed_single', 485, 1325, 591, 1513, 'S');
  I('desk', 306, 1310, 361, 1410, 'E', { label: '書桌' });
  I('chair', 366, 1335, 416, 1390, 'W');
  I('ac', 350, 1519, 440, 1541, 'N');
  I('plant', 130, 1662, 175, 1707);
  I('plant', 420, 1662, 465, 1707);
  return finish(b.plan, null);
}

export function planE() {
  const meta = {
    key: 'e', name: '提案 E · 大客廳', style: 'wabi', elevation: 465, floorHeight: 350, wallHeight: 300,
    note: '兩房兩廳兩衛：前段整面做明亮大客廳（約 7 坪、兩個陽台），後段主臥套房，中段餐廚、書房兼客房與客用浴室。適合夫妻或常招待親友。',
    brief: [
      '前段採光最好、面寬 6 米，整面留給客廳：沙發、電視、閱讀角與書牆，兩扇落地門通往陽台。',
      '書房／客房面天井開窗，另開一扇室內窗朝客廳借光；放沙發床，親友來可以過夜。',
      '客用浴室放在右側管道間旁，客人不用經過私人區域。',
      '後段主臥套房同提案 D，安靜、有獨立衛浴與兩組衣櫃。',
      '從入口到客廳是一條連續的動線：玄關 → 餐廚 → 客廳，視線被餐廚與客浴擋住，不會一眼看穿前後陽台（避開穿堂）。',
    ],
  };
  const b = builder(meta);
  const { W, O, I, R } = b;
  core(b, { ...meta, lightwell: { right: { w: 190, sill: 50, h: 180 }, top: { c: 118, w: 80, sill: 150, h: 60 }, bottom: { c: 95, w: 140, sill: 85, h: 125 } } });
  DUCTS(I);
  masterSuiteBack(b);
  laundryBack(I);

  R('玄關', 'hall', [178, 352, 361, 352, 361, 483, 382, 483, 382, 684, 178, 684]);
  entry(I);

  R('餐廳', 'living', [178, 684, 382, 684, 382, 957, 178, 957]);
  I('table', 205, 765, 365, 855, 'S', { w: 160, label: '餐桌' });
  I('bench', 215, 720, 355, 758, 'S', { label: '長凳' });
  for (const x of [225, 300]) I('chair', x, 860, x + 55, 910, 'N');
  R('廚房', 'kitchen', [382, 677, 600, 677, 600, 957, 382, 957]);
  kitchenL(I);

  // 書房兼客房（面天井開窗＋室內窗朝客廳）
  const sw = W(178, 899, 178, 1152, 12);
  O(sw, 1105, 80, 'sliding', { h: DEFAULTS.doorHeight });
  const sb = W(0, 1152, 178, 1152, 12);
  O(sb, 95, 130, 'window', { sill: 90, h: 120 });
  R('書房', 'bedroom', [0, 899, 178, 1152]);
  I('desk', 99, 905, 172, 960, 'N', { label: '書桌' });
  I('chair', 110, 965, 160, 1012, 'N');
  I('bed_single', 9, 958, 99, 1146, 'E', { w: 188, label: '沙發床' });

  // 客用浴室（右側管道間旁）
  W(416, 957, 600, 957, 12);
  const gw = W(416, 957, 416, 1152, 12);
  O(gw, 1010, 75, 'sliding', { h: DEFAULTS.doorHeight });
  W(416, 1152, 600, 1152, 12);
  R('客浴', 'bath', [416, 957, 600, 1152]);
  I('toilet', 521, 963, 591, 1005, 'W');
  I('basin', 543, 1020, 591, 1080, 'W', { label: '洗手台' });
  I('shower', 422, 1060, 530, 1146, 'N');

  R('走道', 'hall', [178, 957, 416, 957, 416, 1152, 178, 1152]);
  I('shelf', 184, 960, 219, 1050, 'E', { w: 90, label: '展示櫃', h: 200 });

  // 前段大客廳
  R('客廳', 'living', [0, 1152, 600, 1550]);
  I('ac', 9, 1170, 31, 1260, 'E');
  I('tv', 9, 1250, 49, 1450, 'E', { label: '電視櫃' });
  I('rug', 120, 1230, 320, 1470, 'W');
  I('coffee', 190, 1295, 250, 1405, 'W');
  I('sofa', 330, 1240, 420, 1460, 'W', { w: 220, label: '三人沙發' });
  I('armchair', 495, 1185, 570, 1260, 'W');
  I('lamp', 545, 1268, 585, 1308);
  I('shelf', 556, 1330, 591, 1470, 'W', { w: 140, label: '書牆', h: 200 });
  I('plant', 15, 1480, 60, 1525);
  I('plant', 130, 1662, 175, 1707);
  I('plant', 420, 1662, 465, 1707);
  return finish(b.plan, null);
}

export function planF() {
  const meta = {
    key: 'f', name: '提案 F · 樂齡', style: 'japandi', elevation: 465, floorHeight: 350, wallHeight: 300,
    note: '兩房兩廳兩衛、通用設計：長輩主臥在前段（日照最好）且套房浴室就在床邊；後段為子女回家用的客房。全部用 90 cm 拉門、無門檻。',
    brief: [
      '長輩主臥放在前段：日照充足、有陽台；套房浴室就在床頭邊，夜間如廁只要走幾步。',
      '浴室門寬 90 cm、採拉門外推不佔空間，淋浴無門檻；馬桶側與淋浴區預留扶手（高 75–85 cm）。',
      '走道淨寬 120 cm 以上、全室同一高程；入口有穿鞋椅，電梯直達。',
      '客廳在前段右側，坐在沙發就看得到餐廚，照顧者與長輩彼此看得見。',
      '後段客房給子女或看護使用，旁邊有第二間浴室（可做洗衣與晾衣）。',
    ],
  };
  const b = builder(meta);
  const { W, O, I, R } = b;
  core(b, { ...meta, lightwell: { right: { w: 190, sill: 50, h: 180 }, top: { c: 118, w: 80, sill: 150, h: 60 }, bottom: { c: 118, w: 80, sill: 150, h: 60 } } });
  DUCTS(I);
  laundryBack(I);

  // 後段客房
  const gw = W(0, 352, 361, 352, 12);
  O(gw, 300, 90, 'sliding', { h: DEFAULTS.doorHeight });
  R('客房', 'bedroom', [0, 0, 361, 352]);
  I('ac', 200, 9, 290, 29, 'S');
  I('bed', 9, 80, 197, 232, 'E');
  I('nightstand', 9, 30, 49, 75, 'E');
  I('wardrobe', 295, 15, 355, 215, 'W', { label: '衣櫃' });
  I('desk', 120, 290, 220, 346, 'N', { label: '書桌' });

  // 第二間浴室（L1 管道旁）
  const bw = W(178, 352, 178, 684, 12);
  O(bw, 625, 90, 'sliding', { h: DEFAULTS.doorHeight });
  R('浴室', 'bath', [0, 352, 178, 684]);
  I('shower', 64, 358, 172, 470, 'S', { label: '淋浴（無門檻）' });
  I('basin', 9, 360, 57, 440, 'E', { label: '洗手台' });
  I('toilet', 9, 520, 79, 565, 'E');

  R('玄關', 'hall', [178, 352, 361, 352, 361, 483, 382, 483, 382, 684, 178, 684]);
  I('cabinet', 184, 360, 224, 480, 'E', { label: '玄關鞋櫃', h: 210 });
  I('bench', 184, 485, 222, 570, 'E', { label: '穿鞋椅' });

  R('餐廳', 'living', [178, 684, 382, 684, 382, 957, 178, 957]);
  I('table', 205, 765, 365, 855, 'S', { w: 160, label: '餐桌' });
  for (const x of [225, 300]) { I('chair', x, 710, x + 55, 760, 'S'); I('chair', x, 860, x + 55, 910, 'N'); }
  R('廚房', 'kitchen', [382, 677, 600, 677, 600, 957, 382, 957]);
  kitchenL(I);

  // 長輩主臥套房（前段左）
  const mb = W(178, 899, 178, 1152, 12);
  void mb;
  const mt = W(0, 1152, 300, 1152, 12);
  O(mt, 95, 90, 'sliding', { h: DEFAULTS.doorHeight });
  O(mt, 239, 90, 'sliding', { h: DEFAULTS.doorHeight });
  W(300, 1152, 300, 1550, 12);
  R('主浴', 'bath', [0, 899, 178, 1152]);
  I('toilet', 9, 965, 79, 1010, 'E');
  I('basin', 9, 1030, 57, 1100, 'E', { label: '洗手台（下方淨空）' });
  I('shower', 82, 905, 172, 1000, 'S', { label: '淋浴（無門檻＋扶手）' });
  R('主臥', 'bedroom', [0, 1152, 300, 1550]);
  I('bed', 9, 1250, 197, 1402, 'E');
  I('nightstand', 9, 1205, 49, 1248, 'E');
  I('nightstand', 9, 1405, 49, 1450, 'E');
  I('wardrobe', 140, 1164, 294, 1224, 'S', { label: '衣櫃' });
  I('armchair', 215, 1430, 290, 1505, 'N');
  I('ac', 160, 1519, 250, 1541, 'N');

  R('走道', 'hall', [178, 957, 300, 957, 300, 1152, 178, 1152]);

  // 客廳（前段右，向中段開放）
  R('客廳', 'living', [300, 957, 600, 957, 600, 1550, 300, 1550]);
  I('tv', 306, 1270, 346, 1430, 'E', { label: '電視櫃' });
  I('rug', 360, 1250, 490, 1450, 'W');
  I('coffee', 400, 1310, 455, 1390, 'W');
  I('sofa', 501, 1270, 591, 1430, 'W', { w: 160, label: '雙人沙發' });
  I('armchair', 400, 1180, 475, 1255, 'S');
  I('lamp', 548, 1440, 588, 1480);
  I('plant', 550, 1000, 590, 1040);
  I('ac', 350, 1519, 440, 1541, 'N');
  I('plant', 130, 1662, 175, 1707);
  I('plant', 420, 1662, 465, 1707);
  return finish(b.plan, null);
}

// 底圖：掃描頁裁切後的影像像素 → 公分 仿射矩陣（依圖面格線圓圈校正）
const UNDERLAYS = {
  a: { src: 'assets/plan-a.jpg', w: 827, h: 1719, matrix: [1.239618, 0, 0.002648, 1.227596, -265.281036, -231.156396] },
  b: { src: 'assets/plan-b.jpg', w: 918, h: 1891, matrix: [1.123596, 0, -0.005893, 1.115947, -260.690219, -231.001004] },
  c: { src: 'assets/plan-c.jpg', w: 883, h: 1830, matrix: [1.174225, -0.013621, -0.008785, 1.16006, -261.136227, -231.050502] },
};

function finish(plan, key) {
  plan.underlay = key ? { ...UNDERLAYS[key], opacity: 0.45, visible: false } : null;
  return normalizePlan(plan);
}

export const BUILTIN_VERSION = 2;

export function builtinPlans() {
  return [planA(), planB(), planC(), planD(), planE(), planF()];
}
