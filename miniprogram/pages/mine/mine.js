const store = require('../../utils/store');
const sync = require('../../utils/sync');
const api = require('../../utils/api');
const { buildTextAvatar } = require('../../utils/text-avatar');
const { syncTabBar } = require('../../utils/tabbar');
const { pickSettings } = require('../../utils/settings-utils');
const theme = require('../../utils/theme');

const MODULES = [
  { title: '生活时间线', detail: '随手写下此刻', glyph: '记', tone: 'memory', url: '/pages/memory/memory' },
  { title: '每周复盘', detail: '完成、账本与下周', glyph: '周', tone: 'review', url: '/pages/review/review' },
  { title: '统一搜索', detail: '回看所有生活记录', glyph: '查', tone: 'search', url: '/pages/search/search' },
  { title: '日程统筹', detail: '待办与提醒', glyph: '日', tone: 'plan', url: '/pages/plan/plan' },
  { title: '月度报告', detail: '私密财务与生活回顾', glyph: '月', tone: 'report', url: '/pages/report/report' },
  { title: '待买清单', detail: '采购与心愿', glyph: '购', tone: 'shopping', url: '/pages/shopping/shopping' },
  { title: '书影音', detail: '收藏与回顾', glyph: '阅', tone: 'media', url: '/pages/media/media' },
  { title: '减脂健身', detail: '体重与计划', glyph: '健', tone: 'fitness', url: '/pages/fitness/fitness' }
];

function syncPresentation(syncState, pendingCount) {
  if (syncState === 'syncing') return { text: '正在同步', detail: '正在把最新记录安全保存', tone: 'status-syncing' };
  if (syncState === 'offline') {
    return {
      text: pendingCount ? '暂存本机' : '等待连接',
      detail: pendingCount ? pendingCount + ' 条改动会在网络恢复后自动同步' : '网络恢复后会自动继续同步',
      tone: 'status-offline'
    };
  }
  return { text: '已安全同步', detail: '你的记录已同步到专属空间', tone: 'status-ready' };
}

