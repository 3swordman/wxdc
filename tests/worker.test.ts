import { describe, expect, it, vi, afterEach } from 'vitest';
import { Canteen } from '../worker/canteen';
import { categorizeMenu, groupDishesByCategory } from '../worker/categories';
import { cleanSettings, validateSelection } from '../worker/engine';
import {
  addDays,
  bookedMealsRange,
  defaults,
  emptyMeals,
  mondayFor,
  nowShanghai,
  type Env,
} from '../worker/types';

const env = {
  CANTEEN_USER_NO: '1234567',
  WECHAT_OPEN_ID: 'openid',
  WECHAT_JSESSIONID: 'session',
  WECHAT_CENTER_ID: '9053',
} as Env;
afterEach(() => vi.restoreAllMocks());
describe('canteen session', () => {
  function sessionStorage() {
    const entries = new Map<string, unknown>();
    return {
      get: async (key: string) => entries.get(key),
      put: async (key: string, value: unknown) => void entries.set(key, value),
      delete: async (key: string) => entries.delete(key),
    } as Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;
  }

  it('reports an OAuth failure without running the operation', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, code: 500, message: '账号被锁定' }), {
        status: 200,
      }),
    );
    const operation = vi.fn();
    await expect(new Canteen(env).session(operation)).rejects.toThrow('账号被锁定');
    expect(mock).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
  });

  it('reuses OAuth across clients and retries a read with the refreshed identity', async () => {
    const storage = sessionStorage();
    let authorizations = 0;
    let expired = false;
    const profiles: string[] = [];
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/wechat/oauth') {
        expect(url.searchParams.get('openId')).toBe('openid');
        const id = ++authorizations;
        return Response.json({
          success: true,
          result: { token: `token-${id}`, centerId: 9053, empId: `employee-${id}`, empType: 1 },
        });
      }
      expect(url.pathname).toBe('/api/wechat/getUserInfo');
      const token = new Headers(init?.headers).get('X-Access-Token');
      profiles.push(`${token}:${url.searchParams.get('empId')}`);
      if (expired && token === 'token-1') return Response.json({ success: false, code: '401' });
      return Response.json({ success: true, result: { eaccountvalue: '24.50' } });
    });
    const balance = (config = env) => new Canteen(config, storage).session((c) => c.balance());
    expect(await balance()).toBe(24.5);
    expect(await balance()).toBe(24.5);
    expect(authorizations).toBe(1);
    expired = true;
    expect(await balance()).toBe(24.5);
    expect(await balance()).toBe(24.5);
    expect(await balance({ ...env, WECHAT_JSESSIONID: 'new-cookie' })).toBe(24.5);
    expect(authorizations).toBe(3);
    expect(profiles).toEqual([
      'token-1:employee-1',
      'token-1:employee-1',
      'token-1:employee-1',
      'token-2:employee-2',
      'token-2:employee-2',
      'token-3:employee-3',
    ]);
    expect(mock.mock.calls.some(([input]) => /\/(?:toBind|unBind)$/.test(String(input)))).toBe(
      false,
    );
  });

  it('invalidates an expired token without replaying an order', async () => {
    const storage = sessionStorage();
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/oauth'))
        return Response.json({ success: true, result: { token: 'token' } });
      return new Response(null, { status: 401 });
    });
    await expect(
      new Canteen(env, storage).session((c) =>
        c.order([{ date: '2026-11-16', meal: 1, dish: { id: 10, name: 'rice', price: 2 } }]),
      ),
    ).rejects.toThrow('订餐登录已失效');
    expect(mock.mock.calls.map(([input]) => new URL(String(input)).pathname)).toEqual([
      '/api/wechat/oauth',
      '/api/orderdata/setOrder',
    ]);
    expect(await storage.get('canteenSession')).toBeUndefined();
  });
});

