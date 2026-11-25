'use strict';
/*
  Serveur de la boutique MAISON
  - Sert la boutique (/) et le back-office (/admin)
  - Enregistre produits, réglages et photos dans PostgreSQL (Heroku Postgres)
    ou, à défaut, dans le dossier ./data (pratique pour tester sur son ordinateur)
*/
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const zlib = require('zlib');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC = path.join(__dirname, 'public');
const FONT_DIR = path.join(PUBLIC, 'fonts');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET ||
  crypto.createHash('sha256').update('maison-session:' + ADMIN_PASSWORD).digest('hex');
const ON_HEROKU = !!process.env.DYNO;
const SEED = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8'));
// Photos livrées avec le site (créées par « Télécharger une sauvegarde ») : chargées au premier lancement
const SEED_IMAGES = path.join(__dirname, 'seed-images');

const GENDERS = ['femme', 'homme', 'enfant', 'bebe'];
const ILLUSTRATIONS = ['tee', 'knit', 'hoodie', 'puffer', 'fleece', 'coat', 'shirt', 'jeans', 'pants', 'skirt', 'beanie', 'socks', 'body'];
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const FONT_TYPES = { woff2: 'font/woff2', woff: 'font/woff', otf: 'font/otf', ttf: 'font/ttf' };
const SESSION_DAYS = 30;

/* ───────────── Petits outils ───────────── */
const str = (v, max = 500) => (v === undefined || v === null ? '' : String(v)).slice(0, max);
const num = (v) => {
  const x = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(x) && x >= 0 ? Math.round(x * 100) / 100 : 0;
};
const hexColor = (v, d = '#cccccc') => (/^#[0-9a-f]{6}$/i.test(v || '') ? String(v).toLowerCase() : d);
const imageUrl = (v) => {
  const s = str(v, 2000).trim();
  if (/^\/img\/[a-f0-9]{24}$/.test(s)) return s;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(s)) return s;
  return '';
};
const slug = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
const randomId = (bytes = 6) => crypto.randomBytes(bytes).toString('hex');

