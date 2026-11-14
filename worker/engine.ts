import { Canteen, active, type Detail, type RequestBudget } from './canteen';
import { categorizeMenu } from './categories';
import {
  MEALS,
  addDays,
  defaults,
  emptyMeals,
  isDate,
  mondayFor,
  nowShanghai,
  type AIOrderResult,
  type Dish,
  type Env,
  type FoodCategory,
  type Meal,
  type MealMap,
  type OrderDay,
  type Settings,
} from './types';

type DBRow = { value: string };
export async function getSettings(db: D1Database): Promise<Settings> {
  const row = await db.prepare('SELECT value FROM settings WHERE id = 1').first<DBRow>();
  return row ? { ...defaults(), ...JSON.parse(row.value) } : defaults();
}
export function cleanSettings(input: any): Settings {
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.scheduleEnabled !== 'boolean' ||
    typeof input.autoSubmit !== 'boolean' ||
    typeof input.requirements !== 'string' ||
    input.requirements.length > 5000
  )
    throw new Error('Invalid settings');
  const days: Record<string, string> = {},
    exceptions: Record<string, string> = {};
  for (const [key, val] of Object.entries(input.days || {})) {
    if (!/^(?:[1-9]|1[0-4])$/.test(key) || typeof val !== 'string' || !/^[bls]*$/.test(val))
      throw new Error('Invalid meal schedule');
    days[key] = [...new Set(val)].join('');
  }
  for (const [key, val] of Object.entries(input.exceptions || {})) {
    if (!isDate(key) || typeof val !== 'string' || !/^[bls]*$/.test(val))
      throw new Error('Invalid date exception');
    exceptions[key] = [...new Set(val)].join('');
  }
  return {
    scheduleEnabled: input.scheduleEnabled,
    autoSubmit: input.autoSubmit,
    requirements: input.requirements,
    days,
    exceptions,
  };
}
export async function saveSettings(db: D1Database, settings: Settings) {
  await db
    .prepare(
      'INSERT INTO settings (id,value) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value',
    )
    .bind(JSON.stringify(cleanSettings(settings)))
    .run();
}
async function readPending(db: D1Database, week: string): Promise<OrderDay[] | null> {
  const row = await db
    .prepare('SELECT value FROM pending_orders WHERE week_start=?')
    .bind(week)
    .first<DBRow>();
  return row ? JSON.parse(row.value) : null;
}
export async function getPending(db: D1Database, week: string): Promise<OrderDay[]> {
  if (!isDate(week)) throw new Error('Invalid week');
  const days = await readPending(db, week);
  if (!days) throw new Error('Pending order not found');
  return days;
}
export async function savePending(db: D1Database, week: string, days: OrderDay[]) {
  await db
    .prepare(
      'INSERT INTO pending_orders VALUES (?,?,?) ON CONFLICT(week_start) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
    )
    .bind(week, JSON.stringify(days), new Date().toISOString())
    .run();
}
export async function rememberOrderedDays(db: D1Database, dates: Iterable<string>) {
  const writes = [...new Set(dates)].map((date) =>
    db.prepare('INSERT OR IGNORE INTO ordered_days (date) VALUES (?)').bind(date),
  );
  if (writes.length) await db.batch(writes);
}
export async function job(db: D1Database, kind: string, status: string, message: string) {
  await db
    .prepare('INSERT INTO jobs (created_at,kind,status,message) VALUES (?,?,?,?)')
    .bind(new Date().toISOString(), kind, status, message.slice(0, 1000))
    .run();
}
const mealChars = ['b', 'l', 's'];
function mealSchedule(settings: Settings, week: 'current' | 'next', today?: string) {
  const monday = mondayFor(week, today);
  const offset = week === 'next' ? 7 : 0;
  const selections = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(monday, i);
    return {
      date,
      meals: settings.exceptions[date] ?? settings.days[String(i + 1 + offset)] ?? '',
    };
  });
  return { monday, selections };
}

