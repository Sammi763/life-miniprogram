const { billOutstanding, hasOutstandingHabits } = require('./db/reminder-scan');
const crypto = require('crypto');
const { sendSubscriptionMessage } = require('./wechat');

/*
 * 提醒 worker（v2.11 提醒矩阵扩展）：
 * - 原有「单次日程提醒」能力不变（wxReminderTemplateId，落地 pages/plan/plan）
 * - 新增两类「扫描生成」提醒：习惯打卡（planId 前缀 habit:）与账单还款（planId 前缀 bill:）
 *   模板分别在 wxHabitReminderTemplateId / wxBillReminderTemplateId；未配置的 kind 静默停用。
 * - 每轮 runOnce 先跑两类扫描（生成 due 的提醒行），再走既有 claim → send → finish 循环；
 *   发送成功后按 kind 扣减订阅额度（一次订阅授权 = 一次触达）。
 */

function planReminderEnabled(config) {
  return Boolean(config.wxAppId && config.wxSecret && config.wxReminderTemplateId);
}

function reminderKindEnabled(config, kind) {
  if (!config.wxAppId || !config.wxSecret) return false;
  if (kind === 'habit') return Boolean(config.wxHabitReminderTemplateId);
  if (kind === 'bill') return Boolean(config.wxBillReminderTemplateId);
  return false;
}

function getReminderCapabilities(config) {
  const enabled = planReminderEnabled(config);
  return { enabled, templateId: enabled ? config.wxReminderTemplateId : '' };
}

function anyReminderKindEnabled(config) {
  return planReminderEnabled(config) || reminderKindEnabled(config, 'habit') || reminderKindEnabled(config, 'bill');
}

function kindOfReminder(reminder) {
  const planId = String((reminder && reminder.planId) || '');
  if (planId.startsWith('habit:')) return 'habit';
  if (planId.startsWith('bill:')) return 'bill';
  return 'plan';
}

function formatDueAt(value) {
  const date = new Date(Number(value));
  const pad = (part) => String(part).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function messageFor(reminder, config) {
  const kind = kindOfReminder(reminder);
  const templateId = kind === 'habit' ? config.wxHabitReminderTemplateId
    : kind === 'bill' ? config.wxBillReminderTemplateId
      : config.wxReminderTemplateId;
  const page = kind === 'habit' ? 'pages/habit/habit'
    : kind === 'bill' ? 'pages/money/money'
      : (config.wxReminderPage || 'pages/plan/plan');
  const fields = (config.reminderFields && config.reminderFields[kind]) || { title: 'thing1', when: 'time2' };
  const fallbackTitle = kind === 'habit' ? '习惯提醒' : kind === 'bill' ? '还款提醒' : '日程提醒';
  const cleanTitle = String(reminder.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  const title = Array.from(cleanTitle || fallbackTitle).slice(0, 20).join('');
  const billDueDate = kind === 'bill' && /:(\d{4})-(\d{2})-(\d{2})$/.exec(reminder.planId);
  let when = formatDueAt(reminder.dueAt) + (fields.when.startsWith('date') ? ':00' : '');
  if (billDueDate) when = billDueDate[1] + '年' + Number(billDueDate[2]) + '月' + Number(billDueDate[3]) + '日';
  return {
    touser: reminder.ownerId,
    templateId,
    page,
    data: {
      [fields.title]: { value: title },
      [fields.when]: { value: when }
    }
  };
}

function pad2(value) { return String(value).padStart(2, '0'); }

function localToday() {
  const date = new Date();
  return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate());
}

async function runScans(store, config) {
  let scanned = 0;
  if (typeof store.scanHabitReminders === 'function' && reminderKindEnabled(config, 'habit')) {
    scanned += await store.scanHabitReminders(localToday(), Date.now());
  }
  if (typeof store.scanBillReminders === 'function' && reminderKindEnabled(config, 'bill')) {
    scanned += await store.scanBillReminders(localToday(), Date.now());
  }
  return scanned;
}

async function consumeCreditSafely(store, reminder) {
  const kind = kindOfReminder(reminder);
  if (kind === 'plan' || typeof store.addReminderCredit !== 'function') return;
  try { await store.addReminderCredit(reminder.ownerId, kind, -1); } catch (error) { /* 额度扣减失败不影响投递结果 */ }
}

async function habitReminderStillDue(store, reminder) {
  const today = localToday();
  if (reminder.planId !== 'habit:' + today) return false;
  const [habits, setting, credits] = await Promise.all([
    store.getCollection(reminder.ownerId, 'habit'),
    store.getRecord(reminder.ownerId, 'settings', 'app'),
    store.getReminderCredits(reminder.ownerId)
  ]);
  return Boolean(setting && !setting.deletedAt && setting.data.habitReminderEnabled &&
    credits.habit > 0 && hasOutstandingHabits(Object.entries(habits).map(([id, record]) => ({ ...record, id })), today));
}

async function billReminderStillDue(store, reminder) {
  const match = /^bill:([^:]+):(\d{4}-\d{2}-\d{2})$/.exec(reminder.planId);
  return Boolean(match && await billOutstanding(store, reminder.ownerId, match[1], match[2]));
}

function createReminderWorker(store, config, sender) {
  const send = sender || sendSubscriptionMessage;
  const workerId = crypto.randomBytes(12).toString('hex');
  let running = false;
  return {
    async runOnce() {
      if (running || !anyReminderKindEnabled(config)) return { processed: 0, scanned: 0, skipped: true };
      running = true;
      let processed = 0;
      try {
        const scanned = await runScans(store, config);
        // 扫描只负责生成 due 的提醒行；投递统一走既有 claim → send → finish 循环
        const reminders = planReminderEnabled(config) || reminderKindEnabled(config, 'habit') || reminderKindEnabled(config, 'bill')
          ? await store.claimDueReminders(Date.now(), 20, workerId)
          : [];
        for (const reminder of reminders) {
          try {
            const kind = kindOfReminder(reminder);
            if (kind === 'habit' && (!reminderKindEnabled(config, 'habit') || !(await habitReminderStillDue(store, reminder)))) {
              await store.finishReminder(reminder.id, workerId, 'cancelled', '');
              continue;
            }
            if (kind === 'bill' && !(await billReminderStillDue(store, reminder))) {
              await store.finishReminder(reminder.id, workerId, 'cancelled', 'bill_settled');
              continue;
            }
            await send(config, messageFor(reminder, config));
            await store.finishReminder(reminder.id, workerId, 'sent', '');
            await consumeCreditSafely(store, reminder);
          } catch (error) {
            await store.finishReminder(reminder.id, workerId, 'failed', String(error && error.message || 'wechat_send_failed').slice(0, 240));
          }
          processed++;
        }
        return { processed, scanned, skipped: false };
      } finally {
        running = false;
      }
    }
  };
}

function startReminderWorker(worker, config) {
  if (!anyReminderKindEnabled(config)) return () => {};
  const interval = Math.max(15000, Number(config.reminderWorkerIntervalMs) || 60000);
  worker.runOnce().catch((error) => console.error('[reminders] initial scan failed:', error.message));
  const timer = setInterval(() => worker.runOnce().catch((error) => console.error('[reminders] scan failed:', error.message)), interval);
  return () => clearInterval(timer);
}

module.exports = { createReminderWorker, getReminderCapabilities, startReminderWorker, messageFor, reminderKindEnabled };
