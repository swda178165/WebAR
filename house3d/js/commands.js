// 用講的改格局：把一句中文（打字或語音）拆成可以執行、可以復原的動作。
// 常見說法在這裡直接解析；聽不懂的才交給 Claude（見 ask-ui.js）。
import { FURN_VARIANTS, STYLES } from './styles.js';

// ---------- 數字 ----------
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnToNum(s) {
  if (/^\d+$/.test(s)) return +s;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}
export function normalize(text) {
  let t = String(text || '').trim()
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[Ａ-Ｚａ-ｚ]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/\s+/g, '');
  // 中文數字 → 阿拉伯數字（不動「一點」「一些」「一下」這類用語）
  t = t.replace(/[零〇一二兩两三四五六七八九十百]+(?=(樓|層|間|房|廳|衛|台|臺|輛|部|人|張|個|座|盆|組|公分|cm|米|公尺|m|F|f|樓層|號))/g, (m) => String(cnToNum(m)));
  t = t.replace(/(第|總共|要|蓋|停|隔|做|改成|改為)([零〇一二兩两三四五六七八九十]+)/g, (m, a, b) => a + cnToNum(b));
  return t.replace(/臺/g, '台').replace(/f(?=\b|$)/gi, 'F');
}

// ---------- 詞庫 ----------
export const STYLE_WORDS = [['日式|無印|japandi', 'japandi'], ['北歐', 'nordic'], ['侘寂|溫潤|極簡', 'wabi'], ['工業', 'industrial'], ['輕奢|奢華|豪華', 'luxe'], ['原始配色|原本的?配色|原始的?風格', 'basic']];
export const KIND_WORDS = [
  ['單人床', 'bed_single'], ['床頭櫃', 'nightstand'], ['電視櫃|電視', 'tv'], ['雙人床|大床|床', 'bed'], ['沙發', 'sofa'], ['單椅|休閒椅|主人椅|躺椅', 'armchair'],
  ['茶几|咖啡桌', 'coffee'], ['地毯', 'rug'], ['書櫃|書架|層架|展示櫃', 'shelf'], ['立燈|落地燈|檯燈', 'lamp'], ['餐桌|飯桌|桌子', 'table'],
  ['餐椅|椅子', 'chair'], ['書桌|辦公桌|工作桌', 'desk'], ['衣櫃|衣櫥', 'wardrobe'], ['收納櫃|櫃子|鞋櫃', 'cabinet'], ['長凳|穿鞋椅|板凳', 'bench'],
  ['冰箱', 'fridge'], ['洗衣機|烘衣機', 'washer'], ['冷氣', 'ac'], ['植物|植栽|盆栽|綠色植物', 'plant'], ['神明桌|佛桌|神桌', 'altar'],
  ['機車|摩托車|電動車', 'scooter'], ['曬衣架', 'rack'], ['中島', 'island'], ['浴缸', 'bathtub'], ['馬桶', 'toilet'], ['和室桌', 'lowtable'], ['吧檯椅', 'stool'],
].sort((a, b) => Math.max(...b[0].split('|').map((x) => x.length)) - Math.max(...a[0].split('|').map((x) => x.length)));
// 說法 → 平面上房間名稱的樣子
const ROOM_SYNONYM = [['主臥室|主卧|主臥|主房', '主臥'], ['客廳|起居', '客|起居|大空間'], ['餐廳', '餐'], ['廚房', '廚房'], ['小孩房|兒童房|小朋友房', '小孩房'], ['長輩房|孝親房|爸媽房', '長輩房'], ['書房', '書房'], ['和室', '和室'], ['客房', '客房'], ['浴室|廁所|衛浴', '浴|廁'], ['走道|走廊', '走'], ['玄關', '玄關'], ['儲藏室|儲物間', '儲藏'], ['神明廳', '神明廳'], ['露台', '露台'], ['陽台', '陽台'], ['套房', '套房'], ['停車|機車', '機車']];
const PROGRAM_ROOMS = [['書房', 'study'], ['和室', 'tatami'], ['神明廳', 'altar'], ['更衣室', 'walkin'], ['儲藏室|儲物間', 'storage'], ['長輩房|孝親房', 'elder'], ['客房', 'guest'], ['餐廳', 'dining'], ['客廳', 'living']];
const FACADE_WALL = [['清水模', 'concrete'], ['二丁掛|磁磚|瓷磚|紅磚|磚', 'tile'], ['石材|石頭|大理石|石板', 'stone'], ['洗石子|抿石子', 'terrazzo'], ['塗料|油漆|漆', 'paint']];
const COLORS = [['深灰|鐵灰', '#7c7f83'], ['淺灰|灰', '#d8d4cc'], ['米白|米色|奶茶|杏色', '#d9c7a8'], ['黑', '#2f3236'], ['白', '#efece6']];
const FRAME = [['黑', 'black'], ['白', 'white'], ['香檳|金', 'champagne'], ['木', 'wood']];
const PRESET = [['現代白|現代風|現代簡約|現代', 'modern'], ['清水模風|清水模的感覺', 'concrete'], ['經典磚|紅磚屋|紅磚房|經典', 'brick'], ['日式木|日式風|和風|日式|日本', 'japan'], ['石材輕奢|輕奢|高級', 'stone']];

