/* 月度统计只读取已同步到本地的记录；AI 一句话由页面通过受保护接口按需请求。 */
const { derivePlanOccurrences, valuesOfRecords } = require('./plan-utils');
const { buildMemorySummary } = require('./memory-utils');
const { buildCategoryBudgetProgress } = require('./ledger-utils');
// 金额显示全应用统一走 finance.formatMoney（整数不带小数、小数去末尾 0），
// 不能再各页各写一套：这里原先「整数原样、否则两位」会和记账页的 ¥54.5 打架。
const { toCents, fromCents } = require('./amount');
const { formatMoney } = require('./finance');
const { isEntryDone, isScheduled } = require('./habit-utils');

function monthBounds(month) {
  const match = String(month || '').match(/^(\d{4})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const index = Number(match[2]) - 1;
  if (index < 0 || index > 11) return null;
  const first = new Date(year, index, 1);
  const last = new Date(year, index + 1, 0);
  return {
    start: month + '-01',
    end: year + '-' + String(index + 1).padStart(2, '0') + '-' + String(last.getDate()).padStart(2, '0'),
    previous: new Date(year, index - 1, 1).getFullYear() + '-' + String(new Date(year, index - 1, 1).getMonth() + 1).padStart(2, '0')
  };
}

function recordData(records) {
  return valuesOfRecords(records).map((record) => ({ id: record.id, ...record.data, updatedAt: record.updatedAt }));
}

function oneDecimal(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function sumMoney(records, prefix) {
  let income = 0;
  let expense = 0;
  const byCategory = Object.create(null);
  const byDate = {};
  records.forEach((item) => {
    if (String(item.date || '').slice(0, 7) !== prefix) return;
    const amount = toCents(item.amount);
    if (!(amount > 0)) return;
    if (item.type === 'income') income += amount;
    if (item.type === 'expense') {
      expense += amount;
      const category = String(item.category || '其他');
      byCategory[category] = (byCategory[category] || 0) + amount;
    }
    // 支出趋势不应把“只有收入”的日期渲染为 ¥0；收入仍照常计入收支与结余。
    const date = String(item.date || '');
    if (date && item.type === 'expense') byDate[date] = (byDate[date] || 0) + amount;
  });
  return { income, expense, byCategory, byDate };
}

function habitSummary(records, bounds) {
  const definitions = records.filter((item) => item.kind === 'def' && item.id);
  const entries = {};
  records.filter((item) => item.kind === 'entry' && item.habitId && item.date >= bounds.start && item.date <= bounds.end)
    .forEach((item) => { entries[item.habitId + '|' + item.date] = item; });
  const days = Number(bounds.end.slice(-2));
  let total = 0;
  let done = 0;
  definitions.forEach((definition) => {
    for (let day = 1; day <= days; day++) {
      const date = bounds.start.slice(0, 8) + String(day).padStart(2, '0');
      if (!isScheduled(definition, date)) continue;
      total++;
      const entry = entries[definition.id + '|' + date];
      if (isEntryDone(entry, definition)) done++;
    }
  });
  return { total, done, rate: total ? oneDecimal(done * 100 / total) : 0 };
}

function weightSummary(records, bounds) {
  const weights = records.filter((item) => item.kind === 'weight' && item.date >= bounds.start && item.date <= bounds.end && Number(item.weight) > 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)) || Number(a.updatedAt) - Number(b.updatedAt));
  if (!weights.length) return { start: 0, end: 0, change: 0, hasData: false };
  const first = Number(weights[0].weight);
  const last = Number(weights[weights.length - 1].weight);
  return { start: oneDecimal(first), end: oneDecimal(last), change: oneDecimal(last - first), hasData: true };
}

function mediaSummary(records, bounds) {
  const done = records.filter((item) => item.status === 'done' && item.date >= bounds.start && item.date <= bounds.end);
  const rated = done.filter((item) => Number(item.rating) > 0);
  return {
    completed: done.length,
    averageRating: rated.length ? oneDecimal(rated.reduce((sum, item) => sum + Number(item.rating), 0) / rated.length) : 0
  };
}