describe('canteen balance', () => {
  it.each([
    ['24.50', 24.5],
    [0, 0],
    ['', undefined],
  ])('reads the account balance %j using the OAuth account identity', async (value, expected) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/oauth')) {
        return Response.json({
          success: true,
          result: { token: 'token', centerId: 9053, empId: 'account-id', empType: 1 },
        });
      }
      if (url.pathname.endsWith('/getUserInfo')) {
        expect(url.searchParams.get('empId')).toBe('account-id');
        expect(url.searchParams.get('empType')).toBe('1');
        expect(init?.method).toBe('POST');
        expect(new Headers(init?.headers).get('X-Access-Token')).toBe('token');
        return Response.json({ success: true, result: { eaccountvalue: value } });
      }
      return Response.json({ success: true });
    });
    const balance = new Canteen(env).session((client) => client.balance());
    if (expected === undefined) await expect(balance).rejects.toThrow('未返回有效余额');
    else await expect(balance).resolves.toBe(expected);
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      '/api/wechat/oauth',
      '/api/wechat/getUserInfo',
    ]);
  });
});
describe('order safety', () => {
  it('rejects invalid model or client dishes', () => {
    const menu = emptyMeals();
    menu.lunchorders = [{ id: '1', name: 'rice', price: 2 }];
    expect(() =>
      validateSelection(menu, { lunchorders: [{ id: '2', name: 'unknown', price: 2 }] }),
    ).toThrow();
    expect(
      validateSelection(menu, { lunchorders: [{ id: '1', name: 'spoofed', price: 0 }] })
        .lunchorders[0].name,
    ).toBe('rice');
  });
  it('starts automation disabled and checks exception dates', () => {
    expect(defaults()).toMatchObject({ scheduleEnabled: false, autoSubmit: false });
    expect(() => cleanSettings({ ...defaults(), exceptions: { '2026-02-30': 'l' } })).toThrow();
  });
  it('selects coming Monday and the following week', () => {
    expect(mondayFor('current', '2026-11-13')).toBe('2026-11-16');
    expect(mondayFor('next', '2026-11-15')).toBe('2026-11-23');
    expect(mondayFor('current', '2026-11-16')).toBe('2026-11-23');
  });
  it('shows three full calendar weeks starting with this Monday in Beijing time', () => {
    expect(bookedMealsRange(nowShanghai(Date.parse('2026-12-27T15:59:59Z')))).toEqual({
      start: '2026-12-21',
      end: '2027-01-10',
    });
    expect(bookedMealsRange(nowShanghai(Date.parse('2026-12-27T16:00:00Z')))).toEqual({
      start: '2026-12-28',
      end: '2027-01-17',
    });
  });
});

describe('food categories', () => {
  it('loads the canteen category list during the current session', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/oauth'))
        return Response.json({ success: true, result: { token: 'token', centerId: 9053 } });
      if (url.pathname.endsWith('/getOrderFoodType'))
        return Response.json({
          success: true,
          result: [
            { id: 'set', typename: '套餐' },
            { id: 'dish', typename: '菜品' },
          ],
        });
      return Response.json({ success: true, result: {} });
    });
    const categories = await new Canteen(env).session((c) => c.foodCategories());
    expect(categories).toEqual([
      { id: 'set', name: '套餐', order: 0 },
      { id: 'dish', name: '菜品', order: 1 },
    ]);
    const categoryRequest = mock.mock.calls.find((call) =>
      String(call[0]).includes('getOrderFoodType'),
    );
    expect(categoryRequest?.[1]?.method).toBe('GET');
    expect(mock.mock.calls.filter((call) => String(call[0]).includes('/oauth'))).toHaveLength(1);
  });

  it('groups dishes by their actual category without changing selection IDs or duplicating items', () => {
    const menu = emptyMeals();
    menu.lunchorders = [
      { id: 's1', name: '套餐 A', price: 18, typeid: 'set' },
      { id: 'd1', name: '炒菜', price: 5, typeid: 'dish' },
      { id: 'd1', name: '炒菜', price: 5, typeid: 'dish' },
      { id: 'x1', name: '其他菜', price: 2, typeid: 'unknown' },
    ];
    const enriched = categorizeMenu(menu, [
      { id: 'dish', name: '菜品', order: 0 },
      { id: 'set', name: '套餐', order: 1 },
    ]);
    const groups = groupDishesByCategory(enriched.lunchorders);
    expect(groups.map((group) => group.name)).toEqual(['菜品', '套餐', '其他']);
    expect(groups.map((group) => group.dishes.map((dish) => dish.id))).toEqual([
      ['d1'],
      ['s1'],
      ['x1'],
    ]);
    expect(menu.lunchorders[0].categoryName).toBeUndefined();
    expect(
      validateSelection(enriched, { lunchorders: [{ id: 's1' }, { id: 's1' }] }).lunchorders,
    ).toHaveLength(2);
  });

  it('keeps dishes visible under 其他 when category metadata is unavailable', () => {
    const menu = emptyMeals();
    menu.breakfastorders = [{ id: '1', name: '早餐', price: 5, typeid: 'missing' }];
    const groups = groupDishesByCategory(categorizeMenu(menu, []).breakfastorders);
    expect(groups.map((group) => group.name)).toEqual(['其他']);
    expect(groups[0].dishes).toEqual(menu.breakfastorders);
  });
});

