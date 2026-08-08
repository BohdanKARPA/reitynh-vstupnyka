'use strict';

/**
 * Парсер сторінок рейтингових списків abit-poisk.org.ua.
 * Працює на регулярних виразах — сторонні бібліотеки не потрібні.
 */

/** Прибирає HTML-теги, декодує сутності, стискає пробіли. */
function clean(html) {
  if (html == null) return '';
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&mdash;|&ndash;/g, '—')
    .replace(/&bullet;/g, '•')
    .replace(/&laquo;?/g, '«')
    .replace(/&raquo;?/g, '» ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Перше збіжне значення групи 1 або null. */
function m1(html, re) {
  const m = html.match(re);
  return m ? clean(m[1]) : null;
}

function num(html, re) {
  const v = m1(html, re);
  if (v == null) return null;
  const n = parseFloat(v.replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

/**
 * Освітня програма (кафедра) з хлібних крихт: «галузь / спеціальність / програма».
 * Саме вона розрізняє однойменні спеціальності в межах одного вишу.
 */
function parseProgram(html) {
  const block = m1(html, /card-after-header[^>]*>\s*<div class="horizontal-scroll-xs">([\s\S]*?)<\/div>/);
  if (!block) return null;
  // clean() уже прибрав теги, лишається взяти останню частину після «/».
  const parts = block.split('/').map((s) => s.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 1] : null;
}

/** Загальна інформація про напрям: назва, ВНЗ, обсяги, конкурс. */
function parseHeader(html) {
  const meta = m1(html, /data-name="Рейтинговий список ([^"]+)"/);
  let specialty = null, level = null, university = null, year = null;
  if (meta) {
    const parts = meta.split('|').map((s) => s.trim());
    [specialty, level, university, year] = parts;
  }

  return {
    specialty: specialty || m1(html, /<h2 class="headline margin-0">\s*([\s\S]*?)\s*<button/),
    program: parseProgram(html),
    level: level || null,
    university: university || null,
    year: year || null,
    faculty: m1(html, /<span title='([^']*(?:'[^']*)*?)'>\s*([А-ЯІЇЄҐA-Z]{2,})\s*<\/span>\s*&bullet;/) || null,
    // ВМ — загальна кількість місць, БМmax — максимум бюджету, К — контракт.
    totalPlaces: num(html, /Загальна кількість місць"><strong>ВМ<\/strong><\/span>\s*(\d+)/),
    budgetMax: num(html, /<strong>БМ<sub>max<\/sub><\/strong>\s*<\/span>\s*(\d+)/),
    contractPlaces: num(html, /data-stooltip="Кількість місць на контракт"><strong>К<\/strong>\s*<\/span>\s*(\d+)/),
    budgetMin: num(html, /<strong>БМ\s*<sub>min<\/sub><\/strong>\s*(\d+)/),
    applications: num(html, /<strong>Заяв<\/strong>\s*(\d+)/),
    competition: num(html, /<strong>Конкурс на бюджет<\/strong>\s*([\d.]+)/),
    quota1: num(html, /<strong>Квота 1<\/strong>\s*(\d+)/),
    quota2: num(html, /<strong>Квота 2<\/strong>\s*(\d+)/),
  };
}

/**
 * Прогноз сайту («Симуляція вступу»): скільки місць реально розійдеться
 * і який мінімальний бал проходження без урахування квот.
 */
function parseSimulationSummary(html) {
  const block = (attr) => {
    const re = new RegExp(`data-simulation-${attr}-count>([\\s\\S]*?)</span>`);
    const m = html.match(re);
    return m ? m[1] : '';
  };
  const budget = block('budget');
  const contract = block('contract');
  const has = /simulation-panel--available/.test(html);

  return {
    available: has,
    budgetCount: num(budget, /<strong>(\d+)<\/strong>/),
    budgetMinScore: num(budget, /min-score>[\s\S]*?<strong>([\d.]+)<\/strong>/),
    contractCount: num(contract, /<strong>(\d+)<\/strong>/),
    contractMinScore: num(contract, /min-score>[\s\S]*?<strong>([\d.]+)<\/strong>/),
    simulatedListSize: num(html, /\?list=simulation"[\s\S]*?Симульований список\s*\((\d+)\)/),
  };
}

/**
 * Предмети конкурсного балу з ваговими коефіцієнтами.
 * Номер повторюється (кілька «4.») там, де предмет вибірковий — тоді це група альтернатив.
 */
function parseSubjects(html) {
  const start = html.indexOf('id="js-offer-subjects"');
  if (start < 0) return [];
  // Блок закінчується там, де починається наступна вкладка.
  const nextTab = html.indexOf('role="tabpanel"', start + 10);
  const block = html.slice(start, nextTab > start ? nextTab : start + 8000);

  const out = [];
  // Кожен предмет — окремий <div>, тож розбираємо їх поштучно:
  // всередині може бути ще й уточнення в <span class="secondary-text">.
  for (const chunk of block.split(/<div class=''/).slice(1)) {
    const m = chunk.match(/<strong>(\d+)\.<\/strong>([\s\S]*?)<span class='font400'>\s*,\s*k=([\d.]+)/);
    if (!m) continue;

    out.push({
      group: parseInt(m[1], 10),
      name: clean(m[2].replace(/<span class="secondary-text">[\s\S]*?<\/span>/g, '')),
      note: clean((m[2].match(/<span class="secondary-text">([\s\S]*?)<\/span>/) || [])[1]) || null,
      k: parseFloat(m[3]),
      minScore: num(chunk, /мін\.бал\s*<strong>(\d+)<\/strong>/),
    });
  }
  return out;
}

/**
 * Посилання на цю саму спеціальність в інші роки.
 * ID щороку різні, тож без цих посилань перемкнути рік неможливо.
 */
function parseOtherYears(html) {
  const re = /href="\/rate(\d{4})\/direction\/(\d+)"[^>]*>\s*Рейтингові списки/g;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    if (!out.some((x) => x.year === m[1])) out.push({ year: m[1], id: m[2] });
  }
  return out;
}

/** Скільки всього сторінок у списку. */
function parsePageCount(html) {
  const re = /\?(?:list=\w+&(?:amp;)?)?page=(\d+)/g;
  let max = 1, m;
  while ((m = re.exec(html)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > max) max = n;
  }
  return max;
}

/** Прогноз для однієї заяви: лишається тут чи «йде» на іншу спеціальність. */
function parseRowSimulation(row) {
  // Варіант 1 — бейдж: абітурієнт лишається саме на цьому напрямі.
  const badge = row.match(/data-simulation-result="(budget|contract)"/);
  if (badge) {
    const pos = row.match(/simulation-badge__position"[^>]*>№(\d+)</);
    return {
      type: badge[1],
      staysHere: true,
      position: pos ? parseInt(pos[1], 10) : null,
      university: null,
      specialty: null,
      url: null,
    };
  }
  // Варіант 2 — посилання: абітурієнт піде на інший напрям за вищим пріоритетом.
  const type = m1(row, /data-simulation-type="(budget|contract)"/);
  if (!type) return null;
  return {
    type,
    staysHere: false,
    position: num(row, /data-simulation-position="(\d+)"/),
    university: m1(row, /data-simulation-university="([^"]*)"/),
    specialty: m1(row, /data-simulation-specialty="([^"]*)"/),
    specialtyCode: m1(row, /data-simulation-specialty-code="([^"]*)"/),
    url: m1(row, /data-simulation-url="([^"]*)"/),
  };
}