function canonicalMenu(menu: MealMap, allowed: string): MealMap {
  const out = emptyMeals();
  MEALS.forEach((m, i) => {
    out[m] = allowed.includes(mealChars[i]) ? menu[m] : [];
  });
  return out;
}
export function validateSelection(menu: MealMap, selection: any): MealMap {
  const result = emptyMeals();
  for (const m of MEALS) {
    const items = selection?.[m] ?? [];
    if (!Array.isArray(items) || items.length > 100) throw new Error('Invalid meal selection');
    for (const item of items) {
      const found = menu[m].find((d) => String(d.id) === String(item?.id));
      if (!found) throw new Error(`Dish is unavailable: ${String(item?.name || item?.id || '')}`);
      result[m].push(found);
    }
  }
  return result;
}
const reservationLookbackDays = 7;
interface RecentDish {
  date: string;
  meal: Meal;
  name: string;
  status: 'reserved' | 'submitted' | 'draft';
}

function reservationContext(records: Detail[]): RecentDish[] {
  return records.filter(active).flatMap((record) => {
    const meal = MEALS[Number(record.ORDERTYPE)];
    return meal && isDate(record.ORDERDATE) && typeof record.DISHESNAME === 'string'
      ? [{ date: record.ORDERDATE, meal, name: record.DISHESNAME, status: 'reserved' as const }]
      : [];
  });
}

class InvalidDeepSeekResponse extends Error {}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function chooseMenus(
  env: Env,
  days: OrderDay[],
  requirements: string,
  recentDishes: RecentDish[],
  {
    timeout = 120_000,
    budget,
    requireSelection = false,
  }: {
    timeout?: number;
    budget?: RequestBudget;
    requireSelection?: boolean;
  } = {},
) {
  if (!env.DEEPSEEK_API_KEY) throw new Error('DeepSeek API key is not configured');
  const dishes = new Map<number, { date: string; meal: Meal; dish: Dish }>();
  const reduced = days.map((day) => ({
    date: day.date,
    menu: Object.fromEntries(
      MEALS.map((m) => [
        m,
        day.menu[m].map((dish) => {
          const id = dishes.size + 1;
          dishes.set(id, { date: day.date, meal: m, dish });
          return {
            id,
            name: dish.name,
            price: Number(dish.price),
            category: dish.categoryName ?? null,
          };
        }),
      ]),
    ),
    recentMeals: recentDishes.filter(
      ({ date }) => date < day.date && date >= addDays(day.date, -reservationLookbackDays),
    ),
  }));
  const prompt = [
    "Choose canteen meals following the user's requirements. Use each dish's category and the recentMeals list as context for variety.",
    'In recentMeals, reserved means an active reservation, submitted means sent during this run and awaiting confirmation, and draft means a choice saved for review.',
    "Return one JSON object keyed by the dates in Menus, with breakfastorders, lunchorders, and supperorders arrays of numeric IDs only. Copy each ID from that date and meal's menu.",
    'Use [] when no dish is selected. Repeated IDs indicate multiple portions.',
    'Example format with placeholder dates and IDs: {"2026-01-01":{"breakfastorders":[],"lunchorders":[4,7],"supperorders":[]}}.',
    `Requirements: ${requirements}`,
    `Menus: ${JSON.stringify(reduced)}`,
  ].join('\n');
  const signal = AbortSignal.timeout(timeout);
  const requestPicks = async (correction = '') => {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        messages: [{ role: 'user', content: correction + prompt }],
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      }),
      signal,
    });
    const body: any = await response.json();
    if (!response.ok) throw new Error(`DeepSeek: ${body?.error?.message || response.status}`);
    let chosen: unknown;
    try {
      chosen = JSON.parse(body?.choices?.[0]?.message?.content);
    } catch {
      throw new InvalidDeepSeekResponse('DeepSeek returned invalid or empty JSON');
    }
    if (!isObject(chosen) || Object.keys(chosen).length !== days.length)
      throw new InvalidDeepSeekResponse('DeepSeek returned an invalid order');
    return days.map(({ date }) => {
      const picks = chosen[date];
      if (!isObject(picks) || Object.keys(picks).some((key) => !MEALS.some((meal) => meal === key)))
        throw new InvalidDeepSeekResponse(`DeepSeek returned an invalid order for ${date}`);
      const selection = emptyMeals();
      for (const meal of MEALS) {
        const ids = picks[meal] === undefined ? [] : picks[meal];
        if (!Array.isArray(ids) || ids.length > 100)
          throw new InvalidDeepSeekResponse(
            `DeepSeek returned an invalid ${meal} list for ${date}`,
          );
        for (const item of ids) {
          const id = typeof item === 'string' && /^\d+$/.test(item) ? Number(item) : item;
          const offered = typeof id === 'number' ? dishes.get(id) : undefined;
          if (offered?.date !== date || offered.meal !== meal)
            throw new InvalidDeepSeekResponse(
              `DeepSeek selected an invalid dish ID for ${date} ${meal}`,
            );
          selection[meal].push(offered.dish);
        }
      }
      if (requireSelection && !hasDishes(selection))
        throw new InvalidDeepSeekResponse(`DeepSeek returned no dishes for ${date}`);
      return selection;
    });
  };

  let selections: MealMap[];
  try {
    selections = await requestPicks();
  } catch (error) {
    if (!(error instanceof InvalidDeepSeekResponse) || signal.aborted || budget?.remaining === 0)
      throw error;
    if (budget) budget.remaining--;
    selections = await requestPicks(
      `The previous response could not be used. ${error.message}. Copy only numeric dish IDs from the correct date and meal.\n`,
    );
  }
  days.forEach((day, i) => (day.auto_order = selections[i]));
}

