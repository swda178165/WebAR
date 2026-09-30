// 家具／設備目錄。w＝寬（本地 x）、d＝深（本地 y，正面朝 +y）、h＝高，單位 cm。
export const CATALOG = {
  bed: { name: '雙人床 5×6.2尺', w: 152, d: 188, h: 50, group: '臥室' },
  bed_single: { name: '單人床 3.5×6.2尺', w: 106, d: 188, h: 50, group: '臥室' },
  wardrobe: { name: '衣櫃', w: 150, d: 60, h: 220, group: '臥室' },
  nightstand: { name: '床頭櫃', w: 45, d: 40, h: 55, group: '臥室' },
  desk: { name: '書桌', w: 100, d: 60, h: 75, group: '臥室' },
  sofa: { name: '沙發', w: 210, d: 85, h: 80, group: '客餐廳' },
  tv: { name: '電視櫃', w: 150, d: 40, h: 50, group: '客餐廳' },
  table: { name: '餐桌', w: 180, d: 90, h: 75, group: '客餐廳' },
  chair: { name: '椅子', w: 55, d: 50, h: 85, group: '客餐廳' },
  counter: { name: '流理台', w: 100, d: 60, h: 85, group: '廚房', top: 'plain' },
  fridge: { name: '冰箱', w: 70, d: 70, h: 180, group: '廚房' },
  toilet: { name: '馬桶', w: 42, d: 70, h: 75, group: '衛浴' },
  basin: { name: '洗手台', w: 60, d: 48, h: 85, group: '衛浴' },
  shower: { name: '淋浴區', w: 100, d: 90, h: 200, group: '衛浴' },
  bathtub: { name: '浴缸', w: 150, d: 75, h: 55, group: '衛浴' },
  washer: { name: '洗衣機', w: 60, d: 60, h: 90, group: '陽台' },
  laundry: { name: '洗衣台', w: 50, d: 45, h: 85, group: '陽台' },
  ac: { name: '冷氣室內機', w: 90, d: 22, h: 30, elev: 220, group: '設備' },
  acout: { name: '冷氣室外機', w: 80, d: 30, h: 55, group: '設備' },
  ledge: { name: 'AC版', w: 120, d: 80, h: 10, group: '設備' },
  duct: { name: '管道間', w: 50, d: 50, h: 300, group: '設備' },
  column: { name: '柱', w: 40, d: 40, h: 300, group: '結構' },
  stair: { name: '樓梯', w: 224, d: 340, h: 350, group: '結構', risers: 19, style: 'U' },
  elevator: { name: '電梯', w: 185, d: 170, h: 240, group: '結構' },
  plant: { name: '植栽', w: 45, d: 45, h: 120, group: '其他' },
  box: { name: '方塊', w: 60, d: 60, h: 60, group: '其他' },
};

export const COUNTER_TOPS = { plain: '檯面', sink: '水槽', stove: '瓦斯爐' };

export function itemName(it) {
  return it.label || CATALOG[it.kind]?.name || it.kind;
}

export function itemHeight(it) {
  return it.h ?? CATALOG[it.kind]?.h ?? 60;
}

export function itemElev(it) {
  return it.elev ?? CATALOG[it.kind]?.elev ?? 0;
}