/* ───────────── Nettoyage des données reçues ───────────── */
function cleanProduct(p) {
  p = p && typeof p === 'object' ? p : {};
  const colors = (Array.isArray(p.colors) ? p.colors : []).slice(0, 120).map((c) => ({
    name: str(c && c.name, 40).trim(),
    code: str(c && c.code, 8).trim(),
    hex: hexColor(c && c.hex),
    image: imageUrl(c && c.image),
    texture: imageUrl(c && c.texture),
  })).filter((c) => c.name || c.code);
  // Collections = les entrées du menu sous la barre de recherche (Femme, Homme, Enfant, Bébé).
  // Un produit peut être dans plusieurs collections, ou dans aucune (il n’est alors trouvable que par la recherche).
  const wanted = Array.isArray(p.collections) ? p.collections : (GENDERS.includes(p.gender) ? [p.gender] : []);
  const collections = GENDERS.filter((g) => wanted.includes(g));
  const gender = collections.includes(p.gender) ? p.gender : (collections[0] || '');
  const source = str(p.source, 1000).trim();
  const category = str(p.category, 80).trim();
  const subcategory = str(p.subcategory, 80).trim();
  // Autres catégories où le produit apparaît aussi (ex. « Doudounes » et « Best-Sellers »), avec leurs rayons.
  const lc = (s) => s.toLowerCase();
  const seenAlso = new Set();
  const also = (Array.isArray(p.also) ? p.also : []).slice(0, 40).map((a) => {
    a = a && typeof a === 'object' ? a : {};
    const want = Array.isArray(a.cols) ? a.cols : [];
    return { cat: str(a.cat, 80).trim(), sub: str(a.sub, 80).trim(), cols: GENDERS.filter((g) => want.includes(g)) };
  }).filter((a) => {
    if (!a.cat) return false;
    if (lc(a.cat) === lc(category) && lc(a.sub) === lc(subcategory) && a.cols.every((g) => collections.includes(g))) return false;
    const k = lc(a.cat) + '|' + lc(a.sub) + '|' + a.cols.join(',');
    if (seenAlso.has(k)) return false;
    seenAlso.add(k);
    return true;
  });
  return {
    id: /^[\w-]{1,64}$/.test(p.id || '') ? p.id : 'p_' + randomId(),
    handle: slug(p.handle || p.name) || 'produit-' + randomId(3),
    name: str(p.name, 200).trim() || 'Sans nom',
    description: str(p.description, 30000),
    details: str(p.details, 3000),
    gender,
    collections,
    category,
    subcategory,
    also,
    price: num(p.price),
    comparePrice: num(p.comparePrice),
    images: [...new Set((Array.isArray(p.images) ? p.images : []).map(imageUrl).filter(Boolean))].slice(0, 20),
    colors,
    sizes: (Array.isArray(p.sizes) ? p.sizes : []).map((s) => str(s, 20).trim()).filter(Boolean).slice(0, 40),
    illustration: ILLUSTRATIONS.includes(p.illustration) ? p.illustration : '',
    isNew: !!p.isNew,
    featured: !!p.featured,
    bestseller: !!p.bestseller,
    published: p.published !== false,
    demo: !!p.demo,
    // Champs propres à la boutique maquillage
    subtitle: str(p.subtitle, 160).trim(),
    subtitle2: str(p.subtitle2, 160).trim(),
    reviews: Math.round(num(p.reviews)),
    badge: str(p.badge, 40).trim(),
    rating: Math.min(5, num(p.rating)),
    button: p.button === 'shade' ? 'shade' : 'add',
    source: /^https?:\/\/[^\s"'<>]+$/i.test(source) ? source : '',
  };
}

function cleanProducts(list) {
  const ids = new Set();
  const handles = new Set();
  return (Array.isArray(list) ? list : []).slice(0, 5000).map(cleanProduct).map((p) => {
    while (ids.has(p.id)) p.id = 'p_' + randomId();
    ids.add(p.id);
    let h = p.handle;
    let i = 2;
    while (handles.has(h)) h = `${p.handle}-${i++}`;
    p.handle = h;
    handles.add(h);
    return p;
  });
}

/* Catégories de départ de chaque rayon (même liste que sur Uniqlo). Modifiables dans le back-office. */
const CAT_KINDS = ['cat', 'new', 'drop', 'best'];
const DEFAULT_CATEGORY_NAMES = {
  femme: ['Best Sellers', 'Face', 'Skin', 'Lips', 'Brows', 'Eyes', 'Skin Goals'],
  homme: ['Vestes & Manteaux', 'Vestes & Parkas', 'Doudounes', 'Pulls & Cardigans', 'Cachemire', 'Jeans, Pantalons & Shorts', 'Jean', 'T-shirts, Sweats & Polaires', 'Sweats', 'Polaires', 'Chemises & Polos', 'Sous-vêtements & Chaussettes', 'Accessoires', 'Loungewear & Pyjamas', 'HEATTECH', 'PUFFERTECH', 'Sport Utility Wear', 'AIRism', 'Collaborations spéciales', 'UNIQLO and JW ANDERSON', 'UNIQLO : C', 'UNIQLO F.RISSO', 'Uniqlo U', 'T-shirts UT', 'Peace for All', 'Nouveautés', 'Nouveautés à venir', 'Collection Hiver 2026', 'Tailles & Longueurs supplémentaires', 'Prix en baisse', 'Dernières pièces', 'Exclusivités en ligne', 'Offres en lot', 'Best-Sellers'],
  enfant: ['Filles', 'Garçons & Unisexe', 'Vestes & Manteaux', 'T-shirts, Sweats & Polaires', 'Polaire', 'Pulls', 'Sweats', 'Jeans, Pantalons & Joggings', 'Robes, Combinaisons & Jupes-shorts', 'Sous-vêtements & Chaussettes', 'HEATTECH', 'Accessoires', 'Rentrée scolaire', 'Sport Utility Wear', 'AIRism', 'T-Shirts UT', 'Nouveautés', 'Nouveautés à venir', 'Collection Hiver 2026', 'Prix en baisse', 'Dernières pièces', 'Best-Sellers'],
  bebe: ['Nouveau-né (0-24 mois)', 'Bébé (de 6 mois à 4 ans)', 'Vestes', 'Leggings & Pantalons', 'T-shirts, Sweats & Polaires', 'Sous-vêtements', 'Combinaisons', 'Bodies', 'Loungewear & Pyjamas', 'Collection UT', 'Nouveautés', 'Nouveautés à venir', 'Collection Hiver 2026', 'Prix en baisse', 'Offres en lot', 'Best-Sellers'],
};
// « Best-Sellers » est une catégorie normale : on y range les produits (par exemple en scrapant la page Best-Sellers d’Uniqlo).
const BEST_NAME = /^best[\s-]?sellers?$/i;
const catKindOf = (n) => (n === 'Nouveautés' ? 'new' : n === 'Prix en baisse' ? 'drop' : 'cat');
const defaultCategories = (g) => DEFAULT_CATEGORY_NAMES[g].map((name, i) => ({ id: `d_${g}_${i + 1}`, name, image: '', kind: catKindOf(name), subs: [] }));

/* Adresse du checkout externe (vide = paiement désactivé). Seules les adresses http(s) sont acceptées. */
function checkoutUrl(v) {
  const t = str(v, 2000).trim();
  if (!t) return '';
  try { const u = new URL(t); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (e) { return ''; }
}

/* Mode maintenance : page affichée aux visiteurs à la place de la boutique */
const MAINT_DEFAULT = { title: 'Down for maintenance', text: 'We’ll be back very soon. Thank you for your patience!' };
function cleanMaintenance(m) {
  m = m && typeof m === 'object' ? m : {};
  return {
    enabled: !!m.enabled,
    title: m.title === undefined ? MAINT_DEFAULT.title : str(m.title, 120),
    text: m.text === undefined ? MAINT_DEFAULT.text : str(m.text, 600),
    image: imageUrl(m.image),
  };
}
/* Limites de panier : montant maximum, montant minimum, nombre d'articles, quantité par article */
function cleanCartLimit(c) {
  c = c && typeof c === 'object' ? c : {};
  const whole = (v, d, min, max) => (v === undefined ? d : Math.min(max, Math.max(min, Math.round(num(v)) || min)));
  return {
    enabled: !!c.enabled,
    amount: c.amount === undefined ? 500 : Math.min(1000000, num(c.amount)),
    minEnabled: !!c.minEnabled,
    minAmount: c.minAmount === undefined ? 20 : Math.min(1000000, num(c.minAmount)),
    itemsEnabled: !!c.itemsEnabled,
    maxItems: whole(c.maxItems, 20, 1, 999),
    qtyEnabled: !!c.qtyEnabled,
    maxQty: whole(c.maxQty, 5, 1, 99),
  };
}

function cleanSettings(input) {
  const d = SEED.settings;
  const o = input && typeof input === 'object' ? input : {};
  const get = (sec, key) => (o[sec] && typeof o[sec] === 'object' ? o[sec][key] : undefined);
  const S = (sec, key, max = 300) => { const v = get(sec, key); return v === undefined ? d[sec][key] : str(v, max); };
  const B = (sec, key) => { const v = get(sec, key); return v === undefined ? d[sec][key] : !!v; };
  const N = (sec, key, min, max) => { const v = get(sec, key); return v === undefined ? d[sec][key] : Math.min(max, Math.max(min, num(v))); };
  const C = (sec, key) => hexColor(get(sec, key), d[sec][key]);
  const U = (sec, key) => { const v = get(sec, key); return v === undefined ? d[sec][key] : imageUrl(v); };
  const pages = {};
  for (const k of Object.keys(d.pages)) {
    const p = (o.pages && o.pages[k]) || {};
    pages[k] = {
      title: p.title === undefined ? d.pages[k].title : str(p.title, 120),
      body: p.body === undefined ? d.pages[k].body : str(p.body, 30000),
    };
  }
  // Catégories de chaque rayon : nom, photo, type et sous-catégories
  const catsIn = o.categories && typeof o.categories === 'object' ? o.categories : {};
  const categories = {};
  for (const g of GENDERS) {
    const src = Array.isArray(catsIn[g]) ? catsIn[g] : defaultCategories(g);
    const ids = new Set();
    categories[g] = src.slice(0, 150).map((c) => {
      if (!c || typeof c !== 'object') return null;
      const name = str(c.name, 60).trim();
      if (!name) return null;
      let id = /^[\w-]{1,40}$/.test(c.id || '') ? c.id : 'c_' + randomId(4);
      while (ids.has(id)) id = 'c_' + randomId(4);
      ids.add(id);
      const subs = [...new Set((Array.isArray(c.subs) ? c.subs : []).map((x) => str(x, 60).trim()).filter(Boolean))].slice(0, 80);
      const kind = CAT_KINDS.includes(c.kind) && !(c.kind === 'best' && BEST_NAME.test(name)) ? c.kind : 'cat';
      return { id, name, image: imageUrl(c.image), kind, subs };
    }).filter(Boolean);
  }
  const catalog = { showEmpty: o.catalog && o.catalog.showEmpty !== undefined ? !!o.catalog.showEmpty : false };
  // Une première image (hero) par rayon. Sans réglage enregistré, on reprend l'image générale.
  const heroes = {};
  for (const g of GENDERS) {
    const src = o.heroes && o.heroes[g] && typeof o.heroes[g] === 'object' ? o.heroes[g] : (o.hero && typeof o.hero === 'object' ? o.hero : d.hero);
    const hs = (key, max) => (src[key] === undefined ? d.hero[key] : str(src[key], max));
    heroes[g] = {
      kicker: hs('kicker', 80), title: hs('title', 120), subtitle: hs('subtitle', 120), text: hs('text', 400), button: hs('button', 60),
      image: src.image === undefined ? d.hero.image : imageUrl(src.image), color: hexColor(src.color, d.hero.color),
      banner: src.banner === undefined ? '' : imageUrl(src.banner),
    };
  }
  // Les 2 produits à la une de l'accueil de chaque rayon (choisis dans le back-office)
  const featuredIn = o.featured && typeof o.featured === 'object' ? o.featured : {};
  const featured = {};
  for (const g of GENDERS) {
    const l = Array.isArray(featuredIn[g]) ? featuredIn[g] : [];
    featured[g] = [...new Set(l.filter((id) => typeof id === 'string' && /^[\w-]{1,64}$/.test(id)))].slice(0, 2);
  }
  // Les 2 blocs du bas de l'accueil (4 produits + 1 grand produit) : titre, catégorie et sous-catégorie, par rayon.
  // Catégorie vide = Best-Sellers ; « @new » = Nouveautés ; « @drop » = Prix en baisse.
  const railsIn = o.homeRails && typeof o.homeRails === 'object' ? o.homeRails : {};
  const RAIL_TITLES = ['Les plus demandés', 'Nos coups de cœur'];
  const homeRails = {};
  for (const g of GENDERS) {
    const l = Array.isArray(railsIn[g]) ? railsIn[g] : [];
    homeRails[g] = [0, 1].map((i) => {
      const r = l[i] && typeof l[i] === 'object' ? l[i] : {};
      return { title: r.title === undefined ? RAIL_TITLES[i] : str(r.title, 60).trim(), cat: str(r.cat, 80).trim(), sub: str(r.sub, 80).trim() };
    });
  }
  return {
    homeRails,
    shop: { name: S('shop', 'name', 60).trim() || 'Boutique', tagline: str(get('shop', 'tagline') ?? d.shop.tagline ?? '', 40), currency: ['£', '€', '$'].includes(get('shop', 'currency')) ? get('shop', 'currency') : (d.shop.currency || '£'), logo: U('shop', 'logo'), logoMode: S('shop', 'logoMode', 10) === 'original' ? 'original' : 'adapt', logoHeight: Math.round(N('shop', 'logoHeight', 16, 200)) },
    ticker: { enabled: B('ticker', 'enabled'), text: S('ticker', 'text', 160) },
    hero: {
      kicker: S('hero', 'kicker', 80), title: S('hero', 'title', 120), subtitle: S('hero', 'subtitle', 120),
      text: S('hero', 'text', 400), button: S('hero', 'button', 60), image: U('hero', 'image'), color: C('hero', 'color'),
    },
    heroes,
    featured,
    categories,
    catalog,
    sale: { enabled: B('sale', 'enabled'), percent: Math.round(N('sale', 'percent', 0, 90)), label: S('sale', 'label', 60), dropLabel: str(get('sale', 'dropLabel'), 60), hideLabel: !!get('sale', 'hideLabel') },
    genders: Object.fromEntries(GENDERS.map((g) => [g, B('genders', g)])),
    colors: { sale: C('colors', 'sale'), badge: C('colors', 'badge') },
    images: { ratio: S('images', 'ratio', 10) === 'portrait' ? 'portrait' : 'square' },
    shipping: { freeFrom: N('shipping', 'freeFrom', 0, 100000), fee: N('shipping', 'fee', 0, 10000), note: S('shipping', 'note', 200) },
    social: { instagram: S('social', 'instagram', 300), tiktok: S('social', 'tiktok', 300), facebook: S('social', 'facebook', 300) },
    footer: { copyright: S('footer', 'copyright', 200) },
    checkout: { url: checkoutUrl(o.checkout && o.checkout.url) },
    maintenance: cleanMaintenance(o.maintenance),
    cartLimit: cleanCartLimit(o.cartLimit),
    pages,
  };
}

/* ───────────── Stockage : PostgreSQL ou fichiers ───────────── */
function pgStore() {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { throw new Error('Le module « pg » est manquant. Lancez « npm install ».'); }
  const local = /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);
  const ssl = local || process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });
  return {
    kind: 'postgres',
    persistent: true,
    async init() {
      await pool.query('CREATE TABLE IF NOT EXISTS maison_store (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      await pool.query('CREATE TABLE IF NOT EXISTS maison_images (id TEXT PRIMARY KEY, mime TEXT NOT NULL, data BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      await pool.query('CREATE TABLE IF NOT EXISTS maison_stats (id INTEGER PRIMARY KEY, data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    },
    async loadStats() {
      const r = await pool.query('SELECT data FROM maison_stats WHERE id = 1');
      return r.rows[0] ? r.rows[0].data : null;
    },
    async saveStats(doc) {
      await pool.query(
        'INSERT INTO maison_stats (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [JSON.stringify(doc)]
      );
    },
    async load() {
      const r = await pool.query('SELECT data FROM maison_store WHERE id = 1');
      return r.rows[0] ? r.rows[0].data : null;
    },
    async save(doc) {
      await pool.query(
        'INSERT INTO maison_store (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [JSON.stringify(doc)]
      );
    },
    async putImage(id, mime, buf) {
      await pool.query('INSERT INTO maison_images (id, mime, data) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING', [id, mime, buf]);
    },
    async getImage(id) {
      const r = await pool.query('SELECT mime, data FROM maison_images WHERE id = $1', [id]);
      return r.rows[0] || null;
    },
  };
}

function fileStore() {
  const storeFile = path.join(DATA_DIR, 'store.json');
  const imgDir = path.join(DATA_DIR, 'images');
  return {
    kind: 'fichiers',
    persistent: !ON_HEROKU,
    async init() { fs.mkdirSync(imgDir, { recursive: true }); },
    async load() {
      try { return JSON.parse(fs.readFileSync(storeFile, 'utf8')); } catch (e) { return null; }
    },
    async save(doc) {
      const tmp = storeFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(doc));
      fs.renameSync(tmp, storeFile);
    },
    async loadStats() {
      try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'stats.json'), 'utf8')); } catch (e) { return null; }
    },
    async saveStats(doc) { fs.writeFileSync(path.join(DATA_DIR, 'stats.json'), JSON.stringify(doc)); },
    async putImage(id, mime, buf) { fs.writeFileSync(path.join(imgDir, `${id}.${IMAGE_TYPES[mime]}`), buf); },
    async getImage(id) {
      for (const [mime, ext] of Object.entries(IMAGE_TYPES)) {
        const f = path.join(imgDir, `${id}.${ext}`);
        if (fs.existsSync(f)) return { mime, data: fs.readFileSync(f) };
      }
      return null;
    },
  };
}

let db;
let STORE;
let chain = Promise.resolve();
function persist() {
  const doc = { settings: STORE.settings, products: STORE.products, updatedAt: new Date().toISOString() };
  const p = chain.then(() => db.save(doc));
  chain = p.catch(() => {});
  return p;
}

