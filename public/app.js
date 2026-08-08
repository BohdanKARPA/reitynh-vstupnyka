'use strict';

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};
const fmt = (n, d = 3) => (n == null ? '—' : Number(n).toFixed(d).replace(/\.?0+$/, ''));
const debounce = (fn, ms = 250) => {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
};

/* ══════════ Збереження між запусками ══════════ */

const STORE_KEY = 'abit-2026';

/**
 * Усе, що не хочеться вводити повторно: перелік обраних спеціальностей,
 * остання відкрита та бали НМТ. Бали зберігаються за назвами предметів —
 * вони однакові скрізь, а конкурсний бал для кожної спеціальності
 * рахується вже за її власними коефіцієнтами.
 */
function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    const s = raw ? JSON.parse(raw) : {};
    return {
      saved: Array.isArray(s.saved) ? s.saved : [],
      lastId: s.lastId || null,
      subjectScores: s.subjectScores || {},
      choice: s.choice || {},         // який предмет обрано у групі на вибір
      quota: s.quota || '',
      mode: s.mode || 'score',
      scoreById: s.scoreById || {},
      yearMap: s.yearMap || {},
    };
  } catch {
    return {
      saved: [], lastId: null, subjectScores: {}, choice: {},
      quota: '', mode: 'score', scoreById: {}, yearMap: {},
    };
  }
}

/**
 * Заява ще в конкурсі. Статусів багато й вони змінюються по ходу кампанії:
 * «Допущено» на початку, далі «Рекомендовано (б)», «До наказу (б)» тощо.
 * Вибувають лише відмови та скасування — простіше перелічити їх.
 */
const isActiveStatus = (s) => !/Відмова|Скасовано|Деактивовано|Відхилено/i.test(s || '');

/** Чи дивимось завершену кампанію — від цього залежить час у формулюваннях. */
const isPastYear = () => Boolean(DATA) && DATA.year !== String(new Date().getFullYear());

/** Ключ спеціальності, однаковий у різні роки (ID щороку інші). */
function specialtyKey(info) {
  return [info.university, info.specialty, info.program || '', info.level]
    .map((s) => (s || '').trim())
    .join('|');
}

/** Запам'ятовує, який ID відповідає цій спеціальності в цьому році. */
function rememberYearId(info, year, id) {
  const key = specialtyKey(info);
  if (!key.replace(/\|/g, '')) return;
  if (!store.yearMap[key]) store.yearMap[key] = {};
  store.yearMap[key][year] = id;
  saveStore();
}

let store = loadStore();

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch { /* приватний режим або немає місця — не критично */ }
}

const params = new URLSearchParams(location.search);

let DATA = null;          // поточні дані напряму
let currentId = params.get('id') || store.lastId || '1604452';
let currentYear = params.get('year') || store.year || '2026';

/** Адреса API з обов'язковим роком — щоб усе завжди стосувалось одного року. */
function api(path, extra = {}) {
  const q = new URLSearchParams({ year: currentYear, ...extra });
  return `${path}?${q}`;
}
let calcMode = 'score';
let tableFilter = 'all';
let tableLimit = 60;
let myScore = null;       // щоб підсвітити своє місце в таблиці

/* ══════════ Завантаження ══════════ */

async function load(id, refresh = false) {
  $('#loader').classList.remove('hidden');
  $('#content').classList.add('hidden');
  $('#error').classList.add('hidden');
  $('#loader-text').textContent = refresh
    ? 'Оновлюю дані з abit-poisk.org.ua…'
    : 'Завантажую рейтинг із abit-poisk.org.ua…';

  try {
    const res = await fetch(api('/api/direction', refresh ? { id, refresh: '1' } : { id }));
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || 'Помилка завантаження');

    DATA = json;
    currentId = json.id;
    currentYear = json.year || currentYear;
    store.year = currentYear;
    history.replaceState(null, '', `?id=${json.id}&year=${currentYear}`);
    $('#id-input').value = json.id;
    $('#year-select').value = currentYear;

    renderAll();
    $('#loader').classList.add('hidden');
    $('#content').classList.remove('hidden');
  } catch (err) {
    // Збережена пара «ID + рік» могла стати недійсною — тоді не впираємось
    // у порожній екран, а мовчки повертаємось до звичного напряму.
    const badPair = /немає|не знайдено/i.test(err.message);
    if (badPair && (id !== '1604452' || currentYear !== '2026')) {
      currentId = '1604452';
      currentYear = '2026';
      store.year = currentYear;
      store.lastId = currentId;
      saveStore();
      $('#year-select').value = currentYear;
      return load(currentId);
    }

    $('#loader').classList.add('hidden');
    showLoadError(err.message, id, refresh);
  }
}

/** Екран помилки з кнопкою повтору — щоб не перезапускати всю програму. */
function showLoadError(message, id, refresh) {
  const box = $('#error');
  box.innerHTML = '';
  box.append(el('p', null, `Не вдалося завантажити: ${message}`));

  const again = el('button', 'btn btn-primary', 'Спробувати ще раз');
  again.style.marginTop = '12px';
  again.addEventListener('click', () => load(id, refresh));
  box.append(again);
  box.classList.remove('hidden');
}

