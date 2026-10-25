/*
 * 提醒矩阵客户端共用逻辑（v2.11）：能力查询、开关保存、「订阅授权 + 额度上报」统一入口。
 * 合规约束：requestSubscribeMessage 必须由用户点击触发，所以这里所有入口都挂在页面点击
 * 事件链路上（开关开启 / 额度不足横幅续订 / 「我的」页续订），打卡点击本身不弹订阅。
 * 一次订阅授权 = 一次触达：授权成功后立刻上报 +1，服务端发送成功后扣减。
 */
const api = require('./api');
const { pickSettings } = require('./settings-utils');

const DEFAULT_HABIT_TIME = '20:00';
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function currentSettings(records) {
  const record = records && records.settings && records.settings.app;
  return record && !record.deletedAt && record.data ? record.data : {};
}

/* kind 的提醒视图（开关/能力/额度/横幅），供 habit / money 页渲染直接使用 */
function buildReminderView(records, kind, capsResponse) {
  const settings = currentSettings(records);
  const enabled = kind === 'habit' ? settings.habitReminderEnabled === true : settings.billReminderEnabled === true;
  const cap = capsResponse && capsResponse[kind];
  const capEnabled = Boolean(cap && cap.enabled);
  const credits = cap ? Math.max(0, Number(cap.credits) || 0) : 0;
  const time = typeof settings.habitReminderTime === 'string' && TIME_PATTERN.test(settings.habitReminderTime)
    ? settings.habitReminderTime
    : DEFAULT_HABIT_TIME;
  let banner = '';
  if (enabled && capEnabled && credits <= 0) {
    banner = kind === 'habit' ? '提醒额度已用完，点此续订' : '还款提醒额度已用完，点此续订';
  }
  return { enabled, capEnabled, credits, time, banner };
}

/* 只保留白名单字段再合并补丁，随 settings 记录同步 */
function saveReminderSettings(records, patch) {
  const next = { ...pickSettings(currentSettings(records)), ...patch };
  const sync = require('./sync');
  sync.upsert('settings', next, 'app');
  return next;
}

/* 拉取两类提醒的能力与额度；未登录或离线时返回 null（页面保持默认关闭态，不打扰） */
async function fetchCaps() {
  try {
    if (!api.getToken()) return null;
    return await api.getReminderCapabilities();
  } catch (error) {
    return null;
  }
}

/* 订阅授权 → 成功后上报额度；reason: unavailable（服务端/模板未配置）| rejected | network */
async function subscribeAndCredit(kind, capsResponse) {
  const cap = capsResponse && capsResponse[kind];
  if (!cap || !cap.enabled || !cap.templateId) return { ok: false, reason: 'unavailable' };
  const accepted = await api.requestReminderSubscription(cap.templateId);
  if (!accepted) return { ok: false, reason: 'rejected' };
  try {
    const result = await api.addReminderCredit(kind);
    return { ok: true, credits: Number(result && result.credits) || 0 };
  } catch (error) {
    return { ok: false, reason: 'network' };
  }
}

module.exports = { DEFAULT_HABIT_TIME, buildReminderView, currentSettings, fetchCaps, saveReminderSettings, subscribeAndCredit };