/* ───────────── Police TT Commons Pro (si les fichiers sont fournis) ───────────── */
function fontWeight(name) {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  const map = [['extrabold', 800], ['ultrabold', 800], ['semibold', 600], ['demibold', 600], ['extralight', 200],
    ['ultralight', 200], ['black', 900], ['heavy', 900], ['bold', 700], ['medium', 500], ['light', 300], ['thin', 100], ['hairline', 100]];
  for (const [k, w] of map) if (n.includes(k)) return w;
  return 400;
}
function buildFontCss() {
  let files = [];
  try { files = fs.readdirSync(FONT_DIR).filter((f) => /^[\w.-]+\.(woff2|woff|otf|ttf)$/i.test(f)); } catch (e) { return ''; }
  const groups = new Map();
  for (const f of files) {
    const style = /italic|oblique/i.test(f) ? 'italic' : 'normal';
    const key = `${fontWeight(f)}|${style}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(f);
  }
  const order = ['woff2', 'woff', 'otf', 'ttf'];
  const fmt = { woff2: 'woff2', woff: 'woff', otf: 'opentype', ttf: 'truetype' };
  let css = '';
  for (const [key, list] of groups) {
    const [weight, style] = key.split('|');
    list.sort((a, b) => order.indexOf(a.split('.').pop().toLowerCase()) - order.indexOf(b.split('.').pop().toLowerCase()));
    const src = list.map((f) => `url("/fonts/${f}") format("${fmt[f.split('.').pop().toLowerCase()]}")`).join(',');
    css += `@font-face{font-family:"TT Commons Pro";src:${src};font-weight:${weight};font-style:${style};font-display:swap}\n`;
  }
  return css;
}

/* ───────────── Pages ───────────── */
let INDEX_HTML = '';
let ADMIN_HTML = '';
let PREVIEW_HTML = '';
function loadPages() {
  const fontCss = buildFontCss();
  INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8').replace('/*FONT_FACES*/', fontCss);
  ADMIN_HTML = fs.readFileSync(path.join(PUBLIC, 'admin.html'), 'utf8').replace('/*FONT_FACES*/', fontCss);
  PREVIEW_HTML = fs.readFileSync(path.join(PUBLIC, 'apercu.html'), 'utf8');
  if (fontCss) console.log('Police TT Commons Pro chargée depuis public/fonts');
}

/* ───────────── Connexion au back-office ───────────── */
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
const sameText = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return false;
  const [ts, mac] = readCookie(req, 'maison_admin').split('.');
  if (!ts || !mac || !/^\d+$/.test(ts)) return false;
  if (Date.now() - Number(ts) > SESSION_DAYS * 864e5) return false;
  return mac.length === 64 && sameText(mac, sign('admin:' + ts));
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
function sessionCookie(req, value, maxAge) {
  return `maison_admin=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? '; Secure' : ''}`;
}
const attempts = new Map();
function clientIp(req) { return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?'; }
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 15 * 60e3);
  attempts.set(ip, list);
  return list.length >= 10;
}

/* ───────────── Scraper : lecture des pages d’autres sites pour le back-office ───────────── */
const SCRAPE_MAX_BYTES = 6 * 1024 * 1024;
const SCRAPE_TIMEOUT = 20000;
const SCRAPE_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
// Pour tester sur son ordinateur avec de faux sites locaux (jamais actif sur Heroku)
const SCRAPE_ALLOW_LOCAL = !ON_HEROKU && process.env.SCRAPER_ALLOW_LOCAL === '1';

function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  const x = ip.toLowerCase();
  if (x.startsWith('::ffff:')) return privateAddress(x.slice(7));
  return x === '::' || x === '::1' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe80');
}
async function checkTarget(u) {
  if (!/^https?:$/.test(u.protocol)) throw httpError(400, 'Adresse non prise en charge (http ou https uniquement).');
  if (SCRAPE_ALLOW_LOCAL) return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw httpError(400, 'Adresse interne refusée.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => { throw httpError(400, 'Site introuvable.'); });
  if (!addrs.length || addrs.some((a) => privateAddress(a.address))) throw httpError(400, 'Adresse interne refusée.');
}
function decodeBody(buf, contentType) {
  let cs = (/charset=([\w-]+)/i.exec(contentType || '') || [])[1];
  if (!cs && /html/i.test(contentType || '')) cs = (/<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 4096).toString('latin1')) || [])[1];
  try { return new TextDecoder((cs || 'utf-8').toLowerCase()).decode(buf); } catch (e) { return new TextDecoder('utf-8').decode(buf); }
}
async function scrapeFetch(target, wantJson, extraHeaders) {
  let u;
  try { u = new URL(String(target || '')); } catch (e) { throw httpError(400, 'Adresse invalide.'); }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SCRAPE_TIMEOUT);
  // Filtrer les headers custom (seuls les noms sûrs sont transmis)
  const safe = {};
  if (extraHeaders && typeof extraHeaders === 'object') {
    const allow = /^x-[a-z][a-z0-9-]{0,40}$/i;
    for (const [k, v] of Object.entries(extraHeaders)) if (allow.test(k) && typeof v === 'string' && v.length < 200) safe[k] = v;
  }
  try {
    for (let hop = 0; hop < 6; hop++) {
      await checkTarget(u);
      const r = await fetch(u, {
        redirect: 'manual', signal: ctrl.signal,
        headers: {
          'User-Agent': SCRAPE_UA,
          Accept: wantJson ? 'application/json,text/plain;q=0.8,*/*;q=0.5' : 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7',
          ...safe,
        },
      });
      if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
        u = new URL(r.headers.get('location'), u);
        continue;
      }
      const type = r.headers.get('content-type') || '';
      const chunks = [];
      let size = 0;
      if (r.body) {
        for await (const c of r.body) {
          size += c.length;
          if (size > SCRAPE_MAX_BYTES) { ctrl.abort(); throw httpError(413, 'Page trop lourde.'); }
          chunks.push(c);
        }
      }
      return { status: r.status, url: u.href, type, text: decodeBody(Buffer.concat(chunks.map((c) => Buffer.from(c))), type) };
    }
    throw httpError(508, 'Trop de redirections.');
  } catch (err) {
    if (err.status) throw err;
    throw httpError(502, err.name === 'AbortError' ? 'Le site met trop de temps à répondre.' : 'Le site ne répond pas.');
  } finally {
    clearTimeout(timer);
  }
}

/* ───────────── Lexique Uniqlo : noms anglais → noms façon uniqlo.com/fr ─────────────
   Construit à partir des noms réels du site français, par exemple :
   « T-shirt oversize AIRism en coton », « T-shirt HEATTECH en cachemire mélangé Extra Chaud (Manches longues) »,
   « Chaussettes HEATTECH (Côtelées) », « Jean Selvedge droit (Long) », « Pantalon large plissé Relax »,
   « Doudoune ultra légère », « Veste zippée polaire », « Polo AIRism en piqué de coton ».
   Ordre utilisé : Nom + coupe/style + mots gardés + gamme + matière + niveau de chaleur + col (+ détails entre parenthèses). */
const UQ_NOUNS = [
  // [anglais, français, genre m/f, pluriel]
  ['ultra light down jacket', 'Doudoune ultra légère', 'f'], ['ultra light down vest', 'Doudoune ultra légère sans manches', 'f'],
  ['ultra light down parka', 'Doudoune ultra légère à capuche', 'f'], ['ultra light down coat', 'Doudoune longue ultra légère', 'f'],
  ['seamless down parka', 'Doudoune sans coutures', 'f'], ['seamless down jacket', 'Doudoune sans coutures', 'f'], ['seamless down coat', 'Doudoune longue sans coutures', 'f'],
  ['down jacket', 'Doudoune', 'f'], ['down parka', 'Doudoune à capuche', 'f'], ['down vest', 'Doudoune sans manches', 'f'], ['down coat', 'Doudoune longue', 'f'],
  ['puffer jacket', 'Doudoune', 'f'], ['puffer vest', 'Doudoune sans manches', 'f'], ['puffer coat', 'Doudoune longue', 'f'], ['padded jacket', 'Veste matelassée', 'f'], ['padded vest', 'Gilet matelassé', 'm'],
  ['shirt jacket', 'Surchemise', 'f'], ['overshirt', 'Surchemise', 'f'], ['shacket', 'Surchemise', 'f'],
  ['sweat pullover hoodie', 'Sweat à capuche', 'm'], ['sweat full zip hoodie', 'Sweat zippé à capuche', 'm'], ['sweat zip up hoodie', 'Sweat zippé à capuche', 'm'], ['sweat hoodie', 'Sweat à capuche', 'm'], ['sweat shorts', 'Short en molleton', 'm'], ['sweat jacket', 'Veste en molleton', 'f'], ['pullover hoodie', 'Sweat à capuche', 'm'], ['zip up hoodie', 'Sweat zippé à capuche', 'm'], ['full zip hoodie', 'Sweat zippé à capuche', 'm'], ['zip hoodie', 'Sweat zippé à capuche', 'm'], ['hoodie', 'Sweat à capuche', 'm'],
  ['sweatshirt', 'Sweat', 'm'], ['sweat shirt', 'Sweat', 'm'], ['sweatpants', 'Jogging', 'm'], ['sweat pants', 'Jogging', 'm'], ['jogger pants', 'Jogging', 'm'], ['joggers', 'Jogging', 'm'], ['jogger', 'Jogging', 'm'],
  ['t-shirt', 'T-shirt', 'm'], ['t shirt', 'T-shirt', 'm'], ['tshirt', 'T-shirt', 'm'], ['tee', 'T-shirt', 'm'], ['tank top', 'Débardeur', 'm'], ['camisole', 'Caraco', 'm'], ['bra top', 'Top à brassière intégrée', 'm'], ['bra camisole', 'Caraco à brassière intégrée', 'm'],
  ['polo shirt', 'Polo', 'm'], ['polo', 'Polo', 'm'], ['blouse', 'Blouse', 'f'], ['shirt', 'Chemise', 'f'], ['tunic', 'Tunique', 'f'], ['top', 'Haut', 'm'],
  ['turtleneck sweater', 'Pull col roulé', 'm'], ['sweater', 'Pull', 'm'], ['jumper', 'Pull', 'm'], ['cardigan', 'Cardigan', 'm'], ['knit vest', 'Pull sans manches', 'm'], ['sweater vest', 'Pull sans manches', 'm'],
  ['trench coat', 'Trench', 'm'], ['chester coat', 'Manteau Chester', 'm'], ['coat', 'Manteau', 'm'], ['parka', 'Parka', 'f'], ['blouson', 'Blouson', 'm'], ['bomber jacket', 'Blouson aviateur', 'm'], ['blazer', 'Blazer', 'm'],
  ['pile lined fleece jacket', 'Veste polaire doublée', 'f'], ['fleece jacket', 'Veste polaire', 'f'], ['fleece vest', 'Gilet polaire', 'm'], ['jacket', 'Veste', 'f'], ['vest', 'Gilet', 'm'], ['gilet', 'Gilet', 'm'],
  ['jeans', 'Jean', 'm'], ['jean', 'Jean', 'm'], ['chino pants', 'Chino', 'm'], ['chinos', 'Chino', 'm'], ['chino', 'Chino', 'm'], ['cargo pants', 'Pantalon cargo', 'm'], ['pants', 'Pantalon', 'm'], ['trousers', 'Pantalon', 'm'],
  ['shorts', 'Short', 'm'], ['leggings pants', 'Pantalon legging', 'm'], ['leggings', 'Legging', 'm'], ['tights', 'Collants', 'm', 1], ['skort', 'Jupe-short', 'f'], ['skirt', 'Jupe', 'f'], ['dress', 'Robe', 'f'],
  ['jumpsuit', 'Combinaison', 'f'], ['overalls', 'Salopette', 'f'], ['bodysuit', 'Body', 'm'], ['onesie', 'Grenouillère', 'f'], ['romper', 'Barboteuse', 'f'],
  ['socks', 'Chaussettes', 'f', 1], ['sock', 'Chaussettes', 'f', 1], ['boxer briefs', 'Boxer', 'm'], ['trunks', 'Boxer', 'm'], ['boxers', 'Caleçon', 'm'], ['briefs', 'Slip', 'm'], ['wireless bra', 'Soutien-gorge sans armatures', 'm'], ['bra', 'Soutien-gorge', 'm'], ['shorts underwear', 'Culotte', 'f'], ['panties', 'Culotte', 'f'],
  ['pajamas', 'Pyjama', 'm'], ['pajama', 'Pyjama', 'm'], ['lounge set', 'Ensemble loungewear', 'm'], ['lounge pants', 'Pantalon loungewear', 'm'], ['robe', 'Peignoir', 'm'],
  ['bucket hat', 'Bob', 'm'], ['beanie', 'Bonnet', 'm'], ['knit cap', 'Bonnet', 'm'], ['cap', 'Casquette', 'f'], ['hat', 'Chapeau', 'm'], ['scarf', 'Écharpe', 'f'], ['muffler', 'Écharpe', 'f'], ['stole', 'Étole', 'f'],
  ['gloves', 'Gants', 'm', 1], ['mittens', 'Moufles', 'f', 1], ['shoulder bag', 'Sac bandoulière', 'm'], ['tote bag', 'Tote bag', 'm'], ['backpack', 'Sac à dos', 'm'], ['bag', 'Sac', 'm'], ['belt', 'Ceinture', 'f'], ['umbrella', 'Parapluie', 'm'], ['sandals', 'Sandales', 'f', 1], ['slippers', 'Chaussons', 'm', 1],
  ['turtleneck', 'Col roulé', 'm'], ['turtle neck', 'Col roulé', 'm'],
];
// Adjectifs : [anglais, masculin, féminin] (pluriels déduits)
const UQ_ADJ = [
  ['oversized', 'oversize', 'oversize'], ['oversize', 'oversize', 'oversize'], ['relaxed fit', 'Relax', 'Relax'], ['relaxed', 'Relax', 'Relax'], ['relax', 'Relax', 'Relax'],
  ['wide straight', 'droit large', 'droite large'], ['wide leg', 'large', 'large'], ['wide', 'large', 'large'], ['straight leg', 'droit', 'droite'], ['straight', 'droit', 'droite'],
  ['slim fit', 'coupe slim', 'coupe slim'], ['slim', 'slim', 'slim'], ['skinny', 'skinny', 'skinny'], ['regular fit', 'coupe regular', 'coupe regular'], ['tapered', 'fuselé', 'fuselée'],
  ['barrel leg', 'Barrel', 'Barrel'], ['barrel', 'Barrel', 'Barrel'], ['balloon', 'ballon', 'ballon'], ['curved', 'arrondi', 'arrondie'], ['flare', 'évasé', 'évasée'], ['flared', 'évasé', 'évasée'], ['bootcut', 'bootcut', 'bootcut'],
  ['pleated', 'plissé', 'plissée'], ['cargo', 'cargo', 'cargo'], ['cropped', 'court', 'courte'], ['short length', 'court', 'courte'], ['long', 'long', 'longue'], ['mini', 'mini', 'mini'], ['midi', 'midi', 'midi'], ['maxi', 'longue', 'longue'],
  ['high rise', 'taille haute', 'taille haute'], ['high waisted', 'taille haute', 'taille haute'], ['ankle length', '7/8', '7/8'], ['ankle', '7/8', '7/8'], ['ultra stretch', 'ultra stretch', 'ultra stretch'], ['2 way stretch', 'stretch 2 sens', 'stretch 2 sens'], ['stretch', 'stretch', 'stretch'],
  ['seamless', 'sans coutures', 'sans coutures'], ['ultra light', 'ultra léger', 'ultra légère'], ['lightweight', 'léger', 'légère'], ['light', 'léger', 'légère'], ['quilted', 'matelassé', 'matelassée'], ['padded', 'matelassé', 'matelassée'],
  ['full zip', 'zippé', 'zippée'], ['zip up', 'zippé', 'zippée'], ['zipped', 'zippé', 'zippée'], ['half zip', 'demi-zip', 'demi-zip'], ['quarter zip', 'demi-zip', 'demi-zip'], ['hooded', 'à capuche', 'à capuche'], ['pocketable', 'pliable', 'pliable'],
  ['brushed', 'brossé', 'brossée'], ['soft', 'doux', 'douce'], ['striped', 'rayé', 'rayée'], ['stripe', 'rayé', 'rayée'], ['border', 'rayé', 'rayée'], ['checked', 'à carreaux', 'à carreaux'], ['check', 'à carreaux', 'à carreaux'], ['plaid', 'à carreaux', 'à carreaux'],
  ['graphic', 'imprimé', 'imprimée'], ['printed', 'imprimé', 'imprimée'], ['print', 'imprimé', 'imprimée'], ['dotted', 'à pois', 'à pois'], ['polka dot', 'à pois', 'à pois'], ['floral', 'à fleurs', 'à fleurs'], ['utility', 'utilitaire', 'utilitaire'], ['parachute', 'parachute', 'parachute'],
  ['washed', 'délavé', 'délavée'], ['pile lined', 'doublé polaire', 'doublée polaire'], ['fleece lined', 'doublé polaire', 'doublée polaire'], ['lined', 'doublé', 'doublée'], ['warm', 'chaud', 'chaude'], ['cable knit', 'torsadé', 'torsadée'], ['cable', 'torsadé', 'torsadée'],
  ['ribbed', 'côtelé', 'côtelée'], ['rib', 'côtelé', 'côtelée'], ['waffle', 'gaufré', 'gaufrée'], ['fleece', 'polaire', 'polaire'], ['pile', 'polaire', 'polaire'], ['fluffy', 'duveteux', 'duveteuse'], ['fuzzy', 'duveteux', 'duveteuse'],
  ['knitted', 'en maille', 'en maille'], ['knit', 'en maille', 'en maille'], ['sheer', 'transparent', 'transparente'], ['mesh', 'en mesh', 'en mesh'], ['crochet', 'au crochet', 'au crochet'], ['embroidered', 'brodé', 'brodée'],
  ['double breasted', 'croisé', 'croisée'], ['single breasted', 'droit', 'droite'], ['tailored', 'ajusté', 'ajustée'], ['boxy', 'coupe carrée', 'coupe carrée'], ['loose', 'ample', 'ample'], ['baggy', 'baggy', 'baggy'], ['fitted', 'ajusté', 'ajustée'],
  ['crew', 'ras du cou', 'ras du cou'], ['high', 'montant', 'montante'], ['short', 'court', 'courte'], ['easy care', 'Easy Care', 'Easy Care'], ['non iron', 'sans repassage', 'sans repassage'], ['wrinkle resistant', 'infroissable', 'infroissable'],
  ['water repellent', 'déperlant', 'déperlante'], ['windproof', 'coupe-vent', 'coupe-vent'], ['reversible', 'réversible', 'réversible'], ['colour', 'de couleur', 'de couleur'], ['color', 'de couleur', 'de couleur'], ['plain', 'uni', 'unie'], ['logo', 'logo', 'logo'],
  ['ruffle', 'à volants', 'à volants'], ['ruffled', 'à volants', 'à volants'], ['button down', 'col boutonné', 'col boutonné'], ['2 pack', '(Lot de 2)', '(Lot de 2)'], ['3 pack', '(Lot de 3)', '(Lot de 3)'],
];
// Matières (→ « en … »)
const UQ_MAT = [
  ['supima cotton', 'coton Supima'], ['extra fine cotton', 'coton extra fin'], ['cotton linen', 'lin et coton'], ['linen cotton', 'lin et coton'], ['linen blend', 'lin mélangé'], ['cashmere blend', 'cachemire mélangé'],
  ['wool blend', 'laine mélangée'], ['extra fine merino', 'mérinos extra fin'], ['merino wool', 'laine mérinos'], ['merino', 'mérinos'], ['premium lambswool', "laine d'agneau premium"], ['lambswool', "laine d'agneau"], ['premium wool', 'laine premium'],
  ['souffle yarn', 'maille soufflée'], ['3d knit', 'maille 3D'], ['cotton', 'coton'], ['wool', 'laine'], ['cashmere', 'cachemire'], ['linen', 'lin'], ['denim', 'denim'], ['corduroy', 'velours côtelé'], ['velvet', 'velours'], ['velour', 'velours'],
  ['flannel', 'flanelle'], ['jersey', 'jersey'], ['twill', 'sergé'], ['pique', 'piqué'], ['piqué', 'piqué'], ['satin', 'satin'], ['nylon', 'nylon'], ['rayon', 'rayonne'], ['silk', 'soie'], ['leather', 'cuir'], ['suede', 'daim'], ['faux leather', 'similicuir'],
  ['tweed', 'tweed'], ['chambray', 'chambray'], ['seersucker', 'seersucker'], ['boa', 'fausse fourrure'], ['sherpa', 'sherpa'], ['terry', 'éponge'], ['french terry', 'molleton'], ['sweat', 'molleton'], ['chiffon', 'mousseline'], ['crepe', 'crêpe'], ['mohair', 'mohair'],
];
const UQ_COLLAR = [
  ['crew neck', 'col rond'], ['crewneck', 'col rond'], ['round neck', 'col rond'], ['v neck', 'col V'], ['v-neck', 'col V'], ['mock neck', 'col montant'], ['high neck', 'col montant'], ['turtleneck', 'col roulé'], ['turtle neck', 'col roulé'],
  ['boat neck', 'col bateau'], ['henley neck', 'col henley'], ['henley', 'col henley'], ['stand collar', 'col officier'], ['band collar', 'col officier'], ['open collar', 'col ouvert'], ['shawl collar', 'col châle'], ['square neck', 'col carré'],
  ['ballet neck', 'col danseuse'], ['scoop neck', 'col échancré'], ['halter neck', 'col américain'], ['collarless', 'sans col'],
];
const UQ_DETAIL = [
  ['long sleeve', 'manches longues'], ['long sleeves', 'manches longues'], ['short sleeve', 'manches courtes'], ['short sleeves', 'manches courtes'], ['half sleeve', 'demi-manches'], ['half sleeves', 'demi-manches'],
  ['3/4 sleeve', 'manches 3/4'], ['3/4 sleeves', 'manches 3/4'], ['sleeveless', 'sans manches'], ['cap sleeve', 'mancherons'], ['french sleeve', 'mancherons'], ['puff sleeve', 'manches bouffantes'],
  ['extra warm', 'Extra Chaud'], ['ultra warm', 'Ultra Chaud'], ['regular fit', 'coupe regular'], ['slim fit', 'coupe slim'], ['relaxed fit', 'coupe Relax'], ['long length', 'long'], ['short length', 'court'], ['tall', 'long'],
  ['2 pack', 'Lot de 2'], ['3 pack', 'Lot de 3'], ['2-pack', 'Lot de 2'], ['3-pack', 'Lot de 3'], ['pack of 2', 'Lot de 2'], ['pack of 3', 'Lot de 3'], ['set', 'ensemble'], ['washed', 'délavé'], ['indigo', 'Indigo'], ['denim', 'denim'],
];
const UQ_TECH = ['HEATTECH', 'AIRism', 'PUFFTECH', 'BLOCKTECH', 'DRY-EX', 'DRY', 'AirSense', 'UV Protection', 'UNIQLO : C', 'UNIQLO U', 'Uniqlo U', 'UT', 'KANDO', 'Miracle Air', 'Smart', 'Easy', 'Selvedge', 'SUPIMA'];
const UQ_TECH_OUT = { 'UV Protection': 'anti-UV', 'UNIQLO U': 'Uniqlo U', 'Uniqlo U': 'Uniqlo U' };
const UQ_DROP = new Set(["men's", 'mens', 'men', "women's", 'womens', 'women', 'kids', "kids'", 'kid', 'baby', 'babies', 'toddler', 'girls', "girls'", 'boys', "boys'", 'unisex', 'uniqlo', 'new', 'and', 'pullover']);
const UQ_STOP = new Set(['with', 'for', 'the', 'of', 'in', 'on', 'by', 'to', 'from', 'a', 'an']);
const uqNorm = (s) => String(s || '').toLowerCase().replace(/[‐-―]/g, '-').replace(/[^a-z0-9/'-]+/g, ' ').replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
function uqFind(words, i, list) {
  for (let len = Math.min(4, words.length - i); len > 0; len--) {
    const key = words.slice(i, i + len).join(' ');
    const hit = list.find((e) => uqNorm(e[0]) === key);
    if (hit) return { hit, len };
  }
  return null;
}
function agree(adj, g, pl) { let a = g === 'f' ? adj[2] : adj[1]; if (pl && !/[sx]$|^(oversize|large|Relax|Barrel|cargo|stretch|7\/8|ultra stretch|slim|skinny|mini|midi|Easy Care|logo|baggy|parachute|ample|réversible|déperlant|à |en |au |de |col |coupe |taille |sans |doublé polaire|\()/i.test(a)) a = a.split(' ').map((w, k) => (k === 0 ? w + 's' : w)).join(' '); return a; }
function uqTitleFR(title) {
  const raw = String(title || '').trim();
  if (!raw) return null;
  const [mainRaw, ...detRaw] = raw.split(/\s*[|｜]\s*/);
  // Gammes et mots gardés tels quels (avec leur écriture d'origine)
  const kept = [];
  let main = ' ' + mainRaw + ' ';
  for (const t of UQ_TECH) {
    const re = new RegExp('(^|[\\s(])(' + t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')(?=[\\s),]|$)', t === 'UT' ? 'g' : 'gi');
    main = main.replace(re, (m, pre, w) => { kept.push(t === 'SUPIMA' ? null : (UQ_TECH_OUT[t] || t)); if (t === 'SUPIMA') return pre + 'supima'; return pre + ' '; });
  }
  const tech = kept.filter(Boolean);
  const words = uqNorm(main).split(' ').filter(Boolean);
  let noun = null; const adjs = [], mats = [], collars = [], details = [], unknown = [];
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    if (UQ_DROP.has(w)) { i++; continue; }
    let f;
    if ((f = uqFind(words, i, UQ_DETAIL)) && /sleeve|warm|pack|length/.test(f.hit[0])) { details.push(f.hit[1]); i += f.len; continue; }
    if ((f = uqFind(words, i, UQ_NOUNS))) { if (noun && noun[1] === 'Col roulé') collars.push('col roulé'); if (!noun || f.hit[1] !== 'Col roulé') noun = f.hit; else collars.push('col roulé'); i += f.len; continue; }
    if ((f = uqFind(words, i, UQ_COLLAR))) { collars.push(f.hit[1]); i += f.len; continue; }
    if ((f = uqFind(words, i, UQ_MAT))) { mats.push(f.hit[1]); i += f.len; continue; }
    if ((f = uqFind(words, i, UQ_ADJ))) { adjs.push(f.hit); i += f.len; continue; }
    if (/^\d+$/.test(w)) { unknown.push(w); i++; continue; }
    if (UQ_STOP.has(w)) return null; // phrase anglaise trop complexe : traduction automatique
    unknown.push(w); i++;
  }
  if (!noun) return null;
  if (unknown.length > 2) return null;
  const g = noun[2], pl = !!noun[3];
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  // Mots inconnus gardés avec leur écriture d'origine (souvent des noms de modèles : Barrel, Selvedge…)
  const orig = mainRaw.split(/\s+/);
  const unknownOrig = unknown.map((u) => orig.find((o) => uqNorm(o) === u) || u).map((u) => (/^[a-z]/.test(u) ? cap(u) : u));
  const adjFR = [...new Set(adjs.map((a) => agree(a, g, pl)))].filter((a) => !noun[1].toLowerCase().includes(a.toLowerCase()));
  const packs = adjFR.filter((a) => a.startsWith('(')); const adjMain = adjFR.filter((a) => !a.startsWith('('));
  // Détails après « | » : manches, coupe, motif…
  for (const d of detRaw) {
    const dw = uqNorm(d).split(' ').filter(Boolean); let k = 0; const parts = [];
    while (k < dw.length) {
      let f2;
      if ((f2 = uqFind(dw, k, UQ_DETAIL))) { parts.push(f2.hit[1]); k += f2.len; continue; }
      if ((f2 = uqFind(dw, k, UQ_COLLAR))) { parts.push(f2.hit[1]); k += f2.len; continue; }
      if ((f2 = uqFind(dw, k, UQ_ADJ))) { parts.push(agree(f2.hit, g, pl).replace(/^\(|\)$/g, '')); k += f2.len; continue; }
      if ((f2 = uqFind(dw, k, UQ_MAT))) { parts.push('en ' + f2.hit[1]); k += f2.len; continue; }
      if (UQ_DROP.has(dw[k])) { k++; continue; }
      const o = d.split(/\s+/).find((x) => uqNorm(x) === dw[k]); parts.push(o || dw[k]); k++;
    }
    if (parts.length) details.push(parts.join(' '));
  }
  const level = details.filter((d) => /^(Extra|Ultra) Chaud$/.test(d));
  const rest = details.filter((d) => !level.includes(d));
  let name = [noun[1], ...adjMain, ...unknownOrig, ...tech, mats.length ? 'en ' + mats.join(' et ') : '', ...level, ...collars].filter(Boolean).join(' ');
  const det = [...rest.map((d, k) => (k === 0 ? cap(d) : d)), ...packs.map((p) => p.replace(/^\(|\)$/g, ''))];
  if (det.length) name += ` (${det.join(', ')})`;
  return cap(name.replace(/\s{2,}/g, ' ').trim());
}

/* ───────────── Traduction des produits scrapés ─────────────
   1. Clé ANTHROPIC_API_KEY → Claude (meilleure qualité)
   2. Sinon clé DEEPL_API_KEY → DeepL (offre gratuite disponible)
   3. Sinon → service de traduction gratuit intégré, sans clé
   Les noms de gammes et de marques (HEATTECH, AIRism, PUFFTECH…) ne sont jamais traduits. */
const KEEP_TERMS = ['UNIQLO : C', 'UNIQLO U', 'Uniqlo U', 'UNIQLO', 'Uniqlo', 'HEATTECH', 'Heattech', 'AIRism', 'PUFFTECH', 'PuffTech', 'BLOCKTECH', 'BlockTech',
  'DRY-EX', 'Sport Utility Wear', 'JW ANDERSON', 'JW Anderson', 'Peace for All', 'Miracle Air', 'KANDO', 'SUPIMA', 'Supima', 'Lifewear', 'LifeWear', 'UT'];
const KEEP_RE = new RegExp('\\b(' + KEEP_TERMS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')\\b', 'g');
function protect(text, keep, caps) {
  let t = String(text || '').replace(KEEP_RE, (m) => { keep.push(m); return ` ZQX${keep.length - 1}XQZ `; });
  // Dans les noms : un mot tout en majuscules (sigle, gamme) est gardé tel quel
  if (caps) t = t.replace(/\b[A-Z][A-Z0-9-]{1,}\b/g, (m) => (/^ZQX\d+XQZ$/.test(m) ? m : (keep.push(m), ` ZQX${keep.length - 1}XQZ `)));
  return t.replace(/\s{2,}/g, ' ').trim();
}
const unprotect = (t, keep) => String(t || '').replace(/ZQX\s*(\d+)\s*XQZ/gi, (m, i) => (keep[+i] !== undefined ? keep[+i] : m)).replace(/\s{2,}/g, ' ').trim();
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function freeTranslateOne(text) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const u = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=fr&dt=t&q=' + encodeURIComponent(text);
    let r;
    try { r = await fetch(u, { headers: { 'User-Agent': SCRAPE_UA } }); } catch (e) { r = null; }
    if (r && r.ok) {
      const j = await r.json().catch(() => null);
      if (j && Array.isArray(j[0])) return j[0].map((x) => (x && x[0]) || '').join('');
    }
    await pause(800 * (attempt + 1));
  }
  throw httpError(502, 'Le service de traduction gratuit ne répond pas. Réessayez dans quelques minutes.');
}
// Traduit une liste de lignes (sans retour à la ligne) en regroupant les lignes pour aller plus vite
async function freeTranslateLines(lines) {
  const out = new Array(lines.length);
  let i = 0;
  while (i < lines.length) {
    const group = [];
    let size = 0;
    while (i + group.length < lines.length && (group.length === 0 || size + lines[i + group.length].length < 1400)) {
      size += lines[i + group.length].length + 1;
      group.push(lines[i + group.length]);
    }
    const res = (await freeTranslateOne(group.join('\n'))).split('\n');
    if (res.length === group.length) group.forEach((_, k) => { out[i + k] = res[k]; });
    else for (let k = 0; k < group.length; k++) out[i + k] = await freeTranslateOne(group[k]); // découpage inattendu : ligne par ligne
    i += group.length;
    await pause(150);
  }
  return out;
}
async function deeplTranslateLines(lines, key) {
  const host = /:fx$/.test(key) ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
  const out = [];
  for (let i = 0; i < lines.length; i += 40) {
    const form = new URLSearchParams();
    lines.slice(i, i + 40).forEach((l) => form.append('text', l));
    form.append('target_lang', 'FR');
    const r = await fetch(host + '/v2/translate', { method: 'POST', headers: { Authorization: 'DeepL-Auth-Key ' + key, 'Content-Type': 'application/x-www-form-urlencoded' }, body: form });
    if (r.status === 403) throw httpError(502, 'La clé DeepL est refusée. Vérifiez DEEPL_API_KEY dans les Config Vars de Heroku.');
    if (r.status === 456) throw httpError(502, 'Le quota mensuel DeepL est atteint.');
    if (!r.ok) throw httpError(502, 'Erreur DeepL (' + r.status + ').');
    const j = await r.json();
    (j.translations || []).forEach((t) => out.push(t.text));
  }
  return out;
}
async function translateWithoutClaude(items) {
  const deepl = process.env.DEEPL_API_KEY || '';
  const lines = [], index = new Map();
  const add = (text, keep, caps) => {
    const p = protect(text, keep, caps);
    if (!p || !/[a-z]{2,}/i.test(p.replace(/ZQX\d+XQZ/g, ''))) return { fixed: unprotect(p, keep) };
    if (!index.has(p)) { index.set(p, lines.length); lines.push(p); }
    return { at: index.get(p), keep };
  };
  const jobs = items.map((it) => {
    const descLines = String(it.descriptionHtml || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n').replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').split('\n').map((l) => l.trim());
    return {
      title: (() => { const r = uqTitleFR(it.title); return r ? { fixed: r } : add(it.title, [], true); })(),
      type: add(it.type, [], false),
      desc: descLines.map((l) => (l ? add(l, [], false) : { fixed: '' })),
      colors: (Array.isArray(it.colors) ? it.colors : []).map((c) => add(c, [], false)),
    };
  });
  const done = lines.length ? (deepl ? await deeplTranslateLines(lines, deepl) : await freeTranslateLines(lines)) : [];
  const get = (x) => (x.fixed !== undefined ? x.fixed : unprotect(done[x.at] || lines[x.at], x.keep));
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const translated = jobs.map((j) => ({
    title: cap(get(j.title)),
    type: get(j.type),
    descriptionHtml: j.desc.map(get).join('<br>').replace(/(<br>){3,}/g, '<br><br>'),
    colors: j.colors.map(get),
  }));
  return { translated, model: deepl ? 'DeepL' : 'traduction automatique gratuite' };
}

/* ───────────── Réponses ───────────── */
const BASE_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' };
function send(res, status, body, headers = {}) { res.writeHead(status, { ...BASE_HEADERS, ...headers }); res.end(body); }
function sendJson(res, status, obj, headers = {}) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
}
function httpError(status, message) { return Object.assign(new Error(message), { status }); }
function readJson(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(httpError(413, 'Fichier trop lourd.')); req.destroy(); } else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(httpError(400, 'Données illisibles.')); }
    });
    req.on('error', reject);
  });
}
const publicStore = () => ({ settings: STORE.settings, products: STORE.products.filter((p) => p.published) });

/* ───────────── Fichier .zip (sans module externe) ───────────── */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function zipWriter(out) {
  const entries = [];
  let offset = 0;
  const d = new Date();
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const write = (b) => { offset += b.length; return out.write(b) ? null : new Promise((ok) => out.once('drain', ok)); };
  return {
    async add(name, data) {
      data = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const nameBuf = Buffer.from(name, 'utf8');
      const deflated = /\.(png|jpe?g|webp|woff2?|zip)$/i.test(name) ? null : zlib.deflateRawSync(data, { level: 6 });
      const useDeflate = deflated && deflated.length < data.length;
      const body = useDeflate ? deflated : data;
      const crc = crc32(data);
      const h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(useDeflate ? 8 : 0, 8);
      h.writeUInt16LE(time, 10); h.writeUInt16LE(date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(body.length, 18);
      h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
      entries.push({ nameBuf, crc, csize: body.length, size: data.length, method: useDeflate ? 8 : 0, offset });
      await write(h); await write(nameBuf); await write(body);
    },
    async end() {
      const start = offset;
      for (const e of entries) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(e.method, 10);
        c.writeUInt16LE(time, 12); c.writeUInt16LE(date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.csize, 20); c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nameBuf.length, 28); c.writeUInt32LE(e.offset, 42);
        await write(c); await write(e.nameBuf);
      }
      const z = Buffer.alloc(22);
      z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(entries.length, 8); z.writeUInt16LE(entries.length, 10);
      z.writeUInt32LE(offset - start, 12); z.writeUInt32LE(start, 16);
      await write(z);
      out.end();
    },
  };
}
/* Tous les fichiers du site, sauf ce qui ne doit pas partir sur GitHub */
const SKIP = new Set(['node_modules', 'data', '.git', '.env', '.DS_Store', 'seed-images', 'seed.json']);
function siteFiles(dir = __dirname, rel = '') {
  let out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(ent.name) || (dir === DATA_DIR)) continue;
    const full = path.join(dir, ent.name);
    if (full === DATA_DIR) continue;
    if (ent.isDirectory()) out = out.concat(siteFiles(full, rel + ent.name + '/'));
    else if (ent.isFile()) out.push({ name: rel + ent.name, full });
  }
  return out;
}
const imageIdsIn = (obj) => [...new Set((JSON.stringify(obj).match(/\/img\/[a-f0-9]{24}/g) || []).map((x) => x.slice(5)))];


/* ───────────── En direct : activité des visiteurs ─────────────
   Chaque visiteur de la boutique envoie de petits signaux (page vue, ajout au panier, passage au paiement).
   Rien de personnel : un numéro tiré au hasard dans son navigateur, son type d'appareil et d'où il vient.
   Les visiteurs connectés au back-office (vous) ne sont pas comptés. */
const ONLINE_MS = 45e3;
const FORGET_MS = 30 * 60e3;
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime/i;
const parisDay = (t = Date.now()) => new Date(t).toLocaleDateString('sv-SE', { timeZone: 'Europe/Paris' });
const LIVE = { visitors: new Map(), feed: [], series: [], stats: null, dirty: false };
const tAttempts = new Map();

function emptyDay(date) { return { date, visitors: [], visits: 0, views: 0, adds: 0, addValue: 0, checkouts: 0, checkoutValue: 0, products: {} }; }
function today() {
  const d = parisDay();
  const st = LIVE.stats;
  if (st.today.date !== d) {
    const t = st.today;
    st.history = [{ date: t.date, visitors: t.visitors.length, visits: t.visits, views: t.views, adds: t.adds, checkouts: t.checkouts, checkoutValue: t.checkoutValue },
      ...st.history.filter((h) => h.date !== t.date)].slice(0, 30);
    st.today = emptyDay(d);
    LIVE.dirty = true;
  }
  return st.today;
}
function cleanStats(s) {
  s = s && typeof s === 'object' ? s : {};
  const t = s.today && typeof s.today === 'object' ? s.today : {};
  const n = (v) => (Number.isFinite(+v) && +v >= 0 ? +v : 0);
  return {
    today: {
      date: /^\d{4}-\d{2}-\d{2}$/.test(t.date || '') ? t.date : parisDay(),
      visitors: Array.isArray(t.visitors) ? t.visitors.filter((x) => /^[a-z0-9]{8,32}$/.test(x)).slice(0, 50000) : [],
      visits: n(t.visits), views: n(t.views), adds: n(t.adds), addValue: n(t.addValue), checkouts: n(t.checkouts), checkoutValue: n(t.checkoutValue),
      products: t.products && typeof t.products === 'object' ? t.products : {},
    },
    history: (Array.isArray(s.history) ? s.history : []).slice(0, 30),
  };
}
async function saveStats(force) {
  if (!db || !LIVE.stats || (!LIVE.dirty && !force)) return;
  LIVE.dirty = false;
  try { await db.saveStats(LIVE.stats); } catch (err) { console.error('Statistiques non enregistrées :', err.message); }
}
function deviceOf(ua) {
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablette';
  if (/Mobi|iPhone|iPod|Android/i.test(ua)) return 'mobile';
  return 'ordinateur';
}
function sourceOf(ref, utm, host) {
  const u = str(utm, 60).trim().toLowerCase();
  let h = '';
  try { h = new URL(str(ref, 500)).hostname.replace(/^www\./, '').toLowerCase(); } catch (e) { /* pas de provenance */ }
  if (h && host && h === String(host).replace(/^www\./, '').toLowerCase()) h = '';
  const k = u || h;
  if (!k) return 'Accès direct';
  const known = [[/instagram|^ig$/, 'Instagram'], [/tiktok/, 'TikTok'], [/facebook|fb\.|^fb$/, 'Facebook'], [/snapchat/, 'Snapchat'], [/google/, 'Google'], [/bing/, 'Bing'], [/pinterest/, 'Pinterest'], [/youtube/, 'YouTube'], [/t\.co$|twitter|^x\.com$/, 'X (Twitter)'], [/whatsapp/, 'WhatsApp']];
  for (const [re, name] of known) if (re.test(k)) return name;
  return k.slice(0, 40);
}
function productBrief(id) {
  const p = STORE.products.find((x) => x.id === id);
  if (!p) return null;
  const c = p.colors.find((x) => x.image);
  return { id: p.id, name: p.name, image: (c && c.image) || p.images[0] || '' };
}
function cleanView(w) {
  w = w && typeof w === 'object' ? w : {};
  const page = ['home', 'list', 'product', 'cart', 'search', 'info', 'menu'].includes(w.p) ? w.p : 'home';
  const v = { page };
  if (page === 'home') v.g = GENDERS.includes(w.g) ? w.g : '';
  if (page === 'list' || page === 'info' || page === 'search') v.title = str(w.t, 80).trim();
  if (page === 'product') { const b = productBrief(str(w.id, 64)); if (b) v.product = b; else v.page = 'home'; }
  return v;
}
function pushFeed(ev) {
  LIVE.feed.unshift({ t: Date.now(), ...ev });
  if (LIVE.feed.length > 80) LIVE.feed.length = 80;
}
function track(req, body) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT_UA.test(ua) || isAdmin(req)) return;
  const id = str(body.v, 32);
  if (!/^[a-z0-9]{8,32}$/.test(id)) return;
  const kind = ['view', 'ping', 'add', 'checkout', 'leave'].includes(body.k) ? body.k : 'ping';
  const now = Date.now();
  const day = today();
  let v = LIVE.visitors.get(id);
  const fresh = !v || now - v.seen > FORGET_MS;
  if (kind === 'leave') { if (v) { v.last = 0; v.seen = now; } return; }
  if (fresh) {
    v = { id, first: now, last: now, seen: now, device: deviceOf(ua), source: sourceOf(body.r, body.u, req.headers.host), view: { page: 'home' }, viewSince: now, pages: 0, cart: { n: 0, total: 0 } };
    LIVE.visitors.set(id, v);
    day.visits++;
    if (!day.visitors.includes(id) && day.visitors.length < 50000) day.visitors.push(id);
    pushFeed({ kind: 'arrive', visitor: id, device: v.device, source: v.source });
  }
  v.last = now; v.seen = now;
  const c = body.c && typeof body.c === 'object' ? body.c : {};
  v.cart = { n: Math.min(999, Math.round(num(c.n))), total: Math.min(1e6, num(c.s)) };
  if (kind === 'view') {
    const view = cleanView(body.w);
    const same = JSON.stringify(view) === JSON.stringify(v.view);
    if (!same || fresh) {
      v.view = view; v.viewSince = now; v.pages++; day.views++;
      if (view.page === 'product') {
        day.products[view.product.id] = (day.products[view.product.id] || 0) + 1;
        pushFeed({ kind: 'product', visitor: id, product: view.product });
      } else if (view.page === 'cart' && v.cart.n) {
        pushFeed({ kind: 'cart', visitor: id, n: v.cart.n, total: v.cart.total });
      }
    }
  } else if (kind === 'add') {
    const a = body.a && typeof body.a === 'object' ? body.a : {};
    const b = productBrief(str(a.id, 64));
    const qty = Math.max(1, Math.min(10, Math.round(num(a.q)) || 1));
    const amount = Math.min(1e5, num(a.m));
    day.adds++; day.addValue = Math.round((day.addValue + amount) * 100) / 100;
    if (b) pushFeed({ kind: 'add', visitor: id, product: b, qty, amount });
  } else if (kind === 'checkout') {
    day.checkouts++; day.checkoutValue = Math.round((day.checkoutValue + v.cart.total) * 100) / 100;
    pushFeed({ kind: 'checkout', visitor: id, n: v.cart.n, total: v.cart.total });
  }
  LIVE.dirty = true;
}
function onlineVisitors() {
  const now = Date.now();
  return [...LIVE.visitors.values()].filter((v) => now - v.last < ONLINE_MS);
}
function liveSnapshot() {
  const now = Date.now();
  const day = today();
  const online = onlineVisitors().sort((a, b) => b.last - a.last);
  const carts = online.filter((v) => v.cart.n > 0);
  const top = Object.entries(day.products).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, n]) => ({ ...(productBrief(id) || { id, name: 'Produit supprimé', image: '' }), views: n }));
  const t = day;
  return {
    now,
    online: online.length,
    carts: carts.length,
    cartsValue: Math.round(carts.reduce((s, v) => s + v.cart.total, 0) * 100) / 100,
    visitors: online.slice(0, 100).map((v) => ({ id: v.id, device: v.device, source: v.source, view: v.view, viewSince: v.viewSince, first: v.first, pages: v.pages, cart: v.cart })),
    feed: LIVE.feed.slice(0, 40),
    series: LIVE.series.slice(-30),
    today: { date: t.date, visitors: t.visitors.length, visits: t.visits, views: t.views, adds: t.adds, addValue: t.addValue, checkouts: t.checkouts, checkoutValue: t.checkoutValue },
    top,
    history: LIVE.stats.history.slice(0, 6),
  };
}
setInterval(() => {
  if (!LIVE.stats) return;
  today();
  const now = Date.now();
  for (const [id, v] of LIVE.visitors) if (now - v.seen > FORGET_MS) LIVE.visitors.delete(id);
  for (const [ip, w] of tAttempts) if (now - w.t > 60e3) tAttempts.delete(ip);
  LIVE.series.push({ t: now, n: onlineVisitors().length });
  if (LIVE.series.length > 60) LIVE.series.shift();
  saveStats();
}, 60e3).unref();

/* ───────────── Page de maintenance ───────────── */
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function maintenanceOn(req) { return !!(STORE.settings.maintenance && STORE.settings.maintenance.enabled) && !isAdmin(req); }
function maintenancePage() {
  const s = STORE.settings;
  const m = s.maintenance || {};
  const shop = s.shop || {};
  const brand = shop.logo
    ? `<img class="logo" src="${esc(shop.logo)}" alt="${esc(shop.name)}" style="height:${Math.round(shop.logoHeight || 28)}px">`
    : `<p class="name">${esc(shop.name)}</p>`;
  const text = esc(m.text).split(/\n\s*\n/).map((x) => `<p>${x.replace(/\n/g, '<br>')}</p>`).join('');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="120">
<title>${esc(m.title || 'Maintenance')} · ${esc(shop.name)}</title>
<style>
${buildFontCss()}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100vh;min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:40px 20px;background:#fff;color:#111;
  font-family:"TT Commons Pro",Figtree,-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;text-align:center}
main{width:100%;max-width:560px;display:flex;flex-direction:column;align-items:center;gap:22px}
.logo{display:block;max-width:240px;width:auto;object-fit:contain}
.name{margin:0;font-size:22px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}
.pic{display:block;width:100%;max-height:52vh;object-fit:cover;border-radius:14px;background:#f3f3f3}
h1{margin:0;font-size:clamp(26px,6vw,36px);font-weight:800;line-height:1.15;text-wrap:balance}
.txt p{margin:0 0 10px;font-size:17px;line-height:1.5;color:#555}
.txt p:last-child{margin:0}
</style>
</head>
<body>
<main>
  ${brand}
  ${m.image ? `<img class="pic" src="${esc(m.image)}" alt="">` : ''}
  <h1>${esc(m.title)}</h1>
  <div class="txt">${text}</div>
</main>
</body>
</html>`;
}
const MAINT_BANNER = `<div id="mt-admin" style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:99999;background:#cc0a1c;color:#fff;font:700 13px/1.3 -apple-system,BlinkMacSystemFont,Arial,sans-serif;padding:10px 16px;border-radius:999px;box-shadow:0 6px 20px rgba(0,0,0,.25);max-width:calc(100% - 32px);text-align:center">Maintenance activée : les visiteurs voient la page de maintenance. Vous seul voyez la boutique.</div>`;

