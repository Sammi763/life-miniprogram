const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const { buildTextAvatar } = require('../../utils/text-avatar');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const { pickSettings } = require('../../utils/settings-utils');
const backup = require('../../utils/backup');
const { buildMoneyCsv } = require('../../utils/money-csv');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

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

function syncPresentation(syncState, pendingCount, rejectedCount) {
  if (rejectedCount) {
    return {
      text: '部分未同步',
      detail: rejectedCount + ' 条改动被云端拒绝，未写入专属空间',
      tone: 'status-offline'
    };
  }
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

const ISSUE_KIND_LABELS = { onError: '运行错误', onUnhandledRejection: '未处理的异步异常' };

/* 分类预算五项均为支出方向；隐藏条目为 {name,type}（新）或字符串（旧，读取时迁移前的兜底） */
function isHiddenCategory(hiddenList, name) {
  const list = Array.isArray(hiddenList) ? hiddenList : [];
  const hidden = list.some((item) => (item && item.name === name && item.type === 'expense') || item === name);
  return hidden ? '（已隐藏）' : '';
}

/* 「已记录 N 天」：跨账本、日程、健身、随记统计有记录的不同日期数 */
function countActiveDays(state) {
  const dates = new Set();
  const add = (value) => { if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) dates.add(value.slice(0, 10)); };
  Object.values(state.records.money || {}).forEach((record) => { if (!record.deletedAt && record.data) add(record.data.date); });
  Object.values(state.records.plan || {}).forEach((record) => {
    if (record.deletedAt || !record.data) return;
    add(record.data.date);
    if (record.data.kind === 'series') add(record.data.startDate);
  });
  Object.values(state.records.fitness || {}).forEach((record) => { if (!record.deletedAt && record.data) add(record.data.date); });
  Object.values(state.records.memories || {}).forEach((record) => { if (!record.deletedAt && record.data) add(record.data.occurredAt); });
  return dates.size;
}

