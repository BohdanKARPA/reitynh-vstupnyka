'use strict';

/**
 * Розрахунок місця в рейтингу та прогнозу вступу на бюджет.
 *
 * Важливо: справжній розподіл в Україні — це широкий конкурс з адаптивним
 * розміщенням одразу по всіх заявах абітурієнта. Маючи дані лише одного
 * напряму, точно його відтворити неможливо. Тому тут дві оцінки:
 *   1) сира позиція за конкурсним балом серед усіх заяв;
 *   2) позиція серед тих, кого симуляція сайту реально лишає на цьому напрямі
 *      (це набагато ближче до дійсності, бо враховує відтік на вищі пріоритети).
 */

const BUDGET = 'budget';
const CONTRACT = 'contract';

/**
 * Заява ще бере участь у конкурсі.
 *
 * Статуси змінюються по ходу кампанії: «Допущено» на початку, потім
 * «Рекомендовано (б)», «До наказу (б)». Тому перелічуємо не тих, хто в грі,
 * а тих, хто з неї вибув: відмовився, скасував, був відхилений або
 * деактивований (зарахувався деінде чи не отримав рекомендації).
 */
const isActive = (r) => !/Відмова|Скасовано|Деактивовано|Відхилено/i.test(r.status || '');

/**
 * У списках минулих років симуляції немає — натомість є справжній результат
 * у статусі заяви: «До наказу (б)» означає, що людина пройшла сюди на бюджет.
 * Це дає не прогноз, а фактичний прохідний бал того року.
 */
const wonBudget = (r) => /До наказу \(б\)|Зараховано \(б\)|Рекомендовано \(б\)/i.test(r.status || '');
const wonContract = (r) => /До наказу \(к\)|Зараховано \(к\)|Рекомендовано \(к\)/i.test(r.status || '');

/**
 * Одна людина може подати кілька заяв на той самий напрям (різні пріоритети,
 * бюджет + контракт), і всі вони видно окремими рядками. Для рейтингу
 * потрібні люди, а не заяви, — інакше конкуренція виглядає вдвічі більшою.
 */
function uniquePeople(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!r.name) continue;
    const prev = seen.get(r.name);
    // Лишаємо заяву на бюджет — вона визначає участь у конкурсі на держзамовлення.
    if (!prev || (prev.basis !== 'Б' && r.basis === 'Б')) seen.set(r.name, r);
  }
  return [...seen.values()];
}

/** Реальні конкуренти: активні заяви, по одній на людину. */
const competitors = (rows) => uniquePeople(rows.filter(isActive));

/** Заяви, подані на бюджет (а не лише на контракт). */
const budgetApplications = (rows) => competitors(rows).filter((r) => r.basis === 'Б');

const byScoreDesc = (a, b) => b.score - a.score;

/** Скільки заяв мають бал строго вищий за даний. */
function countAbove(rows, score) {
  let n = 0;
  for (const r of rows) if (r.score > score) n++;
  return n;
}

function countEqual(rows, score) {
  let n = 0;
  for (const r of rows) if (r.score === score) n++;
  return n;
}

/** Позиція, яку посів би бал `score` у списку `rows`. */
function placeIn(rows, score) {
  const above = countAbove(rows, score);
  const equal = countEqual(rows, score);
  return {
    position: above + 1,
    total: rows.length,
    ahead: above,
    tied: equal,
    // За однакового балу місце визначають додаткові критерії — звідси діапазон.
    positionWorstCase: above + equal + 1,
  };
}

/**
 * Витягує зі списку симуляції тих, хто отримує тут бюджет / контракт.
 *
 * Квотники йдуть окремо: місця за квотами зарезервовані, тому вступник без
 * квоти конкурує лише за решту місць і лише з такими самими неквотниками.
 * Саме тому сайт окремо показує «мін. бал без квот».
 */