/* ───────────── Routes ───────────── */
async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const m = req.method;

  if (ON_HEROKU && (req.headers['x-forwarded-proto'] || '') === 'http') {
    return send(res, 301, '', { Location: `https://${req.headers.host}${req.url}` });
  }

  // Boutique et back-office
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    if (maintenanceOn(req)) {
      return send(res, 503, maintenancePage(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '1800' });
    }
    const html = STORE.settings.maintenance.enabled ? INDEX_HTML.replace('</body>', MAINT_BANNER + '</body>') : INDEX_HTML;
    return send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  // Aperçu de la page de maintenance (même quand elle n’est pas activée)
  if (m === 'GET' && (p === '/maintenance' || p === '/maintenance/')) {
    return send(res, 200, maintenancePage(), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  }
  // Signaux d’activité envoyés par la boutique (onglet « En direct » du back-office)
  if (m === 'POST' && p === '/api/t') {
    const ip = clientIp(req);
    const w = tAttempts.get(ip) || { t: Date.now(), n: 0 };
    if (Date.now() - w.t > 60e3) { w.t = Date.now(); w.n = 0; }
    w.n++; tAttempts.set(ip, w);
    if (w.n > 90) return send(res, 204, '');
    const body = await readJson(req, 4 * 1024).catch(() => null);
    if (body && typeof body === 'object' && LIVE.stats) track(req, body);
    return send(res, 204, '', { 'Cache-Control': 'no-store' });
  }
  if (m === 'GET' && (p === '/admin' || p === '/admin/')) {
    return send(res, 200, ADMIN_HTML, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex' });
  }
  if (m === 'GET' && (p === '/apercu' || p === '/apercu/')) {
    return send(res, 200, PREVIEW_HTML, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' });
  }
  if (m === 'GET' && p === '/api/store') {
    if (maintenanceOn(req)) return sendJson(res, 503, { error: 'Maintenance en cours.' });
    return sendJson(res, 200, publicStore());
  }

  // Photos
  if (m === 'GET' && p.startsWith('/img/')) {
    const id = p.slice(5);
    if (!/^[a-f0-9]{24}$/.test(id)) return send(res, 404, 'Introuvable');
    const img = await db.getImage(id);
    if (!img) return send(res, 404, 'Introuvable');
    return send(res, 200, img.data, { 'Content-Type': img.mime, 'Cache-Control': 'public, max-age=31536000, immutable' });
  }

  // Police
  if (m === 'GET' && p.startsWith('/fonts/')) {
    const name = p.slice(7);
    const ext = (name.split('.').pop() || '').toLowerCase();
    const file = path.join(FONT_DIR, name);
    if (!/^[\w.-]+$/.test(name) || !FONT_TYPES[ext] || !fs.existsSync(file)) return send(res, 404, 'Introuvable');
    return send(res, 200, fs.readFileSync(file), { 'Content-Type': FONT_TYPES[ext], 'Cache-Control': 'public, max-age=31536000' });
  }

  // Connexion
  if (m === 'POST' && p === '/api/login') {
    if (!ADMIN_PASSWORD) return sendJson(res, 503, { error: 'Back-office désactivé : ajoutez la variable ADMIN_PASSWORD dans Heroku (Settings, Config Vars).' });
    const ip = clientIp(req);
    if (tooManyAttempts(ip)) return sendJson(res, 429, { error: 'Trop de tentatives. Réessayez dans 15 minutes.' });
    const body = await readJson(req, 10 * 1024);
    if (!sameText(body.password || '', ADMIN_PASSWORD)) {
      attempts.get(ip).push(Date.now());
      return sendJson(res, 401, { error: 'Mot de passe incorrect.' });
    }
    attempts.delete(ip);
    const ts = String(Date.now());
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, `${ts}.${sign('admin:' + ts)}`, SESSION_DAYS * 86400) });
  }
  if (m === 'POST' && p === '/api/logout') {
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(req, '', 0) });
  }

  // Back-office (connexion obligatoire)
  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req)) return sendJson(res, 401, { error: 'Non connecté.' });
    if (m !== 'GET' && !(req.headers['content-type'] || '').includes('application/json')) return sendJson(res, 415, { error: 'Format non accepté.' });
    const action = p.slice('/api/admin/'.length);

    if (m === 'GET' && action === 'me') return sendJson(res, 200, { ok: true });
    if (m === 'GET' && action === 'live') return sendJson(res, 200, liveSnapshot());
    if (m === 'GET' && action === 'store') {
      return sendJson(res, 200, { settings: STORE.settings, products: STORE.products, storage: db.kind, persistent: db.persistent });
    }
    if (m === 'PUT' && action === 'products') {
      const body = await readJson(req);
      if (!Array.isArray(body.products)) throw httpError(400, 'Liste de produits manquante.');
      STORE.products = cleanProducts(body.products);
      await persist();
      return sendJson(res, 200, { products: STORE.products });
    }
    if (m === 'PUT' && action === 'settings') {
      const body = await readJson(req);
      STORE.settings = cleanSettings(body.settings);
      await persist();
      return sendJson(res, 200, { settings: STORE.settings });
    }
    if (m === 'POST' && action === 'images') {
      const body = await readJson(req);
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(body.data || '');
      if (!match) throw httpError(400, 'Image non reconnue (PNG, JPEG ou WebP).');
      const buf = Buffer.from(match[2], 'base64');
      if (buf.length > 8 * 1024 * 1024) throw httpError(413, 'Image trop lourde (8 Mo maximum).');
      const id = randomId(12);
      await db.putImage(id, match[1], buf);
      return sendJson(res, 200, { url: `/img/${id}` });
    }
    if (m === 'GET' && action === 'fetch') {
      let xh;
      try { const h64 = url.searchParams.get('h'); if (h64) xh = JSON.parse(Buffer.from(h64, 'base64url').toString()); } catch {}
      const r = await scrapeFetch(url.searchParams.get('url'), url.searchParams.get('json') === '1', xh);
      return sendJson(res, 200, r);
    }
    if (m === 'POST' && action === 'translate') {
      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
      const body = await readJson(req);
      if (!body || !Array.isArray(body.products) || !body.products.length) throw httpError(400, 'Aucun produit à traduire.');
      const items = body.products.slice(0, 10);
      // Pas de clé Claude : traduction intégrée (DeepL si sa clé existe, sinon service gratuit)
      if (!ANTHROPIC_KEY) return sendJson(res, 200, await translateWithoutClaude(items));
      const prompt = `Tu es un traducteur expert pour une boutique de vêtements en ligne française. Traduis TOUT en français naturel et commercial (jamais de traduction mot à mot).

Règles :
- title : le nom du produit doit TOUJOURS être traduit en français, comme sur une boutique française (ex. "Ultra Light Down Jacket" → "Doudoune ultra légère", "Crew Neck T-Shirt" → "T-shirt col rond", "Wide Straight Jeans" → "Jean droit large", "Heattech Socks" → "Chaussettes HEATTECH"). Ne laisse aucun mot anglais sauf les marques et technologies.
- descriptionHtml : traduite naturellement, balises HTML intactes (<br>, <p>…).
- type : traduit (ex. "Outerwear" → "Vestes & Manteaux").
- colors : un nom de couleur français par couleur reçue, MÊME ORDRE, MÊME NOMBRE. Garde le code chiffré au début s'il y en a un et la casse d'origine (ex. "09 BLACK" → "09 NOIR", "01 OFF WHITE" → "01 BLANC CASSÉ", "Dark Navy" → "Bleu marine foncé", "Light Gray" → "Gris clair").
- Si un texte est déjà en français, garde-le. Ne traduis pas les marques ni les technologies (HEATTECH, AIRism, UNIQLO…) ni les codes produit.

Produits (JSON) :
${JSON.stringify(items)}

Réponds UNIQUEMENT avec un tableau JSON (sans markdown, sans backticks), un objet par produit dans le même ordre, avec les clés : title, descriptionHtml, type, colors. Si un champ est vide en entrée, laisse-le vide.`;

      // Modèle choisi dans Heroku (ANTHROPIC_MODEL), sinon on essaie les modèles récents l'un après l'autre
      const models = [process.env.ANTHROPIC_MODEL, 'claude-sonnet-5-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-sonnet-4-20250514'].filter(Boolean);
      let lastErr = '';
      for (const model of [...new Set(models)]) {
        let r;
        try {
          r = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
          });
        } catch (err) {
          throw httpError(502, 'Impossible de joindre l\'API Anthropic : ' + (err.message || ''));
        }
        if (r.status === 404 || r.status === 400) {
          const t = await r.text().catch(() => '');
          lastErr = `(${r.status}) ${t.slice(0, 160)}`;
          if (/model/i.test(t)) continue; // modèle inconnu : on essaie le suivant
          throw httpError(502, 'Erreur API Anthropic ' + lastErr);
        }
        if (r.status === 401 || r.status === 403) throw httpError(502, 'La clé API Anthropic est refusée. Vérifiez ANTHROPIC_API_KEY dans les Config Vars de Heroku.');
        if (!r.ok) {
          const t = await r.text().catch(() => '');
          throw httpError(502, 'Erreur API Anthropic (' + r.status + ') : ' + t.slice(0, 200));
        }
        const data = await r.json();
        const text = (data.content || []).map((x) => x.text || '').join('');
        const clean = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
        const start = clean.indexOf('['), end = clean.lastIndexOf(']');
        let translated;
        try { translated = JSON.parse(start >= 0 && end > start ? clean.slice(start, end + 1) : clean); } catch { throw httpError(502, 'La réponse de Claude n\'est pas du JSON valide.'); }
        if (!Array.isArray(translated)) translated = [translated];
        translated.forEach((t, k) => { const r = items[k] && uqTitleFR(items[k].title); if (t && r) t.title = r; });
        return sendJson(res, 200, { translated, model });
      }
      throw httpError(502, 'Aucun modèle Claude disponible ' + lastErr);
    }
    if (m === 'GET' && action === 'site') {
      // Le site complet en .zip : serveur, pages, guide… avec la boutique actuelle à la place des produits de démonstration.
      // À mettre tel quel sur GitHub : une nouvelle app Heroku démarre avec tout le contenu du back-office.
      const top = slug(STORE.settings.shop.name) || 'boutique';
      const root = `${top}-site/`;
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'application/zip',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="site-${top}-${new Date().toISOString().slice(0, 10)}.zip"`,
      });
      const zip = zipWriter(res);
      try {
        const files = siteFiles();
        for (const f of files) await zip.add(root + f.name, fs.readFileSync(f.full));
        if (!files.some((f) => f.name === '.gitignore')) await zip.add(root + '.gitignore', 'node_modules/\ndata/\n.env\n.DS_Store\n');
        await zip.add(root + 'seed.json', JSON.stringify({ settings: STORE.settings, products: STORE.products }, null, 1));
        for (const id of imageIdsIn(STORE)) {
          const img = await db.getImage(id);
          if (img) await zip.add(`${root}seed-images/${id}.${IMAGE_TYPES[img.mime] || 'jpg'}`, Buffer.from(img.data));
        }
        await zip.end();
      } catch (err) {
        console.error('Téléchargement du site interrompu :', err.message);
        res.destroy();
      }
      return;
    }
    if (m === 'GET' && action === 'backup') {
      // Sauvegarde complète : réglages, produits ET photos envoyées depuis le back-office (/img/…).
      // Les photos hébergées ailleurs (Shopify, sites scrapés) restent des liens.
      const doc = { version: 2, exportedAt: new Date().toISOString(), settings: STORE.settings, products: STORE.products };
      const json = JSON.stringify(doc);
      const ids = [...new Set((json.match(/\/img\/[a-f0-9]{24}/g) || []).map((x) => x.slice(5)))];
      const name = `sauvegarde-${slug(STORE.settings.shop.name) || 'boutique'}-${doc.exportedAt.slice(0, 10)}.json`;
      res.writeHead(200, {
        ...BASE_HEADERS,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="${name}"`,
      });
      const write = (chunk) => (res.write(chunk) ? null : new Promise((ok) => res.once('drain', ok)));
      try {
        await write(json.slice(0, -1) + ',"images":{');
        let first = true;
        for (const id of ids) {
          const img = await db.getImage(id);
          if (!img) continue;
          await write((first ? '' : ',') + JSON.stringify(id) + ':' + JSON.stringify({ mime: img.mime, data: Buffer.from(img.data).toString('base64') }));
          first = false;
        }
        res.end('}}');
      } catch (err) {
        console.error('Sauvegarde interrompue :', err.message);
        res.destroy();
      }
      return;
    }
    if (m === 'POST' && action === 'restore-image') {
      // Restauration d'une photo de la sauvegarde, une par une (évite d'envoyer un fichier énorme d'un coup)
      const body = await readJson(req);
      if (!/^[a-f0-9]{24}$/.test(body.id || '')) throw httpError(400, 'Photo de sauvegarde invalide.');
      if (!IMAGE_TYPES[body.mime] || typeof body.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(body.data)) throw httpError(400, 'Photo de sauvegarde illisible.');
      const buf = Buffer.from(body.data, 'base64');
      if (!buf.length || buf.length > 8 * 1024 * 1024) throw httpError(413, 'Photo trop lourde (8 Mo maximum).');
      await db.putImage(body.id, body.mime, buf);
      return sendJson(res, 200, { ok: true });
    }
    if (m === 'POST' && action === 'restore') {
      const body = await readJson(req);
      if (!body || !Array.isArray(body.products) || !body.settings) throw httpError(400, 'Ce fichier n’est pas une sauvegarde de la boutique.');
      STORE = { settings: cleanSettings(body.settings), products: cleanProducts(body.products) };
      await persist();
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 404, { error: 'Action inconnue.' });
  }

  if (m === 'GET' && p === '/favicon.ico') return send(res, 204, '');
  return send(res, 404, 'Page introuvable', { 'Content-Type': 'text/plain; charset=utf-8' });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Erreur du serveur. Réessayez.' });
  });
});

