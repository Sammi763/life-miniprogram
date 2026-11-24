/*
 * v2.11 提醒矩阵的扫描语义（习惯打卡 / 账单还款）—— mysql 与 file 两驱动共用的唯一实现。
 * driver 只提供数据原语：getReminderCredits / listReminderSettings / listHabitReminderRecords /
 * listLiabilityAccounts / listBillRepayments / createReminder。
 * 同一账号同一提醒周期最多发送一次。结清使待发账单提醒暂停，撤回还款后复用原任务。
 */

const crypto = require('crypto');
const { isScheduled, isEntryDone } = require('../../miniprogram/utils/habit-utils');
const { billRepaymentCents, remainingBillCents } = require('../../miniprogram/utils/money-rules');

const REMINDER_PLAN_PREFIXES = { habit: 'habit:', bill: 'bill:' };
const BILL_WINDOW_DAYS = 2;

function reminderIdFor(ownerId, planId) {
  return crypto.createHash('sha256').update(JSON.stringify([ownerId, planId])).digest('hex').slice(0, 40);
}

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

function hasOutstandingHabits(records, today) {
  const entries = new Map();
  const definitions = [];
  for (const record of records) {
    if (record.deletedAt || !record.data) continue;
    const data = record.data;
    if (data.kind === 'def') definitions.push(record);
    if (data.kind === 'entry' && data.date === today) {
      const previous = entries.get(data.habitId);
      if (!previous || Number(previous.updatedAt) <= Number(record.updatedAt)) entries.set(data.habitId, record);
    }
  }
  return definitions.some((def) => isScheduled(def, today) && !isEntryDone(entries.get(def.id), def));
}

async function scanHabitReminders(store, today, now) {
  const currentNow = Number(now) || Date.now();
  if (!isReminderTemplateConfigured(store.config, 'habit')) return 0;
  const settingsList = await store.listReminderSettings();
  const due = settingsList.filter((item) => item.data && item.data.habitReminderEnabled === true &&
    habitReminderDueAt(today, item.data, store.config) <= currentNow);
  if (!due.length) return 0;
  const byOwner = new Map(due.map((item) => [item.ownerId, []]));
  for (const record of await store.listHabitReminderRecords(today)) {
    const records = byOwner.get(record.ownerId);
    if (records) records.push(record);
  }
  let created = 0;
  for (const item of due) {
    if (!hasOutstandingHabits(byOwner.get(item.ownerId), today)) continue;
    const credits = await store.getReminderCredits(item.ownerId);
    if (!(credits.habit > 0)) continue;
    const planId = REMINDER_PLAN_PREFIXES.habit + today;
    if (await store.reminderExistsFor(item.ownerId, planId)) continue;
    const dueAt = habitReminderDueAt(today, item.data, store.config);
    const onceId = reminderIdFor(item.ownerId, planId);
    if (await store.createReminder(item.ownerId, planId, { title: '今日还有习惯未达标，请记得打卡', dueAt, onceId })) created++;
  }
  return created;
}

async function billOutstanding(store, ownerId, accountId, dueDate) {
  const record = await store.getRecord(ownerId, 'accounts', accountId);
  const data = record && !record.deletedAt ? record.data : null;
  if (!data || data.kind !== 'liability' || !(data.currentBill > 0)) return false;
  const totals = billRepaymentCents(await store.listBillRepayments(ownerId));
  return remainingBillCents(data.currentBill, totals, accountId, dueDate) > 0;
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
  const paidByOwner = new Map();
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
    if (!paidByOwner.has(account.ownerId)) {
      paidByOwner.set(account.ownerId, billRepaymentCents(await store.listBillRepayments(account.ownerId)));
    }
    if (!remainingBillCents(currentBill, paidByOwner.get(account.ownerId), account.id, dueDate)) continue;
    const planId = REMINDER_PLAN_PREFIXES.bill + account.id + ':' + dueDate;
    const previous = await store.getLatestReminderForPlan(account.ownerId, planId);
    const title = String(data.name || '账单');
    if (previous) {
      if (previous.status === 'cancelled' && previous.lastError === 'bill_settled' &&
          await store.resumeCancelledReminder(account.ownerId, previous.id, 'bill_settled', title, Number(previous.dueAt))) created++;
      continue;
    }
    const onceId = reminderIdFor(account.ownerId, planId);
    if (await store.createReminder(account.ownerId, planId, { title, dueAt: currentNow, onceId })) created++;
  }
  return created;
}

module.exports = { billOutstanding, hasOutstandingHabits, nextBillDueDate, scanBillReminders, scanHabitReminders };