export async function generate(
  env: Env,
  week: 'current' | 'next',
  getCategories?: (client: Canteen) => Promise<FoodCategory[]>,
  client = new Canteen(env),
): Promise<{ week: string; days: OrderDay[] }> {
  const settings = await getSettings(env.DB);
  const { monday, selections } = mealSchedule(settings, week);
  if (
    await env.DB.prepare('SELECT week_start FROM pending_orders WHERE week_start=?')
      .bind(monday)
      .first()
  )
    throw new Error('该周已有待提交订单，请先处理或删除');
  const selected = selections.filter((day) => day.meals);
  if (!selected.length) throw new Error('请先配置本周或下周的订餐日期');
  const allMenus: Record<string, MealMap> = {};
  const recentDishes = await client.session(async (c) => {
    const categories = getCategories ? await getCategories(c) : [];
    for (const x of selections) allMenus[x.date] = categorizeMenu(await c.menu(x.date), categories);
    return reservationContext(
      await c.details(
        addDays(selected[0].date, -reservationLookbackDays),
        addDays(selected[selected.length - 1].date, -1),
      ),
    );
  });
  const days: OrderDay[] = selected.map((x) => ({
    date: x.date,
    menu: canonicalMenu(allMenus[x.date], x.meals),
    auto_order: emptyMeals(),
  }));
  await chooseMenus(env, days, settings.requirements, recentDishes);
  await env.DB.prepare(
    'INSERT INTO menus VALUES (?,?,?) ON CONFLICT(week_start) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at',
  )
    .bind(monday, JSON.stringify(allMenus), new Date().toISOString())
    .run();
  await savePending(env.DB, monday, days);
  return { week: monday, days };
}

