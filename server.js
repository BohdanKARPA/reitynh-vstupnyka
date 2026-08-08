'use strict';

/**
 * Локальний сервер: тягне рейтинги з abit-poisk.org.ua, рахує прогноз
 * і віддає веб-сторінку. Сторонні бібліотеки не потрібні — лише Node.js.
 *
 * Запуск:  node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const {
  fetchDirection, fetchRegions, fetchUniversities, fetchDirections,
  DEFAULT_YEAR, YEARS,
} = require('./lib/fetcher.js');
const R = require('./lib/rank.js');
const Priority = require('./lib/priority.js');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DEFAULT_ID = '1604452'; // F7 Комп'ютерна інженерія, Львівська політехніка

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Не знайдено');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(buf);
  });
}

/** Бал останнього в наборі — тобто фактичний прохідний. */
const lastScore = (rows) => (rows.length ? rows[rows.length - 1].score : null);

/** Компактна версія даних для браузера — без важких полів. */
function toPayload(data) {
  const sim = R.simulationSets(data);

  // Симульований список містить рівно одну заяву на людину — ту, що дає місце.
  // Номери позицій у ньому ті самі, що й у загальному списку, тож зіставляємо за ними.
  const simByPosition = new Map();
  const winnerPosition = new Map();
  for (const r of data.simulationRows || []) {
    simByPosition.set(r.position, r.simulation);
    if (r.name) winnerPosition.set(r.name, r.position);
  }

  // Коли симуляції немає (минулі роки або кампанія вже дійшла до рекомендацій),
  // те саме беремо зі статусів: вони кажуть, хто справді проходить.
  if (sim.source === 'actual') {
    sim.budget.forEach((r, i) => {
      simByPosition.set(r.position, { type: 'budget', staysHere: true, position: i + 1 });
    });
    sim.contract.forEach((r, i) => {
      simByPosition.set(r.position, { type: 'contract', staysHere: true, position: i + 1 });
    });
  }

  const people = R.competitors(data.rows || []);

  return {
    id: data.id,
    year: data.year || DEFAULT_YEAR,
    // Дані з кешу, бо зв'язку не було — попереджаємо про це на сторінці.
    stale: Boolean(data.stale),
    // Посилання на цю саму спеціальність в інші роки (ID щороку інші).
    otherYears: data.otherYears || [],
    // Звідки взято набір тих, хто проходить: прогноз чи фактичний результат.
    resultSource: sim.source,
    url: data.url,
    fetchedAt: data.fetchedAt,
    info: data.info,
    // Заяв більше, ніж людей: одна людина подає кілька заяв на той самий напрям.
    counts: {
      applications: (data.rows || []).length,
      active: (data.rows || []).filter(R.isActive).length,
      people: people.length,
      budgetPeople: R.budgetApplications(data.rows || []).length,
    },
    simulation: {
      ...data.simulation,
      budgetOpenSeats: sim.budgetOpen.length,
      quotaSeats: sim.budgetQuota.length,
      // За минулі роки сайт не друкує цих чисел — рахуємо з фактичного набору.
      budgetCount: data.simulation.budgetCount ?? (sim.budget.length || null),
      contractCount: data.simulation.contractCount ?? (sim.contract.length || null),
      budgetMinScore: data.simulation.budgetMinScore ?? lastScore(sim.budgetOpen),
      contractMinScore: data.simulation.contractMinScore ?? lastScore(sim.contractOpen),
    },
    subjects: data.subjects,
    rows: (data.rows || []).map((r) => {
      const winning = simByPosition.get(r.position) || null;
      const winsAt = winnerPosition.get(r.name);

      return {
        position: r.position,
        name: r.name,
        score: r.score,
        priority: r.priority,
        basis: r.basis,
        status: r.status,
        quota: r.quota,
        components: r.components,
        // Куди людину «відправляє» симуляція — або де вона опинилась насправді.
        goesTo: r.simulation || winning
          ? {
              type: winning ? winning.type : r.simulation.type,
              staysHere: Boolean(winning),
              position: winning ? winning.position : r.simulation.position,
              // Куди людина пішла, знає лише симуляція; за фактичними
              // статусами цих полів немає.
              university: r.simulation?.university ?? null,
              specialty: r.simulation?.specialty ?? null,
              specialtyCode: r.simulation?.specialtyCode ?? null,
              url: r.simulation?.url ?? null,
            }
          : null,
        // Одна людина подає кілька заяв на той самий напрям. Місце дає лише одна
        // з них — тут номер тієї заяви, якщо поточний рядок є її дублем.
        sameAs: !winning && winsAt != null && winsAt !== r.position ? winsAt : null,
      };
    }),
    histogram: R.histogram(data.rows || []),
  };
}

