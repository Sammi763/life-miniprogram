const store = require('./utils/store');
const theme = require('./utils/theme');
const { BUILD_VERSION } = require('./config/build');

function syncedThemeId() {
  const setting = store.state.records.settings && store.state.records.settings.app;
  return theme.getThemeId(setting && !setting.deletedAt && setting.data && setting.data.theme);
}

/*
 * 全局异常只落在本机，不上报任何远端 —— 与隐私政策「不采集崩溃信息」保持一致。
 * 保留最近一次异常用于「我的」页展示，方便反馈问题时说清现象。
 */
/* 异常文本可能带上含 token / code 的 URL（例如 WebSocket 连接地址），展示与日志前一律打码 */
function redactSecrets(text) {
  return String(text || '')
    .replace(/(token=)[^\s&"'\\]+/gi, '$1***')
    .replace(/(code=)[^\s&"'\\]+/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1***');
}

function describeIssue(kind, payload) {
  const raw = payload && (payload.message || payload.errMsg || payload.reason || payload);
  const text = typeof raw === 'string' ? raw : (() => {
    try { return JSON.stringify(raw); } catch (error) { return String(raw); }
  })();
  return { kind, text: redactSecrets(text).slice(0, 180), at: Date.now(), buildVersion: BUILD_VERSION };
}

App({
  globalData: { profile: null, themeId: 'forest', clientIssue: null },
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
    /* 跟随系统（theme='auto'）：系统深浅切换时按新系统主题重新解析并应用到已打开页面 */
    if (typeof wx.onThemeChange === 'function') {
      wx.onThemeChange(() => {
        this.globalData.themeId = syncedThemeId();
        theme.applyToOpenPages();
      });
    }
  },
  onError(error) {
    const issue = describeIssue('onError', error);
    this.globalData.clientIssue = issue;
    console.error('[life-issue] ' + JSON.stringify(issue));
  },
  onUnhandledRejection(result) {
    const issue = describeIssue('onUnhandledRejection', result && (result.reason || result));
    this.globalData.clientIssue = issue;
    console.error('[life-issue] ' + JSON.stringify(issue));
  },
  onHide() {
    // 切后台立即落盘：250ms 防抖内的最后一次变更如果等不到回调（进程被杀）就丢了（R06）。
    // 只做本地同步写，不发起网络请求。
    store.persistNow();
  }
});
