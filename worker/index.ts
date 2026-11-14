import { DurableObject } from 'cloudflare:workers';
import { Canteen, active } from './canteen';
import { categorizeMenu } from './categories';
import { SerialQueue } from './queue';
import {
  applyDays,
  cleanSettings,
  generate,
  getPending,
  getSettings,
  job,
  rememberOrderedDays,
  runAIOrder,
  savePending,
  saveSettings,
  validateSelection,
} from './engine';
import { MEALS, isDate, type Env, type FoodCategory, type OrderDay, type Settings } from './types';

const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (message: string, status = 400) => json({ success: false, message }, status);
const encode = new TextEncoder();
const hex = (x: ArrayBuffer) =>
  [...new Uint8Array(x)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sign(secret: string, value: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encode.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encode.encode(value)));
}
async function same(a: string, b: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encode.encode('wxdc-comparison-key'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encode.encode(a));
  return crypto.subtle.verify('HMAC', key, digest, encode.encode(b));
}
function sessionCookie(req: Request) {
  return (
    req.headers
      .get('Cookie')
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('wxdc_session='))
      ?.slice(13) || ''
  );
}
async function authenticated(req: Request, env: Env) {
  const token = sessionCookie(req),
    parts = token.split('.');
  if (
    parts.length !== 3 ||
    !/^\d+$/.test(parts[0]) ||
    Number(parts[0]) < Date.now() ||
    Number(parts[0]) > Date.now() + 12 * 3600_000
  )
    return false;
  return same(parts[2], await sign(env.SESSION_SECRET, `${parts[0]}.${parts[1]}`));
}
function sameOrigin(req: Request) {
  const origin = req.headers.get('Origin');
  return !!origin && origin === new URL(req.url).origin;
}
function requireConfig(env: Env) {
  if (
    !env.APP_PASSWORD ||
    env.APP_PASSWORD.length < 12 ||
    !env.SESSION_SECRET ||
    env.SESSION_SECRET.length < 32
  )
    throw new Error('Configure APP_PASSWORD (12+ characters) and SESSION_SECRET (32+ characters)');
}
function validateDays(days: OrderDay[]) {
  if (!Array.isArray(days) || !days.length || days.length > 7)
    throw new Error('Invalid pending order');
  for (const day of days) {
    if (!isDate(day.date) || !day.menu || !day.auto_order) throw new Error('Invalid pending order');
    day.auto_order = validateSelection(day.menu, day.auto_order);
  }
}

