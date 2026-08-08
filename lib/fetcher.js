'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const tls = require('tls');
const P = require('./parser.js');

const BASE = 'https://abit-poisk.org.ua';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CACHE_DIR = path.join(__dirname, '..', 'cache');
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 хвилин
const REQUEST_DELAY_MS = 350;        // пауза між запитами, щоб не навантажувати сайт

const DEFAULT_YEAR = '2026';
// Роки, за які сайт тримає рейтингові списки.
const YEARS = ['2026', '2025', '2024', '2023', '2022', '2021', '2020', '2019', '2018'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Сертифікати, яким довіряємо.
 *
 * Abit-poisk час від часу віддає неповний ланцюжок — без проміжного
 * сертифіката ZeroSSL. Браузери це переживають (вони вміють дотягувати
 * відсутню ланку), а Node — ні, і падає з UNABLE_TO_VERIFY_LEAF_SIGNATURE.
 * Тому носимо потрібні сертифікати з собою: перевірка лишається увімкненою,
 * але ланцюжок завжди можна добудувати.
 *
 * Додаємо ще й сховище Windows — там лежать корені антивірусів і проксі,
 * які підміняють HTTPS. Саме тому в браузері сайт відкривається, а в Node ні.
 */
function trustedCertificates() {
  const list = [...tls.rootCertificates];

  try {
    list.push(fs.readFileSync(path.join(__dirname, 'ca-chain.pem'), 'utf8'));
  } catch { /* файла немає — обійдемось стандартними коренями */ }

  try {
    // Node 22.15+/24+: корені, яким довіряє сама операційна система.
    if (typeof tls.getCACertificates === 'function') {
      list.push(...tls.getCACertificates('system'));
    }
  } catch { /* не підтримується — не біда */ }

  return list;
}

const agent = new https.Agent({ keepAlive: true, ca: trustedCertificates() });

/** GET через https з нашим набором сертифікатів. */
function httpsGet(fullUrl, headers, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(fullUrl, { agent, headers, timeout: timeoutMs }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('Час очікування вичерпано')));
    req.on('error', reject);
  });
}

/**
 * Обмежувач одночасних запитів до abit-poisk.
 *
 * Коли програмою користується одна людина, це неважливо. Але на спільному
 * сервері десяток відвідувачів може влаштувати сайту зливу запитів —
 * тримаємо не більше трьох одночасно, решта чекає в черзі.
 */
const MAX_PARALLEL = 3;
let running = 0;
const queue = [];