/** Рік із запиту — лише зі списку відомих, щоб не ліпити довільні шляхи. */
function yearOf(url) {
  const y = url.searchParams.get('year');
  return YEARS.includes(y) ? y : DEFAULT_YEAR;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (url.pathname === '/api/years') {
      return sendJson(res, 200, { years: YEARS, current: DEFAULT_YEAR });
    }

    // --- Дані напряму ---
    if (url.pathname === '/api/direction') {
      const raw = (url.searchParams.get('id') || DEFAULT_ID).trim();
      const id = (raw.match(/(\d{4,})/) || [])[1]; // приймає і повне посилання
      if (!id) return sendJson(res, 400, { error: 'Вкажи числовий ID напряму або посилання на нього.' });

      const force = url.searchParams.get('refresh') === '1';
      const data = await fetchDirection(id, { force, year: yearOf(url) });
      return sendJson(res, 200, toPayload(data));
    }

    // --- Прогноз для конкретного балу ---
    if (url.pathname === '/api/evaluate') {
      const id = (url.searchParams.get('id') || DEFAULT_ID).replace(/\D/g, '');
      const score = parseFloat(url.searchParams.get('score'));
      const quota = url.searchParams.get('quota') || null;
      if (!Number.isFinite(score)) return sendJson(res, 400, { error: 'Некоректний конкурсний бал.' });

      const data = await fetchDirection(id, { year: yearOf(url) });
      return sendJson(res, 200, R.evaluate(data, score, { quota }));
    }

    // --- Пошук людини ---
    if (url.pathname === '/api/search') {
      const id = (url.searchParams.get('id') || DEFAULT_ID).replace(/\D/g, '');
      const q = url.searchParams.get('q') || '';
      const data = await fetchDirection(id, { year: yearOf(url) });
      const found = R.search(data, q).slice(0, 40);
      return sendJson(res, 200, { count: found.length, results: found });
    }

    // --- Каталог: області → виші → спеціальності ---
    if (url.pathname === '/api/priority') {
      const id = (url.searchParams.get('id') || '').replace(/\D/g, '');
      const score = parseFloat(url.searchParams.get('score'));
      if (!id) return sendJson(res, 400, { error: 'Не вказано ID напряму.' });
      if (!Number.isFinite(score)) return sendJson(res, 400, { error: 'Некоректний конкурсний бал.' });

      // Кожна перевірка — окремий пошук на сайті, тож обмежуємо зверху.
      const asked = parseInt(url.searchParams.get('limit'), 10);
      const limit = Math.min(Number.isFinite(asked) ? asked : 60, 150);

      const data = await fetchDirection(id, { year: yearOf(url) });
      return sendJson(res, 200, await Priority.simulate(data, score, { limit }));
    }

    if (url.pathname === '/api/regions') {
      return sendJson(res, 200, await fetchRegions(yearOf(url)));
    }

    if (url.pathname === '/api/universities') {
      const region = (url.searchParams.get('region') || '').replace(/\D/g, '');
      if (!region) return sendJson(res, 400, { error: 'Не вказано область.' });
      return sendJson(res, 200, await fetchUniversities(region, yearOf(url)));
    }

    if (url.pathname === '/api/directions') {
      const univer = (url.searchParams.get('univer') || '').replace(/\D/g, '');
      if (!univer) return sendJson(res, 400, { error: 'Не вказано ВНЗ.' });

      const level = url.searchParams.get('level'); // «Бакалавр» / «Магістр»
      let list = await fetchDirections(univer, yearOf(url));
      if (level) list = list.filter((d) => d.level === level);
      return sendJson(res, 200, list);
    }

    // --- Статика ---
    const file = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    const safe = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[\\/])+/, ''));
    if (!safe.startsWith(PUBLIC_DIR)) {
      res.writeHead(403); return res.end('Заборонено');
    }
    return serveStatic(res, safe);
  } catch (err) {
    if (/HTTP 404/.test(err.message)) {
      const what = url.pathname === '/api/direction' || url.pathname === '/api/evaluate'
        ? 'Такого напряму немає. Перевір ID або обери спеціальність зі списку.'
        : 'Такої сторінки немає на abit-poisk — схоже, невірний ID.';
      return sendJson(res, 404, { error: what });
    }
    if (/fetch failed|ENOTFOUND|ETIMEDOUT/.test(err.message)) {
      return sendJson(res, 503, { error: 'Немає зв\'язку з abit-poisk.org.ua. Перевір інтернет і спробуй ще раз.' });
    }
    return sendJson(res, 500, { error: err.message });
  }
});

/**
 * Відкриває сторінку в браузері. Консоль Windows часто не показує кирилицю
 * правильно, тому текст тут навмисно латиницею — головне все одно в браузері.
 */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  // На хостингу браузера немає й консоль не інтерактивна — відкривати нічого.
  if (!process.stdout.isTTY) return;
  const { spawn } = require('child_process');
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* не вдалося — користувач відкриє вручну за адресою нижче */ }
}

/** Адреса цього комп'ютера в домашній мережі — щоб відкрити з телефона чи ноутбука. */
function lanAddress() {
  const nets = require('os').networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;

  // На хостингу локальні адреси не мають сенсу — там своя публічна.
  if (!process.stdout.isTTY) {
    console.log(`Server listening on port ${PORT}`);
    return;
  }

  const lan = lanAddress();
  console.log('');
  console.log('  Reytyng vstupnyka');
  console.log('  --------------------------------------');
  console.log(`  Cey kompyuter:  ${url}`);
  if (lan) {
    console.log(`  Inshi prystroyi: http://${lan}:${PORT}`);
    console.log('  (telefon/noutbuk u tiy samiy Wi-Fi merezhi)');
  }
  console.log('  Stop: Ctrl+C');
  console.log('');
  openBrowser(url);
});
