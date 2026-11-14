import { MEALS, type Dish, type Env, type FoodCategory, type MealMap } from './types';

const ORIGIN = 'http://wxdc.szsy.cn';
const UA =
  'Mozilla/5.0 (Linux; Android 12; LIO-AN00 Build/HUAWEILIO-AN00; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.7444.173 Mobile Safari/537.36 XWEB/1420273 MMWEBSDK/20260201 MMWEBID/2946 MicroMessenger/8.0.69.3040(0x28004555) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64';
type Reply = { success?: boolean; code?: number; message?: string; result?: any };
export type Detail = {
  ORDERDATE: string;
  ORDERTYPE: string | number;
  ORDERSTATUS: string | number;
  DISHESNAME: string;
  ID: string;
  ORDERAMOUNT?: string;
};
export const active = (r: Detail) => !['3', '4'].includes(String(r.ORDERSTATUS));
export interface OrderHistoryBudget {
  extraPages: number;
}

export async function encryptedCredentials(user: string, password: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode('7Fpu9FSkjayCeqaE'),
    'AES-CBC',
    false,
    ['encrypt'],
  );
  const plaintext = encoder.encode(JSON.stringify({ userno: user, pwd: password }));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: encoder.encode('0123456789ABCDEF') },
    key,
    plaintext,
  );
  return btoa(String.fromCharCode(...new Uint8Array(ciphertext)));
}

export class Canteen {
  private token = '';
  private center: string;
  constructor(private env: Env) {
    if (
      !/^\d{7}$/.test(env.CANTEEN_USER_NO || '') ||
      !env.CANTEEN_PASSWORD ||
      !env.WECHAT_OPEN_ID ||
      !env.WECHAT_JSESSIONID
    ) {
      throw new Error('Configure the canteen account and WeChat session secrets before connecting');
    }
    this.center = env.WECHAT_CENTER_ID || '9053';
  }
  private headers(auth = false): Headers {
    const h = new Headers({
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: ORIGIN,
      'X-Requested-With': 'com.tencent.mm',
      Referer: `${ORIGIN}/order/`,
      Cookie: `JSESSIONID=${this.env.WECHAT_JSESSIONID}`,
    });
    if (auth) {
      h.set('X-Access-Token', this.token);
      h.set('CENTER_ID', this.center);
    }
    return h;
  }
  private async request(
    path: string,
    params: Record<string, string>,
    method = 'POST',
    auth = true,
    body?: FormData,
  ): Promise<Reply> {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const options: RequestInit = {
      method,
      headers: this.headers(auth),
      signal: AbortSignal.timeout(25_000),
    };
    if (body) options.body = body;
    const r = await fetch(url, options);
    const text = await r.text();
    let payload: Reply;
    try {
      payload = JSON.parse(text) as Reply;
    } catch {
      throw new Error(`Canteen ${path}: HTTP ${r.status}, invalid JSON`);
    }
    // Full authentication responses are retained for debugging as requested by the operator.
    if (path === '/api/wechat/oauth' || path === '/api/wechat/toBind')
      console.log(`Canteen ${path} response`, payload);
    if (!r.ok || !payload.success)
      throw new Error(
        payload.message || `Canteen ${path}: HTTP ${r.status}, code ${payload.code ?? 'unknown'}`,
      );
    return payload;
  }
  async session<T>(operation: (client: Canteen) => Promise<T>): Promise<T> {
    const form = new FormData();
    form.set('openId', this.env.WECHAT_OPEN_ID);
    form.set(
      'params',
      await encryptedCredentials(this.env.CANTEEN_USER_NO, this.env.CANTEEN_PASSWORD),
    );
    await this.request('/api/wechat/toBind', {}, 'POST', false, form);
    try {
      const auth = await this.request(
        '/api/wechat/oauth',
        { openId: this.env.WECHAT_OPEN_ID },
        'POST',
        false,
      );
      this.token = auth.result?.token;
      if (!this.token) throw new Error('Canteen authentication did not return a token');
      this.center = String(auth.result?.centerId || this.center);
      return await operation(this);
    } finally {
      if (this.token) {
        try {
          await this.request('/api/wechat/unBind', { userno: this.env.CANTEEN_USER_NO });
        } catch (e) {
          console.error('WeChat unbind failed', e);
        }
        this.token = '';
      }
    }
  }
  async menu(date: string): Promise<MealMap> {
    const data =
      (
        await this.request('/api/orderdata/getOrderFoodList', {
          selectdate: date,
          userno: this.env.CANTEEN_USER_NO,
          foodtype: '',
        })
      ).result || {};
    return Object.fromEntries(
      MEALS.map((m) => [m, Array.isArray(data[m]) ? data[m].filter((d: Dish) => !d.ydflag) : []]),
    ) as MealMap;
  }
  async foodCategories(): Promise<FoodCategory[]> {
    const result = (await this.request('/api/orderdata/getOrderFoodType', {}, 'GET')).result;
    if (!Array.isArray(result)) throw new Error('Canteen returned invalid food categories');
    return result.flatMap((item, order) =>
      item && item.id != null && typeof item.typename === 'string' && item.typename.trim()
        ? [{ id: String(item.id), name: item.typename.trim(), order }]
        : [],
    );
  }
  async booked(start: string, end: string): Promise<any[]> {
    const result = (
      await this.request(
        '/api/orderdata/getWeekBookData',
        { startdate: start, enddate: end, userno: this.env.CANTEEN_USER_NO },
        'GET',
      )
    ).result;
    return Array.isArray(result) ? result : [];
  }
  async details(start: string, end: string, budget?: OrderHistoryBudget): Promise<Detail[]> {
    const rows: Detail[] = [];
    for (let page = 1; page <= 30; page++) {
      const result =
        (
          await this.request('/api/orderdata/getOrderList', {
            userno: this.env.CANTEEN_USER_NO,
            starttime: start,
            endtime: end,
            page: String(page),
            querytype: '1',
            orderstatus: '',
          })
        ).result || {};
      if (budget && !Array.isArray(result.records)) throw new Error('订餐系统返回的订单记录无效');
      const batch = Array.isArray(result.records) ? result.records : [];
      rows.push(...batch);
      if (!batch.length || page >= Number(result.pages || 1)) return rows;
      if (budget) {
        if (!budget.extraPages) throw new Error('订餐记录页数过多，无法确认订单');
        budget.extraPages--;
      }
    }
    throw new Error('Order history exceeds the page limit; narrow the date range');
  }
  async cancel(id: string) {
    return this.request('/api/orderdata/cancelOrderDetail', {
      userno: this.env.CANTEEN_USER_NO,
      orderid: id,
    });
  }
  async order(entries: { date: string; meal: number; dish: Dish }[]) {
    if (!entries.length) return;
    // The existing client sends the literal text %27 as part of the data value;
    // URLSearchParams then encodes the percent sign for transport.
    const data = entries
      .map((e) => `${e.date}~${e.meal}~${e.dish.id}~1~'`)
      .join(',')
      .replaceAll("'", '%27');
    await this.request('/api/orderdata/setOrder', { userno: this.env.CANTEEN_USER_NO, data });
  }
}
