'use strict';

/**
 * Повний розклад напряму: хто з поданих реально його займе.
 *
 * Це не «моє місце», а картина цілком — для кожного абітурієнта видно, чи він
 * лишається тут, чи піде на свій вищий пріоритет, і хто в підсумку опиняється
 * в межах бюджетних місць.
 *
 * Джерел два:
 *   1) симуляція сайту — там уже пораховано все, тож беремо готове й миттєво;
 *   2) власний обхід за пріоритетами — коли симуляції немає (магістратура).
 *
 * Другий шлях має глибину в один крок: ми бачимо, чи конкурент проходить на
 * свій вищий пріоритет, але не опитуємо вже тамтешніх людей. Тому результат —
 * не число, а вилка: скільки піде напевно і скільки — якщо вище звільняться
 * місця. Відтворити справжній широкий конкурс, маючи дані одного напряму,
 * неможливо в принципі.
 */

const R = require('./rank.js');
const S = require('./statements.js');
const P = require('./priority.js');

const byScoreDesc = (a, b) => b.score - a.score;

/** Вердикти, за яких людина звідси йде. */
const GONE = new Set(['leaves', 'likely-leaves']);
/** Піде лише за сприятливого збігу — друга межа вилки. */
const MAYBE_GONE = new Set(['maybe-leaves']);

/** Скільки бюджетних місць лишається на загальний конкурс, поза квотами. */
function openSeats(info) {
  const budget = info.budgetMax ?? 0;
  const reserved = (info.quota1 ?? 0) + (info.quota2 ?? 0);
  return Math.max(0, budget - reserved) || budget;
}

/**
 * Розклад із готової симуляції сайту. Мережа не потрібна: у кожному рядку
 * вже написано, куди людина йде за своїми пріоритетами.
 */
function fromSimulation(data) {
  const sim = R.simulationSets(data);
  const staysHere = new Set();
  for (const r of data.simulationRows || []) {
    if (r.simulation && r.simulation.staysHere) staysHere.add(r.position);
  }

  const budget = sim.budgetOpen.map((r, i) => ({
    place: i + 1,
    name: r.name,
    score: r.score,
    priority: r.priority,
    quota: r.quota || null,
    outcome: 'stays',
    reason: 'за симуляцією сайту лишається тут',
  }));

  const leaving = (data.rows || [])
    .filter((r) => r.simulation && !r.simulation.staysHere)
    .sort(byScoreDesc)
    .map((r) => ({
      name: r.name,
      score: r.score,
      priority: r.priority,
      quota: r.quota || null,
      outcome: 'leaves',
      reason: 'за симуляцією йде на вищий пріоритет',
      where: [r.simulation.university, r.simulation.specialty].filter(Boolean).join(' · '),
    }));

  return {
    source: 'simulation',
    exact: true,
    seats: sim.budgetOpen.length,
    checked: (data.rows || []).length,
    total: (data.rows || []).length,
    notChecked: 0,
    cutoff: budget.length ? budget[budget.length - 1].score : null,
    cutoffBest: null,
    budget,
    leaving,
    quotaTaken: sim.budgetQuota.length,
  };
}

/**
 * Розклад власним обходом: опитуємо кожного за пріоритетами й перескладаємо
 * список із тих, хто лишається. `limit` рятує від нескінченного очікування
 * на великих бакалаврських напрямах.
 */
async function byPriorities(data, { limit = 100, onProgress = null } = {}) {
  const people = R.budgetApplications(data.rows || []).sort(byScoreDesc);
  const checked = people.slice(0, limit);
  const allow = P.directionBudget();
  const verdicts = new Map();

  for (let i = 0; i < checked.length; i++) {
    const row = checked[i];
    if (onProgress) onProgress(i + 1, checked.length);

    let verdict;
    try {
      verdict = await P.verdictFor(row, await S.findPerson(row.name, data.year), data.info.level,
        { year: data.year, allow });
    } catch (err) {
      verdict = { outcome: 'unknown', reason: `не вдалося перевірити (${err.message})` };
    }
    verdicts.set(row.name, verdict);
  }

  // Кого не встигли опитати — вважаємо таким, що лишається. Це обережніше:
  // прохідний вийде радше завищеним, ніж заниженим.
  const fateOf = (r) => verdicts.get(r.name)
    || { outcome: 'unchecked', reason: 'не перевіряли — далеко від межі' };

  const seats = openSeats(data.info);
  const rows = people.map((r) => ({
    name: r.name,
    score: r.score,
    priority: r.priority,
    quota: r.quota || null,
    ...fateOf(r),
  }));

  // Квотники займають свої місця окремо й у загальному конкурсі не заважають.
  const contenders = rows.filter((r) => !r.quota);

  const build = (goneSet) => contenders
    .filter((r) => !goneSet.has(r.outcome))
    .slice(0, seats);

  // Песимістична межа: йдуть лише ті, за кого є розрахунок.
  const budget = build(GONE).map((r, i) => ({ place: i + 1, ...r }));
  // Оптимістична: додатково йдуть ті, кому бракує лише звільнених місць вище.
  const budgetBest = build(new Set([...GONE, ...MAYBE_GONE]));

  const last = (list) => (list.length ? list[list.length - 1].score : null);

  return {
    source: 'priorities',
    exact: false,
    seats,
    checked: checked.length,
    total: people.length,
    notChecked: people.length - checked.length,
    cutoff: last(budget),
    // Друга межа вилки — прохідний, якщо вище теж звільняться місця.
    cutoffBest: last(budgetBest),
    budget,
    leaving: rows.filter((r) => GONE.has(r.outcome) || MAYBE_GONE.has(r.outcome)),
    quotaTaken: rows.filter((r) => r.quota).length,
  };
}

/**
 * Розклад минулого року. Тут нічого прогнозувати не треба: у статусі кожної
 * заяви записано, чим усе скінчилось. Це не оцінка, а факт.
 */
function fromActual(data, sets) {
  const budget = sets.budgetOpen.map((r, i) => ({
    place: i + 1,
    name: r.name,
    score: r.score,
    priority: r.priority,
    quota: r.quota || null,
    outcome: 'stays',
    reason: r.status || 'пройшов на бюджет',
  }));

  return {
    source: 'actual',
    exact: true,
    seats: budget.length,
    checked: (data.rows || []).length,
    total: (data.rows || []).length,
    notChecked: 0,
    cutoff: budget.length ? budget[budget.length - 1].score : null,
    cutoffBest: null,
    budget,
    leaving: [],
    quotaTaken: sets.budgetQuota.length,
  };
}

/** Повний розклад напряму — найточнішим доступним способом. */
async function forecast(data, opts = {}) {
  // 1) Симуляція сайту — готовий розрахунок, мережа не потрібна.
  if ((data.simulationRows || []).length) return fromSimulation(data);

  // 2) Минулий рік — справжній результат зі статусів заяв.
  const sets = R.simulationSets(data);
  if (sets.source === 'actual') return fromActual(data, sets);

  // 3) Інакше рахуємо самі, обходом за пріоритетами.
  return byPriorities(data, opts);
}

module.exports = { forecast, fromSimulation, fromActual, byPriorities, openSeats };
