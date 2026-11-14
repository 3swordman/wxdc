import { MEALS, type Dish, type FoodCategory, type MealMap } from './types';

/** Attach display metadata without changing IDs, availability, or order quantities. */
export function categorizeMenu(menu: MealMap, categories: FoodCategory[]): MealMap {
  const lookup = new Map(categories.map((category) => [category.id, category]));
  return Object.fromEntries(
    MEALS.map((meal) => [
      meal,
      (menu[meal] || []).map((dish) => {
        const category = dish.typeid == null ? undefined : lookup.get(String(dish.typeid));
        return category
          ? { ...dish, categoryName: category.name, categoryOrder: category.order }
          : dish;
      }),
    ]),
  ) as MealMap;
}

/** Group each dish under one category, preserving the upstream category order. */
export function groupDishesByCategory(dishes: Dish[]): { name: string; dishes: Dish[] }[] {
  const groups = new Map<string, { name: string; order: number; dishes: Dish[] }>();
  const seen = new Set<string>();
  for (const dish of dishes) {
    const dishId = String(dish.id);
    if (seen.has(dishId)) continue;
    seen.add(dishId);
    const name = dish.categoryName || '其他';
    const key = dish.categoryName ? String(dish.typeid ?? dish.categoryName) : '__other__';
    let group = groups.get(key);
    if (!group) {
      group = { name, order: dish.categoryOrder ?? Number.MAX_SAFE_INTEGER, dishes: [] };
      groups.set(key, group);
    }
    group.dishes.push(dish);
  }
  return [...groups.values()].sort((a, b) => a.order - b.order);
}