/** Бали за окремі предмети всередині колонки «Складові». */
function parseComponents(row) {
  const td = row.match(/<td data-header="Складові">([\s\S]*?)<\/td>/);
  if (!td) return [];
  const re = /<li>([^:<]+):\s*<strong>([\d.]+)<\/strong><\/li>/g;
  const out = [];
  let m;
  while ((m = re.exec(td[1])) !== null) {
    out.push({ subject: clean(m[1]), score: parseFloat(m[2]) });
  }
  return out;
}

/** Рядки таблиці заяв. */
function parseRows(html) {
  const chunks = html.split(/<tr class="application-status/);
  const rows = [];

  for (let i = 1; i < chunks.length; i++) {
    const row = chunks[i];
    const score = num(row, /<td data-header="Бал">\s*([\d.]+)\s*<\/td>/);
    if (score == null) continue;

    const prio = row.match(/<td data-header="Пріоритет"[^>]*>\s*(\d+)\s*\(([^)]+)\)/);

    rows.push({
      position: num(row, /<td data-header="#"[^>]*>\s*(\d+)\s*<\/td>/),
      name: m1(row, /<a href="\/#search-[^"]*"\s*target="_blank">\s*([\s\S]*?)\s*<\/a>/),
      priority: prio ? parseInt(prio[1], 10) : null,
      // «Б» — заява на бюджет, «К» — лише контракт.
      basis: prio ? clean(prio[2]) : null,
      score,
      status: m1(row, /<td data-header="Статус"[^>]*>\s*([^<]*?)\s*<\/td>/),
      components: parseComponents(row),
      quota: m1(row, /<strong class="quota[^"]*">\s*([^<]+?)\s*<\/strong>/),
      simulation: parseRowSimulation(row),
    });
  }
  return rows;
}