function renderAll() {
  store.lastId = currentId;
  rememberYearId(DATA.info, currentYear, currentId);
  // Сторінка сама підказує свій ID в інші роки — запам'ятовуємо і їх.
  for (const o of DATA.otherYears || []) {
    if (!store.yearMap[specialtyKey(DATA.info)]) store.yearMap[specialtyKey(DATA.info)] = {};
    store.yearMap[specialtyKey(DATA.info)][o.year] = o.id;
  }
  saveStore();

  renderHead();
  renderStats();
  renderNotice();
  renderSubjectInputs();
  restoreInputs();
  renderSaved();
  renderTable();
  $('#fetched-at').textContent = new Date(DATA.fetchedAt).toLocaleString('uk-UA');
  $('#source-link').href = DATA.url;
  recalc();
}

function renderHead() {
  const i = DATA.info;
  const h1 = $('#specialty');
  h1.textContent = i.specialty || 'Напрям';
  // Однойменні спеціальності розрізняє лише освітня програма — показуємо помітно.
  if (i.program) {
    h1.append(el('span', 'program-tag', i.program));
  }
  // Рік показуємо в підзаголовку: інакше при невдалому перемиканні можна
  // подумати, що на екрані вже інший рік.
  $('#subtitle').textContent =
    [`Вступ ${DATA.year}`, i.university, i.faculty, i.level].filter(Boolean).join(' · ');
}

function renderStats() {
  const i = DATA.info, s = DATA.simulation, c = DATA.counts;
  // За минулі роки це не прогноз, а те, що сталося насправді.
  const past = DATA.resultSource === 'actual';
  const stats = [
    { v: c.budgetPeople ?? '—', l: 'реальних конкурентів на бюджет' },
    { v: s.budgetOpenSeats ?? i.budgetMax ?? '—', l: 'бюджетних місць без квот', hl: true },
    { v: fmt(s.budgetMinScore), l: past ? 'прохідний бал (факт)' : 'прохідний бал (прогноз)', hl: true },
    { v: s.quotaSeats ?? '—', l: 'місць займуть квотники' },
    { v: i.contractPlaces ?? '—', l: 'місць на контракт' },
    { v: (c.budgetPeople / Math.max(1, s.budgetOpenSeats || 1)).toFixed(1), l: 'людей на одне місце' },
  ];
  const box = $('#stats');
  box.innerHTML = '';
  for (const st of stats) {
    const n = el('div', 'stat' + (st.hl ? ' highlight' : ''));
    n.append(el('div', 'stat-value', String(st.v)), el('div', 'stat-label', st.l));
    box.append(n);
  }
}

