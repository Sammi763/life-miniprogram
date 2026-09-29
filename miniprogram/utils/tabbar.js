/* 自定义 Tab 导航的选中态由当前页面主动同步，避免组件复用时沿用上一个页面的索引。 */

/* Tab 索引常量：页面里写 syncTabBar(this, TAB.HABIT)，别再手写魔法数字 */
const TAB = { TODAY: 0, MONEY: 1, HABIT: 2, MINE: 3 };

/*
 * 弹层打开期间隐藏悬浮导航。
 * 背景：自定义 tabBar 与页面内容不在同一层叠上下文 —— 实测把 .sheet 提到 z-index:200、
 * .mask 提到 199，截图里 .tabbar-shell(z-index:100) 依然画在弹层之上，页面内任何 z-index
 * 都盖不住它。于是「记一笔」的「保存」按钮（实测 [655,699]）完整落在 tabbar([653,753]) 里，
 * 用户能打开弹层、能输入，却看不到也点不到保存。结论：只能把导航藏起来，不能和层叠规则较劲。
 */

/* 页面 data 里凡是名字含 Sheet 的布尔字段都视为弹层开关（sheetShow / weightSheet / accountSheetShow …） */
const SHEET_KEY = /[Ss]heet/;
function overlayVisible(data) {
  if (!data) return false;
  for (const key of Object.keys(data)) {
    if (SHEET_KEY.test(key) && data[key] === true) return true;
  }
  return false;
}

function setTabBarHidden(page, hidden) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (!tabBar || typeof tabBar.setData !== 'function') return;
  if (tabBar.data && tabBar.data.hidden === hidden) return;
  tabBar.setData({ hidden: !!hidden });
}

/*
 * 依据当前页面 data 重新计算导航显隐。
 * 由 setData 包装器在每个含 Sheet 字段的 setData 之后调用，覆盖「打开」和「关闭」两条路径，
 * 不依赖页面是否记得手动通知；页面 onShow 时再跑一次，保证不会卡在隐藏态。
 */
function syncTabBarOverlay(page) {
  if (!page || !page.data) return;
  const next = overlayVisible(page.data);
  if (page.__tabbarOverlay === next) return;
  page.__tabbarOverlay = next;
  setTabBarHidden(page, next);
}

/*
 * 给页面装一个 setData 观察器。
 * 七个页面共约 20 处弹层开关，逐处补通知容易漏（漏一处就是「导航永远消失」）；
 * 包装一次 setData 可以覆盖全部现有与将来的开关路径。非 Tab 页（购物、日程、书影音等
 * 由 navigateTo 打开）本来就没有悬浮导航，getTabBar() 返回空，这里是空操作。
 */
function attachOverlayWatcher(page) {
  if (!page || page.__overlayWatched || typeof page.setData !== 'function') return;
  page.__overlayWatched = true;
  page.__tabbarOverlay = overlayVisible(page.data);
  const originalSetData = page.setData;
  page.setData = function setDataWithOverlay(data, callback) {
    const result = originalSetData.call(this, data, callback);
    try {
      if (data && typeof data === 'object' && Object.keys(data).some((key) => SHEET_KEY.test(key))) {
        syncTabBarOverlay(this);
      }
    } catch (error) { /* 显隐同步失败不应影响页面本身的数据更新 */ }
    return result;
  };
}

function syncTabBar(page, selected, badges) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (!tabBar || typeof tabBar.setData !== 'function') return;
  const theme = require('./theme');
  const hidden = overlayVisible(page.data);
  page.__tabbarOverlay = hidden;
  tabBar.setData({
    selected: Number(selected),
    themeStyle: theme.getThemeStyle(page.data && page.data.themeId),
    hidden,
    /* 角标：{ [tabIndex]: count }，不传或传空则清空全部角标 */
    badges: badges && typeof badges === 'object' ? badges : {}
  });
}

module.exports = { TAB, syncTabBar, attachOverlayWatcher, syncTabBarOverlay, overlayVisible };
