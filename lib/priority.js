/**
 * Хто насправді займе місце на цій спеціальності.
 *
 * У списку видно пріоритет заяви, але не видно долі людини. Якщо заява має
 * пріоритет 3, а людина проходить за пріоритетом 1 деінде — вона піде туди,
 * і місце тут звільниться. Саме через це реальний прохідний бал нижчий за той,
 * що видно «в лоб» за списком.
 *
 * Тут ми для кожного конкурента вище за тебе дивимось усі його заяви й
 * питаємо: чи є серед них та, що дає йому місце за вищим пріоритетом?
 */

const S = require('./statements.js');
const R = require('./rank.js');
const { fetchDirection } = require('./fetcher.js');

// Скільки різних напрямів дозволено підняти за один перерахунок. Кожен —
// це кілька сторінок із сайту, тож ставимо стелю. Популярні напрями
// повторюються в багатьох конкурентів і беруться з кешу безкоштовно.
const MAX_DIRECTIONS = 25;

/** Лічильник піднятих напрямів: той самий ID вільний, новий — доки є ліміт. */
function directionBudget(max = MAX_DIRECTIONS) {
  const seen = new Set();
  return (id) => {
    if (seen.has(id)) return true;
    if (seen.size >= max) return false;
    seen.add(id);
    return true;
  };
}

/**
 * Яке місце людина посідає на спеціальності свого вищого пріоритету.
 *
 * Номер зі сторінки пошуку для цього не годиться: сайт ставить свіжі заяви
 * («Заява надійшла з сайту») в кінець списку незалежно від балу, і рахує
 * туди ж контрактників, відмови та дублі. Тому беремо рейтинговий список
 * того напряму й рахуємо місце за балом — тими самими правилами, що й тут.
 */
async function rankAtDirection(statement, fallbackYear, allow) {
  const id = statement.directionId;
  if (!id || statement.score == null || !allow(id)) return null;

  const data = await fetchDirection(id, { year: statement.directionYear || fallbackYear });
  // Списку ще немає (так буває на магістратурі) — рахувати нема з чого.
  if (!(data.rows || []).length) return null;

  const ev = R.evaluate(data, statement.score, { quota: statement.quota || null });
  if (!ev.budgetPlaces) return null;

  return {
    position: ev.budgetRace.position,
    places: ev.budgetPlaces,
    cutoff: ev.budgetMinScore,
    method: ev.method,
    exact: true,
  };
}

/** Заяви вище за твій бал, які зараз стоять попереду в черзі за бюджет. */
function competitorsAbove(rows, score) {
  return rows
    .filter((r) => r.basis === 'Б' && typeof r.score === 'number' && r.score > score)
    .filter((r) => !/Відмова|Скасовано|Відхилено/i.test(r.status || ''))
    .sort((a, b) => b.score - a.score);
}

/**
 * Доля однієї заяви: чи людина залишиться тут, чи піде на вищий пріоритет.
 * Рішення приймається лише за фактами; де фактів немає — так і кажемо.
 */