export async function runAIOrder(
  env: Env,
  settings: Settings,
  submit: boolean,
  getCategories: (client: Canteen) => Promise<FoodCategory[]>,
  scheduledTime?: number,
  canteen = new Canteen(env),
): Promise<AIOrderResult> {
  const result: AIOrderResult = {
    ordered: [],
    existing: [],
    drafted: [],
    unavailable: [],
    failures: [],
  };
  const today = nowShanghai(scheduledTime);
  const schedule = (['current', 'next'] as const).flatMap((week) => {
    const { monday, selections } = mealSchedule(settings, week, today);
    return selections.filter(({ meals }) => meals).map((day) => ({ ...day, monday }));
  });
  if (!schedule.length) return result;

  const first = schedule[0].date;
  const last = schedule[schedule.length - 1].date;
  const { results: cached } = await env.DB.prepare(
    'SELECT date FROM ordered_days WHERE date BETWEEN ? AND ?',
  )
    .bind(first, last)
    .all<{ date: string }>();
  const ordered = new Set(cached.map(({ date }) => date));
  const remaining = schedule.filter(({ date }) => !ordered.has(date));
  result.existing = schedule.filter(({ date }) => ordered.has(date)).map(({ date }) => date);
  if (!remaining.length) return result;

  const timeLimit = scheduledTime === undefined ? Infinity : Date.now() + 13 * 60_000;
  await canteen.session(async (client) => {
    // Reserve requests for OAuth and one refresh/retry, categories, two history lookups, and each date.
    const budget = { remaining: 50 - 6 - remaining.length * (submit ? 3 : 2) };
    const records = await client.details(
      addDays(remaining[0].date, -reservationLookbackDays),
      remaining[remaining.length - 1].date,
      budget,
    );
    const recentDishes = reservationContext(records);
    const candidates = await findUnorderedDates(env.DB, records, remaining, result);
    if (!candidates.length) return;

    const drafts = new Map<string, OrderDay[]>();
    if (!submit) {
      for (const monday of new Set(candidates.map((day) => day.monday))) {
        drafts.set(monday, (await readPending(env.DB, monday)) ?? []);
      }
    }
    const categories = await getCategories(client);
    if (!categories.length) throw new Error('无法读取食堂菜品分类');

    const attempted: OrderDay[] = [];
    for (const { date, meals, monday } of candidates) {
      if (Date.now() >= timeLimit) {
        result.failures.push(`${date} 起的剩余日期将在下次运行时检查`);
        break;
      }
      const pending = drafts.get(monday) ?? [];
      if (pending.some((day) => day.date === date && hasDishes(day.auto_order))) {
        result.drafted.push(date);
        continue;
      }
      try {
        const menu = canonicalMenu(categorizeMenu(await client.menu(date), categories), meals);
        const hasRegularDish = MEALS.some((meal) =>
          menu[meal].some((dish) => dish.categoryName && dish.categoryName !== '套餐'),
        );
        if (!hasRegularDish) {
          result.unavailable.push(date);
          continue;
        }
        const day: OrderDay = { date, menu, auto_order: emptyMeals() };
        await chooseMenus(env, [day], settings.requirements, recentDishes, {
          timeout: 35_000,
          budget,
          requireSelection: true,
        });
        const entries = orderEntries(day);
        if (submit) {
          attempted.push(day);
          await client.order(entries);
        } else {
          const updated = [...pending.filter((draft) => draft.date !== date), day].sort((a, b) =>
            a.date.localeCompare(b.date),
          );
          await savePending(env.DB, monday, updated);
          drafts.set(monday, updated);
          result.drafted.push(date);
        }
        recentDishes.push(
          ...entries.map(({ meal, dish }): RecentDish => ({
            date,
            meal: MEALS[meal],
            name: dish.name,
            status: submit ? 'submitted' : 'draft',
          })),
        );
      } catch (e) {
        result.failures.push(`${date} ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (attempted.length) {
      await confirmAIOrders(env.DB, client, attempted, result, budget);
    }
  });
  return result;
}

function orderEntries({ date, auto_order }: OrderDay) {
  return MEALS.flatMap((meal, index) =>
    auto_order[meal].map((dish) => ({ date, meal: index, dish })),
  );
}

async function findUnorderedDates<T extends { date: string }>(
  db: D1Database,
  records: Detail[],
  dates: T[],
  result: AIOrderResult,
) {
  const live = new Set(records.filter(active).map((record) => record.ORDERDATE));
  const existing = dates.filter(({ date }) => live.has(date)).map(({ date }) => date);
  await rememberOrderedDays(db, existing);
  result.existing.push(...existing);
  return dates.filter(({ date }) => !live.has(date));
}

async function confirmAIOrders(
  db: D1Database,
  client: Canteen,
  days: OrderDay[],
  result: AIOrderResult,
  budget: RequestBudget,
) {
  try {
    const records = (await client.details(days[0].date, days[days.length - 1].date, budget)).filter(
      active,
    );
    const orderedDates = new Set(records.map((record) => record.ORDERDATE));
    await rememberOrderedDays(
      db,
      days.map(({ date }) => date).filter((date) => orderedDates.has(date)),
    );
    const actual = count(records);
    for (const { date, auto_order } of days) {
      const confirmed = MEALS.every((meal, index) => {
        const quantities = new Map<string, number>();
        for (const dish of auto_order[meal]) {
          const quantity = (quantities.get(dish.name) ?? 0) + 1;
          if ((actual.get(key(date, index, dish.name)) ?? 0) < quantity) return false;
          quantities.set(dish.name, quantity);
        }
        return true;
      });
      if (confirmed) result.ordered.push(date);
      else result.failures.push(`${date} 订单未完全确认`);
    }
  } catch (e) {
    result.failures.push(`无法确认 AI 订单：${e instanceof Error ? e.message : String(e)}`);
  }
}

function hasDishes(meals: MealMap) {
  return MEALS.some((meal) => meals?.[meal]?.length);
}

function key(date: string, meal: number, name: string) {
  return `${date}\u0000${meal}\u0000${name}`;
}
function count(records: Detail[]) {
  const m = new Map<string, number>();
  for (const r of records.filter(active)) {
    const k = key(r.ORDERDATE, Number(r.ORDERTYPE), r.DISHESNAME);
    m.set(k, (m.get(k) || 0) + 1);
  }
  return m;
}
type DesiredDay = Pick<OrderDay, 'date' | 'auto_order'>;

export async function applyDays(
  env: Env,
  desiredDays: DesiredDay[],
  cancelExtras: boolean,
  client = new Canteen(env),
) {
  if (!Array.isArray(desiredDays) || !desiredDays.length || desiredDays.length > 31)
    throw new Error('No valid days');
  for (const day of desiredDays) if (!isDate(day.date)) throw new Error('Invalid date');
  const dates = desiredDays.map((d) => d.date).sort();
  const failures: string[] = [],
    cancelled: string[] = [],
    ordered: string[] = [];
  return client.session(async (c) => {
    const before = await c.details(dates[0], dates[dates.length - 1]);
    const initial = count(before);
    const entries: { date: string; meal: number; dish: Dish }[] = [];
    const desiredCounts = new Map<string, number>();
    const menus = new Map<string, MealMap>();
    for (const day of desiredDays) {
      const menu = await c.menu(day.date);
      menus.set(day.date, menu);
      const validated = validateSelection(menu, day.auto_order);
      MEALS.forEach((meal, index) =>
        validated[meal].forEach((dish) => {
          const k = key(day.date, index, dish.name);
          const n = (desiredCounts.get(k) || 0) + 1;
          desiredCounts.set(k, n);
          if (n > (initial.get(k) || 0)) entries.push({ date: day.date, meal: index, dish });
        }),
      );
    }
    if (cancelExtras) {
      for (const record of before.filter(active)) {
        const meal = MEALS[Number(record.ORDERTYPE)];
        if (
          menus.has(record.ORDERDATE) &&
          meal &&
          !menus.get(record.ORDERDATE)![meal].some((d) => d.name === record.DISHESNAME)
        ) {
          throw new Error(`已订菜品不在当前菜单中，无法安全修改: ${record.DISHESNAME}`);
        }
      }
      const kept = new Map<string, number>();
      for (const record of before.filter(active)) {
        if (!dates.includes(record.ORDERDATE) || ![0, 1, 2].includes(Number(record.ORDERTYPE)))
          continue;
        const k = key(record.ORDERDATE, Number(record.ORDERTYPE), record.DISHESNAME);
        const n = (kept.get(k) || 0) + 1;
        kept.set(k, n);
        if (n > (desiredCounts.get(k) || 0)) {
          try {
            await c.cancel(record.ID);
            cancelled.push(record.DISHESNAME);
          } catch (e) {
            failures.push(`取消 ${record.DISHESNAME}: ${String(e)}`);
          }
        }
      }
    }
    // Do not place replacement orders if cancellation has failed.
    if (!failures.length && entries.length) {
      try {
        await c.order(entries);
        ordered.push(...entries.map((e) => e.dish.name));
      } catch (e) {
        failures.push(`提交失败: ${String(e)}`);
      }
    }
    let records: Detail[];
    try {
      records = await c.details(dates[0], dates[dates.length - 1]);
    } catch {
      failures.push('无法确认最终订单，请手动检查后再重试');
      return { success: false, cancelled, ordered, failures, confirmedDates: [] };
    }
    const after = count(records);
    for (const [k, n] of desiredCounts)
      if ((after.get(k) || 0) < n) failures.push(`未确认: ${k.split('\u0000').join(' ')}`);
    if (cancelExtras)
      for (const [k, n] of after)
        if (
          dates.includes(k.split('\u0000')[0]) &&
          ['0', '1', '2'].includes(k.split('\u0000')[1]) &&
          n > (desiredCounts.get(k) || 0)
        )
          failures.push(`未取消: ${k.split('\u0000').join(' ')}`);
    const confirmedDates = [
      ...new Set(records.filter(active).map((record) => record.ORDERDATE)),
    ].filter((date) => dates.includes(date));
    return { success: !failures.length, cancelled, ordered, failures, confirmedDates };
  });
}
