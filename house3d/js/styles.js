// 裝潢風格：材質配色＋家具款式（furn：每種家具預設用哪一款，見 FURN_VARIANTS）。floor 依房間用途給地坪（wood 木地板、tile 磁磚、concrete 磨石子／水泥、marble 大理石）。
export const STYLES = {
  basic: {
    name: '原始配色',
    desc: '中性的木地板與白牆，方便看格局。',
    walls: '#f4f1ea', parapet: '#e9e4d9',
    floor: {
      living: { tex: 'wood', base: '#caa27a', dark: '#7b5a3a' },
      bedroom: { tex: 'wood', base: '#d8b994', dark: '#8a6a47' },
      hall: { tex: 'wood', base: '#cfae88', dark: '#80613f' },
      kitchen: { tex: 'tile', base: '#e3e3de', dark: '#b9b8b1', size: 60 },
      bath: { tex: 'tile', base: '#d7e1e6', dark: '#a9b7bf', size: 30 },
      balcony: { tex: 'tile', base: '#caa491', dark: '#9b7968', size: 30 },
    },
    wood: '#c49a6c', woodLight: '#e1c9a5', woodDark: '#7a5a3f', cabinet: '#e1c9a5',
    fabric: '#e8e4dc', fabric2: '#8ea4a8', fabric3: '#b9876a', sofa: '#7d8f86', rug: '#d9cfbf',
    stone: '#dad6ce', door: '#b88a5b', frame: '#e7e2d8', metal: '#2b2e33', lampShade: '#f3ead8',
    bedding: '#f4f2ec', throw: '#8ea4a8', leather: '#7b5135', brass: '#b8955a', paper: '#f5eedd', cane: '#cdb28a', plaster: '#e2ddd3',
    kitchenFront: '#fafaf7', counterTop: '#dad6ce', counterTex: null, pot: '#b56d4b', foliage: '#5d8a57', rugPattern: 'plain',
    furn: {},
  },
  japandi: {
    name: '日式無印（Japandi）',
    desc: '淺色橡木、米白牆、亞麻與棉麻布料，點綴少量炭黑。東方的簡約靜謐加上北歐的溫暖實用，東西少而精、每件都有用途。',
    refs: ['MUJI 無印良品之家', 'Norm Architects（丹麥，Japandi 代表事務所）', '隈研吾的木作溫度'],
    pinterest: ['Japandi living room', 'Japandi narrow house', '日式無印 客廳', 'muji style bedroom'],
    walls: '#f3efe7', parapet: '#ebe5da',
    floor: {
      living: { tex: 'wood', base: '#dcc39e', dark: '#a98b63' },
      bedroom: { tex: 'wood', base: '#dcc39e', dark: '#a98b63' },
      hall: { tex: 'wood', base: '#dcc39e', dark: '#a98b63' },
      kitchen: { tex: 'tile', base: '#e8e3d9', dark: '#cfc7b9', size: 60 },
      bath: { tex: 'tile', base: '#dfd9cf', dark: '#c3bbad', size: 30 },
      balcony: { tex: 'tile', base: '#cdbfae', dark: '#a99a88', size: 30 },
    },
    wood: '#c9a77c', woodLight: '#e4d1b0', woodDark: '#3a3632', cabinet: '#e8dcc6',
    fabric: '#ece6da', fabric2: '#bdb3a1', fabric3: '#7f8a6c', sofa: '#d2c8b6', rug: '#d9cdb7',
    stone: '#e6e1d7', door: '#d6bd95', frame: '#3a3632', metal: '#2f2d2a', lampShade: '#f6efe1',
    bedding: '#efe9dd', throw: '#8a8f74', leather: '#8a6a4b', brass: '#a08257', paper: '#f7efdc', cane: '#cdb48a', plaster: '#e8e1d4',
    kitchenFront: '#d9c19b', counterTop: '#ece8df', counterTex: null, pot: '#d8d0c2', foliage: '#6f8a5a', rugPattern: 'jute',
    furn: {
      bed: 'platform', sofa: 'lowwood', armchair: 'lounge', coffee: 'roundwood', table: 'slab', chair: 'wishbone', desk: 'oak',
      nightstand: 'cube', wardrobe: 'grooved', cabinet: 'grooved', tv: 'slat', lamp: 'akari', shelf: 'grid', bench: 'slat',
      plant: 'olive', pendant: 'lantern', altar: 'modern', handle: 'groove',
    },
  },
  nordic: {
    name: '北歐風',
    desc: '白牆、白洗梣木地板、灰藍布料加一點芥末黃。強調採光、好清理、耐用，適合有小孩的家庭。',
    refs: ['IKEA／HAY／Muuto 的北歐生活', '瑞典 lagom「剛剛好」的生活觀', 'Alvar Aalto 的木作家具'],
    pinterest: ['scandinavian living room bright', 'nordic kids room', '北歐風 小坪數', 'scandinavian dining nook'],
    walls: '#f7f7f4', parapet: '#efefeb',
    floor: {
      living: { tex: 'wood', base: '#e6dac7', dark: '#bba98d' },
      bedroom: { tex: 'wood', base: '#e6dac7', dark: '#bba98d' },
      hall: { tex: 'wood', base: '#e6dac7', dark: '#bba98d' },
      kitchen: { tex: 'tile', base: '#f1f1ef', dark: '#d2d2cf', size: 30 },
      bath: { tex: 'tile', base: '#eaeef0', dark: '#cdd4d8', size: 20 },
      balcony: { tex: 'tile', base: '#d3cdc4', dark: '#b1aaa0', size: 30 },
    },
    wood: '#d9ba90', woodLight: '#efe4d1', woodDark: '#4b4f54', cabinet: '#f4f3ef',
    fabric: '#f1efea', fabric2: '#6f8796', fabric3: '#d9a441', sofa: '#9ba6ad', rug: '#e6e2da',
    stone: '#eeedea', door: '#f2f2ee', frame: '#f2f2ee', metal: '#3b3f44', lampShade: '#ffffff',
    bedding: '#fbfbf9', throw: '#d9a441', leather: '#a0714a', brass: '#b8955a', paper: '#fbf7ee', cane: '#d9c29a', plaster: '#f1f0ec',
    kitchenFront: '#f4f3ef', counterTop: '#d9ba90', counterTex: null, pot: '#f4f4f1', foliage: '#4f7a4a', rugPattern: 'stripe',
    furn: {
      bed: 'upholstered', sofa: 'tapered', armchair: 'shell', coffee: 'tripod', table: 'oval', chair: 'shell', desk: 'white',
      nightstand: 'roundleg', wardrobe: 'knob', cabinet: 'knob', tv: 'whiteleg', lamp: 'tripod', shelf: 'white', bench: 'woodbench',
      plant: 'fig', pendant: 'ph', altar: 'modern', handle: 'knob',
    },
  },
  wabi: {
    name: '侘寂／溫潤極簡',
    desc: '灰米色礦物塗料牆、煙燻橡木、洞石與微水泥，布料用亞麻與毛圈。接受自然紋理與不完美，安靜、有質感。',
    refs: ['Axel Vervoordt（侘寂代表，石灰牆與煙燻橡木）', 'Vincent Van Duysen（溫潤極簡 warm minimalism）', 'John Pawson（極簡）'],
    pinterest: ['wabi sabi interior', 'warm minimalism living room', 'Vincent Van Duysen interior', '侘寂風 客廳'],
    walls: '#e8dfd2', parapet: '#ddd3c5',
    floor: {
      living: { tex: 'wood', base: '#ad8b66', dark: '#6f553b' },
      bedroom: { tex: 'wood', base: '#b59473', dark: '#76593e' },
      hall: { tex: 'concrete', base: '#cfc5b6' },
      kitchen: { tex: 'concrete', base: '#c9beae' },
      bath: { tex: 'concrete', base: '#cbc1b2' },
      balcony: { tex: 'tile', base: '#c4b39f', dark: '#a39280', size: 40 },
    },
    wood: '#8a6a4b', woodLight: '#c8b49a', woodDark: '#4a3a2c', cabinet: '#d8ccbb',
    fabric: '#e9e2d6', fabric2: '#a5937c', fabric3: '#6b5b4a', sofa: '#dcd3c4', rug: '#cdbfa9',
    stone: '#d8cbb7', door: '#c2ad91', frame: '#5a4a3a', metal: '#4a3e33', lampShade: '#efe5d3',
    bedding: '#e6dccd', throw: '#a5937c', leather: '#7a5a3e', brass: '#9c8463', paper: '#efe5d3', cane: '#c9b08a', plaster: '#ddd2c2',
    kitchenFront: '#cfc3b2', counterTop: '#d8cbb7', counterTex: 'concrete', pot: '#8c7b68', foliage: '#7a7f5c', rugPattern: 'organic',
    furn: {
      bed: 'floor', sofa: 'cloud', armchair: 'tub', coffee: 'block', table: 'plinth', chair: 'jeanneret', desk: 'slab',
      nightstand: 'stone', wardrobe: 'plaster', cabinet: 'plaster', tv: 'ledge', lamp: 'pleat', shelf: 'niche', bench: 'stone',
      plant: 'branch', pendant: 'drum', altar: 'modern', handle: 'groove',
    },
  },
  industrial: {
    name: '工業風',
    desc: '水泥粉光地、灰牆、黑鐵件、胡桃木與皮革沙發。耐髒好整理，適合喜歡粗獷質感的人。',
    refs: ['紐約 Loft 公寓', 'Restoration Hardware 的皮革與鐵件', 'Soho House 的老件混搭'],
    pinterest: ['industrial loft living room', 'concrete floor walnut leather sofa', '工業風 客廳', 'black steel kitchen'],
    walls: '#d8d5cf', parapet: '#cfccc6',
    floor: {
      living: { tex: 'concrete', base: '#a9a7a2' },
      bedroom: { tex: 'wood', base: '#8a6648', dark: '#4f3a29' },
      hall: { tex: 'concrete', base: '#a9a7a2' },
      kitchen: { tex: 'tile', base: '#46484c', dark: '#2a2b2e', size: 20 },
      bath: { tex: 'tile', base: '#bdbbb7', dark: '#8f8d89', size: 20 },
      balcony: { tex: 'concrete', base: '#9d9b96' },
    },
    wood: '#6e4e35', woodLight: '#a9876a', woodDark: '#232427', cabinet: '#3a3c40',
    fabric: '#cfccc6', fabric2: '#4d5560', fabric3: '#b3653b', sofa: '#8b5a36', rug: '#8c8578',
    stone: '#8e8c88', door: '#2d2f33', frame: '#26282b', metal: '#1f2023', lampShade: '#2d2f33',
    bedding: '#d5d2cb', throw: '#4d5560', leather: '#8b5a36', brass: '#8a7a5a', paper: '#efe6d2', cane: '#b39467', plaster: '#cfccc6',
    kitchenFront: '#2d2f33', counterTop: '#9a9893', counterTex: 'concrete', pot: '#8e8c88', foliage: '#3f6b3a', rugPattern: 'vintage',
    furn: {
      bed: 'iron', sofa: 'chesterfield', armchair: 'sling', coffee: 'steel', table: 'trestle', chair: 'tolix', desk: 'hairpin',
      nightstand: 'crate', wardrobe: 'steelglass', cabinet: 'steelglass', tv: 'pipe', lamp: 'task', shelf: 'pipe', bench: 'steel',
      plant: 'monstera', pendant: 'dome', altar: 'classic', handle: 'bar',
    },
  },
  luxe: {
    name: '現代輕奢',
    desc: '大理石紋大板磚、深胡桃木、墨綠絨布與金屬細節。俐落但有份量，適合想要飯店感的客廳。',
    refs: ['Kelly Wearstler（大膽配色與材質）', 'Aman 安縵飯店的沉穩奢華', '義式家具 Minotti／Poliform'],
    pinterest: ['modern luxury living room marble green velvet', 'quiet luxury interior', '輕奢風 客廳', 'brass and marble kitchen'],
    walls: '#efeae3', parapet: '#e5dfd6',
    floor: {
      living: { tex: 'marble', base: '#ece8e2', dark: '#c9c2b8', size: 120 },
      bedroom: { tex: 'wood', base: '#a07c58', dark: '#5f452f' },
      hall: { tex: 'marble', base: '#ece8e2', dark: '#c9c2b8', size: 120 },
      kitchen: { tex: 'marble', base: '#e9e6e1', dark: '#c4bdb3', size: 80 },
      bath: { tex: 'marble', base: '#e7e3dd', dark: '#bfb7ab', size: 60 },
      balcony: { tex: 'tile', base: '#cfc8bd', dark: '#aaa296', size: 60 },
    },
    wood: '#5a3d2b', woodLight: '#d9c7ad', woodDark: '#1e1e20', cabinet: '#e9e3d9',
    fabric: '#ece6dc', fabric2: '#3a4a5c', fabric3: '#b48a4a', sofa: '#2f4a43', rug: '#cfc3b0',
    stone: '#e8e4dd', door: '#e9e4dc', frame: '#b8955a', metal: '#b8955a', lampShade: '#f4ead6',
    bedding: '#f3eee6', throw: '#b48a4a', leather: '#5a3d2b', brass: '#c3a062', paper: '#f4ead6', cane: '#cdb48a', plaster: '#ece6dc',
    kitchenFront: '#3b2a20', counterTop: '#efebe5', counterTex: 'marble', pot: '#c3a062', foliage: '#4c7a4c', rugPattern: 'border',
    furn: {
      bed: 'tufted', sofa: 'curved', armchair: 'club', coffee: 'drum', table: 'pedestal', chair: 'velvet', desk: 'brass',
      nightstand: 'marble', wardrobe: 'fluted', cabinet: 'fluted', tv: 'fluted', lamp: 'arc', shelf: 'brassframe', bench: 'velvet',
      plant: 'palm', pendant: 'globe', altar: 'classic', handle: 'brass',
    },
  },
};

