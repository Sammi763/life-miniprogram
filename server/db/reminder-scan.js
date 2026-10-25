/*
 * v2.11 提醒矩阵的扫描语义（习惯打卡 / 账单还款）—— mysql 与 file 两驱动共用的唯一实现。
 * driver 只提供数据原语：getReminderCredits / listReminderSettings / listHabitEntryOwners /
 * listLiabilityAccounts / reminderExistsFor / createReminder。
 * 去重铁律：同 userId+kind+日期（账单为 账户+到期日）只存在一条提醒；已有任何状态（pending/
 * sent/failed/cancelled）即跳过，绝不重发。
 */

const REMINDER_PLAN_PREFIXES = { habit: 'habit:', bill: 'bill:' };
const BILL_WINDOW_DAYS = 2;

function pad2(value) { return String(value).padStart(2, '0'); }

function isReminderTemplateConfigured(config, kind) {
  if (!config || !config.wxAppId || !config.wxSecret) return false;
  if (kind === 'habit') return Boolean(config.wxHabitReminderTemplateId);
  if (kind === 'bill') return Boolean(config.wxBillReminderTemplateId);
  return false;
}

/* 用户设置的提醒时间（'HH:MM'）；缺省或非法时回退 config.habitReminderHour（默认 20 点整） */
function habitReminderDueAt(today, settingsData, config) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String((settingsData && settingsData.habitReminderTime) || ''));
  const fallbackHour = Math.min(23, Math.max(0, Number(config && config.habitReminderHour) || 20));
  const hour = match ? Number(match[1]) : fallbackHour;
  const minute = match ? Number(match[2]) : 0;
  return new Date(today + 'T' + pad2(hour) + ':' + pad2(minute) + ':00').getTime();
}

/* 到期日 = 今天起未来最近的 dueDay；月份无该日时截到月末（31 号在 30 天月按月末算） */
function nextBillDueDate(today, dueDay) {
  const [year, month, day] = today.split('-').map(Number);
  const lastDayOf = (y, m) => new Date(y, m, 0).getDate();
  let useYear = year;
  let useMonth = month;
  if (dueDay < day) {
    useMonth += 1;
    if (useMonth > 12) { useMonth = 1; useYear += 1; }
  }
  const dueDayClamped = Math.min(dueDay, lastDayOf(useYear, useMonth));
  return useYear + '-' + pad2(useMonth) + '-' + pad2(dueDayClamped);
}

async function scanHabitReminders(store, today, now) {
  const currentNow = Number(now) || Date.now();
  if (!isReminderTemplateConfigured(store.config, 'habit')) return 0;
  const settingsList = await store.listReminderSettings();
  const entryOwners = await store.listHabitEntryOwners(today);
  let created = 0;
  for (const item of settingsList) {
    if (!item.data || item.data.habitReminderEnabled !== true) continue;
    const credits = await store.getReminderCredits(item.ownerId);
    if (!(credits.habit > 0)) continue;
    if (entryOwners.has(item.ownerId)) continue;
    const planId = REMINDER_PLAN_PREFIXES.habit + today;
    if (await store.reminderExistsFor(item.ownerId, planId)) continue;
    const dueAt = habitReminderDueAt(today, item.data, store.config);
    if (dueAt > currentNow) continue;
    await store.createReminder(item.ownerId, planId, { title: '今日习惯还未打卡', dueAt });
    created++;
  }
  return created;
}

async function scanBillReminders(store, today, now) {
  const currentNow = Number(now) || Date.now();
  if (!isReminderTemplateConfigured(store.config, 'bill')) return 0;
  const settingsList = await store.listReminderSettings();
  const enabledOwners = new Set(settingsList.filter((item) => item.data && item.data.billReminderEnabled === true).map((item) => item.ownerId));
  if (!enabledOwners.size) return 0;
  const accounts = await store.listLiabilityAccounts();
  const todayMidnight = new Date(today + 'T00:00:00').getTime();
  let created = 0;
  for (const account of accounts) {
    if (!enabledOwners.has(account.ownerId)) continue;
    const data = account.data || {};
    const dueDay = Number(data.dueDay) || 0;
    const currentBill = Number(data.currentBill) || 0;
    if (data.kind !== 'liability' || !dueDay || !(currentBill > 0)) continue;
    const credits = await store.getReminderCredits(account.ownerId);
    if (!(credits.bill > 0)) continue;
    const dueDate = nextBillDueDate(today, dueDay);
    const daysLeft = Math.round((new Date(dueDate + 'T00:00:00').getTime() - todayMidnight) / 86400000);
    if (daysLeft < 0 || daysLeft > BILL_WINDOW_DAYS) continue;
    const planId = REMINDER_PLAN_PREFIXES.bill + account.id + ':' + dueDate;
    if (await store.reminderExistsFor(account.ownerId, planId)) continue;
    const title = (String(data.name || '账单') + '还款提醒').slice(0, 20);
    await store.createReminder(account.ownerId, planId, { title, dueAt: currentNow });
    created++;
  }
  return created;
}

module.exports = { nextBillDueDate, scanBillReminders, scanHabitReminders };