export class Coordinator extends DurableObject<Env> {
  private queue = new SerialQueue();
  private async foodCategories(client?: Canteen): Promise<FoodCategory[]> {
    const cached = await this.ctx.storage.get<{ categories: FoodCategory[]; expiresAt: number }>(
      'foodCategories',
    );
    if (cached && cached.expiresAt > Date.now()) return cached.categories;
    try {
      const categories = client
        ? await client.foodCategories()
        : await new Canteen(this.env).session((canteen) => canteen.foodCategories());
      if (!categories.length) throw new Error('Canteen returned no food categories');
      await this.ctx.storage.put('foodCategories', {
        categories,
        expiresAt: Date.now() + 24 * 3600_000,
      });
      return categories;
    } catch (e) {
      console.warn('Food categories unavailable:', e);
      // Avoid repeated binding attempts if credentials or the service are unavailable.
      const categories = cached?.categories ?? [];
      await this.ctx.storage.put('foodCategories', {
        categories,
        expiresAt: Date.now() + 15 * 60_000,
      });
      return categories;
    }
  }
  async fetch(req: Request): Promise<Response> {
    // Durable Objects can interleave across external fetches; chain the whole operation.
    return this.queue.run(() => this.handle(req));
  }
  private async orderWithAI(settings: Settings, scheduledTime?: number) {
    const scheduled = scheduledTime !== undefined;
    const kind = scheduled ? 'scheduled' : 'manual';
    try {
      const result = await runAIOrder(
        this.env,
        settings,
        !scheduled || settings.autoSubmit,
        (client) => this.foodCategories(client),
        scheduledTime,
      );
      const summary = `AI 订餐：提交 ${result.ordered.length} 天，已有订单 ${result.existing.length} 天，待提交 ${result.drafted.length} 天，未供餐 ${result.unavailable.length} 天`;
      await job(
        this.env.DB,
        kind,
        result.failures.length ? 'failed' : 'success',
        [summary, ...result.failures].join('；'),
      );
      return result;
    } catch (e) {
      await job(this.env.DB, kind, 'failed', String(e));
      throw e;
    }
  }
  private async runScheduled(scheduledTime: number): Promise<Response> {
    const settings = await getSettings(this.env.DB);
    if (!settings.scheduleEnabled) return json({ skipped: true });
    const lastRun = await this.ctx.storage.get<number>('lastScheduledTime');
    if (lastRun !== undefined && scheduledTime <= lastRun) return json({ skipped: true });
    await this.ctx.storage.put('lastScheduledTime', scheduledTime);

    const result = await this.orderWithAI(settings, scheduledTime);
    return json(result, result.failures.length ? 502 : 200);
  }
  private async handle(req: Request): Promise<Response> {
    const url = new URL(req.url),
      path = url.pathname;
    try {
      if (path === '/internal/cron') {
        const { scheduledTime } = await req.json<{ scheduledTime: number }>();
        return await this.runScheduled(scheduledTime);
      }
      requireConfig(this.env);
      if (req.method !== 'GET' && !sameOrigin(req)) return error('Invalid request origin', 403);
      if (path === '/api/login' && req.method === 'POST') {
        const failures = await this.ctx.storage.get<{ count: number; until: number }>(
          'loginFailures',
        );
        if (failures && failures.count >= 5 && failures.until > Date.now())
          return error('Too many attempts; try again later', 429);
        const body: { password?: unknown } = await req.json();
        if (
          typeof body.password !== 'string' ||
          !(await same(body.password, this.env.APP_PASSWORD))
        ) {
          const count = failures && failures.until > Date.now() ? failures.count + 1 : 1;
          await this.ctx.storage.put('loginFailures', { count, until: Date.now() + 15 * 60_000 });
          return error('Incorrect password', 401);
        }
        await this.ctx.storage.delete('loginFailures');
        const expiry = String(Date.now() + 12 * 3600_000),
          nonce = crypto.randomUUID(),
          payload = `${expiry}.${nonce}`;
        const token = `${payload}.${await sign(this.env.SESSION_SECRET, payload)}`;
        return json({ success: true }, 200, {
          'Set-Cookie': `wxdc_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
        });
      }
      if (!(await authenticated(req, this.env))) return error('请先登录', 401);
      if (path === '/api/session' && req.method === 'GET') return json({ success: true });
      if (path === '/api/logout' && req.method === 'POST')
        return json({ success: true }, 200, {
          'Set-Cookie': 'wxdc_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0',
        });
      if (path === '/api/settings' && req.method === 'GET')
        return json(await getSettings(this.env.DB));
      if (path === '/api/settings' && req.method === 'PUT') {
        await saveSettings(this.env.DB, cleanSettings(await req.json()));
        return json({ success: true });
      }
      if (path === '/api/jobs' && req.method === 'GET')
        return json(
          (
            await this.env.DB.prepare(
              'SELECT created_at,kind,status,message FROM jobs ORDER BY id DESC LIMIT 20',
            ).all()
          ).results,
        );
      if (path === '/api/orders' && req.method === 'GET')
        return json(
          (
            await this.env.DB.prepare(
              'SELECT week_start,updated_at FROM pending_orders ORDER BY week_start DESC',
            ).all()
          ).results,
        );
      if (path === '/api/ai-order' && req.method === 'POST') {
        return json(await this.orderWithAI(await getSettings(this.env.DB)));
      }
      if (path === '/api/generate' && req.method === 'POST') {
        const body: { week: string } = await req.json();
        if (!['current', 'next'].includes(body.week)) return error('Invalid week');
        try {
          const result = await generate(this.env, body.week as 'current' | 'next', (c) =>
            this.foodCategories(c),
          );
          await job(this.env.DB, 'manual', 'success', `Generated ${result.week}`);
          return json(result);
        } catch (e) {
          await job(this.env.DB, 'manual', 'failed', String(e));
          throw e;
        }
      }
      const match = path.match(/^\/api\/orders\/(\d{4}-\d{2}-\d{2})(?:\/(submit|status))?$/);
      if (match) {
        const [, week, action] = match;
        if (!action && req.method === 'GET') {
          const pending = await getPending(this.env.DB, week);
          const needsCategories = pending.some((day) =>
            MEALS.some((meal) =>
              (day.menu[meal] || []).some((dish) => dish.typeid != null && !dish.categoryName),
            ),
          );
          const categories = needsCategories ? await this.foodCategories() : [];
          return json(
            pending.map((day) => ({ ...day, menu: categorizeMenu(day.menu, categories) })),
          );
        }
        if (!action && req.method === 'DELETE') {
          await getPending(this.env.DB, week);
          await this.env.DB.prepare('DELETE FROM pending_orders WHERE week_start=?')
            .bind(week)
            .run();
          return json({ success: true });
        }
        if (!action && req.method === 'PUT') {
          const original = await getPending(this.env.DB, week),
            body: { days: OrderDay[] } = await req.json();
          if (!Array.isArray(body.days) || body.days.length !== original.length)
            throw new Error('Invalid order');
          const edited = original.map((day, i) => {
            if (body.days[i]?.date !== day.date) throw new Error('Order dates cannot be changed');
            return { ...day, auto_order: body.days[i].auto_order };
          });
          validateDays(edited);
          await savePending(this.env.DB, week, edited);
          return json({ success: true });
        }
        if (action === 'submit' && req.method === 'POST') {
          const pending = await getPending(this.env.DB, week);
          validateDays(pending);
          const { confirmedDates, ...result } = await applyDays(this.env, pending, false);
          await rememberOrderedDays(this.env.DB, confirmedDates);
          if (result.success)
            await this.env.DB.prepare('DELETE FROM pending_orders WHERE week_start=?')
              .bind(week)
              .run();
          await job(
            this.env.DB,
            'submit',
            result.success ? 'success' : 'failed',
            result.failures.join('; ') || `Submitted ${week}`,
          );
          return json(result, result.success ? 200 : 409);
        }
        if (action === 'status' && req.method === 'GET') {
          const pending = await getPending(this.env.DB, week);
          const dates = pending.map((d) => d.date).sort();
          const records = await new Canteen(this.env).session((c) =>
            c.details(dates[0], dates[dates.length - 1]),
          );
          return json(
            records
              .filter(active)
              .map((r) => ({ date: r.ORDERDATE, meal: Number(r.ORDERTYPE), name: r.DISHESNAME })),
          );
        }
      }
      if (path === '/api/live' && req.method === 'GET') {
        const date = url.searchParams.get('date');
        if (!isDate(date)) return error('Invalid date');
        const result = await new Canteen(this.env).session(async (c) => {
          const menu = await c.menu(date);
          const categories = await this.foodCategories(c);
          return {
            menu: categorizeMenu(menu, categories),
            records: (await c.details(date, date)).filter(active),
          };
        });
        return json(result);
      }
      if (path === '/api/live' && req.method === 'POST') {
        const body: { date: string; auto_order: OrderDay['auto_order'] } = await req.json();
        const { confirmedDates, ...result } = await applyDays(this.env, [body], true);
        await rememberOrderedDays(this.env.DB, confirmedDates);
        await job(
          this.env.DB,
          'edit',
          result.success ? 'success' : 'failed',
          result.failures.join('; ') || `Updated ${body.date}`,
        );
        return json(result, result.success ? 200 : 409);
      }
      if (path === '/api/overview' && req.method === 'GET') {
        const start = url.searchParams.get('start'),
          end = url.searchParams.get('end');
        if (
          !isDate(start) ||
          !isDate(end) ||
          start > end ||
          (Date.parse(end) - Date.parse(start)) / 86400_000 > 30
        )
          return error('Invalid date range');
        const result = await new Canteen(this.env).session(async (c) => ({
          booked: await c.booked(start, end),
          details: (await c.details(start, end)).filter(active),
        }));
        return json(result);
      }
      return error('Not found', 404);
    } catch (e) {
      console.error('Worker operation failed', e);
      return error(e instanceof Error ? e.message : 'Unexpected error', 500);
    }
  }
}
export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (new URL(req.url).pathname.startsWith('/api/'))
      return env.COORDINATOR.get(env.COORDINATOR.idFromName('account')).fetch(req);
    return env.ASSETS.fetch(req);
  },
  async scheduled(event: ScheduledController, env: Env) {
    if (event.cron !== '0 0,10 * * *') return;
    const result = await env.COORDINATOR.get(env.COORDINATOR.idFromName('account')).fetch(
      'https://internal/internal/cron',
      { method: 'POST', body: JSON.stringify({ scheduledTime: event.scheduledTime }) },
    );
    if (!result.ok)
      throw new Error(`Scheduled ordering failed (${result.status}) ${await result.text()}`);
  },
} satisfies ExportedHandler<Env>;
