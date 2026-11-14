import './style.css';
import { groupDishesByCategory } from '../worker/categories';
import {
  MEALS,
  emptyMeals,
  type AIOrderResult,
  type MealMap,
  type OrderDay,
  type Settings,
} from '../worker/types';

const app = document.querySelector<HTMLDivElement>('#app')!;
const labels = ['早餐', '午餐', '晚餐'];
const days = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const chars = ['b', 'l', 's'];
const scheduleHours = '每天 08:00 和 18:00（北京时间）';
const esc = (s: unknown) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const response = await fetch(path, { ...init, headers });
  const data: any = await response.json().catch(() => ({ message: '服务器响应无效' }));
  if (!response.ok)
    throw new Error(data.message || data.failures?.join('；') || `HTTP ${response.status}`);
  return data as T;
}
function report(e: unknown) {
  alert(e instanceof Error ? e.message : String(e));
}
function shell(content: string, current = '') {
  app.innerHTML = `<div class="min-h-screen"><header class="border-b border-base-300 bg-base-100"><div class="mx-auto max-w-6xl px-5 py-4 sm:flex sm:items-center sm:justify-between"><a href="#home" class="text-xl font-bold tracking-tight">WXDC <span class="text-sm font-normal text-base-content/60">订餐助手</span></a><nav class="mt-3 flex flex-wrap gap-2 sm:mt-0"><a class="btn btn-sm ${current === 'home' ? 'btn-active' : 'btn-ghost'}" href="#home">首页</a><a class="btn btn-sm ${current === 'settings' ? 'btn-active' : 'btn-ghost'}" href="#settings">订餐设置</a><a class="btn btn-sm ${current === 'live' ? 'btn-active' : 'btn-ghost'}" href="#live">每日订单</a><button id="logout" class="btn btn-sm btn-ghost">退出</button></nav></div></header><main class="mx-auto max-w-6xl px-5 py-8">${content}</main></div>`;
  document.querySelector('#logout')?.addEventListener('click', async () => {
    try {
      await api('/api/logout', { method: 'POST' });
      login();
    } catch (e) {
      report(e);
    }
  });
}
function login() {
  app.innerHTML = `<main class="min-h-screen grid place-items-center p-5"><div class="card card-border bg-base-100 w-full max-w-md shadow-sm"><div class="card-body gap-4"><p class="text-sm font-medium text-base-content/60">WXDC</p><h1 class="card-title text-2xl">登录订餐助手</h1><p class="text-base-content/70">使用部署时设置的应用密码。</p><form id="login" class="grid gap-4"><label><span class="mb-2 block text-sm font-medium">应用密码</span><input name="password" type="password" autocomplete="current-password" required class="input w-full" /></label><button class="btn btn-primary w-full" type="submit">登录</button><div id="login-error" role="alert" class="text-error text-sm"></div></form></div></div></main>`;
  document.querySelector<HTMLFormElement>('#login')!.onsubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget as HTMLFormElement;
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({ password: new FormData(form).get('password') }),
      });
      location.hash = 'home';
      await home();
    } catch (err) {
      document.querySelector('#login-error')!.textContent =
        err instanceof Error ? err.message : String(err);
    }
  };
}
async function home(result?: AIOrderResult) {
  const [settings, orders, jobs] = await Promise.all([
    api<Settings>('/api/settings'),
    api<{ week_start: string; updated_at: string }[]>('/api/orders'),
    api<{ created_at: string; status: string; message: string }[]>('/api/jobs'),
  ]);
  shell(
    `<div class="mb-8 sm:flex sm:items-end sm:justify-between"><div><p class="text-sm font-medium text-base-content/60">YOUR MEAL PLANNER</p><h1 class="mt-1 text-3xl font-bold">今天吃什么？</h1><p class="mt-2 text-base-content/70">管理订餐偏好，查看菜单并确认订单。</p></div><div class="mt-4 flex flex-wrap gap-2 sm:mt-0"><button id="ai-order" type="button" class="btn btn-primary">AI 立即订餐</button><a href="#settings" class="btn">设置订餐偏好 →</a></div></div>
  <div id="ai-order-status" role="status" class="alert mb-5 sm:alert-horizontal" hidden><span></span></div>
  <div class="grid gap-4 md:grid-cols-3"><section class="card card-border bg-base-100"><div class="card-body"><p class="text-sm text-base-content/60">定时生成</p><h2 class="text-xl font-semibold">${settings.scheduleEnabled ? '已开启' : '未开启'}</h2><p class="text-sm text-base-content/60">${scheduleHours}</p></div></section><section class="card card-border bg-base-100"><div class="card-body"><p class="text-sm text-base-content/60">自动提交</p><h2 class="text-xl font-semibold">${settings.autoSubmit ? '已开启' : '未开启'}</h2><p class="text-sm text-base-content/60">${settings.autoSubmit ? '定时生成后将提交订单' : '生成后由你手动确认'}</p></div></section><section class="card card-border bg-base-100"><div class="card-body"><p class="text-sm text-base-content/60">待确认订单</p><h2 class="text-xl font-semibold">${orders.length} 份</h2><p class="text-sm text-base-content/60">已保存的周订单</p></div></section></div>
  <section class="mt-8 card card-border bg-base-100"><div class="card-body"><div class="sm:flex sm:items-center sm:justify-between"><div><h2 class="card-title">待提交订单</h2><p class="mt-1 text-sm text-base-content/60">选择日期，核对菜品并提交。</p></div><div class="mt-4 flex gap-2 sm:mt-0"><button id="generate-current" class="btn btn-sm">生成本周</button><button id="generate-next" class="btn btn-sm">生成下周</button></div></div><div class="mt-4 divide-y divide-base-300">${orders.length ? orders.map((o) => `<a href="#order/${esc(o.week_start)}" class="flex items-center justify-between py-4 hover:opacity-70"><span><strong>${esc(o.week_start)}</strong><span class="ml-2 text-sm text-base-content/60">周订单</span></span><span>查看 →</span></a>`).join('') : '<p class="py-5 text-sm text-base-content/60">暂无待提交订单。请先设置订餐日期，再生成订单。</p>'}</div></div></section>
  <section class="mt-6 card card-border bg-base-100"><div class="card-body"><h2 class="card-title">最近活动</h2>${jobs.length ? jobs.map((j) => `<div class="flex justify-between gap-4 border-b border-base-200 py-2 text-sm"><span>${esc(j.message)}</span><span class="shrink-0 text-base-content/60">${esc(j.status)}</span></div>`).join('') : '<p class="text-sm text-base-content/60">暂无活动记录</p>'}</div></section>`,
    'home',
  );
  const aiButton = document.querySelector<HTMLButtonElement>('#ai-order')!;
  const aiStatus = document.querySelector<HTMLDivElement>('#ai-order-status')!;
  if (result) {
    aiStatus.hidden = false;
    aiStatus.classList.toggle('alert-warning', !!result.failures.length);
    aiStatus.querySelector('span')!.textContent =
      `AI 订餐完成。已提交 ${result.ordered.length} 天，跳过已有订单 ${result.existing.length} 天，未供餐 ${result.unavailable.length} 天。` +
      (result.failures.length ? ` ${result.failures.join('；')}` : '');
  }
  aiButton.addEventListener('click', async () => {
    if (!confirm('立即检查订餐计划，并为符合条件的日期提交真实订单？')) return;
    aiButton.disabled = true;
    aiButton.textContent = 'AI 正在订餐…';
    try {
      const out = await api<AIOrderResult>('/api/ai-order', { method: 'POST' });
      if (aiButton.isConnected) await home(out);
    } catch (e) {
      if (aiButton.isConnected) report(e);
    } finally {
      aiButton.disabled = false;
      aiButton.textContent = 'AI 立即订餐';
    }
  });
  for (const week of ['current', 'next'])
    document.querySelector(`#generate-${week}`)!.addEventListener('click', async (e) => {
      const b = e.currentTarget as HTMLButtonElement;
      b.disabled = true;
      b.textContent = '正在生成…';
      try {
        const result = await api<{ week: string }>('/api/generate', {
          method: 'POST',
          body: JSON.stringify({ week }),
        });
        location.hash = `order/${result.week}`;
      } catch (err) {
        report(err);
        b.disabled = false;
        b.textContent = week === 'current' ? '生成本周' : '生成下周';
      }
    });
}
async function settingsPage() {
  const settings = await api<Settings>('/api/settings');
  const grid = (offset: number) =>
    `<div class="overflow-x-auto"><table class="table"><thead><tr><th>日期</th>${labels.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>${days.map((d, i) => `<tr><th>${d}</th>${chars.map((c, k) => `<td><input aria-label="${d}${labels[k]}" class="checkbox checkbox-sm" type="checkbox" name="day-${i + offset}" value="${c}" ${(settings.days[String(i + offset)] || '').includes(c) ? 'checked' : ''}></td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  shell(
    `<div class="mb-7"><a href="#home" class="text-sm text-base-content/60">← 返回首页</a><h1 class="mt-3 text-3xl font-bold">订餐设置</h1><p class="mt-2 text-base-content/70">选择每周餐次，特殊日期会覆盖常规设置。</p></div><form id="settings-form" class="grid gap-5"><section class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">本周</h2>${grid(1)}<h2 class="card-title mt-5">下周提前订餐</h2>${grid(8)}</div></section><section class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">特殊日期</h2><p class="text-sm text-base-content/60">每行填写日期和餐次字母，例如 2026-11-16 bl。留空餐次表示当天不订餐。</p><textarea class="textarea w-full" name="exceptions" rows="4" placeholder="2026-11-16 bl">${esc(
      Object.entries(settings.exceptions)
        .map(([d, m]) => `${d} ${m}`)
        .join('\n'),
    )}</textarea></div></section><section class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">订餐规则</h2><p class="text-sm text-base-content/60">告诉 DeepSeek 你的偏好和忌口。</p><textarea class="textarea w-full" name="requirements" rows="5">${esc(settings.requirements)}</textarea></div></section><section class="card card-border bg-base-100"><div class="card-body"><h2 class="card-title">自动化</h2><label class="flex items-center justify-between gap-4 py-2"><span><strong>定时生成</strong><span class="block text-sm text-base-content/60">${scheduleHours}</span></span><input class="toggle" type="checkbox" name="scheduleEnabled" ${settings.scheduleEnabled ? 'checked' : ''}></label><label class="flex items-center justify-between gap-4 py-2"><span><strong>自动提交</strong><span class="block text-sm text-base-content/60">定时生成后提交真实订单</span></span><input class="toggle" type="checkbox" name="autoSubmit" ${settings.autoSubmit ? 'checked' : ''}></label></div></section><div><button class="btn btn-primary" type="submit">保存设置</button></div></form>`,
    'settings',
  );
  document.querySelector<HTMLFormElement>('#settings-form')!.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.currentTarget as HTMLFormElement,
      fd = new FormData(f),
      data: Settings = {
        scheduleEnabled: fd.has('scheduleEnabled'),
        autoSubmit: fd.has('autoSubmit'),
        requirements: String(fd.get('requirements') || ''),
        days: {},
        exceptions: {},
      };
    for (let i = 1; i <= 14; i++) data.days[String(i)] = fd.getAll(`day-${i}`).join('');
    for (const line of String(fd.get('exceptions') || '')
      .split('\n')
      .map((x) => x.trim())
      .filter(Boolean)) {
      const m = line.match(/^(\d{4}-\d{2}-\d{2})(?:\s+([bls]*))?$/);
      if (!m) {
        report(`无效特殊日期: ${line}`);
        return;
      }
      data.exceptions[m[1]] = m[2] || '';
    }
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(data) });
      alert('设置已保存');
      location.hash = 'home';
    } catch (err) {
      report(err);
    }
  };
}
function selectionTable(date: string, menu: MealMap, selected: MealMap) {
  return `<div class="space-y-4"><h2 class="text-lg font-semibold">${esc(date)}</h2>${MEALS.map(
    (meal, mi) =>
      `<div><h3 class="mb-2 text-sm font-semibold">${labels[mi]}</h3>${
        menu[meal].length
          ? `<div class="space-y-4">${groupDishesByCategory(menu[meal])
              .map(
                (category) =>
                  `<section><h4 class="mb-2 text-sm font-medium text-base-content/70">${esc(category.name)}</h4><div class="grid gap-2 sm:grid-cols-2">${category.dishes
                    .map((d) => {
                      const count = selected[meal].filter(
                        (x) => String(x.id) === String(d.id),
                      ).length;
                      return `<label class="flex items-center justify-between gap-3 rounded-box border border-base-300 px-3 py-2"><span>${esc(d.name)} <span class="text-sm text-base-content/60">¥${esc(d.price)}</span></span><input class="input input-sm w-20" type="number" min="0" max="10" value="${count}" data-meal="${meal}" data-dish="${esc(d.id)}" aria-label="${esc(d.name)} 数量" /></label>`;
                    })
                    .join('')}</div></section>`,
              )
              .join('')}</div>`
          : '<p class="text-sm text-base-content/50">该餐暂无菜品</p>'
      }</div>`,
  ).join('')}</div>`;
}
function collectSelection(container: Element, menu: MealMap): MealMap {
  const out = emptyMeals();
  container.querySelectorAll<HTMLInputElement>('[data-meal][data-dish]').forEach((input) => {
    const meal = input.dataset.meal as keyof MealMap;
    const dish = menu[meal].find((d) => String(d.id) === input.dataset.dish);
    const count = Number(input.value);
    if (!dish || !Number.isInteger(count) || count < 0 || count > 10)
      throw new Error('菜品数量必须介于 0 和 10');
    for (let i = 0; i < count; i++) out[meal].push(dish);
  });
  return out;
}
async function orderPage(week: string) {
  const order = await api<OrderDay[]>(`/api/orders/${encodeURIComponent(week)}`);
  shell(
    `<div class="mb-7"><a href="#home" class="text-sm text-base-content/60">← 返回首页</a><h1 class="mt-3 text-3xl font-bold">${esc(week)} 周订单</h1><p class="mt-2 text-base-content/70">修改数量，保存后再提交到订餐系统。</p></div><div id="order-days" class="grid gap-4">${order.map((d, i) => `<section class="order-day card card-border bg-base-100" data-index="${i}"><div class="card-body">${selectionTable(d.date, d.menu, d.auto_order)}</div></section>`).join('')}</div><div class="mt-5 flex flex-wrap gap-3"><button id="save-order" class="btn">保存修改</button><button id="submit-order" class="btn btn-primary">提交订单</button><button id="status-order" class="btn">刷新订餐状态</button><button id="delete-order" class="btn btn-ghost">删除待提交订单</button></div><div id="order-result" class="mt-4"></div>`,
  );
  const save = async () => {
    const edited = order.map((d, i) => ({
      ...d,
      auto_order: collectSelection(
        document.querySelector(`.order-day[data-index="${i}"]`)!,
        d.menu,
      ),
    }));
    await api(`/api/orders/${week}`, { method: 'PUT', body: JSON.stringify({ days: edited }) });
  };
  document.querySelector('#save-order')!.addEventListener('click', async () => {
    try {
      await save();
      alert('已保存');
    } catch (e) {
      report(e);
    }
  });
  document.querySelector('#submit-order')!.addEventListener('click', async () => {
    if (!confirm('确认将这些菜品提交到订餐系统？')) return;
    try {
      await save();
      const result = await api<{ ordered: string[] }>(`/api/orders/${week}/submit`, {
        method: 'POST',
      });
      alert(`提交并确认成功（新增 ${result.ordered.length} 项）`);
      location.hash = 'home';
    } catch (e) {
      report(e);
    }
  });
  document.querySelector('#delete-order')!.addEventListener('click', async () => {
    if (!confirm('确认删除这份待提交订单？已提交的订单不会改变。')) return;
    try {
      await api(`/api/orders/${week}`, { method: 'DELETE' });
      location.hash = 'home';
    } catch (e) {
      report(e);
    }
  });
  document.querySelector('#status-order')!.addEventListener('click', async () => {
    try {
      const rows = await api<{ date: string; meal: number; name: string }[]>(
        `/api/orders/${week}/status`,
      );
      document.querySelector('#order-result')!.innerHTML =
        `<div class="alert"><span>${rows.length ? rows.map((r) => esc(`${r.date} ${labels[r.meal]} ${r.name}`)).join('<br>') : '查询范围内暂无已订菜品'}</span></div>`;
    } catch (e) {
      report(e);
    }
  });
}
async function livePage(date = today()) {
  shell(
    `<div class="mb-7"><a href="#home" class="text-sm text-base-content/60">← 返回首页</a><h1 class="mt-3 text-3xl font-bold">每日菜单与订单</h1><p class="mt-2 text-base-content/70">查看并调整已经提交的餐品。</p></div><section class="card card-border bg-base-100"><div class="card-body"><form id="date-form" class="flex flex-wrap items-end gap-3"><label><span class="mb-2 block text-sm font-medium">选择日期</span><input type="date" name="date" class="input" value="${esc(date)}" required></label><button class="btn" type="submit">查看</button></form><div id="live-content" class="mt-5 text-base-content/60">正在加载…</div></div></section><section class="card card-border bg-base-100 mt-5"><div class="card-body"><h2 class="card-title">按日期查询已订餐品</h2><form id="range-form" class="flex flex-wrap items-end gap-3"><label><span class="mb-2 block text-sm font-medium">开始日期</span><input type="date" name="start" class="input" value="${esc(date)}" required></label><label><span class="mb-2 block text-sm font-medium">结束日期</span><input type="date" name="end" class="input" value="${esc(date)}" required></label><button class="btn" type="submit">查询订单</button></form><div id="range-result" class="mt-4"></div></div></section>`,
    'live',
  );
  document.querySelector<HTMLFormElement>('#range-form')!.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget as HTMLFormElement);
    const target = document.querySelector('#range-result')!;
    try {
      const out = await api<{
        details: { ORDERDATE: string; ORDERTYPE: string | number; DISHESNAME: string }[];
      }>(
        `/api/overview?start=${encodeURIComponent(String(fd.get('start')))}&end=${encodeURIComponent(String(fd.get('end')))}`,
      );
      target.innerHTML = out.details.length
        ? out.details
            .map(
              (x) =>
                `<p class="border-b border-base-200 py-2">${esc(x.ORDERDATE)} · ${esc(labels[Number(x.ORDERTYPE)] || '其他')} · ${esc(x.DISHESNAME)}</p>`,
            )
            .join('')
        : '<p class="text-base-content/60">该日期范围内暂无订单。</p>';
    } catch (err) {
      report(err);
    }
  };
  document.querySelector<HTMLFormElement>('#date-form')!.onsubmit = (e) => {
    e.preventDefault();
    const date = new FormData(e.currentTarget as HTMLFormElement).get('date');
    location.hash = `live/${date}`;
  };
  const target = document.querySelector('#live-content')!;
  try {
    const result = await api<{
      menu: MealMap;
      records: { DISHESNAME: string; ORDERTYPE: string | number }[];
    }>(`/api/live?date=${encodeURIComponent(date)}`);
    const selected = emptyMeals();
    const missing: string[] = [];
    for (const r of result.records) {
      const meal = MEALS[Number(r.ORDERTYPE)];
      if (!meal) continue;
      const dish = result.menu[meal].find((x) => x.name === r.DISHESNAME);
      if (dish) selected[meal].push(dish);
      else missing.push(r.DISHESNAME);
    }
    target.innerHTML = `${missing.length ? `<div class="alert alert-warning mb-4"><span>已订菜品不在当前菜单中，暂不能安全修改：${missing.map(esc).join('、')}</span></div>` : ''}<div id="live-selection">${selectionTable(date, result.menu, selected)}</div><button id="apply-live" class="btn btn-primary mt-6" ${missing.length ? 'disabled' : ''}>提交修改</button>`;
    document.querySelector('#apply-live')!.addEventListener('click', async () => {
      if (!confirm('将同步此日期的订单，包括取消不再选择的菜品。确认继续？')) return;
      try {
        const auto_order = collectSelection(target, result.menu);
        const out = await api<{ cancelled: string[]; ordered: string[] }>('/api/live', {
          method: 'POST',
          body: JSON.stringify({ date, auto_order }),
        });
        alert(`已取消 ${out.cancelled.length} 项，新增 ${out.ordered.length} 项，结果已确认。`);
        await livePage(date);
      } catch (e) {
        report(e);
      }
    });
  } catch (e) {
    target.innerHTML = `<div class="alert alert-error"><span>${esc(e instanceof Error ? e.message : e)}</span></div>`;
  }
}
async function route() {
  try {
    await api('/api/session');
    const [page, arg] = location.hash.slice(1).split('/');
    if (page === 'settings') await settingsPage();
    else if (page === 'order' && arg) await orderPage(arg);
    else if (page === 'live') await livePage(arg || today());
    else await home();
  } catch (e) {
    if (e instanceof Error && e.message === '请先登录') login();
    else {
      shell(
        `<div class="alert alert-error"><span>${esc(e instanceof Error ? e.message : e)}</span></div>`,
      );
    }
  }
}
window.addEventListener('hashchange', () => {
  void route();
});
void route();