function buildSummary(finance, life) {
  /*
   * 比率沿用与页面一致的一位小数写法：页面上直接绑定 {{finance.budgetUsed}}%，
   * 未经 toFixed 时会渲染成「0%」，而这里写 toFixed(1) 会渲染成「0.0%」，
   * 同一屏的两处百分比就打架了。用 String(Number) 的形式保持两边一致。
   */
  const rateText = (value) => String(oneDecimal(value));
  const financeSentence = '本月收入 ¥' + formatMoney(finance.income) + '，支出 ¥' + formatMoney(finance.expense) + '，结余 ¥' + formatMoney(finance.balance) + '。';
  const budgetSentence = finance.budget > 0 ? '预算已使用 ' + rateText(finance.budgetUsed) + '%。' : '本月尚未设置预算。';
  const lifeSentence = '习惯达标率 ' + rateText(life.habit.rate) + '%，日程完成率 ' + rateText(life.plan.rate) + '%。';
  const weightSentence = life.weight.hasData ? '体重变化 ' + (life.weight.change > 0 ? '+' : '') + life.weight.change.toFixed(1) + ' kg。' : '本月没有体重记录。';
  const mediaSentence = '本月完成 ' + life.media.completed + ' 部书影音' + (life.media.averageRating ? '，平均评分 ' + life.media.averageRating.toFixed(1) + ' 分。' : '。');
  const memorySentence = life.memory.count ? '留下 ' + life.memory.count + ' 条文字记忆，跨越 ' + life.memory.days + ' 天。' : '这个月还没有留下随记。';
  const overspentSentence = finance.overspent.length ? '分类预算超出：' + finance.overspent.map((item) => item.category).join('、') + '。' : '';
  return financeSentence + budgetSentence + overspentSentence + lifeSentence + weightSentence + mediaSentence + memorySentence;
}

function buildMonthlyReport(source, month) {
  const bounds = monthBounds(month);
  if (!bounds) throw new Error('invalid_month');
  const money = recordData(source && source.money);
  const current = sumMoney(money, month);
  const previous = sumMoney(money, bounds.previous);
  const settings = recordData(source && source.settings);
  const appSettings = settings.find((item) => item.id === 'app') || settings[0] || {};
  const budget = Math.max(0, toCents(appSettings.budget) || 0);
  const categoryBudget = buildCategoryBudgetProgress(money, appSettings.categoryBudgets, month);
  const occurrences = derivePlanOccurrences(source && source.plan, bounds.start, bounds.end);
  const planRelevant = occurrences.filter((item) => !item.skipped);
  const planDone = planRelevant.filter((item) => item.done).length;
  const finance = {
    income: fromCents(current.income),
    expense: fromCents(current.expense),
    balance: fromCents(current.income - current.expense),
    budget: fromCents(budget),
    budgetUsed: budget ? oneDecimal(current.expense * 100 / budget) : 0,
    incomeChange: fromCents(current.income - previous.income),
    expenseChange: fromCents(current.expense - previous.expense),
    categoryBudgets: categoryBudget.rows,
    overspent: categoryBudget.overspent,
    topCategories: Object.keys(current.byCategory).map((category) => ({ category, amount: fromCents(current.byCategory[category]) }))
      .sort((a, b) => b.amount - a.amount || a.category.localeCompare(b.category, 'zh-Hans-CN')).slice(0, 3),
    dailyTrend: Object.keys(current.byDate).sort().map((date) => ({ date, amount: fromCents(current.byDate[date]) }))
  };
  const life = {
    habit: habitSummary(recordData(source && source.habit), bounds),
    plan: { total: planRelevant.length, done: planDone, rate: planRelevant.length ? oneDecimal(planDone * 100 / planRelevant.length) : 0 },
    weight: weightSummary(recordData(source && source.fitness), bounds),
    media: mediaSummary(recordData(source && source.media), bounds),
    memory: buildMemorySummary(source && source.memories, month)
  };
  return { month, finance, life, summary: buildSummary(finance, life) };
}

module.exports = { buildMonthlyReport, monthBounds };