const has = (t, re) => new RegExp(re).test(t);
const pick = (t, table) => { for (const [re, v] of table) if (new RegExp(re).test(t)) return v; return null; };
const floorOf = (t) => {
  if (/頂樓|屋頂|屋突|樓頂/.test(t)) return 'RF';
  const m = t.match(/(\d)\s*(?:樓|F)/);
  return m ? `${m[1]}F` : null;
};

// 句子拆成子句
export function clauses(text) {
  return normalize(text).split(/[，,。；;！!？?\n]|然後|另外|還有|並且|再來|接著/).map((x) => x.trim()).filter(Boolean);
}

// ctx：{ bmode, building:{n, roof, floors:[ids]}, rooms:[{id,name}], plan:{name, generated} }
export function parse(text, ctx = {}) {
  const out = { actions: [], unknown: [] };
  let lastFloor = null;
  for (const c of clauses(text)) {
    const fl = floorOf(c);
    if (fl) lastFloor = fl;
    const acts = parseClause(c, ctx, fl || lastFloor);
    if (acts?.length) out.actions.push(...acts);
    else out.unknown.push(c);
  }
  return out;
}

function parseClause(t, ctx, floor) {
  const A = [];
  // 復原
  if (/^(復原|還原|上一步|回上一步|取消剛剛|剛剛那個不要|不要剛剛)/.test(t)) return [{ type: 'undo' }];
  // 看效果圖、360
  if (has(t, '360|環景|全景|VR|轉一圈')) return [{ type: 'view', what: 'pano' }];
  if (has(t, '效果圖|擬真|像照片|渲染|拍一張|拍照|真實')) return [{ type: 'view', what: 'render' }];

  // ---- 外觀 ----
  const facadeCtx = has(t, '外觀|外牆|立面|外面的牆|房子外面|窗框|欄杆|屋頂|格柵|雨遮|花架') || pick(t, FACADE_WALL);
  if (facadeCtx && !has(t, '屋頂.*(房間|神明|和室)')) {
    const preset = pick(t, PRESET);
    const set = {};
    const wall = pick(t, FACADE_WALL);
    if (wall) set['facade.wall'] = wall;
    const col = has(t, '外牆|外觀|顏色|色') ? pick(t.replace(/窗框.*$/, ''), COLORS) : null;
    if (col) set['facade.color'] = col;
    else if (wall === 'tile' && has(t, '紅')) set['facade.color'] = '#a8644a';
    else if (wall && !has(t, '色')) set['facade.color'] = { concrete: '#b9b6b0', stone: '#d9cfbf', terrazzo: '#c9c3b7', tile: '#a8644a' }[wall] || undefined;
    if (set['facade.color'] === undefined) delete set['facade.color'];
    if (has(t, '窗框|窗戶框')) { const f = pick(t.slice(t.indexOf('窗')), FRAME); if (f) set['facade.frame'] = f; }
    if (has(t, '欄杆|扶手')) { const r = has(t, '玻璃') ? 'glass' : has(t, '鐵|金屬|直條') ? 'iron' : has(t, '實牆|水泥|女兒牆') ? 'solid' : null; if (r) set['facade.rail'] = r; }
    if (has(t, '斜屋頂|屋頂.*斜|尖屋頂|人字')) set['facade.roof'] = 'pitched';
    else if (has(t, '平屋頂|屋頂.*平')) set['facade.roof'] = 'flat';
    if (has(t, '花架|涼亭|葡萄架')) set['facade.roof'] = has(t, '不要|拿掉|取消') ? 'flat' : 'pergola';
    if (has(t, '格柵')) set['facade.grille'] = has(t, '不要|拿掉|取消|去掉') ? 'none' : has(t, '鋁|金屬|鐵|黑') ? 'alu' : 'wood';
    if (has(t, '雨遮')) set['facade.awning'] = !has(t, '不要|拿掉|取消|去掉');
    if (Object.keys(set).length) return [{ type: 'building', set }];
    if (preset) return [{ type: 'facadePreset', preset }];
    if (has(t, '外觀') && !has(t, '換|改')) return [{ type: 'view', what: 'building' }];
  }

  // ---- 整棟、樓層 ----
  const bctx = ctx.bmode || floor || has(t, '整棟|樓層|頂樓|機車|出租|租|一樓|店面|樓梯|電梯|入口|通道|蓋|層');
  if (has(t, '^(看)?(整棟|整間房子|全部的?樓層|整個房子)$|看整棟|回到整棟')) return [{ type: 'view', what: 'building' }];
  if (has(t, '剖開|切開|裡面') && floor) return [{ type: 'view', what: `focus:${floor}` }];
  const useWord = t.match(/(出租|租人|租給|租學生|租出去|自住|自己住|空著|先空|大空間|店面|工作室|辦公室|開店)/);
  if (floor && useWord && !has(t, '\\d\\s*間')) {
    const w = useWord[1];
    const use = /租/.test(w) ? 'rent' : /自/.test(w) ? 'home' : /空著|先空/.test(w) ? 'empty' : floor === 'RF' ? 'roof' : 'shop';
    A.push({ type: 'floorUse', floor, use });
    if (use === 'shop') { const hall = /店面|開店/.test(w) ? 'shop' : /工作室|辦公/.test(w) ? 'office' : null; if (hall) A.push({ type: 'building', set: { 'shop.hall': hall } }); }
    return A;
  }
  if (bctx) {
    const m = t.match(/(?:蓋|總共|改成|做)?(\d)\s*(?:層樓|層|樓)(?:就好|好了)?$/);
    if (m && has(t, '蓋|總共|層') && !has(t, '樓的|樓改|樓做|樓當')) { const n = +m[1]; if (n >= 1 && n <= 5) return [{ type: 'building', set: { n } }]; }
    if (has(t, '不要頂樓|頂樓不(要|用)了|不做頂樓|頂樓取消')) return [{ type: 'building', set: { hasRoof: false } }];
    if (has(t, '頂樓')) {
      const set = {};
      if (has(t, '(要|做|加)頂樓|頂樓要(做|有)')) set.hasRoof = true;
      const n = t.match(/(\d)\s*間/);
      if (n) set['roof.rooms'] = Math.max(0, Math.min(2, +n[1]));
      if (has(t, '不要房間|只要儲藏|改成儲藏|只放儲藏')) set['roof.rooms'] = 0;
      const rr = t.match(/(神明廳|起居室|起居|泡茶|和室|臥室|房間|書房|儲藏室|儲藏)/);
      if (rr) {
        const k = { 神明廳: 'altar', 起居室: 'family', 起居: 'family', 泡茶: 'family', 和室: 'tatami', 臥室: 'bedroom', 房間: 'bedroom', 書房: 'study', 儲藏室: 'storage', 儲藏: 'storage' }[rr[1]];
        if (k && !set['roof.rooms'] && set['roof.rooms'] !== 0) {
          if (['altar', 'family'].includes(k)) { set['roof.front'] = k; set['roof.rooms'] = 2; }
          else set['roof.back'] = k;
        }
      }
      if (Object.keys(set).length) { set.hasRoof = true; return [{ type: 'building', set }]; }
    }
    const rent = t.match(/(?:出租|套房|雅房|隔|租)[^\d]*(\d)\s*間|(\d)\s*間(?:套房|雅房|出租)/);
    if (rent) { const n = +(rent[1] || rent[2]); return [{ type: 'building', set: { 'rent.rooms': n }, note: n > 3 ? 'rentMax' : null }]; }
    const sc = t.match(/(?:機車|摩托車|車)[^\d]*(\d+)\s*(?:台|輛|部)|停\s*(\d+)\s*(?:台|輛|部)/);
    if (sc) return [{ type: 'building', set: { 'shop.scooters': +(sc[1] || sc[2]) } }];
    if (has(t, '機車') && has(t, '多停|多一點|多幾台')) return [{ type: 'building', inc: { 'shop.scooters': 2 } }];
    if (has(t, '(機車|樓梯|電梯|入口|出入口).*(後面|後巷|巷子)|從後面進|後巷進')) return [{ type: 'building', set: { 'shop.entry': 'back' } }];
    if (has(t, '(機車|樓梯|電梯|入口|出入口|通道).*(側邊|旁邊|前面)|側邊通道|從前面進|留通道')) return [{ type: 'building', set: { 'shop.entry': 'side' } }];
    if (has(t, '一樓|1樓') && has(t, '客廳|店面|工作室|辦公|開店|空著')) {
      const hall = has(t, '店面|開店') ? 'shop' : has(t, '工作室|辦公') ? 'office' : has(t, '空著') ? 'empty' : 'living';
      return [{ type: 'floorUse', floor: '1F', use: 'shop' }, { type: 'building', set: { 'shop.hall': hall } }];
    }
    if (has(t, '廁所') && has(t, '一樓|1樓')) return [{ type: 'building', set: { 'shop.toilet': !has(t, '不要|不用|拿掉') } }];
  }
  if (floor && has(t, '^(打開|看|去|到|切到|換到|進去)?' + (floor === 'RF' ? '(頂樓|屋頂)' : floor[0] + '(樓|F)') + '(的)?(平面|格局|圖)?(看看)?$')) return [{ type: 'view', what: `floor:${floor}` }];

  // ---- 檢視 ----
  if (has(t, '走進去|漫遊|第一人稱|走走看')) return [{ type: 'view', what: 'walk' }];
  if (has(t, '日照|太陽|陰影|曬')) return [{ type: 'view', what: 'sun' }];
  if (has(t, '採光|亮度|多亮|暗不暗')) return [{ type: 'view', what: 'daylight' }];
  if (has(t, '俯視|從上面看')) return [{ type: 'view', what: 'top' }];
  if (has(t, '正面|從前面看')) return [{ type: 'view', what: 'front' }];

  // ---- 窗戶 ----
  if (has(t, '自動開窗|幫我開窗|重新開窗|依.*開窗')) return [{ type: 'autoWindows' }];
  const room = matchRoom(t, ctx.rooms || []);
  if (has(t, '窗') && has(t, '大一點|大一些|加大|變大|小一點|小一些|縮小|變小')) return [{ type: 'windows', room: room?.name || null, scale: has(t, '小') ? 0.8 : 1.25 }];

  // ---- 風格 ----
  const style = pick(t, STYLE_WORDS);
  const kind = pickKind(t);
  if (style && !kind && has(t, '風|風格|裝潢|換成|改成|全部|整棟|整間')) return [{ type: 'style', style, all: has(t, '整棟|全部|每一層|所有') }];

  // ---- 家具款式 ----
  if (kind && has(t, '換成|改成|換|改')) {
    const rest = t.slice(t.search(/換成|改成|換|改/));
    let variant = null;
    for (const [k, name] of Object.entries(FURN_VARIANTS[kind] || {})) if (rest.includes(name) || rest.includes(name.replace(/（.*）/, '').slice(-3))) { variant = k; break; }
    if (!variant && style) variant = STYLES[style]?.furn?.[kind] || null;
    const kw = [['弧形|彎', 'curved'], ['雲朵|雲', 'cloud'], ['皮|拉扣', 'chesterfield'], ['木框|低', 'lowwood'], ['錐腳|北歐', 'tapered'], ['圓', kind === 'coffee' ? 'roundwood' : kind === 'table' ? 'oval' : null], ['大理石', kind === 'coffee' ? 'drum' : kind === 'table' ? 'pedestal' : null], ['鐵', kind === 'bed' ? 'iron' : kind === 'coffee' ? 'steel' : null]];
    if (!variant) for (const [re, v] of kw) if (v && FURN_VARIANTS[kind]?.[v] && new RegExp(re).test(rest)) { variant = v; break; }
    if (has(rest, 'L型|L形|l型')) return [{ type: 'say', text: '目前沙發款式沒有 L 型，可以改用「加一張單椅」放在沙發旁邊，或從右側「款式」挑一款。' }];
    if (variant) return [{ type: 'variant', kind, variant, room: room?.name || null }];
    return [{ type: 'listVariants', kind }];
  }
  // ---- 加、刪家具 ----
  if (kind && has(t, '(加|放|擺|多|再|新增|買)[一-龥\\d]{0,3}') && !has(t, '加大|放大|多大')) return [{ type: 'addItem', kind, room: room?.name || null, n: Math.min(4, +(t.match(/(\d)\s*(?:張|個|台|座|盆|組|把)/)?.[1] || 1)) }];
  if (kind && has(t, '拿掉|刪掉|刪除|不要|移除|去掉|丟掉|搬走')) return [{ type: 'removeItem', kind, room: room?.name || null }];

  // ---- 格局（重新排）----
  const prog = { set: {}, inc: {} };
  if (has(t, '(多|加|再)(一|1)?間(小孩房|房間|臥室|房)')) prog.inc.kids = 1;
  if (has(t, '(少|減|拿掉|刪掉|不要)(一|1)?間(小孩房|房間|臥室|房)')) prog.inc.kids = -1;
  const rooms = t.match(/(?:改成|變成|要|排成?)?(\d)\s*房/);
  if (rooms && !has(t, '\\d\\s*房間')) prog.set.bedrooms = +rooms[1];
  const baths = t.match(/(\d)\s*(?:間)?(?:衛浴|浴室|廁所|衛)/);
  if (baths) prog.set.baths = +baths[1];
  for (const [re, key] of PROGRAM_ROOMS) {
    if (!new RegExp(re).test(t)) continue;
    if (key === 'dining' || key === 'living') { if (has(t, '不要|拿掉|取消')) prog.set[key] = false; continue; }
    prog.set[key] = !has(t, '不要|拿掉|取消|刪掉|去掉|少');
  }
  if (has(t, '廚房') && has(t, '開放')) prog.set.kitchen = 'open';
  if (has(t, '廚房') && has(t, '封閉|獨立|拉門|關起來|隔起來|門')) prog.set.kitchen = 'closed';
  if (has(t, '中島')) prog.set.island = !has(t, '不要|拿掉|取消');
  const seats = t.match(/餐桌[^\d]*(\d)\s*人|(\d)\s*人.*餐桌/);
  if (seats) prog.set.seats = Math.min(6, Math.max(2, +(seats[1] || seats[2])));
  if (has(t, '長輩友善|無障礙|老人家|長輩方便')) prog.set.accessible = !has(t, '不要|不用');
  if (has(t, '主臥') && has(t, '浴室|衛浴|廁所|套房')) prog.set.masterBath = !has(t, '不要|不用|拿掉');
  if (has(t, '安靜')) prog.set.priority = 'quiet';
  if (has(t, '明亮|亮一點|採光好')) prog.set.priority = 'light';
  if (Object.keys(prog.set).length || Object.keys(prog.inc).length) return [{ type: 'program', ...prog, floor }];

  // ---- 房間大小 ----
  if (room || has(t, '房間')) {
    const cm = t.match(/(\d+)\s*(公分|cm|CM)/);
    const m = t.match(/(\d+(?:\.\d+)?)\s*(米|公尺|m)(?![²2])/);
    let d = cm ? +cm[1] : m ? Math.round(+m[1] * 100) : 30;
    if (has(t, '小一點|小一些|縮小|變小|窄|小點')) d = -Math.abs(d);
    else if (!has(t, '大一點|大一些|加大|放大|變大|寬|大點|大\\d|大')) d = 0;
    if (d && room) return [{ type: 'resizeRoom', room: room.name, delta: Math.max(-120, Math.min(120, d)) }];
  }
  return null;
}

