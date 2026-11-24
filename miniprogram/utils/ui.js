/*
 * 交互反馈工具：页面共用。主体只依赖 wx；bindStore 是唯一例外，函数体内延迟 require store（避免循环依赖）。
 *
 * 解决两类真实问题：
 * 1) 同步保存（本地乐观写）是同步执行的，快速连点会写入两条语义相同的记录；
 * 2) 离线时点「重试」过去只调用生命周期回调，用户看不到成功或失败。
 */

/*
 * 重复点击节流：返回 true 表示应忽略本次点击。
 * 时间戳存在页面实例上而非 data，避免为节流触发布局渲染。
 * 必须在「校验通过、真正写入之前」调用，否则校验失败的点击会占用节流窗口。
 */
function isRepeatedTap(page, key, waitMs) {
  if (!page) return false;
  const wait = Number(waitMs) > 0 ? Number(waitMs) : 400;
  const now = Date.now();
  if (!page.__lastTapAt) page.__lastTapAt = {};
  const last = page.__lastTapAt[key] || 0;
  if (now - last < wait) return true;
  page.__lastTapAt[key] = now;
  return false;
}

/*
 * 手动重试的统一样式：loading → 结果 toast。
 * loader 返回 false 视为失败（sync.pull() 以 boolean 表达成功/离线，从不 reject）。
 * 任何异常都收敛为「失败」提示，不把错误抛给页面。
 *
 * 保险丝：showLoading({mask:true}) 的透明遮罩会挡住整屏点击，若 loader 的 Promise
 * 因底层异常永不 settle，遮罩就把整个小程序卡死（真机上表现为「页面正常、能滚、
 * 点哪都没反应」）。这里保证无论 loader 行为如何，loading 最多存在 30 秒。
 */
const RETRY_LOADING_GUARD_MS = 30000;

function retryWithFeedback(loader, options) {
  const settings = options || {};
  const okTitle = settings.okTitle || '连接已恢复';
  const failTitle = settings.failTitle || '仍无法连接，请稍后重试';
  wx.showLoading({ title: settings.loadingTitle || '正在重试', mask: true });
  let settled = false;
  const guard = setTimeout(() => settle(false), RETRY_LOADING_GUARD_MS);
  function settle(ok) {
    if (settled) return;
    settled = true;
    clearTimeout(guard);
    wx.hideLoading();
    wx.showToast({ title: ok ? okTitle : failTitle, icon: ok ? 'success' : 'none' });
    return ok;
  }
  try {
    return Promise.resolve(loader()).then((result) => settle(result !== false), () => settle(false));
  } catch (error) {
    return Promise.resolve(settle(false));
  }
}

/*
 * 完成类操作的统一反馈：轻震动 + 可选 toast。
 * 打卡、勾选、记账成功、切 Tab 等高频操作全走这里，保证手感一致。
 * 震动失败静默（模拟器、无震动硬件、旧基础库）不影响主流程。
 */
function completeFeedback(options) {
  const settings = options || {};
  if (settings.vibrate !== false && typeof wx.vibrateShort === 'function') {
    try { wx.vibrateShort({ type: 'light', fail: () => {} }); } catch (error) { /* older base libraries */ }
  }
  if (settings.toast) wx.showToast({ title: settings.toast, icon: settings.icon || 'success' });
}

/*
 * 「删除 + 撤销」范式：删除立即执行，底部浮出撤销条，窗口期内可一键恢复，
 * 过期自动收起。相比确认弹窗，它不拦住高频操作，又给了反悔路径。
 * 页面在删除处保存被删数据并传入 onUndo；计时与显隐由这里统一管理。
 * 撤销条是公共组件 components/undo-bar，页面 data 需要有 undoShow 字段，
 * 且 onUnload 应 clearTimeout(page.__undoTimer)。
 */
function armUndo(page, options) {
  if (!page) return;
  const settings = options || {};
  const windowMs = Number(settings.windowMs) > 0 ? Number(settings.windowMs) : 5000;
  clearTimeout(page.__undoTimer);
  page.__undo = settings;
  const patch = { undoShow: true };
  if (settings.text) patch.undoText = settings.text;
  page.setData(patch);
  page.__undoTimer = setTimeout(() => {
    page.__undo = null;
    page.setData({ undoShow: false });
    if (typeof settings.onExpire === 'function') settings.onExpire();
  }, windowMs);
}

/* 撤销条上的「撤销」点击：恢复数据并收起撤销条 */
function performUndo(page) {
  if (!page) return;
  const settings = page.__undo;
  if (!settings) return;
  page.__undo = null;
  clearTimeout(page.__undoTimer);
  page.setData({ undoShow: false });
  if (typeof settings.onUndo === 'function') settings.onUndo();
}

/*
 * 值相同的字段不进 setData（性能方案 §5「减少 onLoad/onShow 重复渲染」）。
 * 记录数据均为可 JSON 序列化的纯值，用字符串比较判断相等；比较失败（循环引用等）按变化处理。
 * 返回是否发生了 setData。
 */
function valueEquals(a, b) {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch (error) { return false; }
}
function diffSetData(page, patch) {
  if (!page || !patch) return false;
  const changed = {};
  let any = false;
  for (const key of Object.keys(patch)) {
    if (!valueEquals(page.data ? page.data[key] : undefined, patch[key])) {
      changed[key] = patch[key];
      any = true;
    }
  }
  if (any) page.setData(changed);
  return any;
}

/*
 * 页面 × store 的统一绑定（性能方案 §5）：
 * - 订阅按集合过滤，无关集合变化不进入本页；
 * - 页面隐藏（onHide）时只标记 dirty，onShow 再合并刷新；
 * - 仅同步状态变化（'__sync__'）时走页面的 renderSyncState 轻更新（只改状态角标），不做全量重算。
 * 使用方：this.unbindStore = bindStore(this, ['money', 'habit'], this.render.bind(this), () => this.renderSyncState());
 * onUnload 里 this.unbindStore()。页面须在 onHide 置 __pageHidden = true、onShow 复位并**无条件** render()
 * （onShow 无条件刷新是最终一致性的兜底，__storeDirty 仅用于跳过隐藏期渲染，onShow 不看它）。
 */
function bindStore(page, collections, render, renderSyncState) {
  // 延迟 require store，避免 ui.js ↔ store.js 循环依赖
  const store = require('./store');
  return store.subscribe((changed) => {
    if (page.__pageHidden) { page.__storeDirty = true; return; }
    if (changed && changed.length === 1 && changed[0] === '__sync__' && typeof renderSyncState === 'function') {
      renderSyncState();
      return;
    }
    render();
  }, collections);
}

module.exports = { isRepeatedTap, retryWithFeedback, completeFeedback, armUndo, performUndo, diffSetData, bindStore };