/** Повертає збережені вибір режиму, квоту й конкурсний бал цієї спеціальності. */
function restoreInputs() {
  const tab = document.querySelector(`#calc-tabs .tab[data-mode="${store.mode}"]`);
  if (tab) {
    calcMode = store.mode;
    document.querySelectorAll('#calc-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
    $('#pane-score').classList.toggle('hidden', calcMode !== 'score');
    $('#pane-subjects').classList.toggle('hidden', calcMode !== 'subjects');
  }
  $('#quota-select').value = store.quota || '';
  // Конкурсний бал залежить від коефіцієнтів, тож зберігається окремо для кожного напряму.
  $('#score-input').value = store.scoreById[currentId] ?? '';
}

/* ══════════ Збережені спеціальності ══════════ */

// Той самий напрям за різні роки — це різні записи (у них і ID різні).
const isSaved = (id, year) => store.saved.some((s) => s.id === id && (s.year || '2026') === year);

function toggleSave() {
  if (isSaved(currentId, currentYear)) {
    store.saved = store.saved.filter((s) => !(s.id === currentId && (s.year || '2026') === currentYear));
  } else {
    store.saved.unshift({
      id: currentId,
      year: currentYear,
      specialty: DATA.info.specialty,
      program: DATA.info.program,
      university: DATA.info.university,
      level: DATA.info.level,
    });
  }
  saveStore();
  renderSaved();
}

function renderSaved() {
  const card = $('#saved-card');
  const box = $('#saved-list');
  box.innerHTML = '';

  const btn = $('#save-btn');
  const on = isSaved(currentId, currentYear);
  btn.textContent = on ? '★ Збережено' : '☆ Зберегти';
  btn.classList.toggle('active', on);

  card.classList.toggle('hidden', store.saved.length === 0);

  for (const s of store.saved) {
    const year = s.year || '2026';
    const isCurrent = s.id === currentId && year === currentYear;
    const chip = el('div', 'saved-chip' + (isCurrent ? ' current' : ''));

    const open = el('button', 'saved-open');
    const name = el('span', 'saved-name');
    name.append(document.createTextNode(s.specialty || `Напрям ${s.id}`));
    name.append(el('span', 'saved-year', year));
    open.append(name);
    if (s.program) open.append(el('span', 'saved-program', s.program));
    open.append(el('span', 'saved-meta', [s.university, s.level].filter(Boolean).join(' · ')));
    open.addEventListener('click', () => {
      if (isCurrent) return;
      tableLimit = 60;
      currentYear = year;
      store.year = year;
      $('#year-select').value = year;
      load(s.id);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

    const del = el('button', 'saved-del', '✕');
    del.title = 'Прибрати зі збережених';
    del.addEventListener('click', () => {
      store.saved = store.saved.filter((x) => !(x.id === s.id && (x.year || '2026') === year));
      saveStore();
      renderSaved();
    });

    chip.append(open, del);
    box.append(chip);
  }
}

/**
 * Пояснення, коли рахувати нема з чого або коли оцінка приблизна.
 * Для магістратури списки з'являються пізніше за бакалаврські.
 */
function renderNotice() {
  const box = $('#notice');
  box.innerHTML = '';
  const empty = !DATA.rows.length;
  const isMaster = DATA.info.level === 'Магістр';

  if (DATA.stale) {
    const n = el('div', 'notice');
    n.innerHTML = '<strong>Показано збережені дані.</strong> Зв\'язку з abit-poisk зараз немає, ' +
      `тому взято те, що завантажилось раніше (${new Date(DATA.fetchedAt).toLocaleString('uk-UA')}). ` +
      'Натисни ↻, коли інтернет повернеться.';
    box.append(n);
  }

  if (empty) {
    const n = el('div', 'notice');
    n.innerHTML = isMaster
      ? '<strong>Рейтинговий список ще не опубліковано.</strong> На магістратуру документи подають пізніше, ' +
        'ніж на бакалаврат, тому заяв поки немає. Сторінка вже читає цей напрям — щойно список з\'явиться, ' +
        'натисни ↻ і прогноз запрацює. Коефіцієнти предметів нижче вже підтягнулися, тож конкурсний бал порахувати можна.'
      : '<strong>Заяв на цей напрям ще немає.</strong> Список порожній — спробуй оновити пізніше кнопкою ↻.';
    box.append(n);
    return;
  }

  if (DATA.resultSource === 'actual') {
    const current = DATA.year === String(new Date().getFullYear());
    const n = el('div', 'notice');
    n.innerHTML = current
      ? '<strong>Рекомендації вже оприлюднені — це не прогноз.</strong> ' +
        'Симуляції на сайті більше немає, натомість у кожної заяви стоїть справжній ' +
        'результат. Прохідний бал порахований по тих, кого рекомендували до зарахування.'
      : `<strong>Це підсумки ${DATA.year} року, а не прогноз.</strong> ` +
        'Прохідний бал тут — той, що склався насправді: він порахований по тих, кого справді ' +
        'рекомендували до зарахування. Зручно як орієнтир, але щороку конкурс змінюється.';
    box.append(n);
    return;
  }

  if (!DATA.simulation.available || !DATA.simulation.budgetCount) {
    const n = el('div', 'notice');
    n.innerHTML = '<strong>Прогноз спрощений.</strong> Для цього напряму сайт ще не рахує симуляцію розподілу, ' +
      'тому місце оцінюється просто за конкурсним балом серед поданих заяв. ' +
      'Реальний прохідний бал зазвичай <em>нижчий</em>: частина людей піде на спеціальності з вищим пріоритетом.';
    box.append(n);
  }
}

/* ══════════ Калькулятор конкурсного балу ══════════ */

function renderSubjectInputs() {
  const box = $('#subject-inputs');
  box.innerHTML = '';

  // Предмети з однаковим номером — це альтернативи на вибір.
  const groups = new Map();
  for (const s of DATA.subjects || []) {
    if (!groups.has(s.group)) groups.set(s.group, []);
    groups.get(s.group).push(s);
  }

  for (const [group, subjects] of [...groups].sort((a, b) => a[0] - b[0])) {
    const wrap = el('div', 'subject');
    wrap.dataset.group = group;

    const head = el('div', 'subject-name');
    const input = el('input');

    // Запам'ятовуємо, який саме предмет зараз у цій комірці, щоб підставити
    // збережений бал і зберегти новий під правильною назвою.
    const useSubject = (s) => {
      wrap.dataset.k = s.k;
      wrap.dataset.min = s.minScore ?? '';
      wrap.dataset.subject = s.name;
      const kBox = head.querySelector('.subject-k');
      if (kBox) kBox.textContent = `k = ${s.k}`;
      const saved = store.subjectScores[s.name];
      input.value = saved != null ? saved : '';
    };

    if (subjects.length === 1) {
      const label = el('span', null, subjects[0].name);
      if (subjects[0].note) label.title = subjects[0].note;
      head.append(label, el('span', 'subject-k', ''));
      wrap.append(head);
    } else {
      head.append(el('span', null, 'Предмет на вибір'), el('span', 'subject-k', ''));
      wrap.append(head);

      const sel = el('select');
      subjects.forEach((s, idx) => {
        const o = el('option', null, `${s.name} (k = ${s.k})`);
        o.value = String(idx);
        sel.append(o);
      });

      // Якщо раніше вже обирали предмет — ставимо його й тут.
      const preferred = (store.choice.preferred || [])
        .map((name) => subjects.findIndex((s) => s.name === name))
        .find((i) => i >= 0);
      if (preferred != null) sel.value = String(preferred);

      sel.addEventListener('change', () => {
        const s = subjects[+sel.value];
        const list = (store.choice.preferred || []).filter((n) => n !== s.name);
        store.choice.preferred = [s.name, ...list].slice(0, 6);
        saveStore();
        useSubject(s);
        recalc();
      });
      wrap.append(sel);
      wrap.dataset.index = sel.value;
    }

    input.type = 'number';
    input.min = '100'; input.max = '200'; input.step = '0.001';
    input.placeholder = 'бал НМТ (100–200)';
    input.addEventListener('input', () => {
      const name = wrap.dataset.subject;
      const v = parseFloat(input.value);
      if (name) {
        if (Number.isFinite(v)) store.subjectScores[name] = v;
        else delete store.subjectScores[name];
        saveStore();
      }
      recalc();
    });

    useSubject(subjects.length === 1 ? subjects[0] : subjects[+(wrap.dataset.index || 0)]);
    wrap.append(input);
    box.append(wrap);
  }
}

/** Конкурсний бал із введених балів НМТ. */
function computeFromSubjects() {
  let weighted = 0, weights = 0, filled = 0, belowMin = false;

  for (const wrap of document.querySelectorAll('#subject-inputs .subject')) {
    const input = wrap.querySelector('input');
    const k = parseFloat(wrap.dataset.k);
    const min = wrap.dataset.min ? parseFloat(wrap.dataset.min) : null;
    const v = parseFloat(input.value);

    wrap.classList.remove('below-min');
    wrap.querySelector('.subject-warn')?.remove();

    if (!Number.isFinite(v)) continue;
    filled++;

    if (min != null && v < min) {
      belowMin = true;
      wrap.classList.add('below-min');
      wrap.append(el('div', 'subject-warn', `Мінімум для вступу — ${min}`));
    }
    weighted += v * k;
    weights += k;
  }

  const total = document.querySelectorAll('#subject-inputs .subject').length;
  if (filled < total || weights === 0) return { score: null, belowMin, filled, total };
  return { score: +(weighted / weights).toFixed(3), belowMin, filled, total };
}

function currentScore() {
  if (calcMode === 'score') {
    const v = parseFloat($('#score-input').value);
    return Number.isFinite(v) ? v : null;
  }
  const r = computeFromSubjects();
  const out = $('#computed-score');
  out.querySelector('strong').textContent = r.score != null ? fmt(r.score) : '—';
  const note = r.score == null ? `заповни всі предмети (${r.filled} з ${r.total})` : 'Σ(бал × коефіцієнт) ÷ Σ(коефіцієнтів)';
  out.querySelector('.formula').textContent = note;
  return r.score;
}

const recalc = debounce(async () => {
  const score = currentScore();
  myScore = score;
  renderTable();

  // Без опублікованих заяв рахувати місце нема з чого — показуємо лише бал.
  if (score == null || !DATA.rows.length) {
    $('#result').classList.add('hidden');
    $('#priority-box').classList.add('hidden');
    return;
  }

  // Перевірка пріоритетів має сенс лише коли є з ким порівнюватись.
  if (lastScoreUsed !== score) {
    lastScoreUsed = score;
    $('#priority-result').innerHTML = '';
    $('#priority-run').textContent = 'Перевірити';

    // Коли конкурентів небагато, рахуємо одразу — це секунди. Для великих
    // списків лишаємо кнопку: там це десятки запитів до сайту.
    const ahead = DATA.rows.filter((r) => r.basis === 'Б' && r.score > score
      && !/Відмова|Скасовано|Відхилено/i.test(r.status || '')).length;
    if (ahead > 0 && ahead <= AUTO_PRIORITY_LIMIT) runPriorityCheck();
  }
  $('#priority-box').classList.remove('hidden');

  const quota = $('#quota-select').value;
  const res = await fetch(api('/api/evaluate', { id: currentId, score, quota }));
  const e = await res.json();
  if (!res.ok) return;
  renderResult(e);
}, 260);

/* ══════════ Вивід прогнозу ══════════ */

const VERDICTS = {
  'budget-safe': {
    cls: 'v-good', icon: '✅', title: 'Проходиш на бюджет',
    text: (e) => {
      if (e.method !== 'actual') {
        return `Запас над прогнозованим прохідним балом — ${fmt(e.margin)} бала. Позиція впевнена.`;
      }
      // Минулий рік — «проходив би»; поточний — місця вже роздані.
      return isPastYear()
        ? `З таким балом ти проходив би на бюджет того року із запасом ${fmt(e.margin)} бала.`
        : `Запас над прохідним балом — ${fmt(e.margin)} бала. Місця вже розподілені.`;
    },
  },
  'budget-edge': {
    cls: 'v-warn', icon: '⚠️', title: 'Проходиш, але впритул',
    text: (e) => e.method === 'actual'
      ? `Над прохідним балом лише ${fmt(e.margin)} бала — місце було б, але без жодного запасу.`
      : `До прохідного балу лишається всього ${fmt(e.margin)} бала. Кілька нових заяв можуть змінити картину.`,
  },
  'budget-tie': {
    cls: 'v-warn', icon: '⚖️', title: 'Рівно на межі',
    text: (e) => `У тебе такий самий бал, як в інших на останніх бюджетних місцях (${e.budgetRace.tied} збігів). Хто пройде — вирішать додаткові критерії.`,
  },
  'budget-close': {
    cls: 'v-warn', icon: '📉', title: 'Трохи не вистачає на бюджет',
    text: (e) => e.method === 'actual'
      ? `Бракує ${fmt(e.scoreGap)} бала до прохідного. Різниця невелика, але місця вже розподілені.`
      : `Бракує ${fmt(e.scoreGap)} бала до прогнозованого прохідного. Різниця невелика — усе ще можливо, якщо хтось забере документи.`,
  },
  'contract': {
    cls: 'v-info', icon: 'ℹ️', title: 'Бюджет малоймовірний, контракт — так',
    text: (e) => `До бюджету бракує ${fmt(e.scoreGap)} бала, але на контракт бал достатній.`,
  },
  'out': {
    cls: 'v-bad', icon: '❌', title: 'Не проходиш на цю спеціальність',
    text: (e) => `Бракує ${fmt(e.scoreGap)} бала навіть до бюджетного мінімуму. Варто розглянути інші напрями.`,
  },
};

function renderResult(e) {
  const box = $('#result');
  box.innerHTML = '';
  box.classList.remove('hidden');

  const v = VERDICTS[e.verdict];
  const card = el('div', `verdict ${v.cls}`);
  card.append(el('div', 'verdict-icon', v.icon));
  const txt = el('div');
  txt.append(el('p', 'verdict-title', v.title), el('p', 'verdict-text', v.text(e)));
  card.append(txt);
  box.append(card);

  const metrics = [
    { v: `${e.budgetRace.position} / ${e.budgetPlaces}`, l: e.quota ? `місце за ${e.quota}` : 'місце в боротьбі за бюджет' },
    { v: `${e.overall.position} / ${e.overall.total}`, l: 'позиція серед усіх конкурентів' },
    { v: fmt(e.budgetMinScore), l: e.method === 'actual' ? `прохідний ${DATA.year} року` : 'прогнозований прохідний' },
    { v: (e.margin >= 0 ? '+' : '') + fmt(e.margin), l: 'твій запас у балах' },
  ];
  const mbox = el('div', 'metrics');
  for (const m of metrics) {
    const n = el('div', 'metric');
    n.append(el('div', 'metric-value', m.v), el('div', 'metric-label', m.l));
    mbox.append(n);
  }
  box.append(mbox);

  // Далі йде таблиця за пріоритетами — вона й показує, хто попереду
  // насправді, тож смуга й список сусідів тут були б повторенням.
}

/* ══════════ Повна таблиця ══════════ */

function filteredRows() {
  const q = $('#table-search').value.trim().toLowerCase();
  const rows = DATA.rows.filter((r) => {
    if (q && !(r.name || '').toLowerCase().includes(q)) return false;
    if (tableFilter === 'active') return isActiveStatus(r.status);
    if (tableFilter === 'budget') return r.basis === 'Б' && isActiveStatus(r.status);
    if (tableFilter === 'stays') return r.goesTo?.staysHere;
    if (tableFilter === 'quota') return Boolean(r.quota);
    return true;
  });

  // Сайт відсуває свіжі заяви («Заява надійшла з сайту») в кінець списку,
  // хоч бал у них може бути вищий. Конкурс вирішує бал — сортуємо за ним.
  return rows.sort((a, b) => {
    const sa = typeof a.score === 'number' ? a.score : -Infinity;
    const sb = typeof b.score === 'number' ? b.score : -Infinity;
    if (sb !== sa) return sb - sa;
    return (a.position ?? 0) - (b.position ?? 0);
  });
}

function renderTable() {
  const rows = filteredRows();
  const shown = rows.slice(0, tableLimit);
  const body = $('#table-body');
  body.innerHTML = '';

  // Куди б вклинився мій бал
  let myInserted = false;
  // Нумеруємо самі, за балом: у номерах сайту свіжі заяви стоять у кінці.
  let n = 0;

  for (const r of shown) {
    if (myScore != null && !myInserted && r.score < myScore) {
      body.append(myRow());
      myInserted = true;
    }
    const active = isActiveStatus(r.status);
    const tr = el('tr', [r.goesTo?.staysHere ? 'stays' : '', active ? '' : 'inactive'].filter(Boolean).join(' '));
    tr.append(
      el('td', 'num', String(++n)),
      el('td', null, r.name || '—'),
      el('td', 'num', fmt(r.score)),
      el('td', 'num', `${r.priority ?? '—'}${r.basis ? ` (${r.basis})` : ''}`),
      el('td', null, r.quota || ''),
    );

    const goes = el('td', 'goes');
    if (!active) {
      goes.textContent = r.status; // «Відмова» / «Скасовано» — заява вже не конкурує
    } else if (r.goesTo?.staysHere) {
      goes.textContent = r.goesTo.type === 'budget' ? '✅ бюджет тут' : 'ℹ️ контракт тут';
    } else if (r.sameAs) {
      // Друга заява тієї самої людини — місце їй дає інша.
      goes.textContent = `та сама людина, проходить за заявою №${r.sameAs}`;
      goes.classList.add('dup');
    } else if (r.goesTo) {
      const a = el('a', null, `${r.goesTo.specialtyCode || ''} ${r.goesTo.specialty || ''}`.trim());
      a.href = `?id=${(r.goesTo.url || '').replace(/\D/g, '')}`;
      a.title = `${r.goesTo.university} — відкрити цей напрям`;
      goes.append('→ ', a);
    } else {
      goes.textContent = '—';
    }
    tr.append(goes);
    body.append(tr);
  }

  $('#table-count').textContent = `— ${rows.length} ${plural(rows.length, 'заява', 'заяви', 'заяв')}`;
  $('#more-btn').classList.toggle('hidden', rows.length <= tableLimit);
}

function myRow() {
  const tr = el('tr', 'me');
  tr.append(
    el('td', 'num', '—'),
    el('td', null, '⬅ ТИ'),
    el('td', 'num', fmt(myScore)),
    el('td', 'num', '—'),
    el('td', null, ''),
    el('td', 'goes', 'твоє місце за балом'),
  );
  return tr;
}

function plural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

/* ══════════ Вибір спеціальності ══════════ */

let pickCache = [];

/** Запит, який не мовчить: будь-яка невдача перетворюється на зрозумілий текст. */
async function getList(url) {
  let res;
  try {
    res = await fetch(url);
  } catch {
    throw new Error('Сервер не відповідає. Він ще працює у чорному вікні?');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error((data && data.error) || `Помилка ${res.status}`);
  if (!Array.isArray(data)) throw new Error((data && data.error) || 'Несподівана відповідь сервера.');
  if (!data.length) throw new Error('Сайт повернув порожній перелік. Спробуй ще раз за хвилину.');
  return data;
}

/** Показує помилку прямо в блоці вибору, а не тільки в консолі. */
function pickError(message) {
  const box = $('#pick-list');
  box.innerHTML = '';
  const n = el('div', 'pick-error');
  n.append(el('strong', null, 'Не вдалося завантажити перелік. '), document.createTextNode(message));
  box.append(n);
}

function fillSelect(sel, items, placeholder) {
  sel.innerHTML = '';
  const first = el('option', null, placeholder);
  first.value = '';
  sel.append(first);
  for (const it of items) {
    const o = el('option', null, it.name);
    o.value = it.id;
    sel.append(o);
  }
}

async function loadRegions() {
  const sel = $('#pick-region');
  if (sel.dataset.loaded === '1') return;

  fillSelect(sel, [], 'завантажую…');
  try {
    const list = await getList(api('/api/regions'));
    fillSelect(sel, list, 'обери область');
    sel.dataset.loaded = '1';
    $('#pick-list').innerHTML = '';
  } catch (err) {
    fillSelect(sel, [], '— не завантажилось —');
    pickError(err.message);
  }
}

async function loadUniversities(regionId) {
  const sel = $('#pick-univer');
  fillSelect(sel, [], 'завантажую…');
  try {
    const list = await getList(api('/api/universities', { region: regionId }));
    fillSelect(sel, list, 'обери заклад');
    $('#pick-list').innerHTML = '';
  } catch (err) {
    fillSelect(sel, [], '— не завантажилось —');
    pickError(err.message);
  }
}

async function loadDirections(univerId) {
  const box = $('#pick-list');
  box.innerHTML = '<p class="pick-empty">Завантажую перелік спеціальностей…</p>';
  const level = $('#pick-level').value;
  const url = api('/api/directions', level ? { univer: univerId, level } : { univer: univerId });
  try {
    pickCache = await getList(url);
    $('#pick-filter').classList.remove('hidden');
    renderPickList();
  } catch (err) {
    pickCache = [];
    $('#pick-filter').classList.add('hidden');
    pickError(err.message);
  }
}

function renderPickList() {
  const box = $('#pick-list');
  const q = $('#pick-filter').value.trim().toLowerCase();
  box.innerHTML = '';

  const list = pickCache.filter((d) =>
    !q || `${d.name} ${d.program || ''} ${d.faculty || ''}`.toLowerCase().includes(q));

  if (!list.length) {
    box.append(el('p', 'pick-empty', 'Нічого не знайдено за цим фільтром.'));
    return;
  }

  // Спочатку ті, де вже є заяви — саме там є що рахувати.
  list.sort((a, b) => (b.applications || 0) - (a.applications || 0));

  for (const d of list.slice(0, 120)) {
    const btn = el('button', 'pick-item' + (d.id === currentId ? ' current' : ''));
    const left = el('div');
    left.append(el('div', 'pick-name', d.name));
    // Освітня програма — окремим рядком: часто це єдина відмінність між записами.
    if (d.program) left.append(el('div', 'pick-program', d.program));
    left.append(el('div', 'pick-meta', [d.faculty, d.level, d.duration].filter(Boolean).join(' · ')));
    btn.append(left);

    const right = el('div', 'pick-count');
    right.textContent = d.applications
      ? `${d.applications} заяв`
      : 'списку ще немає';
    btn.append(right);

    btn.addEventListener('click', () => {
      tableLimit = 60;
      load(d.id);
      $('#picker').classList.add('hidden');
      $('#picker-toggle').classList.remove('open');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    box.append(btn);
  }
}

/* ══════════ Хто попереду насправді (перерахунок за пріоритетами) ══════════ */

let lastScoreUsed = null;

// До скількох конкурентів перевіряємо без запитання. Магістерські списки
// зазвичай саме такі, а великі бакалаврські чекають на натискання кнопки.
const AUTO_PRIORITY_LIMIT = 45;

async function runPriorityCheck() {
  const btn = $('#priority-run');
  const box = $('#priority-result');
  if (lastScoreUsed == null) return;

  btn.disabled = true;
  btn.textContent = 'Перевіряю…';
  box.innerHTML = '<p class="pick-empty">Опитую сайт по одній людині. Це може зайняти хвилину…</p>';

  try {
    const res = await fetch(api('/api/priority', { id: currentId, score: lastScoreUsed }));
    const j = await res.json();
    if (!res.ok) throw new Error(j.error || 'Помилка перевірки');
    renderPriority(j);
  } catch (err) {
    box.innerHTML = '';
    const e = el('div', 'pick-error');
    e.append(el('strong', null, 'Не вдалося перевірити. '), document.createTextNode(err.message));
    box.append(e);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Перевірити ще раз';
  }
}

function renderPriority(r) {
  const box = $('#priority-result');
  box.innerHTML = '';

  const sum = el('div', 'priority-summary');
  const freed = r.positionBefore - r.positionAfter;
  const likely = r.positionAfter - (r.positionLikely ?? r.positionAfter);

  // Показуємо два числа: точне і з урахуванням ймовірних.
  const target = likely > 0 ? r.positionLikely : r.positionAfter;
  sum.append(el('div', 'priority-big', `${r.positionBefore} → ${target}`));

  const parts = [];
  if (freed) parts.push(`${freed} точно ${plural(freed, 'йде', 'йдуть', 'йдуть')} вище`);
  if (likely) parts.push(`ще ${likely} ${plural(likely, 'ймовірно піде', 'ймовірно підуть', 'ймовірно підуть')}`);
  sum.append(el('div', 'priority-cap', parts.length ? parts.join(', ') : 'ніхто з перевірених не йде вище'));
  box.append(sum);

  // Коротко: перевірено стільки-то, решта — деталі в самій таблиці.
  const bits = [`перевірено ${r.checked} із ${r.aheadTotal}`];
  if (r.notChecked) bits.push('решта — може стати ще краще');
  if (r.likelyLeaving) bits.push('«ймовірно» — оцінка за місцем у вищому пріоритеті');
  if (r.unknown) bits.push(`${r.unknown} без даних`);

  const note = el('p', 'priority-note', bits.join(' · '));
  box.append(note);

  const table = el('table', 'priority-table');
  const head = el('tr');
  for (const h of ['№', 'Абітурієнт', 'Бал', 'Пр.', 'Що з ним']) head.append(el('th', null, h));
  const thead = el('thead');
  thead.append(head);
  table.append(thead);

  const LOOK = {
    'leaves':        { row: 'p-leaves', tag: 'p-tag-go',    label: 'піде' },
    'likely-leaves': { row: 'p-likely', tag: 'p-tag-maybe', label: 'ймовірно піде' },
    'stays':         { row: '',         tag: 'p-tag-stay',  label: 'лишається' },
    'likely-stays':  { row: '',         tag: 'p-tag-stay',  label: 'радше лишається' },
    'unknown':       { row: 'p-unknown', tag: 'p-tag-q',    label: '?' },
  };

  const body = el('tbody');
  let n = 0;
  for (const d of r.details) {
    const look = LOOK[d.outcome] || LOOK.unknown;
    const tr = el('tr', look.row);
    tr.append(el('td', null, String(++n)));
    tr.append(el('td', null, d.name));
    tr.append(el('td', 'num', fmt(d.score)));
    tr.append(el('td', null, String(d.priority ?? '—')));

    const what = el('td');
    what.append(el('span', `p-tag ${look.tag}`, look.label));
    what.append(document.createTextNode(` ${d.reason}`));
    if (d.where) what.append(el('div', 'p-where', d.where));
    tr.append(what);
    body.append(tr);
  }
  table.append(body);
  box.append(table);
}

/* ══════════ Рік вступної кампанії ══════════ */

async function initYears() {
  const sel = $('#year-select');
  let years = ['2026', '2025', '2024', '2023'];
  try {
    const j = await (await fetch('/api/years')).json();
    if (Array.isArray(j.years) && j.years.length) years = j.years;
  } catch { /* лишаємо запасний перелік */ }

  sel.innerHTML = '';
  for (const y of years) {
    const o = el('option', null, y);
    o.value = y;
    sel.append(o);
  }
  sel.value = currentYear;
}

/**
 * Кожен рік має власні ID спеціальностей, тож просто підмінити рік не можна.
 * Сторінка містить посилання на себе ж у сусідній рік — ним і користуємось,
 * а якщо його немає, пропонуємо обрати спеціальність за той рік.
 */
async function switchYear(year) {
  const previousYear = currentYear;
  // 1) що вже знаємо про цю спеціальність, 2) підказка самої сторінки.
  const known = DATA ? (store.yearMap[specialtyKey(DATA.info)] || {})[year] : null;
  const link = known || (DATA?.otherYears || []).find((x) => x.year === year)?.id;

  // Рік зберігаємо лише після вдалого завантаження — інакше в пам'яті
  // осяде пара «ID + рік», якої не існує, і наступний запуск впаде.
  currentYear = year;

  if (link) {
    tableLimit = 60;
    await load(link);
    return;
  }

  // Прямого посилання немає — пробуємо той самий ID, раптом він чинний.
  $('#loader-text').textContent = `Шукаю цю спеціальність за ${year} рік…`;
  let res;
  try {
    res = await fetch(api('/api/direction', { id: currentId }));
  } catch { res = null; }

  if (res && res.ok) {
    tableLimit = 60;
    await load(currentId);
    return;
  }

  currentYear = previousYear;
  $('#loader').classList.add('hidden');
  $('#content').classList.remove('hidden');

  const n = $('#notice');
  n.innerHTML = '';
  const box = el('div', 'notice');
  box.innerHTML = `<strong>За ${year} рік ця спеціальність має інший номер.</strong> ` +
    'Сайт нумерує напрями заново щороку, а прямого посилання на цей рік тут немає. ' +
    'Обери спеціальність зі списку нижче — рік уже перемкнеться.';
  n.append(box);

  // Рік лишаємо обраним, щоб вибір нижче шукав саме за нього.
  currentYear = year;
  $('#year-select').value = year;
  $('#picker').classList.remove('hidden');
  $('#picker-toggle').classList.add('open');
  $('#pick-region').dataset.loaded = '';
  await loadRegions();
  $('#picker').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/* ══════════ Події ══════════ */

$('#year-select').addEventListener('change', (e) => switchYear(e.target.value));

$('#picker-toggle').addEventListener('click', async () => {
  const p = $('#picker');
  const open = p.classList.toggle('hidden');
  $('#picker-toggle').classList.toggle('open', !open);
  if (!open) await loadRegions();
});

$('#pick-region').addEventListener('change', (e) => {
  if (e.target.value) loadUniversities(e.target.value);
});
$('#pick-univer').addEventListener('change', (e) => {
  if (e.target.value) loadDirections(e.target.value);
});
$('#pick-level').addEventListener('change', () => {
  const u = $('#pick-univer').value;
  if (u) loadDirections(u);
});
$('#pick-filter').addEventListener('input', debounce(renderPickList, 200));

$('#id-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const raw = $('#id-input').value.trim();
  const id = (raw.match(/(\d{4,})/) || [])[1];
  if (id) { tableLimit = 60; load(id); }
});

$('#refresh-btn').addEventListener('click', () => load(currentId, true));

$('#save-btn').addEventListener('click', toggleSave);
$('#priority-run').addEventListener('click', runPriorityCheck);

$('#table-toggle').addEventListener('click', () => {
  const open = $('#table-collapse').classList.toggle('hidden');
  $('#table-toggle').querySelector('.caret').textContent = open ? '▸' : '▾';
});

$('#calc-tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  calcMode = tab.dataset.mode;
  store.mode = calcMode;
  saveStore();
  document.querySelectorAll('#calc-tabs .tab').forEach((t) => t.classList.toggle('active', t === tab));
  $('#pane-score').classList.toggle('hidden', calcMode !== 'score');
  $('#pane-subjects').classList.toggle('hidden', calcMode !== 'subjects');
  recalc();
});

$('#score-input').addEventListener('input', (e) => {
  const v = parseFloat(e.target.value);
  if (Number.isFinite(v)) store.scoreById[currentId] = v;
  else delete store.scoreById[currentId];
  saveStore();
  recalc();
});

$('#quota-select').addEventListener('change', (e) => {
  store.quota = e.target.value;
  saveStore();
  recalc();
});
$('#table-search').addEventListener('input', debounce(() => { tableLimit = 60; renderTable(); }, 200));
$('#more-btn').addEventListener('click', () => { tableLimit += 100; renderTable(); });

$('#table-filters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  tableFilter = chip.dataset.filter;
  tableLimit = 60;
  document.querySelectorAll('#table-filters .chip').forEach((c) => c.classList.toggle('active', c === chip));
  renderTable();
});

// Дозволяємо переходити між напрямами через посилання в колонці прогнозу
document.addEventListener('click', (e) => {
  const a = e.target.closest('.goes a');
  if (!a) return;
  e.preventDefault();
  const id = new URL(a.href, location.origin).searchParams.get('id');
  if (id) { tableLimit = 60; load(id); window.scrollTo({ top: 0, behavior: 'smooth' }); }
});

initYears().then(() => load(currentId));
