const crypto = require('crypto');
const { sendSubscriptionMessage } = require('./wechat');

function getReminderCapabilities(config) {
  const enabled = Boolean(config.wxAppId && config.wxSecret && config.wxReminderTemplateId);
  return { enabled, templateId: enabled ? config.wxReminderTemplateId : '' };
}

function formatDueAt(value) {
  const date = new Date(Number(value));
  const pad = (part) => String(part).padStart(2, '0');
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
}

function messageFor(reminder, config) {
  return {
    touser: reminder.ownerId,
    templateId: config.wxReminderTemplateId,
    page: config.wxReminderPage || 'pages/plan/plan',
    data: {
      thing1: { value: String(reminder.title || '日程提醒').slice(0, 20) },
      time2: { value: formatDueAt(reminder.dueAt) }
    }
  };
}

function createReminderWorker(store, config, sender) {
  const send = sender || sendSubscriptionMessage;
  const workerId = crypto.randomBytes(12).toString('hex');
  let running = false;
  return {
    async runOnce() {
      if (running || !getReminderCapabilities(config).enabled) return { processed: 0, skipped: true };
      running = true;
      let processed = 0;
      try {
        const reminders = await store.claimDueReminders(Date.now(), 20, workerId);
        for (const reminder of reminders) {
          try {
            await send(config, messageFor(reminder, config));
            await store.finishReminder(reminder.id, workerId, 'sent', '');
          } catch (error) {
            await store.finishReminder(reminder.id, workerId, 'failed', String(error && error.message || 'wechat_send_failed').slice(0, 240));
          }
          processed++;
        }
        return { processed, skipped: false };
      } finally {
        running = false;
      }
    }
  };
}

function startReminderWorker(worker, config) {
  if (!getReminderCapabilities(config).enabled) return () => {};
  const interval = Math.max(15000, Number(config.reminderWorkerIntervalMs) || 60000);
  worker.runOnce().catch((error) => console.error('[reminders] initial scan failed:', error.message));
  const timer = setInterval(() => worker.runOnce().catch((error) => console.error('[reminders] scan failed:', error.message)), interval);
  return () => clearInterval(timer);
}

module.exports = { createReminderWorker, getReminderCapabilities, startReminderWorker };
