/* 自定义 Tab 导航的选中态由当前页面主动同步，避免组件复用时沿用上一个页面的索引。 */
function syncTabBar(page, selected) {
  if (!page || typeof page.getTabBar !== 'function') return;
  const tabBar = page.getTabBar();
  if (!tabBar || typeof tabBar.setData !== 'function') return;
  const theme = require('./theme');
  tabBar.setData({ selected: Number(selected), themeStyle: theme.getThemeStyle(page.data && page.data.themeId) });
}

module.exports = { syncTabBar };