Page({
  data: {
    syncText: '—',
    syncDetail: '',
    syncTone: 'status-ready',
    recordCount: 0,
    activeDays: 0,
    pendingCount: 0,
    budgetInput: '',
    categoryBudgetInputs: [],
    themeId: 'forest',
    themeOptions: [],
    deletingAccount: false,
    aiConsent: false,
    cacheText: '—',
    cacheError: '',
    issueText: '',
    rejectedCount: 0,
    rejectedText: '',
    showDemoControls: true,
    // 低频运维项（导出 / 复制备份 / 导入恢复 / 重建缓存 / 清理示例）收进弹层，见 openDataSheet
    dataSheetShow: false,
    /* 导入备份恢复：粘贴 → 解析预览 → 确认应用（utils/backup.js） */
    importSheetShow: false,
    importText: '',
    importPreview: null,
    importBusy: false,
    modules: MODULES,
    profile: { nickname: '生活记忆用户', avatarText: '生', avatarTone: 'avatar-tone-0' }
  },
  unsub: null,
  onLoad() {
    // 弹层打开时整体隐藏悬浮导航：自定义 tabBar 压在页面之上（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = store.subscribe(() => this.render());
    this.loadProfile();
    this.render();
  },
  onShow() { theme.applyToPage(this); share.enableShareMenu(); syncTabBar(this, TAB.MINE); this.loadProfile(); },
  onShareAppMessage: share.onShareAppMessage('mine'),
  onShareTimeline: share.onShareTimeline('mine'),
  onUnload() { this.unsub && this.unsub(); clearTimeout(this.__undoTimer); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  /* 数据管理弹层：四项都是「点一下就完事」的低频运维，不需要独立页面 */
  openDataSheet() { this.setData({ dataSheetShow: true }); },
  closeDataSheet() { if (this.data.dataSheetShow) this.setData({ dataSheetShow: false }); },
  noop() {},

  loadProfile() {
    const profile = api.getProfile();
    const nickname = profile.nickname || '生活记忆用户';
    const avatar = buildTextAvatar(nickname);
    this.setData({
      profile: {
        nickname,
        avatarText: avatar.label,
        avatarTone: avatar.tone
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
    const presentation = syncPresentation(s.syncState, s.queue.length, s.rejectedWrites.length);
    this.setData({
      syncText: presentation.text,
      syncDetail: presentation.detail,
      syncTone: presentation.tone,
      recordCount: n,
      activeDays: countActiveDays(s),
      pendingCount: s.queue.length,
      rejectedCount: s.rejectedWrites.length,
      // 把「哪一条、被什么状态码拒绝」说清楚，用户才能判断是数据格式问题还是服务端版本问题
      rejectedText: (() => {
        const list = s.rejectedWrites;
        if (!list.length) return '';
        const last = list[list.length - 1];
        const label = last.item.collection + (last.item.id ? '/' + last.item.id : '');
        const reason = last.statusCode ? 'HTTP ' + last.statusCode : '被拒绝';
        const tail = last.code ? '（' + last.code + '）' : '';
        return list.length + ' 条改动未被云端接受，本机已保留你填的值。最近一条：' + label + ' · ' + reason + tail +
          '。这类写入不会自动重试，可点「重试」再提交一次。';
      })(),
      aiConsent: settings.aiConsent === true,
      themeId,
      themeOptions: theme.getThemeOptions(themeId),
      showDemoControls: !api.getRuntimeConfig().isProduction,
      // 本机缓存占用直接取上次落盘的实测体积，避免每次渲染都重新序列化全量数据
      cacheText: s.persistSize ? (Math.max(1, Math.round(s.persistSize / 1024)) + ' KB') : '—',
      cacheError: s.persistError || '',
      // 全局异常只落在本机（app.js），这里展示最近一次，便于反馈问题时说清现象
      issueText: (() => {
        const appInstance = typeof getApp === 'function' ? getApp() : null;
        const issue = appInstance && appInstance.globalData && appInstance.globalData.clientIssue;
        if (!issue) return '';
        const label = ISSUE_KIND_LABELS[issue.kind] || issue.kind;
        return label + '：' + issue.text;
      })(),
      budgetInput: settings.budget ? String(settings.budget) : '',
      // 已隐藏的记账分类保留其预算数值，行上标注「已隐藏」避免用户以为丢配置；
      // 隐藏条目按方向+名称识别（兼容旧扁平字符串），分类预算五项均为支出方向
      categoryBudgetInputs: ['餐饮', '交通', '娱乐休闲', '居家用品', '医疗健康'].map((key) => ({
        key,
        value: categoryBudgets[key] === undefined ? '' : String(categoryBudgets[key]),
        hiddenSuffix: isHiddenCategory(settings.hiddenCategories, key)
      }))
    });
  },

  onThemeSelect(event) {
    const themeId = theme.normalizeThemeId(event.currentTarget.dataset.theme);
    if (themeId === this.data.themeId) return;
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    sync.upsert('settings', { ...settings, theme: themeId }, 'app');
    theme.selectTheme(themeId);
    this.setData({ themeId, themeOptions: theme.getThemeOptions(themeId) });
    /* 不再弹 toast：选中态已有 ✓ 角标，双重反馈是噪音 */
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
    if (ui.isRepeatedTap(this, 'budget-save', 600)) return;
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

  /*
   * 手动重试被云端拒绝的写入：放回队列头部并用新的 updatedAt 重发。
   * 这些写入是被服务端「明确拒绝」后丢弃的（不是网络问题），所以不自动重试，交给用户决定。
   * 结果必须按真实状态回报 —— flush() 只要队列走完就算成功，被拒的条目会重新记进
   * rejectedWrites，不能只看 flush 的 resolve 就报「成功」。
   */
  retryRejected() {
    if (ui.isRepeatedTap(this, 'retry-rejected', 800)) return;
    const n = store.retryRejectedWrites();
    if (!n) return;
    wx.showLoading({ title: '正在重试', mask: true });
    sync.flush().catch(() => {}).then(() => {
      wx.hideLoading();
      const rejected = store.state.rejectedWrites.length;
      if (rejected) wx.showToast({ title: '仍有 ' + rejected + ' 条被云端拒绝', icon: 'none' });
      else if (store.state.queue.length) wx.showToast({ title: '网络不可用，已暂存本机', icon: 'none' });
      else wx.showToast({ title: '已重新提交 ' + n + ' 条改动', icon: 'success' });
    });
  },

  /* 导出/复制是低频运维：loading 全部带 30s 保险丝，避免底层回调不返回时透明遮罩永久挡住点击 */
  copyBackup() {
    this.closeDataSheet();
    if (ui.isRepeatedTap(this, 'copy-backup', 800)) return;
    // v1 备份：含记录 ID 与墓碑，可用于「导入备份恢复」；旧版仅 data 的副本无法恢复
    const json = JSON.stringify(backup.buildLocalBackup());
    wx.showLoading({ title: '正在准备备份（' + Math.max(1, Math.round(json.length / 1024)) + ' KB）', mask: true });
    const guard = setTimeout(() => wx.hideLoading(), 30000);
    // setClipboardData 成功后系统会自带「内容已复制」提示，这里不再叠加自定义 toast
    wx.setClipboardData({
      data: json,
      success: () => { clearTimeout(guard); wx.hideLoading(); },
      fail: () => {
        clearTimeout(guard);
        wx.hideLoading();
        wx.showToast({ title: '复制失败，请重试', icon: 'none' });
      }
    });
  },

  exportFromServer() {
    this.closeDataSheet();
    if (ui.isRepeatedTap(this, 'export-server', 800)) return;
    wx.showLoading({ title: '导出中', mask: true });
    const guard = setTimeout(() => wx.hideLoading(), 30000);
    const done = () => { clearTimeout(guard); wx.hideLoading(); };
    api.request('GET', '/api/export').then((result) => {
      done();
      const normalized = backup.normalizeCloudExport(result);
      const payload = normalized || result;
      wx.setClipboardData({ data: JSON.stringify(payload) });
    }).catch(() => {
      done();
      wx.showToast({ title: '云端导出失败，请稍后重试', icon: 'none' });
    });
  },

  /* 导出账本 CSV（仅 money 集合，UTF-8 BOM，剪贴板交付） */
  exportMoneyCsv() {
    this.closeDataSheet();
    if (ui.isRepeatedTap(this, 'export-csv', 800)) return;
    const csv = buildMoneyCsv(store.state.records.money);
    wx.setClipboardData({
      data: csv,
      success: () => wx.showToast({ title: 'CSV 已复制，可粘贴到表格', icon: 'none' }),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
    });
  },

  /* ---- 导入备份恢复：粘贴 JSON → 解析预览 → 确认应用（不覆盖现值、幂等） ---- */
  openImportSheet() {
    this.closeDataSheet();
    const blocked = backup.importBlockedReason();
    if (blocked) { wx.showToast({ title: blocked, icon: 'none' }); return; }
    this.setData({ importSheetShow: true, importText: '', importPreview: null });
  },
  closeImportSheet() { if (!this.data.importBusy) this.setData({ importSheetShow: false }); },
  onImportText(e) { this.setData({ importText: e.detail.value }); },
  parseImport() {
    if (ui.isRepeatedTap(this, 'import-parse', 600)) return;
    const parsed = backup.parseBackup(this.data.importText);
    if (parsed.error) {
      this.setData({ importPreview: { ok: false, message: parsed.message } });
      return;
    }
    const preview = backup.previewImport(parsed.backup);
    if (preview.error) {
      this.setData({ importPreview: { ok: false, message: preview.message } });
      return;
    }
    this.setData({
      importPreview: {
        ok: true,
        total: preview.total,
        create: preview.create,
        skipLive: preview.skipLive,
        skipDeleted: preview.skipDeleted,
        skipBackupDeleted: preview.skipBackupDeleted,
        invalidCount: preview.invalidCount || 0,
        invalidSample: preview.invalid,
        byCollection: Object.keys(preview.byCollection).map((coll) => ({ coll, ...preview.byCollection[coll] }))
      }
    });
  },
  /*
   * 确认恢复：分批「本地写入 → 冲刷」，服务端 createOnly 保证云端已有同 ID 记录时以云端为准。
   * 提示语按实际结果组装（本次真实创建数 / 云端接管数 / 中断原因）——部分失败绝不提示
   * 「本机数据未变化」；撤销清单只含本次实际创建且未被修改的记录（backup.undoImport 再过滤一次）。
   */
  async confirmImport() {
    if (this.data.importBusy || !this.data.importPreview || !this.data.importPreview.ok) return;
    if (ui.isRepeatedTap(this, 'import-confirm', 800)) return;
    const blocked = backup.importBlockedReason();
    if (blocked) { wx.showToast({ title: blocked, icon: 'none' }); return; }
    this.setData({ importBusy: true });
    wx.showLoading({ title: '正在恢复…', mask: true });
    try {
      const parsed = backup.parseBackup(this.data.importText);
      if (parsed.error) {
        wx.hideLoading();
        this.setData({ importBusy: false, importPreview: { ok: false, message: parsed.message } });
        return;
      }
      const preview = backup.previewImport(parsed.backup);
      if (preview.error) {
        wx.hideLoading();
        this.setData({ importBusy: false, importPreview: { ok: false, message: preview.message } });
        return;
      }
      if (!preview.create) {
        wx.hideLoading();
        this.setData({ importBusy: false });
        wx.showToast({ title: '没有可导入的新记录', icon: 'none' });
        return;
      }
      const result = await backup.applyImport(preview);
      wx.hideLoading();
      // 中断时只说「已写入」（记录在本机、待续传），冲刷完成才说「已恢复」——不虚报同步结果
      const parts = [result.stopped ? '已写入 ' + result.created + ' 条记录' : '已恢复 ' + result.created + ' 条记录'];
      if (result.cloudResolved) parts.push(result.cloudResolved + ' 条以云端为准');
      if (result.stopped) parts.push(result.stopped);
      const message = parts.join('；');
      this.setData({ importSheetShow: false, importBusy: false, importText: '', importPreview: null });
      if (result.applied.length) {
        ui.armUndo(this, {
          text: message,
          windowMs: 8000,
          onUndo: () => {
            const undone = backup.undoImport(result.applied);
            wx.showToast({ title: undone ? '已撤销 ' + undone + ' 条导入' : '记录已变化，无可撤销项', icon: 'none' });
          }
        });
      } else {
        wx.showToast({ title: message, icon: 'none' });
      }
    } catch (error) {
      wx.hideLoading();
      this.setData({ importBusy: false });
      // 到这里说明应用阶段出现意外异常：如实说明状态未知、指引预览重查，绝不声称「本机数据未变化」
      wx.showToast({ title: '导入中断，部分记录可能已写入；请重新预览核对', icon: 'none' });
    }
  },

  /*
   * 重建本机缓存：清掉本地快照并从头全量重拉。
   * 用于本机缓存写入失败或占用过大时自救；云端数据不受影响，未上送的队列会保留。
   */
  rebuildLocalCache() {
    this.closeDataSheet();
    const pending = store.state.queue.length;
    wx.showModal({
      title: '重建本机缓存？',
      content: pending
        ? '本机缓存会清空并从云端重新拉取；' + pending + ' 条还没上送的改动会被保留。'
        : '本机缓存会清空并从云端重新拉取。云端数据不受影响，拉取完成前页面可能短暂显示为空。',
      confirmText: '重建',
      success: (result) => {
        if (!result.confirm) return;
        store.rebuildCache();
        ui.retryWithFeedback(() => sync.pull(), {
          loadingTitle: '正在重建',
          okTitle: '本机缓存已重建',
          failTitle: '重建未完成，请检查网络后重试'
        });
      }
    });
  },

  clearDemo() {
    this.closeDataSheet();
    wx.showModal({
      title: '清空示例数据？',
      content: '将删除所有 demo- 开头的预置示例，自己记的数据不受影响',
      confirmColor: theme.activeTokens()['--red'],
      success: (m) => {
        if (!m.confirm) return;
        const n = sync.clearDemo();
        wx.showToast({ title: '已清空 ' + n + ' 条示例', icon: 'none' });
      }
    });
  },
  /*
   * 永久删除账户：一次 modal 说明后果 + 输入「删除」二次确认，双重门槛。
   * deletingAccount 在 modal 期间就置位，避免连续点击叠出多层确认框。
   */
  deleteAccount() {
    if (this.data.deletingAccount) return;
    const dangerColor = theme.activeTokens()['--red'];
    wx.showModal({
      title: '永久删除账户？',
      content: '这会删除云端资料、同步记录、提醒和会话。导出备份后再继续，此操作无法恢复。',
      confirmText: '继续',
      confirmColor: dangerColor,
      success: (result) => {
        if (!result.confirm) return;
        wx.showModal({
          title: '最后确认',
          content: '请输入「删除」两个字以确认执行：',
          editable: true,
          placeholderText: '删除',
          confirmText: '确认删除',
          confirmColor: dangerColor,
          success: (confirmResult) => {
            if (!confirmResult.confirm) return;
            if (String(confirmResult.content || '').trim() !== '删除') {
              wx.showToast({ title: '输入不匹配，已取消删除', icon: 'none' });
              return;
            }
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
      }
    });
  },
  logout() {
    wx.showModal({
      title: '退出当前账号？',
      content: '本机缓存会清除，云端数据不会删除。下次登录后可重新同步。',
      confirmColor: theme.activeTokens()['--amber'],
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