function simulationSets(data) {
  const rows = data.simulationRows || [];
  let budget = rows.filter((r) => r.simulation && r.simulation.type === BUDGET).sort(byScoreDesc);
  let contract = rows.filter((r) => r.simulation && r.simulation.type === CONTRACT).sort(byScoreDesc);
  let source = 'simulation';

  // Немає симуляції — пробуємо взяти справжній результат зі статусів (минулі роки).
  if (!budget.length) {
    const actualBudget = (data.rows || []).filter(wonBudget).sort(byScoreDesc);
    if (actualBudget.length) {
      budget = actualBudget;
      contract = (data.rows || []).filter(wonContract).sort(byScoreDesc);
      source = 'actual';
    } else {
      source = 'none'; // ні прогнозу, ні результату — лишається рейтинг за балом
    }
  }

  return {
    source,
    budget,
    contract,
    budgetOpen: budget.filter((r) => !r.quota),
    budgetQuota: budget.filter((r) => r.quota),
    contractOpen: contract.filter((r) => !r.quota),
  };
}

/**
 * Прохідний бал — бал того, хто займає останнє доступне місце.
 * Якщо охочих менше, ніж місць, конкурсу фактично немає.
 */
function cutoffAt(rows, places) {
  if (!rows.length || !places) return null;
  if (rows.length < places) return rows[rows.length - 1].score;
  return rows[places - 1].score;
}

/** Кілька сусідів зверху й знизу від позиції, яку посів би бал. */
function neighbours(rows, score, span = 3) {
  const sorted = [...rows].sort(byScoreDesc);
  const idx = sorted.findIndex((r) => r.score <= score);
  const at = idx < 0 ? sorted.length : idx;
  return {
    above: sorted.slice(Math.max(0, at - span), at),
    below: sorted.slice(at, at + span),
  };
}

/**
 * Головна функція: що буде з абітурієнтом із конкурсним балом `score`.
 * `quota` — 'Квота-1' / 'Квота-2' або null для загального конкурсу.
 */
function evaluate(data, score, { quota = null } = {}) {
  const all = competitors(data.rows || []);
  const budgetApps = budgetApplications(data.rows || []);
  const sim = simulationSets(data);

  const budgetTotal = data.simulation.budgetCount ?? data.info.budgetMax ?? 0;
  const contractTotal = data.simulation.contractCount ?? data.info.contractPlaces ?? 0;

  const overall = placeIn(all, score);
  const amongBudgetApps = placeIn(budgetApps, score);

  // Пул суперників і кількість місць, за які реально йде боротьба.
  const hasQuota = Boolean(quota);
  // Симуляція є не завжди (зокрема на магістратурі). Тоді рахуємо простіше:
  // рейтинг за балом серед активних заяв на бюджет проти заявленого обсягу місць.
  const hasSimulation = sim.budget.length > 0;

  let rivals, budgetPlaces;
  if (!hasSimulation) {
    rivals = hasQuota
      ? budgetApps.filter((r) => r.quota === quota)
      : budgetApps.filter((r) => !r.quota);
    budgetPlaces = hasQuota
      ? (quota === 'Квота-2' ? data.info.quota2 : data.info.quota1) ?? 0
      : (data.info.budgetMax ?? 0) - ((data.info.quota1 ?? 0) + (data.info.quota2 ?? 0));
    if (budgetPlaces <= 0) budgetPlaces = data.info.budgetMax ?? 0;
  } else if (hasQuota) {
    rivals = sim.budgetQuota.filter((r) => r.quota === quota);
    budgetPlaces = (quota === 'Квота-2' ? data.info.quota2 : data.info.quota1) ?? rivals.length;
  } else {
    rivals = sim.budgetOpen;
    budgetPlaces = sim.budgetOpen.length;
  }
  rivals = [...rivals].sort(byScoreDesc);

  const contractRivals = hasSimulation
    ? sim.contractOpen
    : [...competitors(data.rows || [])].sort(byScoreDesc);

  const budgetRace = placeIn(rivals, score);
  const contractRace = placeIn(contractRivals, score);

  const budgetMin = cutoffAt(rivals, budgetPlaces);
  const contractMin = cutoffAt(contractRivals, contractTotal) ?? data.simulation.contractMinScore;
  const margin = budgetMin != null ? +(score - budgetMin).toFixed(3) : null;

  // Проходить, якщо витісняє когось із поточного набору на бюджет.
  const passesBudget = budgetPlaces > 0 && budgetRace.position <= budgetPlaces;
  const passesWorstCase = budgetPlaces > 0 && budgetRace.positionWorstCase <= budgetPlaces;
  const passesContract = contractTotal > 0 && contractRace.position <= contractTotal;

  // Незаповнені місця (буває за квотами) — тоді нікого витісняти не треба.
  const spareSeats = Math.max(0, budgetPlaces - rivals.length);

  let verdict;
  if (passesBudget && spareSeats > 0) verdict = 'budget-safe';
  else if (passesBudget && passesWorstCase && margin != null && margin >= 5) verdict = 'budget-safe';
  else if (passesBudget && !passesWorstCase) verdict = 'budget-tie';
  else if (passesBudget) verdict = 'budget-edge';
  else if (margin != null && margin > -5) verdict = 'budget-close';
  else if (passesContract) verdict = 'contract';
  else verdict = 'out';

  return {
    score,
    quota: quota || null,
    verdict,
    // 'simulation' — прогноз сайту з урахуванням відтоку на вищі пріоритети;
    // 'actual'     — справжній результат того року (зі статусів заяв);
    // 'raw'        — простий рейтинг за балом, коли нема ні того, ні того.
    method: hasSimulation ? sim.source : 'raw',
    rivalCount: rivals.length,
    margin,
    budgetMinScore: budgetMin,
    contractMinScore: contractMin,
    budgetPlaces,
    budgetTotal,
    spareSeats,
    quotaPlacesTaken: sim.budgetQuota.length,
    contractPlaces: contractTotal,
    overall,
    amongBudgetApps,
    budgetRace,
    contractRace,
    // Скільки балів бракує до прохідного (0, якщо вже проходить).
    scoreGap: margin != null && margin < 0 ? +Math.abs(margin).toFixed(3) : 0,
    neighbours: neighbours(rivals, score),
  };
}