async function verdictFor(row, allStatements, level, { year = null, allow = () => false } = {}) {
  const statements = S.samePerson(allStatements, row, level);

  // Жодна заява не збіглася за балами предметів — це були однофамільці.
  if (!statements.length) {
    return { outcome: 'unknown', reason: 'не вдалося певно розпізнати серед однофамільців' };
  }

  // Заяви цієї ж людини з вищим пріоритетом (менший номер).
  const higher = statements.filter((s) => s.priority != null && row.priority != null
    && s.priority < row.priority);

  const wonHigher = higher.find((s) => S.isWinning(s.status));
  if (wonHigher) {
    return {
      outcome: 'leaves',
      reason: `пр. ${wonHigher.priority} — вже рекомендований`,
      where: [wonHigher.university, wonHigher.specialty].filter(Boolean).join(' · '),
      status: wonHigher.status,
    };
  }

  // Заява тут виграла — людина точно лишається.
  const here = statements.find((s) => s.priority === row.priority && S.isWinning(s.status));
  if (here) {
    return { outcome: 'stays', reason: 'рекомендований сюди', status: here.status };
  }

  if (!higher.length) {
    return { outcome: 'stays', reason: 'це його 1-й пріоритет' };
  }

  const closed = (s) => /Деактивовано|Відмова|Скасовано|Відхилено/i.test(s.status || '');
  if (higher.every(closed)) {
    return { outcome: 'stays', reason: 'вищі пріоритети відпали' };
  }

  // Результатів ще немає (так буває до оприлюднення рекомендацій). Тоді
  // дивимось, яке місце людина посідає у списку свого вищого пріоритету.
  const live = higher.filter((s) => !closed(s));

  // Заява на спеціальність без держзамовлення нікого звідси не забере:
  // пріоритети розподіляють саме бюджетні місця.
  // Найвищий пріоритет першим: якщо людина проходить одразу в кількох місцях,
  // піде вона саме туди, і саме це місце має бути в поясненні.
  const threats = live
    .filter((s) => s.places && s.places.budgetMax > 0)
    .sort((a, b) => a.priority - b.priority);
  if (!threats.length) {
    return {
      outcome: 'likely-stays',
      reason: live.length ? 'вище лише контракт' : 'вищі пріоритети відпали',
    };
  }

  // Для кожної такої заяви з'ясовуємо місце за балом у тому списку.
  // Якщо напрям підняти не вдалося — лишається грубий номер зі сторінки
  // пошуку; він ненадійний, тому й позначається окремо (exact: false).
  const graded = [];
  for (const s of threats) {
    let place = null;
    try {
      place = await rankAtDirection(s, year, allow);
    } catch { /* напрям недоступний — нижче візьмемо запасний варіант */ }

    if (!place && s.position && s.places.budgetMax) {
      place = { position: s.position, places: s.places.budgetMax, exact: false };
    }
    if (place) graded.push({ s, place });
  }

  const at = (g) => `${g.place.position}-й із ${g.place.places} місць` + (g.place.exact ? ' за балом' : '');
  const where = (g) => [g.s.university, g.s.specialty].filter(Boolean).join(' · ');

  const winner = graded.find((g) => g.place.position <= g.place.places);
  if (winner) {
    return {
      outcome: 'likely-leaves',
      reason: `пр. ${winner.s.priority} — ${at(winner)}`,
      where: where(winner),
      status: winner.s.status,
      cutoff: winner.place.cutoff ?? null,
    };
  }

  if (graded.length === threats.length) {
    const best = graded.reduce((a, b) => (a.place.position <= b.place.position ? a : b));
    return {
      outcome: 'likely-stays',
      reason: `вище ${at(best)} — не вміщається`,
      where: where(best),
      cutoff: best.place.cutoff ?? null,
    };
  }

  return { outcome: 'unknown', reason: 'вищі пріоритети без результату' };
}

/**
 * Перерахунок місця з урахуванням пріоритетів.
 * `limit` обмежує кількість пошуків: сайт їх обмежує, тож беремо найближчих.
 */
async function simulate(data, score, { limit = 60, onProgress = null } = {}) {
  const above = competitorsAbove(data.rows || [], score);

  // Одна людина може мати тут кілька заяв — питаємо про неї один раз.
  const byName = new Map();
  for (const r of above) {
    if (!r.name) continue;
    if (!byName.has(r.name)) byName.set(r.name, r);
  }

  const people = [...byName.values()];
  const checked = people.slice(0, limit);
  const details = [];
  let leaving = 0, likelyLeaving = 0, unknown = 0;

  // Стеля на піднятi напрями спільна для всього перерахунку, а не для кожного
  // конкурента окремо — інакше ліміт не мав би сенсу.
  const allow = directionBudget();

  for (let i = 0; i < checked.length; i++) {
    const row = checked[i];
    if (onProgress) onProgress(i + 1, checked.length);

    let verdict;
    try {
      verdict = await verdictFor(row, await S.findPerson(row.name, data.year), data.info.level,
        { year: data.year, allow });
    } catch (err) {
      verdict = { outcome: 'unknown', reason: `не вдалося перевірити (${err.message})` };
    }

    if (verdict.outcome === 'leaves') leaving++;
    if (verdict.outcome === 'likely-leaves') likelyLeaving++;
    if (verdict.outcome === 'unknown') unknown++;

    details.push({
      position: row.position,
      name: row.name,
      score: row.score,
      priority: row.priority,
      quota: row.quota,
      status: row.status,
      ...verdict,
    });
  }

  const notChecked = people.length - checked.length;

  return {
    score,
    // Скільки людей стоїть попереду тебе за балом (унікальних).
    aheadTotal: people.length,
    checked: checked.length,
    notChecked,
    leaving,
    likelyLeaving,
    unknown,
    // Місце в черзі: усі попереду мінус ті, хто піде на вищий пріоритет.
    // Підтверджені й ймовірні рахуємо окремо — це різна певність.
    positionBefore: people.length + 1,
    positionAfter: people.length - leaving + 1,
    positionLikely: people.length - leaving - likelyLeaving + 1,
    details,
  };
}

module.exports = { simulate, competitorsAbove, verdictFor, rankAtDirection, directionBudget };