Page({
  data: {
    syncText: '—',
    syncDetail: '',
    syncTone: 'status-ready',
    recordCount: 0,
    pendingCount: 0,
    budgetInput: '',
    categoryBudgetInputs: [],
    themeId: 'forest',
    themeOptions: [],
    deletingAccount: false,
    aiConsent: false,
    showDemoControls: true,
    modules: MODULES,
    profile: { nickname: '生活记忆用户', avatarText: '生', avatarTone: 'avatar-tone-0', phone: '', hasPhone: false }
  },
  unsub: null,
  onLoad() {
    this.unsub = store.subscribe(() => this.render());
    this.loadProfile();
    this.render();
  },
  onShow() { theme.applyToPage(this); syncTabBar(this, 3); this.loadProfile(); },
  onUnload() { this.unsub && this.unsub(); },

  loadProfile() {
    const profile = api.getProfile();
    const nickname = profile.nickname || '生活记忆用户';
    const avatar = buildTextAvatar(nickname);
    this.setData({
      profile: {
        nickname,
        avatarText: avatar.label,
        avatarTone: avatar.tone,
        phone: profile.phone || '未绑定手机号',
        hasPhone: Boolean(profile.hasPhone)
      }
    });
  },

  render() {
    const s = store.state;
    const settings = s.records.settings.app && s.records.settings.app.data || {};
    const themeId = theme.getThemeId(settings.theme);
    theme.applyToPage(this, themeId);
    const categoryBudgets = settings.categoryBudgets && typeof settings.categoryBudgets === 'object' ? settings.categoryBudgets : {};
    let n = 0;
    for (const c of store.COLLECTIONS) {
      for (const r of Object.values(s.records[c])) if (!r.deletedAt) n++;
    }
    const presentation = syncPresentation(s.syncState, s.queue.length);
    this.setData({
      syncText: presentation.text,
      syncDetail: presentation.detail,
      syncTone: presentation.tone,
      recordCount: n,
      pendingCount: s.queue.length,
      aiConsent: settings.aiConsent === true,
      themeId,
      themeOptions: theme.getThemeOptions(themeId),
      showDemoControls: !api.getRuntimeConfig().isProduction,
      budgetInput: settings.budget ? String(settings.budget) : '',
      categoryBudgetInputs: ['餐饮', '交通', '娱乐休闲', '居家用品', '医疗健康'].map((key) => ({ key, value: categoryBudgets[key] === undefined ? '' : String(categoryBudgets[key]) }))
    });
  },

  onThemeSelect(event) {
    const themeId = theme.normalizeThemeId(event.currentTarget.dataset.theme);
    if (themeId === this.data.themeId) return;
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    sync.upsert('settings', { ...settings, theme: themeId }, 'app');
    theme.selectTheme(themeId);
    this.setData({ themeId, themeOptions: theme.getThemeOptions(themeId) });
    wx.showToast({ title: '已切换为「' + theme.getTheme(themeId).name + '」', icon: 'none' });
  },

  onBudgetInput(e) { this.setData({ budgetInput: (e.detail && e.detail.value) || '' }); },
  onCategoryBudgetInput(e) {
    const key = e.currentTarget.dataset.key;
    const value = (e.detail && e.detail.value) || '';
    this.setData({ categoryBudgetInputs: this.data.categoryBudgetInputs.map((item) => item.key === key ? { ...item, value } : item) });
  },
  saveBudget() {
    const source = String(this.data.budgetInput || '').trim();
    const budget = source === '' ? 0 : Number(source);
    if (!Number.isFinite(budget) || budget < 0 || budget > 1000000) {
      wx.showToast({ title: '预算应为 0～100 万之间的金额', icon: 'none' });
      return;
    }
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    const categoryBudgets = { ...(settings.categoryBudgets || {}) };
    for (const item of this.data.categoryBudgetInputs) {
      const input = String(item.value || '').trim();
      if (!input) { delete categoryBudgets[item.key]; continue; }
      const value = Math.round(Number(input) * 100) / 100;
      if (!Number.isFinite(value) || value < 0 || value > 1000000) {
        wx.showToast({ title: item.key + '预算应为 0～100 万', icon: 'none' });
        return;
      }
      categoryBudgets[item.key] = value;
    }
    const normalizedBudget = Math.round(budget * 100) / 100;
    const next = { ...settings, budget: normalizedBudget };
    if (Object.keys(categoryBudgets).length) next.categoryBudgets = categoryBudgets;
    else delete next.categoryBudgets;
    sync.upsert('settings', next, 'app');
    this.setData({ budgetInput: normalizedBudget ? String(normalizedBudget) : '' });
    wx.showToast({ title: normalizedBudget ? '本月预算已保存' : '已清除本月预算', icon: 'success' });
  },

  saveAiConsent(enabled) {
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    sync.upsert('settings', { ...settings, aiConsent: Boolean(enabled) }, 'app');
    this.setData({ aiConsent: Boolean(enabled) });
  },

  onAiConsentChange(event) {
    const enabled = Boolean(event.detail && event.detail.value);
    if (!enabled) {
      this.saveAiConsent(false);
      wx.showToast({ title: '已关闭个性化 AI 文案', icon: 'none' });
      return;
    }
    this.setData({ aiConsent: true });
    wx.showModal({
      title: '开启个性化 AI 文案？',
      content: '开启后，服务端会将经过裁剪的随记片段、任务标题和汇总统计发送至 DeepSeek API，仅用于生成轻提醒与月度一句话。不会发送手机号、账户余额或原始账本备注。',
      confirmText: '同意开启',
      confirmColor: this.data.themeAccent || theme.getTheme().tokens['--accent'],
      success: (result) => {
        if (result.confirm) {
          this.saveAiConsent(true);
          wx.showToast({ title: '个性化 AI 已开启', icon: 'success' });
        } else {
          this.setData({ aiConsent: false });
        }
      }
    });
  },

  copyBackup() {
    const dump = {};
    for (const c of store.COLLECTIONS) {
      dump[c] = Object.values(store.state.records[c]).filter((r) => !r.deletedAt).map((r) => r.data);
    }
    wx.setClipboardData({
      data: JSON.stringify(dump),
      success: () => wx.showToast({ title: '备份已复制到剪贴板', icon: 'none' })
    });
  },

  exportFromServer() {
    wx.showLoading({ title: '导出中' });
    api.request('GET', '/api/export').then((result) => {
      wx.hideLoading();
      wx.setClipboardData({ data: JSON.stringify(result), success: () => wx.showToast({ title: '云端备份已复制', icon: 'none' }) });
    }).catch(() => {
      wx.hideLoading();
      wx.showToast({ title: '云端导出失败，请稍后重试', icon: 'none' });
    });
  },

  clearDemo() {
    wx.showModal({
      title: '清空示例数据？',
      content: '将删除所有 demo- 开头的预置示例，自己记的数据不受影响',
      confirmColor: '#C0392B',
      success: (m) => {
        if (!m.confirm) return;
        const n = sync.clearDemo();
        wx.showToast({ title: '已清空 ' + n + ' 条示例', icon: 'none' });
      }
    });
  },
  deleteAccount() {
    wx.showModal({
      title: '永久删除账户？',
      content: '这会删除云端资料、同步记录、提醒和会话。导出备份后再继续，此操作无法恢复。',
      confirmText: '确认删除',
      confirmColor: '#C0392B',
      success: (result) => {
        if (!result.confirm) return;
        this.setData({ deletingAccount: true });
        api.deleteAccount().then(() => {
          sync.destroy();
          store.resetLocal();
          try { wx.removeStorageSync('wb_life_seeded'); } catch (error) { /* ignore */ }
          api.clearLogin();
          wx.reLaunch({ url: '/pages/login/login' });
        }).catch((error) => {
          const text = error && error.code === 'fresh_login_mismatch' ? '登录身份不一致，请重试' : '删除失败，请检查网络后重试';
          wx.showToast({ title: text, icon: 'none' });
        }).finally(() => this.setData({ deletingAccount: false }));
      }
    });
  },
  logout() {
    wx.showModal({
      title: '退出当前账号？',
      content: '本机缓存会清除，云端数据不会删除。下次登录后可重新同步。',
      confirmColor: '#C4553B',
      success: (result) => {
        if (!result.confirm) return;
        sync.destroy();
        store.resetLocal();
        try { wx.removeStorageSync('wb_life_seeded'); } catch (e) { /* ignore */ }
        api.clearLogin();
        wx.reLaunch({ url: '/pages/login/login' });
      }
    });
  },
  editProfile() { wx.navigateTo({ url: '/pages/login/login?edit=1' }); },
  goLegal(event) {
    const doc = event.currentTarget.dataset.doc || 'service';
    wx.navigateTo({ url: '/pages/legal/legal?doc=' + encodeURIComponent(doc) });
  },
  goModule(event) {
    const url = event.currentTarget.dataset.url;
    if (url) wx.navigateTo({ url });
  }
});
