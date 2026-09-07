const store = require('./utils/store');
const theme = require('./utils/theme');

function syncedThemeId() {
  const setting = store.state.records.settings && store.state.records.settings.app;
  return theme.getThemeId(setting && !setting.deletedAt && setting.data && setting.data.theme);
}

App({
  globalData: { profile: null, themeId: 'forest' },
  onLaunch() {
    const applySyncedTheme = () => {
      const nextId = syncedThemeId();
      if (nextId === this.globalData.themeId) return;
      this.globalData.themeId = nextId;
      theme.selectTheme(nextId);
    };
    this.globalData.themeId = syncedThemeId();
    theme.applyToOpenPages(this.globalData.themeId);
    this._unsubTheme = store.subscribe(applySyncedTheme);
  },
  onHide() {
    // 设置记录会在下一次 store 通知时更新；此处不做网络或存储写入。
  }
});
