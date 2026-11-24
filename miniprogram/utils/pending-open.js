/*
 * 跨页深链中转：money 是 tab 页带不了查询参数，搜索页/今日页先经 storage
 * 写入一条「待打开」意图，money onShow 消费后打开对应流水编辑弹层。
 * set 与 consume 必须配对使用；consume 只在 kind 匹配时取走并清除，
 * 不匹配的意图保留给真正的目标页。
 *
 * v2.12 扩展（U01 一次性导航意图）：action 支持 'create'（直达新增表单）、
 * 'budget'（直达预算编辑）、'account'（定位账户）、'accounts'（展开账户列表）。浏览入口不写意图，新增入口写入；目标页 onShow/onLoad
 * 消费后立即清除 —— 无论用户保存还是放弃，意图都只生效一次。
 */
const PENDING_OPEN_KEY = 'wb_life_pending_open';
/* 一次性动作枚举：调用方统一引用，避免手写字符串 typo 造成意图被静默消费 */
const ACTIONS = { CREATE: 'create', BUDGET: 'budget', ACCOUNT: 'account', ACCOUNTS: 'accounts', SEARCH: 'search' };
/*
 * 意图有效期：写方与消费方之间只隔一次页面跳转；超过 10 分钟的残留意图（导航被打断、
 * 跨会话残留）直接丢弃 —— 「打开表单」类意图迟到出现反而像 bug（复核补充）。
 */
const INTENT_TTL_MS = 10 * 60 * 1000;

function setPendingOpen(kind, id, action) {
  try { wx.setStorageSync(PENDING_OPEN_KEY, { kind, id: id || '', action: action || '', at: Date.now() }); } catch (error) { /* storage may be unavailable */ }
}

/* 返回匹配的记录 id；无匹配（含 kind 不同）时返回空串且不清除已有意图 */
function consumePendingOpen(kind) {
  return consumePendingAction(kind).id;
}

/* 返回 {id, action}；kind 不匹配或意图已过期时返回空对象。消费即清除（一次性）。 */
function consumePendingAction(kind) {
  let pending = null;
  try { pending = wx.getStorageSync(PENDING_OPEN_KEY); } catch (error) { return { id: '', action: '' }; }
  if (!pending || pending.kind !== kind) return { id: '', action: '' };
  try { wx.removeStorageSync(PENDING_OPEN_KEY); } catch (error) { /* ignore */ }
  if (pending.at && Date.now() - pending.at > INTENT_TTL_MS) return { id: '', action: '' };
  return { id: String(pending.id || ''), action: String(pending.action || '') };
}

module.exports = { PENDING_OPEN_KEY, ACTIONS, setPendingOpen, consumePendingOpen, consumePendingAction };
