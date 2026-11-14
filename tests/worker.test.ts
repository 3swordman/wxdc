import { describe, expect, it, vi, afterEach } from 'vitest';
import { createCipheriv } from 'node:crypto';
import { Canteen, encryptedCredentials } from '../worker/canteen';
import { categorizeMenu, groupDishesByCategory } from '../worker/categories';
import { cleanSettings, validateSelection } from '../worker/engine';
import { addDays, defaults, emptyMeals, mondayFor, type Env } from '../worker/types';

const env = {
  CANTEEN_USER_NO: '1234567',
  CANTEEN_PASSWORD: 'example',
  WECHAT_OPEN_ID: 'openid',
  WECHAT_JSESSIONID: 'session',
  WECHAT_CENTER_ID: '9053',
} as Env;
afterEach(() => vi.restoreAllMocks());
describe('canteen binding', () => {
  it('encrypts credentials compatibly with AES-CBC and PKCS7', async () => {
    const cipher = createCipheriv(
      'aes-128-cbc',
      Buffer.from('7Fpu9FSkjayCeqaE'),
      Buffer.from('0123456789ABCDEF'),
    );
    const expected = Buffer.concat([
      cipher.update(JSON.stringify({ userno: '1234567', pwd: 'example' })),
      cipher.final(),
    ]).toString('base64');
    expect(await encryptedCredentials('1234567', 'example')).toBe(expected);
  });
  it('stops immediately on a locked account instead of continuing to oauth', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, code: 500, message: '账号被锁定' }), {
        status: 200,
      }),
    );
    await expect(new Canteen(env).session(async () => true)).rejects.toThrow('账号被锁定');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('binds, authenticates, runs, and unbinds in order', async () => {
    const mock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const path = new URL(String(input)).pathname;
      return Response.json(
        path.endsWith('/oauth')
          ? { success: true, result: { token: 'token', centerId: 9053 } }
          : { success: true, result: {} },
      );
    });
    expect(await new Canteen(env).session(async () => 42)).toBe(42);
    expect(mock.mock.calls.map((c) => new URL(String(c[0])).pathname)).toEqual([
      '/api/wechat/toBind',
      '/api/wechat/oauth',
      '/api/wechat/unBind',
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
    expect(mock.mock.calls.filter((call) => String(call[0]).includes('/toBind'))).toHaveLength(1);
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
              lunchorders: [{ id: 0, name: 'rice', price: 2, category: '菜品' }],
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
                  [monday]: { lunchorders: [{ id: 0, name: 'rice', price: 2 }] },
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      if (url.hostname === 'api.deepseek.com') {
        const prompt = JSON.parse(String(init?.body)).messages[0].content as string;
        const [day] = JSON.parse(prompt.split('\nMenus: ')[1]);
        prompts.push(day);
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  [day.date]: { lunchorders: [{ id: 0, name: 'rice', price: 2 }] },
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
    expect(prompts.map(({ date, recentMeals }) => ({ date, recentMeals }))).toEqual([
      { date: monday, recentMeals: [] },
      {
        date: tuesday,
        recentMeals: [{ date: monday, meal: 'lunchorders', name: 'rice', status: 'draft' }],
      },
    ]);
  });

  it('rejects invalid JSON without writing an order', async () => {
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
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const u = new URL(String(input));
      if (u.hostname === 'api.deepseek.com')
        return Response.json({ choices: [{ message: { content: 'not json' } }] });
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
    ).rejects.toThrow('invalid or empty JSON');
    expect(writes).not.toHaveBeenCalled();
  });
});