/** Повний розбір першої сторінки (шапка + перша порція рядків). */
function parseDirectionPage(html) {
  return {
    info: parseHeader(html),
    simulation: parseSimulationSummary(html),
    subjects: parseSubjects(html),
    otherYears: parseOtherYears(html),
    pages: parsePageCount(html),
    rows: parseRows(html),
  };
}

/* ────────── Каталог: області → виші → спеціальності ────────── */

/** Посилання виду /rate<рік>/<kind>/<id> разом із назвою (лапки бувають різні). */
function parseIndexLinks(html, kind) {
  const re = new RegExp(`href=['"]/rate\\d{4}/${kind}/(\\d+)['"][^>]*>([\\s\\S]{0,300}?)</a>`, 'g');
  const seen = new Map();
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = clean(m[2]);
    if (!name || seen.has(m[1])) continue;
    seen.set(m[1], { id: m[1], name });
  }
  return [...seen.values()];
}

const parseRegions = (html) => parseIndexLinks(html, 'region');
const parseUniversities = (html) => parseIndexLinks(html, 'univer');

/** Вміст комірки таблиці за її data-header (щоб не «перестрибнути» в сусідню). */
function cell(row, header) {
  const re = new RegExp(`<td data-header="${header}"[^>]*>([\\s\\S]*?)</td>`);
  const m = row.match(re);
  return m ? m[1] : '';
}

/** Перелік пропозицій одного вишу (сторінка /rate2026/univer/<id>). */
function parseDirections(html) {
  const out = [];
  for (const row of html.split('<tr>').slice(1)) {
    const id = m1(row, /\/rate\d{4}\/direction\/(\d+)/);
    if (!id) continue;

    // «Магістр (на основі:Бакалавр)» — рівень і база вступу.
    const okr = m1(row, /data-stooltip="([^"]*на основі[^"]*)"/) || '';
    const okrMatch = okr.match(/^(.+?)\s*\(на основі:\s*(.+?)\)/);

    // Назва спеціальності може повторюватись кілька разів у межах одного вишу —
    // розрізняє їх освітня програма (кафедра). Вона лежить в окремому блоці
    // одразу після посилання, а іноді ще й у <span class="body-1"> у заголовку.
    const titleBlock = m1(row, /<div class="title"[^>]*>([\s\S]*?)<\/div>/) || '';
    const beforeSpan = m1(row, /<div class="title"[^>]*>([\s\S]*?)<span class="body-1">/);
    const name = (beforeSpan || titleBlock).replace(/\s*\/\s*$/, '');

    const inTitle = (m1(row, /<span class="body-1">([\s\S]*?)<\/span>/) || '').replace(/^\/\s*/, '');
    const beside = m1(row, /<\/a>\s*<div class="small secondary-text"[^>]*>([\s\S]*?)<\/div>/);
    const program = beside || inTitle || null;

    out.push({
      id,
      name: name || titleBlock,
      program,
      faculty: m1(row, /<div class="title"[^>]*>[\s\S]*?<\/div>\s*<div>([\s\S]*?)<\/div>/),
      level: okrMatch ? clean(okrMatch[1]) : (okr || null),
      basedOn: okrMatch ? clean(okrMatch[2]) : null,
      // Для магістратури обсяг держзамовлення часто ще не визначений — там «n/a».
      budgetMax: num(cell(row, 'Бюджетні місця'), /<strong>(\d+)<\/strong>/),
      totalPlaces: num(cell(row, 'Всього місць'), /^\s*(\d+)/),
      contractPlaces: num(cell(row, 'Місця на контракт'), /^\s*(\d+)/),
      applications: num(cell(row, 'Конкурс'), /<a[^>]*>(\d+)<\/a>/),
      duration: m1(row, /<small class="secondary-text">([^<]{2,20})<\/small>/),
    });
  }
  return out;
}

module.exports = {
  clean,
  parseRegions,
  parseUniversities,
  parseDirections,
  parseHeader,
  parseOtherYears,
  parseSimulationSummary,
  parseSubjects,
  parsePageCount,
  parseRows,
  parseDirectionPage,
};
