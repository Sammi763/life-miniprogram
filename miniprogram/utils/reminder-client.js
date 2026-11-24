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

/*
 * kind 的提醒视图（开关/能力/额度/状态/横幅），供 habit / money 页渲染直接使用。
 * U06 状态口径 —— 明确区分「用户想要提醒」与「当前可送达」：
 *   state = off          未开启（用户意图：不要提醒）
 *   state = ready        已开启且有剩余额度 → 可送达
 *   state = exhausted    已开启但额度用完 → 不会送达，待续订
 *   state = unavailable  已开启但服务端/模板未配置 → 不会送达
 *   state = unknown      已开启但能力尚未查询到（离线/查询中）→ 如实说「查询中」，不误报
 * 开关本身只表达意图；credits 与 capEnabled 才决定能否送达，文案绝不只凭开关宣称可送达。
 */
function buildReminderView(records, kind, capsResponse) {
  const settings = currentSettings(records);
  const enabled = kind === 'habit' ? settings.habitReminderEnabled === true : settings.billReminderEnabled === true;
  const capsKnown = Boolean(capsResponse);
  const cap = capsResponse && capsResponse[kind];
  const capEnabled = Boolean(cap && cap.enabled);
  const credits = cap ? Math.max(0, Number(cap.credits) || 0) : 0;
  const time = typeof settings.habitReminderTime === 'string' && TIME_PATTERN.test(settings.habitReminderTime)
    ? settings.habitReminderTime
    : DEFAULT_HABIT_TIME;
  let state = 'off';
  let statusText = '未开启';
  let banner = '';
  if (enabled) {
    if (!capsKnown) {
      state = 'unknown';
      statusText = '已开启 · 提醒能力查询中（离线时暂无法确认）';
    } else if (!capEnabled) {
      state = 'unavailable';
      statusText = '已开启 · 服务端暂不支持，不会送达';
    } else if (credits > 0) {
      state = 'ready';
      statusText = '已开启 · 剩余 ' + credits + ' 次提醒';
    } else {
      state = 'exhausted';
      statusText = '已开启 · 额度已用完，当前不会送达';
      banner = kind === 'habit' ? '提醒额度已用完，点此续订' : '还款提醒额度已用完，点此续订';
    }
  }
  return { enabled, capEnabled, credits, time, state, statusText, banner };
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
