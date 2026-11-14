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
export interface RequestBudget {
  remaining: number;
}

interface CanteenSession {
  token: string;
  center: string;
  employee?: { empId: string; empType: string };
}

const sessionKey = 'canteenSession';
type SessionStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'delete'>;

class CanteenSessionExpired extends Error {
  constructor() {
    super('订餐登录已失效，请重试。如果仍然失败，请在官方微信订餐入口重新登录。');
  }
}

export class Canteen {
  private auth?: CanteenSession;
  private scope?: string;
  private refreshAvailable = true;

  constructor(
    private env: Env,
    private storage?: SessionStorage,
  ) {}

  private async authorize() {
    const env = this.env;
    if (
      !/^\d{7}$/.test(env.CANTEEN_USER_NO || '') ||
      !env.WECHAT_OPEN_ID ||
      !env.WECHAT_JSESSIONID
    ) {
      throw new Error('Configure the canteen account and WeChat session secrets before connecting');
    }
    const { result } = await this.send('/api/wechat/oauth', { openId: env.WECHAT_OPEN_ID }, 'POST');
    const { token, centerId, empId, empType } = result ?? {};
    if (typeof token !== 'string' || !token)
      throw new Error('Canteen authentication did not return a token');
    const session: CanteenSession = {
      token,
      center: String(centerId || env.WECHAT_CENTER_ID || '9053'),
    };
    if (empId != null && empType != null)
      session.employee = { empId: String(empId), empType: String(empType) };
    await this.storage?.put(sessionKey, { scope: this.scope, session });
    this.auth = session;
    return session;
  }

  private headers(auth?: CanteenSession): Headers {
    const h = new Headers({
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Origin: ORIGIN,
      'X-Requested-With': 'com.tencent.mm',
      Referer: `${ORIGIN}/order/`,
      Cookie: `JSESSIONID=${this.env.WECHAT_JSESSIONID}`,
    });
    if (auth) {
      h.set('X-Access-Token', auth.token);
      h.set('CENTER_ID', auth.center);
    }
    return h;
  }
  private async send(
    path: string,
    params: Record<string, string>,
    method: string,
    auth?: CanteenSession,
  ): Promise<Reply> {
    const url = new URL(path, ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const options: RequestInit = {
      method,
      headers: this.headers(auth),
      signal: AbortSignal.timeout(25_000),
    };
    const r = await fetch(url, options);
    if (r.status === 401) throw new CanteenSessionExpired();
    const text = await r.text();
    let payload: Reply;
    try {
      payload = JSON.parse(text) as Reply;
    } catch {
      throw new Error(`Canteen ${path}: HTTP ${r.status}, invalid JSON`);
    }
    if (String(payload?.code) === '401') throw new CanteenSessionExpired();
    if (!r.ok || !payload?.success)
      throw new Error(
        payload?.message || `Canteen ${path}: HTTP ${r.status}, code ${payload?.code ?? 'unknown'}`,
      );
    return payload;
  }

  async session<T>(operation: (client: Canteen) => Promise<T>): Promise<T> {
    this.refreshAvailable = true;
    if (this.storage && !this.auth) {
      const env = this.env;
      const identity = JSON.stringify([
        env.CANTEEN_USER_NO,
        env.WECHAT_OPEN_ID,
        env.WECHAT_JSESSIONID,
        env.WECHAT_CENTER_ID,
      ]);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
      this.scope = btoa(String.fromCharCode(...new Uint8Array(digest)));
      const saved = await this.storage.get<{ scope: string; session: CanteenSession }>(sessionKey);
      if (saved?.scope === this.scope) this.auth = saved.session;
      else if (saved) await this.storage.delete(sessionKey);
    }
    if (!this.auth) await this.authorize();
    return operation(this);
  }

  private async request(
    path: string,
    params: Record<string, string> | ((session: CanteenSession) => Record<string, string>),
    method = 'POST',
    retryOnExpiry = true,
  ): Promise<Reply> {
    while (true) {
      let auth = this.auth;
      if (!auth) {
        if (!this.refreshAvailable) throw new CanteenSessionExpired();
        this.refreshAvailable = false;
        auth = await this.authorize();
      }
      try {
        return await this.send(
          path,
          typeof params === 'function' ? params(auth) : params,
          method,
          auth,
        );
      } catch (e) {
        if (!(e instanceof CanteenSessionExpired)) throw e;
        this.auth = undefined;
        await this.storage?.delete(sessionKey);
        if (!retryOnExpiry || !this.refreshAvailable) throw e;
        console.info('Canteen rejected the cached OAuth token. Refreshing the session.');
      }
    }
  }

  async balance(): Promise<number> {
    const { result } = await this.request('/api/wechat/getUserInfo', ({ employee }) => {
      if (!employee?.empId || !employee.empType) throw new Error('订餐系统未返回账户信息');
      return employee;
    });
    const value: unknown = result?.eaccountvalue;
    const balance =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value.trim())
          ? Number(value)
          : NaN;
    if (!Number.isFinite(balance)) throw new Error('订餐系统未返回有效余额');
    return balance;
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
  async details(start: string, end: string, budget?: RequestBudget): Promise<Detail[]> {
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
        if (!budget.remaining) throw new Error('订餐记录页数过多，无法确认订单');
        budget.remaining--;
      }
    }
    throw new Error('Order history exceeds the page limit; narrow the date range');
  }
  async cancel(id: string) {
    return this.request(
      '/api/orderdata/cancelOrderDetail',
      { userno: this.env.CANTEEN_USER_NO, orderid: id },
      'POST',
      false,
    );
  }
  async order(entries: { date: string; meal: number; dish: Dish }[]) {
    if (!entries.length) return;
    // The existing client sends the literal text %27 as part of the data value;
    // URLSearchParams then encodes the percent sign for transport.
    const data = entries
      .map((e) => `${e.date}~${e.meal}~${e.dish.id}~1~'`)
      .join(',')
      .replaceAll("'", '%27');
    await this.request(
      '/api/orderdata/setOrder',
      { userno: this.env.CANTEEN_USER_NO, data },
      'POST',
      false,
    );
  }
}