describe('order reconciliation', () => {
  const menu = {
    breakfastorders: [],
    lunchorders: [
      { id: '1', name: 'rice', price: 2 },
      { id: '2', name: 'noodles', price: 3 },
    ],
    supperorders: [],
  };
  const record = (name: string, id: string) => ({
    ORDERDATE: '2026-11-16',
    ORDERTYPE: '1',
    ORDERSTATUS: '0',
    DISHESNAME: name,
    ID: id,
  });
  function simulate(options: { confirmOrder?: boolean; failCancel?: boolean } = {}) {
    let rows = [record('rice', 'r1')];
    return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input)),
        path = u.pathname;
      if (path.endsWith('/oauth'))
        return Response.json({ success: true, result: { token: 'test', centerId: '9053' } });
      if (path.endsWith('/getOrderList'))
        return Response.json({ success: true, result: { records: rows, pages: 1 } });
      if (path.endsWith('/getOrderFoodList')) return Response.json({ success: true, result: menu });
      if (path.endsWith('/cancelOrderDetail')) {
        if (options.failCancel) return Response.json({ success: false, message: 'cancel failed' });
        rows = rows.filter((r) => r.ID !== u.searchParams.get('orderid'));
        return Response.json({ success: true });
      }
      if (path.endsWith('/setOrder')) {
        if (options.confirmOrder !== false) rows.push(record('noodles', 'n1'));
        return Response.json({ success: true });
      }
      return Response.json({ success: true, result: {} });
    });
  }
  it('orders only missing dishes and confirms the result', async () => {
    const { applyDays } = await import('../worker/engine');
    const mock = simulate();
    const result = await applyDays(
      env,
      [{ date: '2026-11-16', auto_order: { ...emptyMeals(), lunchorders: menu.lunchorders } }],
      false,
    );
    expect(result.success).toBe(true);
    expect(result.ordered).toEqual(['noodles']);
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('setOrder'))).toHaveLength(1);
    const request = mock.mock.calls.find((c) => String(c[0]).includes('setOrder'))!;
    expect(new URL(String(request[0])).searchParams.get('data')).toContain('%27');
  });
  it('keeps an unconfirmed submission as a failure', async () => {
    const { applyDays } = await import('../worker/engine');
    simulate({ confirmOrder: false });
    const result = await applyDays(
      env,
      [{ date: '2026-11-16', auto_order: { ...emptyMeals(), lunchorders: menu.lunchorders } }],
      false,
    );
    expect(result.success).toBe(false);
    expect(result.failures.join()).toContain('未确认');
  });
  it('does not place replacement dishes when cancellation fails', async () => {
    const { applyDays } = await import('../worker/engine');
    const mock = simulate({ failCancel: true });
    const result = await applyDays(
      env,
      [{ date: '2026-11-16', auto_order: { ...emptyMeals(), lunchorders: [menu.lunchorders[1]] } }],
      true,
    );
    expect(result.success).toBe(false);
    expect(mock.mock.calls.filter((c) => String(c[0]).includes('setOrder'))).toHaveLength(0);
  });
});