function acquire() {
  if (running < MAX_PARALLEL) {
    running++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release() {
  const next = queue.shift();
  if (next) next();
  else running--;
}

/**
 * Завантажує сторінку з повторами: обрив зв'язку — річ звичайна, і одна
 * невдала спроба не привід показувати користувачеві помилку.
 * Відповіді на кшталт 404 повторювати сенсу немає — вони не зміняться.
 */
async function getPage(url, attempts = 3) {
  await acquire();
  try {
    return await getPageUnlimited(url, attempts);
  } finally {
    release();
  }
}

async function getPageUnlimited(url, attempts = 3) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await httpsGet(BASE + url, {
        'User-Agent': UA,
        'Accept-Language': 'uk-UA,uk;q=0.9',
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status} для ${url}`);
      }

      const html = res.body;
      // Сайт іноді відповідає короткою заглушкою замість сторінки — це не дані.
      if (html.length < 500 && /тимчасово недоступний|Service Unavailable/i.test(html)) {
        throw new Error('STUB');
      }
      return html;
    } catch (err) {
      lastError = err;
      if (/HTTP \d{3}/.test(err.message)) throw err; // сторінки просто немає
      if (attempt < attempts) await sleep(500 * attempt);
    }
  }

  if (lastError && lastError.message === 'STUB') {
    throw new Error('Сайт abit-poisk тимчасово не віддає дані. Спробуй за хвилину.');
  }

  // Технічну причину лишаємо в тексті — без неї неможливо зрозуміти,
  // це зник інтернет, заблокував антивірус чи впав сайт.
  const cause = lastError?.code || lastError?.cause?.code || lastError?.message || '';
  throw new Error(
    `Не вдалося зв'язатися з abit-poisk.org.ua за ${attempts} спроби` +
    (cause ? ` (${String(cause).slice(0, 60)})` : '') + '. ' +
    'Схоже, зник інтернет або сайт недоступний.'
  );
}

/**
 * Витягує всі сторінки одного списку («усі заяви» або симульований)
 * і повертає плаский масив рядків.
 */
async function fetchList(id, listParam, onProgress, year = DEFAULT_YEAR) {
  const q = listParam ? `?list=${listParam}&page=` : '?page=';
  const firstUrl = `/rate${year}/direction/${id}/` + (listParam ? `?list=${listParam}` : '');
  const firstHtml = await getPage(firstUrl);

  const parsed = P.parseDirectionPage(firstHtml);
  const pages = parsed.pages;
  let rows = parsed.rows;

  for (let p = 2; p <= pages; p++) {
    if (onProgress) onProgress(p, pages);
    await sleep(REQUEST_DELAY_MS);
    const html = await getPage(`/rate${year}/direction/${id}/${q}${p}`);
    rows = rows.concat(P.parseRows(html));
  }

  return { firstHtml, parsed, rows };
}

/**
 * Повні дані напряму: інформація, всі заяви та симульований список.
 * Результат кешується на диск, щоб не смикати сайт при кожному оновленні сторінки.
 */
async function fetchDirection(id, { force = false, onProgress = null, year = DEFAULT_YEAR } = {}) {
  const cacheFile = path.join(CACHE_DIR, `${year}-${id}.json`);

  let cached = null;
  try {
    cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  } catch { /* кешу немає або він пошкоджений */ }

  if (!force && cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  const say = (msg) => { if (onProgress) onProgress(msg); };

  // Якщо цей самий напрям уже завантажується (інший відвідувач), приєднуємось
  // до наявного завантаження замість того, щоб починати друге.
  const key = `${year}-${id}`;
  if (!force && inFlight.has(key)) return inFlight.get(key);

  const job = (async () => {
    try {
      return await downloadDirection(id, year, say, cacheFile);
    } catch (err) {
      // Зв'язку немає, але щось збережене є — краще застарілі дані, ніж порожній екран.
      if (cached && !/HTTP 404/.test(err.message)) return { ...cached, stale: true };
      throw err;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, job);
  return job;
}

/** Завантаження, що вже виконуються, — щоб не дублювати роботу. */
const inFlight = new Map();

/** Власне завантаження всіх сторінок напряму. */
async function downloadDirection(id, year, say, cacheFile) {
  say('Завантажую список заяв…');
  const main = await fetchList(id, null, (p, t) => say(`Заяви: сторінка ${p} з ${t}…`), year);

  if (!main.parsed.info.specialty) {
    throw new Error(`Не вдалося прочитати напрям ${id}. Перевір ID.`);
  }

  let simulationRows = [];
  if (main.parsed.simulation.available) {
    say('Завантажую симульований список…');
    await sleep(REQUEST_DELAY_MS);
    const sim = await fetchList(id, 'simulation', (p, t) => say(`Симуляція: сторінка ${p} з ${t}…`), year);
    simulationRows = sim.rows;
  }

  const data = {
    id: String(id),
    year: String(year),
    url: `${BASE}/rate${year}/direction/${id}/`,
    fetchedAt: Date.now(),
    info: main.parsed.info,
    simulation: main.parsed.simulation,
    subjects: main.parsed.subjects,
    otherYears: main.parsed.otherYears,
    rows: main.rows,
    simulationRows,
  };

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(data));
  return data;
}

/** Кешоване завантаження довідкових сторінок каталогу (області / виші / напрями). */
const indexCache = new Map();
const INDEX_TTL_MS = 6 * 60 * 60 * 1000; // каталог змінюється рідко

const indexFile = (urlPath) =>
  path.join(CACHE_DIR, 'index' + urlPath.replace(/[^\w]+/g, '-') + '.json');

/**
 * Каталог зберігається ще й на диск: він майже не змінюється, тож при
 * перебоях на сайті краще показати вчорашній перелік, ніж порожній список.
 */
async function fetchIndex(urlPath, parse) {
  const hit = indexCache.get(urlPath);
  if (hit && Date.now() - hit.at < INDEX_TTL_MS) return hit.value;

  const file = indexFile(urlPath);
  let onDisk = null;
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - onDisk.at < INDEX_TTL_MS && onDisk.value.length) {
      indexCache.set(urlPath, onDisk);
      return onDisk.value;
    }
  } catch { /* кешу ще немає — завантажимо */ }

  let value = null, lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      value = parse(await getPage(urlPath));
      if (value.length) break;
      lastError = new Error('Сайт повернув сторінку без потрібних даних.');
    } catch (err) {
      lastError = err;
    }
    if (attempt < 2) await sleep(1200);
  }

  if (!value || !value.length) {
    // Свіжого немає — краще віддати збережене раніше, ніж нічого.
    if (onDisk && onDisk.value.length) return onDisk.value;
    throw lastError || new Error('Не вдалося завантажити перелік.');
  }

  const entry = { at: Date.now(), value };
  indexCache.set(urlPath, entry);
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(entry));
  } catch { /* не змогли зберегти — не критично */ }
  return value;
}