async function start() {
  db = process.env.DATABASE_URL ? pgStore() : fileStore();
  await db.init();
  let doc = await db.load();
  if (!doc) {
    doc = { settings: SEED.settings, products: SEED.products };
    await db.save(doc);
    // Photos livrées avec le site (dossier seed-images)
    let n = 0;
    try {
      for (const f of fs.readdirSync(SEED_IMAGES)) {
        const mt = /^([a-f0-9]{24})\.(png|jpg|webp)$/.exec(f);
        if (!mt) continue;
        const mime = Object.keys(IMAGE_TYPES).find((k) => IMAGE_TYPES[k] === mt[2]);
        await db.putImage(mt[1], mime, fs.readFileSync(path.join(SEED_IMAGES, f)));
        n++;
      }
    } catch (e) { /* pas de dossier seed-images */ }
    if (n) console.log(`${n} photos chargées depuis seed-images.`);
    console.log('Boutique initialisée à partir de seed.json.');
  }
  STORE = { settings: cleanSettings(doc.settings), products: cleanProducts(doc.products) };
  LIVE.stats = cleanStats(await db.loadStats().catch(() => null));
  today();
  loadPages();
  if (!ADMIN_PASSWORD) console.warn('ATTENTION : ADMIN_PASSWORD n’est pas défini, le back-office est désactivé.');
  if (!db.persistent) console.warn('ATTENTION : aucune base de données. Ajoutez Heroku Postgres, sinon les modifications seront perdues au redémarrage.');
  server.listen(PORT, () => console.log(`Boutique en ligne sur le port ${PORT} (stockage : ${db.kind})`));
}

// Heroku redémarre le serveur chaque jour : on garde les statistiques du jour avant de s’arrêter
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => { saveStats(true).finally(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); });
}

start().catch((err) => {
  console.error('Impossible de démarrer :', err.message);
  process.exit(1);
});