describe('account coordination', () => {
  it('serializes asynchronous operations and continues after an error', async () => {
    const { SerialQueue } = await import('../worker/queue');
    const q = new SerialQueue();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls: string[] = [];
    const first = q.run(async () => {
      calls.push('bind-1');
      await gate;
      calls.push('unbind-1');
      throw new Error('failure');
    });
    const second = q.run(async () => {
      calls.push('bind-2');
      calls.push('unbind-2');
    });
    await Promise.resolve();
    expect(calls).toEqual(['bind-1']);
    release();
    await expect(first).rejects.toThrow('failure');
    await second;
    expect(calls).toEqual(['bind-1', 'unbind-1', 'bind-2', 'unbind-2']);
  });
});

describe('DeepSeek generation', () => {
  it('sends categories and recent active reservations while retaining original IDs', async () => {
    const { generate } = await import('../worker/engine');
    const db = {
      prepare: (sql: string) => ({
        bind() {
          return this;
        },
        first: async () =>
          sql.startsWith('SELECT value FROM settings')
            ? { value: JSON.stringify({ ...defaults(), days: { '1': 'l' } }) }
            : null,
        run: async () => ({}),
      }),
    };
    const monday = mondayFor('current');
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.deepseek.com') {
        const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
        expect(JSON.parse(prompt.split('\nMenus: ')[1])).toEqual([
          {
            date: monday,
            menu: {
              ...emptyMeals(),
              lunchorders: [{ id: 1, name: 'rice', price: 2, category: '菜品' }],
            },
            recentMeals: [
              {
                date: addDays(monday, -7),
                meal: 'supperorders',
                name: 'noodles',
                status: 'reserved',
              },
            ],
          },
        ]);
        expect(prompt).not.toContain('private-record-id');
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  [monday]: { lunchorders: ['1'] },
                }),
              },
            },
          ],
        });
      }
      if (url.pathname.endsWith('/getOrderList')) {
        expect(url.searchParams.get('starttime')).toBe(addDays(monday, -7));
        expect(url.searchParams.get('endtime')).toBe(addDays(monday, -1));
        const record = { ORDERTYPE: '2', DISHESNAME: 'noodles', ID: 'private-record-id' };
        return Response.json({
          success: true,
          result: {
            records: [
              { ...record, ORDERDATE: addDays(monday, -7), ORDERSTATUS: '1' },
              { ...record, ORDERDATE: addDays(monday, -1), ORDERSTATUS: '3' },
              { ...record, ORDERDATE: addDays(monday, -8), ORDERSTATUS: '1' },
              { ...record, ORDERDATE: monday, ORDERSTATUS: '1' },
            ],
          },
        });
      }
      if (url.pathname.endsWith('/oauth'))
        return Response.json({ success: true, result: { token: 'token', centerId: '9053' } });
      if (url.pathname.endsWith('/getOrderFoodType'))
        return Response.json({ success: true, result: [{ id: 'dish', typename: '菜品' }] });
      if (url.pathname.endsWith('/getOrderFoodList'))
        return Response.json({
          success: true,
          result: {
            ...emptyMeals(),
            lunchorders: [{ id: 'original-id', name: 'rice', price: 2, typeid: 'dish' }],
          },
        });
      return Response.json({ success: true, result: {} });
    });
    const result = await generate(
      { ...env, DB: db as unknown as D1Database, DEEPSEEK_API_KEY: 'test' },
      'current',
      (client) => client.foodCategories(),
    );
    expect(result.days[0].menu.lunchorders[0]).toMatchObject({
      categoryName: '菜品',
      id: 'original-id',
    });
    expect(result.days[0].auto_order.lunchorders[0].id).toBe('original-id');
    expect(
      mock.mock.calls.filter((call) => String(call[0]).includes('/getOrderFoodType')),
    ).toHaveLength(1);
  });

  it('includes an earlier draft from the same pass when choosing the next date', async () => {
    const { runAIOrder } = await import('../worker/engine');
    const db = {
      prepare: () => ({
        bind() {
          return this;
        },
        all: async () => ({ results: [] }),
        first: async () => null,
        run: async () => ({}),
      }),
    };
    const monday = '2026-11-16';
    const tuesday = '2026-11-17';
    const prompts: { date: string; recentMeals: unknown[] }[] = [];
    let retryPrompt = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.deepseek.com') {
        const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
        const [day] = JSON.parse(prompt.split('\nMenus: ')[1]);
        const retrying = prompt.startsWith('The previous response could not be used');
        if (retrying) retryPrompt = prompt;
        else prompts.push(day);
        const picks =
          day.date === monday && !retrying
            ? { supperorders: [day.menu.lunchorders[0].id] }
            : { lunchorders: [day.menu.lunchorders[0].id] };
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  [day.date]: picks,
                }),
              },
            },
          ],
        });
      }
      const result = {
        oauth: { token: 'token' },
        getOrderList: { records: [] },
        getOrderFoodList: {
          ...emptyMeals(),
          lunchorders: [{ id: '1', name: 'rice', price: 2, typeid: 'dish' }],
        },
      };
      const operation = url.pathname.split('/').pop() as keyof typeof result;
      return Response.json({ success: true, result: result[operation] ?? {} });
    });
    const result = await runAIOrder(
      { ...env, DB: db as unknown as D1Database, DEEPSEEK_API_KEY: 'test' },
      { ...defaults(), days: { '1': 'l', '2': 'l' } },
      false,
      async () => [{ id: 'dish', name: '菜品', order: 0 }],
      Date.parse('2026-11-15T00:00:00Z'),
    );
    expect(result.drafted).toEqual([monday, tuesday]);
    expect(result.failures).toEqual([]);
    expect(retryPrompt).toContain(`invalid dish ID for ${monday} supperorders`);
    expect(prompts.map(({ date, recentMeals }) => ({ date, recentMeals }))).toEqual([
      { date: monday, recentMeals: [] },
      {
        date: tuesday,
        recentMeals: [{ date: monday, meal: 'lunchorders', name: 'rice', status: 'draft' }],
      },
    ]);
  });

  it.each(['invalid JSON', 'an unknown dish ID'])(
    'rejects %s twice without writing an order',
    async (invalid) => {
      const { generate } = await import('../worker/engine');
      const writes = vi.fn();
      const db = {
        prepare: (sql: string) => ({
          bind() {
            return this;
          },
          first: async () =>
            sql.startsWith('SELECT value FROM settings')
              ? { value: JSON.stringify({ ...defaults(), days: { '1': 'l' } }) }
              : null,
          run: async () => writes(),
        }),
      };
      let requests = 0;
      const monday = mondayFor('current');
      const response =
        invalid === 'invalid JSON'
          ? 'not json'
          : JSON.stringify({ [monday]: { lunchorders: [999] } });
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
        const u = new URL(String(input));
        if (u.hostname === 'api.deepseek.com') {
          requests++;
          return Response.json({ choices: [{ message: { content: response } }] });
        }
        if (u.pathname.endsWith('/oauth'))
          return Response.json({ success: true, result: { token: 'token', centerId: '9053' } });
        if (u.pathname.endsWith('/getOrderFoodList'))
          return Response.json({
            success: true,
            result: { ...emptyMeals(), lunchorders: [{ id: '1', name: 'rice', price: 2 }] },
          });
        return Response.json({ success: true, result: {} });
      });
      await expect(
        generate({ ...env, DB: db as unknown as D1Database, DEEPSEEK_API_KEY: 'test' }, 'current'),
      ).rejects.toThrow(invalid === 'invalid JSON' ? 'invalid or empty JSON' : 'invalid dish ID');
      expect(requests).toBe(2);
      expect(writes).not.toHaveBeenCalled();
    },
  );
});
