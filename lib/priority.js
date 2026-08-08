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
function verdictFor(row, allStatements, level) {
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
      reason: `проходить за пріоритетом ${wonHigher.priority}`,
      where: [wonHigher.university, wonHigher.specialty].filter(Boolean).join(' · '),
      status: wonHigher.status,
    };
  }

  // Заява тут виграла — людина точно лишається.
  const here = statements.find((s) => s.priority === row.priority && S.isWinning(s.status));
  if (here) {
    return { outcome: 'stays', reason: 'проходить саме сюди', status: here.status };
  }

  if (!higher.length) {
    return { outcome: 'stays', reason: 'це його найвищий пріоритет' };
  }

  const allClosed = higher.every((s) => /Деактивовано|Відмова|Скасовано|Відхилено/i.test(s.status || ''));
  if (allClosed) {
    return { outcome: 'stays', reason: 'вищі пріоритети вже відпали' };
  }

  return { outcome: 'unknown', reason: 'вищі пріоритети ще без результату' };
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
  let leaving = 0, unknown = 0;

  for (let i = 0; i < checked.length; i++) {
    const row = checked[i];
    if (onProgress) onProgress(i + 1, checked.length);

    let verdict;
    try {
      verdict = verdictFor(row, await S.findPerson(row.name, data.year), data.info.level);
    } catch (err) {
      verdict = { outcome: 'unknown', reason: `не вдалося перевірити (${err.message})` };
    }

    if (verdict.outcome === 'leaves') leaving++;
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
    unknown,
    // Місце в черзі: усі попереду мінус ті, хто піде на вищий пріоритет.
    positionBefore: people.length + 1,
    positionAfter: people.length - leaving + 1,
    details,
  };
}

module.exports = { simulate, competitorsAbove, verdictFor };