/**
 * Перелік областей майже не змінюється, тож тримаємо копію в коді.
 * Це рятує перший крок вибору, коли інтернет саме зник.
 */
const REGIONS_FALLBACK = [
  { id: '27', name: 'м. Київ' }, { id: '3', name: 'Вінницька область' },
  { id: '4', name: 'Волинська область' }, { id: '5', name: 'Дніпропетровська область' },
  { id: '6', name: 'Донецька область' }, { id: '7', name: 'Житомирська область' },
  { id: '8', name: 'Закарпатська область' }, { id: '9', name: 'Запорізька область' },
  { id: '10', name: 'Івано-Франківська область' }, { id: '11', name: 'Київська область' },
  { id: '12', name: 'Кіровоградська область' }, { id: '13', name: 'Луганська область' },
  { id: '14', name: 'Львівська область' }, { id: '15', name: 'Миколаївська область' },
  { id: '16', name: 'Одеська область' }, { id: '17', name: 'Полтавська область' },
  { id: '18', name: 'Рівненська область' }, { id: '19', name: 'Сумська область' },
  { id: '20', name: 'Тернопільська область' }, { id: '21', name: 'Харківська область' },
  { id: '22', name: 'Херсонська область' }, { id: '23', name: 'Хмельницька область' },
  { id: '24', name: 'Черкаська область' }, { id: '25', name: 'Чернівецька область' },
  { id: '26', name: 'Чернігівська область' },
];

async function fetchRegions(year = DEFAULT_YEAR) {
  try {
    return await fetchIndex(`/rate${year}`, P.parseRegions);
  } catch {
    return REGIONS_FALLBACK;
  }
}
const fetchUniversities = (regionId, year = DEFAULT_YEAR) =>
  fetchIndex(`/rate${year}/region/${regionId}`, P.parseUniversities);
const fetchDirections = (univerId, year = DEFAULT_YEAR) =>
  fetchIndex(`/rate${year}/univer/${univerId}`, P.parseDirections);

module.exports = {
  fetchDirection, fetchList, getPage, CACHE_TTL_MS, DEFAULT_YEAR, YEARS,
  fetchRegions, fetchUniversities, fetchDirections,
};