export const STYLE_KEYS = Object.keys(STYLES);

// 家具款式：同一種家具在不同風格下的造型。key＝款式代號，value＝顯示名稱。
export const FURN_VARIANTS = {
  bed: { basic: '標準床架', platform: '日式低床架＋格柵床頭', upholstered: '北歐布面高床頭', floor: '侘寂地台床', iron: '工業黑鐵管床', tufted: '輕奢高背拉扣床' },
  sofa: { basic: '方正沙發', lowwood: '日式木框低沙發', tapered: '北歐錐腳沙發', cloud: '侘寂雲朵沙發', chesterfield: '工業皮革拉扣沙發', curved: '輕奢弧形絨布沙發' },
  armchair: { basic: '單椅', lounge: '日式木框休閒椅', shell: '北歐貝殼單椅', tub: '侘寂圓桶椅', sling: '工業皮革吊帶椅', club: '輕奢絨布圓背椅' },
  coffee: { basic: '方茶几', roundwood: '日式圓木矮几', tripod: '北歐三腳圓几', block: '侘寂石塊茶几', steel: '工業鐵件茶几', drum: '輕奢大理石圓几' },
  table: { basic: '四腳餐桌', slab: '日式實木板腳桌', oval: '北歐橢圓餐桌', plinth: '侘寂厚板餐桌', trestle: '工業鐵架餐桌', pedestal: '輕奢大理石餐桌' },
  chair: { basic: '餐椅', wishbone: 'Y 字椅（Wegner）', shell: '殼椅（Eames）', jeanneret: '藤編椅（Jeanneret）', tolix: '鐵椅（Tolix）', velvet: '絨布金腳椅' },
  desk: { basic: '書桌', oak: '日式橡木書桌', white: '北歐白色書桌', slab: '侘寂厚板書桌', hairpin: '工業髮夾腳書桌', brass: '輕奢胡桃金腳書桌' },
  nightstand: { basic: '床頭櫃', cube: '日式木格床頭櫃', roundleg: '北歐圓邊几', stone: '侘寂石墩', crate: '工業鐵架床頭櫃', marble: '輕奢大理石圓櫃' },
  wardrobe: { basic: '平板門', grooved: '日式木紋溝縫門', knob: '北歐白門木把手', plaster: '侘寂無把手門', steelglass: '工業黑框玻璃門', fluted: '輕奢胡桃格柵門' },
  tv: { basic: '電視櫃', slat: '日式木格柵櫃', whiteleg: '北歐白色腳櫃', ledge: '侘寂懸浮平台', pipe: '工業鐵架層板', fluted: '輕奢格柵大理石櫃' },
  lamp: { basic: '立燈', akari: '和紙立燈（Noguchi）', tripod: '北歐三腳燈', pleat: '侘寂陶座燈', task: '工業鐵件燈', arc: '輕奢弧形釣魚燈' },
  shelf: { basic: '書櫃', grid: '日式木格櫃', white: '北歐白色層架', niche: '侘寂壁龕', pipe: '工業水管層架', brassframe: '輕奢金屬框層架' },
  bench: { basic: '長凳', slat: '日式木條凳', woodbench: '北歐實木凳', stone: '侘寂石凳', steel: '工業鐵件凳', velvet: '輕奢絨布凳' },
  plant: { basic: '盆栽', olive: '橄欖樹', fig: '琴葉榕', branch: '枝材花器', monstera: '龜背芋', palm: '天堂鳥' },
  altar: { classic: '傳統神明桌', modern: '現代簡約神明桌' },
  rug: { plain: '素色', jute: '黃麻編織', stripe: '條紋', organic: '不規則圓角', vintage: '復古花紋', border: '金色滾邊' },
};
FURN_VARIANTS.bed_single = FURN_VARIANTS.bed;
FURN_VARIANTS.cabinet = FURN_VARIANTS.wardrobe;

// 家具實際使用的款式：家具自己指定的 variant 優先，否則依平面風格
export function variantOf(it, styleKey) {
  const list = FURN_VARIANTS[it.kind];
  if (!list) return 'basic';
  if (it.variant && list[it.variant]) return it.variant;
  if (it.kind === 'rug') return STYLES[styleKey]?.rugPattern || 'plain';
  const f = STYLES[styleKey]?.furn || {};
  const k = it.kind === 'bed_single' ? 'bed' : it.kind;
  const v = f[k];
  if (v && list[v]) return v;
  return list.basic ? 'basic' : Object.keys(list)[0];
}
