/*
 * 跨页深链中转：money 是 tab 页带不了查询参数，搜索页/今日页先经 storage
 * 写入一条「待打开」意图，money onShow 消费后打开对应流水编辑弹层。
 * set 与 consume 必须配对使用；consume 只在 kind 匹配时取走并清除，
 * 不匹配的意图保留给真正的目标页。
 */
const PENDING_OPEN_KEY = 'wb_life_pending_open';

function setPendingOpen(kind, id) {
  try { wx.setStorageSync(PENDING_OPEN_KEY, { kind, id, at: Date.now() }); } catch (error) { /* storage may be unavailable */ }
}

/* 返回匹配的记录 id；无匹配（含 kind 不同）时返回空串且不清除已有意图 */
function consumePendingOpen(kind) {
  let pending = null;
  try { pending = wx.getStorageSync(PENDING_OPEN_KEY); } catch (error) { return ''; }
  if (!pending || pending.kind !== kind || !pending.id) return '';
  try { wx.removeStorageSync(PENDING_OPEN_KEY); } catch (error) { /* ignore */ }
  return String(pending.id);
}

module.exports = { PENDING_OPEN_KEY, setPendingOpen, consumePendingOpen };