/** Пошук заяв за частиною прізвища або номером. */
function search(data, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  // Зіставляємо за номером позиції: у симульованому списку та сама нумерація,
  // і в ньому лежить рівно та заява людини, яка дає їй місце.
  const simByPosition = new Map();
  const winnerPosition = new Map();
  for (const r of data.simulationRows || []) {
    simByPosition.set(r.position, r.simulation);
    if (r.name) winnerPosition.set(r.name, r.position);
  }

  return (data.rows || [])
    .filter((r) => r.name && r.name.toLowerCase().includes(q))
    .map((r) => {
      const winning = simByPosition.get(r.position) || null;
      const winsAt = winnerPosition.get(r.name);
      return {
        ...r,
        // Прогноз саме для цієї заяви (а не просто для людини).
        simulationHere: winning,
        sameAs: !winning && winsAt != null && winsAt !== r.position ? winsAt : null,
        evaluation: evaluate(data, r.score),
      };
    });
}

/**
 * Конкурсний бал за формулою: сума (бал предмета × ваговий коефіцієнт),
 * поділена на суму коефіцієнтів.
 */
function competitiveScore(entries) {
  let weighted = 0, weights = 0;
  for (const e of entries) {
    if (e.score == null || e.k == null) continue;
    weighted += e.score * e.k;
    weights += e.k;
  }
  if (weights === 0) return null;
  return +(weighted / weights).toFixed(3);
}

/** Розподіл балів для гістограми. */
function histogram(rows, buckets = 24) {
  const scores = rows.map((r) => r.score).filter((s) => s != null);
  if (!scores.length) return { bins: [], min: 0, max: 0 };
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const width = (max - min) / buckets || 1;
  const bins = Array.from({ length: buckets }, (_, i) => ({
    from: +(min + i * width).toFixed(1),
    to: +(min + (i + 1) * width).toFixed(1),
    count: 0,
  }));
  for (const s of scores) {
    const i = Math.min(buckets - 1, Math.floor((s - min) / width));
    bins[i].count++;
  }
  return { bins, min, max };
}

module.exports = {
  wonBudget,
  wonContract,
  evaluate,
  search,
  competitiveScore,
  histogram,
  placeIn,
  simulationSets,
  budgetApplications,
  competitors,
  isActive,
};
