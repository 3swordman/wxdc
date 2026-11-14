export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  COORDINATOR: DurableObjectNamespace;
  APP_PASSWORD: string;
  SESSION_SECRET: string;
  CANTEEN_USER_NO: string;
  CANTEEN_PASSWORD: string;
  WECHAT_OPEN_ID: string;
  WECHAT_JSESSIONID: string;
  WECHAT_CENTER_ID?: string;
  DEEPSEEK_API_KEY: string;
}
export const MEALS = ['breakfastorders', 'lunchorders', 'supperorders'] as const;
export type Meal = (typeof MEALS)[number];
export type Dish = {
  id: string | number;
  name: string;
  price: number;
  ydflag?: unknown;
  typeid?: string | number;
  categoryName?: string;
  categoryOrder?: number;
};
export type FoodCategory = { id: string; name: string; order: number };
export type MealMap = Record<Meal, Dish[]>;
export interface OrderDay {
  date: string;
  menu: MealMap;
  auto_order: MealMap;
  failed_items?: unknown[];
}
export interface AIOrderResult {
  ordered: string[];
  existing: string[];
  drafted: string[];
  unavailable: string[];
  failures: string[];
}
export interface Settings {
  scheduleEnabled: boolean;
  autoSubmit: boolean;
  requirements: string;
  days: Record<string, string>;
  exceptions: Record<string, string>;
}
export const defaults = (): Settings => ({
  scheduleEnabled: false,
  autoSubmit: false,
  requirements: '',
  days: {},
  exceptions: {},
});
export const emptyMeals = (): MealMap => ({
  breakfastorders: [],
  lunchorders: [],
  supperorders: [],
});
export const nowShanghai = (time = Date.now()) =>
  new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
export function mondayFor(week: 'current' | 'next', today = nowShanghai()): string {
  const day = new Date(`${today}T00:00:00Z`).getUTCDay();
  return addDays(today, ((8 - day) % 7 || 7) + (week === 'next' ? 7 : 0));
}
export function isDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
}
