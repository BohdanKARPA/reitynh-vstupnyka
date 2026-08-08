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
// Змінюється, коли з відповіді почали діставати нові поля: старі записи
// без них треба перечитати, інакше вони мовчки псують розрахунок.
const CACHE_VERSION = 2;
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

function post(query, offset = 0) {
  return new Promise((resolve, reject) => {
    const body = `search=${encodeURIComponent(query)}&offset=${offset}`;
    const req = https.request('https://abit-poisk.org.ua/api/statements/', {
      method: 'POST',
      timeout: 20000,
      // Той самий агент, що й для сторінок: abit-poisk часом віддає неповний
      // ланцюжок сертифікатів, тож потрібні наші додаткові.
      agent: require('./fetcher.js').agent,
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
    const cells = [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => x[1]);
    const c = cells.map(clean);
    if (c.length < 13) continue;

    const [level, name, status, position, priorityCell, placesCell, score, , components, university, faculty, specialty, quota] = c;

    // Номер заяви — посилання на той напрям. ID звідти дозволяє взяти
    // рейтинговий список тієї спеціальності й порахувати місце за балом.
    const dir = (cells[3] || '').match(/\/rate(\d{4})\/direction\/(\d+)/);
    const pr = priorityCell.match(/(\d+)\s*\(([БК])\)/);

    // «ВМ 300 БМ MAX 230 БМ MIN 5 К 70» — скільки місць на тій спеціальності.
    const num = (re) => {
      const m = placesCell.match(re);
      return m ? Number(m[1]) : null;
    };

    out.push({
      level,
      name,
      status,
      // «Українська мова 195 Історія України 197 …» — за цими числами
      // розрізняємо різних людей з однаковим скороченим іменем.
      subjectScores: (components.match(/\d+(?:[.,]\d+)?/g) || []).map(Number),
      // Номер у списку того напряму. Довіряти йому не можна: свіжі заяви
      // сайт ставить у кінець незалежно від балу, та й рахує сюди
      // контрактників і дублі. Тримаємо лише як запасний варіант.
      position: Number(position) || null,
      directionId: dir ? dir[2] : null,
      directionYear: dir ? dir[1] : null,
      places: {
        total: num(/ВМ\s+(\d+)/),
        budgetMax: num(/БМ\s*MAX\s+(\d+)/i),
        contract: num(/(?:^|\s)К\s+(\d+)/),
      },
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

/**
 * Відсіює чужі заяви.
 *
 * Імена в списках скорочені («Роман М. В.»), і під одним таким іменем цілком
 * може бути кілька різних абітурієнтів. Розрізняємо їх за балами предметів:
 * у однієї людини вони однакові в усіх її заявах, хоч конкурсний бал і різний
 * (бо коефіцієнти в кожної спеціальності свої).
 */
function samePerson(statements, row, level) {
  const want = (row.components || []).map((c) => c.score).filter((n) => typeof n === 'number');
  if (!want.length) return statements;

  const okr = level === 'Магістр' ? 'М' : level === 'Бакалавр' ? 'Б' : null;

  const matched = statements.filter((s) => {
    if (okr && s.level && s.level !== okr) return false;
    // Усі наші бали мають бути серед балів тієї заяви.
    const have = [...s.subjectScores];
    return want.every((n) => {
      const i = have.indexOf(n);
      if (i < 0) return false;
      have.splice(i, 1);
      return true;
    });
  });

  return matched.length ? matched : [];
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
    if (hit.v === CACHE_VERSION && Date.now() - hit.at < CACHE_TTL_MS) return hit.statements;
  } catch { /* немає кешу */ }

  // Пошук віддає по 20 заяв за раз. У активних абітурієнтів їх буває більше,
  // і саме заява з першим пріоритетом може опинитись на другій сторінці.
  const first = await post(query);
  let statements = parseStatements(first.html || '');
  const total = Number(first.count) || statements.length;

  for (let offset = statements.length; offset < total && offset < 80; offset += 20) {
    await sleep(PAUSE_MS);
    const next = await post(query, offset);
    const more = parseStatements(next.html || '');
    if (!more.length) break;
    statements = statements.concat(more);
  }

  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ v: CACHE_VERSION, at: Date.now(), query, statements }));
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
      if (hit.v === CACHE_VERSION && Date.now() - hit.at < CACHE_TTL_MS) n++;
    } catch { /* не кешовано */ }
  }
  return n;
}

module.exports = {
  findPerson, parseStatements, samePerson, isWinning, wonBudget, cachedCount, PAUSE_MS,
};