export function pickKind(t) {
  for (const [re, k] of KIND_WORDS) if (new RegExp(re).test(t)) return k;
  return null;
}

// 找句子裡提到的房間（平面上的名字優先，其次常見說法）
export function matchRoom(t, rooms) {
  let best = null;
  for (const r of rooms) {
    if (!r.name) continue;
    const n = r.name.replace(/\s+/g, '');
    if (t.includes(n) && (!best || n.length > best.n.length)) best = { ...r, n };
  }
  if (best) return best;
  for (const [re, key] of ROOM_SYNONYM) {
    if (!new RegExp(re).test(t)) continue;
    const r = rooms.find((x) => x.name && new RegExp(key).test(x.name));
    if (r) return r;
  }
  return null;
}

// 給 Claude 的說明：可以用哪些動作
export const ACTION_DOC = `動作（JSON 物件，type 必填）：
- {"type":"view","what":"building|floor:2F|focus:2F|walk|iso|front|top|sun|daylight|render|pano"}：看整棟、打開某層平面、剖開某層、漫遊、日照、採光、效果圖、360 環景
- {"type":"floorUse","floor":"1F|2F|3F|4F|5F|RF","use":"shop|rent|home|roof|empty"}：某層改用途（shop＝一樓大空間，RF＝頂樓）
- {"type":"building","set":{"n":3,"hasRoof":true,"shop.entry":"back|side","shop.scooters":0-7,"shop.hall":"living|shop|office|empty","shop.toilet":true,"rent.rooms":2|3,"roof.rooms":0|1|2,"roof.back":"tatami|bedroom|study|storage","roof.front":"altar|family|tatami","facade.wall":"paint|tile|stone|concrete|terrazzo","facade.color":"#rrggbb","facade.frame":"black|white|champagne|wood","facade.rail":"solid|glass|iron","facade.roof":"flat|pitched|pergola","facade.grille":"none|wood|alu","facade.awning":true}}
- {"type":"facadePreset","preset":"modern|concrete|brick|japan|stone"}
- {"type":"style","style":"japandi|nordic|wabi|industrial|luxe|basic","all":false}：裝潢風格
- {"type":"program","set":{"bedrooms":3,"baths":2,"study":true,"tatami":false,"altar":false,"walkin":false,"storage":false,"elder":false,"guest":false,"kitchen":"open|closed","island":false,"seats":4,"accessible":false,"masterBath":true},"inc":{"kids":1},"floor":"3F"}：重新自動排這一層的格局
- {"type":"resizeRoom","room":"主臥","delta":30}：房間加大（公分，負數是縮小）
- {"type":"variant","kind":"sofa|bed|armchair|coffee|table|chair|desk|nightstand|wardrobe|tv|lamp|shelf|bench|plant|altar|rug","variant":"款式代碼","room":null}
- {"type":"addItem","kind":"家具代碼","room":"房間名","n":1}、{"type":"removeItem","kind":"家具代碼","room":"房間名"}
- {"type":"autoWindows"}、{"type":"windows","room":"主臥","scale":1.25}、{"type":"undo"}`;
