/**
 * Пошук усіх заяв однієї людини.
 *
 * Abit-poisk має пошук, який за прізвищем повертає всі заяви абітурієнта —
 * з пріоритетами, спеціальностями та статусами. Це те, чого бракує в списку
 * однієї спеціальності: там видно лише пріоритет, але не видно, чи людина
 * вже пройшла кудись вище.
 *
 * Сайт навмисно обмежує цей пошук паузами, тому тут: жорсткий кеш на диску,
 * послідовні запити з паузою і обмеження зверху на кількість пошуків.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const CACHE_DIR = path.join(__dirname, '..', 'cache', 'people');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // статуси змінюються повільно
const PAUSE_MS = 900;                    // пауза між пошуками
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clean = (s) => s
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&mdash;/g, '—')
  .replace(/&#039;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim();

const cacheFile = (query) =>
  path.join(CACHE_DIR, crypto.createHash('sha1').update(query).digest('hex') + '.json');

function post(query) {
  return new Promise((resolve, reject) => {
    const body = `search=${encodeURIComponent(query)}&offset=0`;
    const req = https.request('https://abit-poisk.org.ua/api/statements/', {
      method: 'POST',
      timeout: 20000,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} від пошуку`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error('Пошук повернув не JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Пошук не відповів вчасно')));
    req.on('error', reject);
    req.end(body);
  });
}

/** Розбирає таблицю результатів пошуку в перелік заяв. */
function parseStatements(html) {
  const tbody = html.slice(html.indexOf('<tbody'));
  const out = [];

  for (const m of tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const c = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => clean(x[1]));
    if (c.length < 13) continue;

    const [level, name, status, position, priorityCell, , score, , , university, faculty, specialty, quota] = c;
    const pr = priorityCell.match(/(\d+)\s*\(([БК])\)/);

    out.push({
      level,
      name,
      status,
      position: Number(position) || null,
      priority: pr ? Number(pr[1]) : null,
      basis: pr ? pr[2] : null,
      score: parseFloat(String(score).replace(',', '.')) || null,
      university,
      faculty,
      specialty,
      quota: quota && quota !== '—' ? quota : null,
    });
  }
  return out;
}

/** Заява, яка вже дала людині місце (у списку пошуку статуси пишуться повніше). */
const isWinning = (s) => /До наказу|Рекомендовано|Зараховано/i.test(s || '');
const wonBudget = (s) => isWinning(s) && /\(б|бюджет/i.test(s || '');

/**
 * Усі заяви людини. Кешується на диск: той самий абітурієнт трапляється
 * в списку по кілька разів, та й між перерахунками нічого не змінюється.
 */
async function findPerson(name, year) {
  const query = `${name} ${year}`;
  const file = cacheFile(query);

  try {
    const hit = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Date.now() - hit.at < CACHE_TTL_MS) return hit.statements;
  } catch { /* немає кешу */ }

  const json = await post(query);
  const statements = parseStatements(json.html || '');

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ at: Date.now(), query, statements }));
  } catch { /* не змогли зберегти — не критично */ }

  await sleep(PAUSE_MS);
  return statements;
}

/** Скільки людей уже є в кеші — щоб показати, скільки лишилось питати. */
function cachedCount(names, year) {
  let n = 0;
  for (const name of names) {
    try {
      const hit = JSON.parse(fs.readFileSync(cacheFile(`${name} ${year}`), 'utf8'));
      if (Date.now() - hit.at < CACHE_TTL_MS) n++;
    } catch { /* не кешовано */ }
  }
  return n;
}

module.exports = { findPerson, parseStatements, isWinning, wonBudget, cachedCount, PAUSE_MS };
