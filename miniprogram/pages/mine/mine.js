const store = require('../../utils/store');
const sync = require('../../utils/sync');
const ui = require('../../utils/ui');
const api = require('../../utils/api');
const avatarImage = require('../../utils/avatar');
const { buildTextAvatar } = require('../../utils/text-avatar');
const { syncTabBar, attachOverlayWatcher, TAB } = require('../../utils/tabbar');
const { pickSettings } = require('../../utils/settings-utils');
const backup = require('../../utils/backup');
const { buildMoneyCsv } = require('../../utils/money-csv');
const theme = require('../../utils/theme');
const reminderClient = require('../../utils/reminder-client');
const share = require('../../utils/share');

const ISSUE_KIND_LABELS = { onError: '运行错误', onUnhandledRejection: '未处理的异步异常' };

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
    recordCount: 0,
    activeDays: 0,
    themeId: 'forest',
    themeSetting: 'forest',
    themeOptions: [],
    /* 主题收纳为一行入口 + 弹层（U03）：减少「我的」页长度 */
    themeSheetShow: false,
    deletingAccount: false,
    showPersonalizedAi: false,
    aiConsent: false,
    cacheText: '—',
    cacheError: '',
    issueText: '',
    rejectedCount: 0,
    rejectedText: '',
    showDemoControls: true,
    // 低频运维项（导出 / 复制备份 / 导入恢复 / 重建缓存 / 清理示例）收进弹层，见 openDataSheet
    dataSheetShow: false,
    /* 提醒设置弹层（v2.11）：订阅额度展示与续订入口；开关本体在习惯页/记账页 */
    reminderSheetShow: false,
    reminderCaps: null,
    reminderHabitText: '',
    reminderBillText: '',
    /* 导入备份恢复：粘贴 → 解析预览 → 确认应用（utils/backup.js） */
    importSheetShow: false,
    importText: '',
    importPreview: null,
    importBusy: false,
    profile: { nickname: '生活记忆用户', avatarText: '生', avatarTone: 'avatar-tone-0' }
  },
  unsub: null,
  onLoad() {
    // 弹层打开时整体隐藏悬浮导航：自定义 tabBar 压在页面之上（详见 utils/tabbar.js）
    attachOverlayWatcher(this);
    this.unsub = ui.bindStore(this, null, () => this.render(), () => this.renderSaveIssues());
  },
  onShow() {
    this.__pageHidden = false;
    share.enableShareMenu();
    this.loadProfile();
    if (api.getToken() && api.validateSession) api.validateSession().then((profile) => this.loadProfile(profile)).catch(() => {});
    this.render();
    syncTabBar(this, TAB.MINE);
  },
  onHide() { this.__pageHidden = true; },
  onShareAppMessage: share.onShareAppMessage('mine'),
  onShareTimeline: share.onShareTimeline('mine'),
  onUnload() { this.unsub && this.unsub(); clearTimeout(this.__undoTimer); },
  onPullDownRefresh() {
    sync.pull().then(() => wx.stopPullDownRefresh()).catch(() => wx.stopPullDownRefresh());
  },

  /* 数据管理弹层：四项都是「点一下就完事」的低频运维，不需要独立页面 */
  openReminderCenter() { wx.navigateTo({ url: '/pages/activity/activity' }); },

  openDataSheet() { this.setData({ dataSheetShow: true }); },
  closeDataSheet() { if (this.data.dataSheetShow) this.setData({ dataSheetShow: false }); },
  noop() {},

  loadProfile(profile = api.getProfile()) {
    const nickname = profile.nickname || '生活记忆用户';
    const avatar = buildTextAvatar(nickname);
    ui.diffSetData(this, {
      profile: {
        nickname,
        avatarText: avatar.label,
        avatarTone: avatar.tone
      }
    });
    avatarImage.load(profile).then((path) => {
      if (profile.avatarVersion === api.getProfile().avatarVersion && !this.__pageHidden) {
        ui.diffSetData(this, { avatarPath: path });
      }
    });
  },

  avatarError() { this.setData({ avatarPath: '' }); },

  render() {
    const s = store.state;
    const settings = s.records.settings.app && s.records.settings.app.data || {};
    /* theme 可能是 'auto'（跟随系统）：token 用解析后的具体主题，选中态用原始设置值 */
    const themeId = theme.getThemeId(settings.theme);
    const themeChoice = settings.theme === theme.AUTO_THEME_ID ? theme.AUTO_THEME_ID : themeId;
    theme.applyToPage(this, themeId);
    let n = 0;
    for (const c of store.COLLECTIONS) {
      for (const r of Object.values(s.records[c])) if (!r.deletedAt) n++;
    }
    const { aiConsentKey, isProduction } = api.getRuntimeConfig();
    ui.diffSetData(this, {
      recordCount: n,
      activeDays: countActiveDays(s),
      showPersonalizedAi: Boolean(aiConsentKey),
      aiConsent: Boolean(aiConsentKey && settings[aiConsentKey] === true),
      themeId,
      themeSetting: themeChoice,
      themeOptions: theme.getThemeOptions(themeChoice),
      themeName: (theme.getThemeOptions(themeChoice).find((option) => option.selected) || {}).name || themeId,
      showDemoControls: !isProduction
    });
    this.renderSaveIssues();
  },

  renderSaveIssues() {
    const s = store.state;
    ui.diffSetData(this, {
      rejectedCount: s.rejectedWrites.length,
      // 把「哪一条、被什么状态码拒绝」说清楚，用户才能判断是数据格式问题还是服务端版本问题
      rejectedText: (() => {
        const list = s.rejectedWrites;
        if (!list.length) return '';
        const last = list[list.length - 1];
        const label = last.item.collection + (last.item.id ? '/' + last.item.id : '');
        const reason = last.statusCode ? 'HTTP ' + last.statusCode : '被拒绝';
        const tail = last.code ? '（' + last.code + '）' : '';
        return list.length + ' 条改动未保存到账号。最近一条：' + label + ' · ' + reason + tail +
          '。这类写入不会自动重试，可点「重试」再提交一次。';
      })(),
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
      })()
    });
  },

  onThemeSelect(event) {
    const choice = theme.normalizeThemeChoice(event.currentTarget.dataset.theme);
    if (choice === this.data.themeSetting) return;
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    sync.upsert('settings', { ...settings, theme: choice }, 'app');
    theme.selectTheme(choice);
    /* 不再弹 toast：选中态已有 ✓ 角标，双重反馈是噪音 */
  },
  /* 主题收纳为一行入口 + 弹层（U03） */
  openThemeSheet() { this.setData({ themeSheetShow: true }); },
  closeThemeSheet() { if (this.data.themeSheetShow) this.setData({ themeSheetShow: false }); },

  /* ---- 提醒设置弹层（v2.11）：额度展示 + 续订；开关本体在习惯页/记账页 ---- */
  openReminderSheet() {
    this.setData({ reminderSheetShow: true, reminderHabitText: '查询中…', reminderBillText: '查询中…' });
    reminderClient.fetchCaps().then((caps) => {
      this.reminderCaps = caps;
      if (!caps) {
        this.setData({ reminderHabitText: '暂不可用，请稍后再试', reminderBillText: '暂不可用，请稍后再试' });
        return;
      }
      this.setData({ reminderHabitText: this.reminderKindText('habit', caps), reminderBillText: this.reminderKindText('bill', caps) });
    });
  },
  closeReminderSheet() { if (this.data.reminderSheetShow) this.setData({ reminderSheetShow: false }); },
  reminderKindText(kind, caps) {
    const cap = caps && caps[kind];
    if (!cap || !cap.enabled) return '服务端未开启';
    const credits = Math.max(0, Number(cap.credits) || 0);
    return credits > 0 ? '剩余提醒次数 ' + credits : '额度已用完，点右侧续订';
  },
  async onReminderRenew(event) {
    const kind = event.currentTarget.dataset.kind === 'bill' ? 'bill' : 'habit';
    if (ui.isRepeatedTap(this, 'renew-' + kind, 800)) return;
    if (!this.reminderCaps) this.reminderCaps = await reminderClient.fetchCaps();
    const result = await reminderClient.subscribeAndCredit(kind, this.reminderCaps || {});
    if (result.ok) wx.showToast({ title: '已续订', icon: 'success' });
    else if (result.reason === 'unavailable') wx.showToast({ title: '服务端未开启该提醒', icon: 'none' });
    else if (result.reason === 'rejected') wx.showToast({ title: '未同意订阅', icon: 'none' });
    else wx.showToast({ title: '续订失败，请稍后重试', icon: 'none' });
    /* 上报成功的额度直接回写本页缓存，文案立即反映新值，不等下次 onShow */
    if (result.ok && this.reminderCaps && this.reminderCaps[kind]) {
      this.reminderCaps[kind].credits = Math.max(this.reminderCaps[kind].credits, Number(result.credits) || 0);
    }
    if (this.reminderCaps) {
      this.setData({ reminderHabitText: this.reminderKindText('habit', this.reminderCaps), reminderBillText: this.reminderKindText('bill', this.reminderCaps) });
    }
  },

  /* 预算编辑已迁回「记账」页（U03/U05）：那里能直接引用全部自定义支出分类 */

  saveAiConsent(enabled) {
    const settings = pickSettings(store.state.records.settings.app && store.state.records.settings.app.data);
    const { aiConsentKey } = api.getRuntimeConfig();
    if (!aiConsentKey) return;
    sync.upsert('settings', { ...settings, [aiConsentKey]: Boolean(enabled) }, 'app');
    this.setData({ aiConsent: Boolean(enabled) });
  },

  onAiConsentChange(event) {
    if (!api.getRuntimeConfig().aiConsentKey) return;
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
      if (rejected) wx.showToast({ title: '仍有 ' + rejected + ' 条未保存到账号', icon: 'none' });
      else if (store.state.queue.length) wx.showToast({ title: '仍有改动等待保存到账号', icon: 'none' });
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
      wx.showToast({ title: '备份导出失败，请稍后重试', icon: 'none' });
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
    const localWrites = parsed.backup.localWrites;
    const localWriteCount = localWrites ? localWrites.pending.length + localWrites.rejected.length : 0;
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
        roundedMoneyRecords: preview.roundedMoneyRecords,
        localWriteCount,
        moneyDifferences: preview.moneyDifferences.map((row) => {
          const fields = [['income', '收入'], ['expense', '支出'], ['transfer', '转账'], ['balance', '结余']];
          const text = fields.filter(([key]) => row[key].differenceCents).map(([key, label]) => {
            const cents = row[key].differenceCents;
            return label + ' ' + (cents > 0 ? '+' : '') + cents + ' 分';
          }).join(' · ');
          return { month: row.month, text };
        }),
        byCollection: Object.keys(preview.byCollection).map((coll) => ({ coll, ...preview.byCollection[coll] }))
      }
    });
  },
  copyImportLocalWrites() {
    const parsed = backup.parseBackup(this.data.importText);
    const localWrites = parsed.backup && parsed.backup.localWrites;
    if (localWrites) wx.setClipboardData({
      data: JSON.stringify(localWrites, null, 2),
      fail: () => wx.showToast({ title: '复制失败，请重试', icon: 'none' })
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
      if (result.cloudResolved) parts.push(result.cloudResolved + ' 条保留账号里的记录');
      if (result.stopped) parts.push(result.stopped);
      const message = parts.join('，');
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
   * 重建本机缓存（R06 原子重建）：先拉云端全量到 staging、叠加未同步改动、校验通过才替换；
   * 失败保留旧缓存，页面不会先变空白。
   */
  rebuildLocalCache() {
    this.closeDataSheet();
    const pending = store.state.queue.length;
    wx.showModal({
      title: '重建本机缓存？',
      content: pending
        ? '会重新读取账号里的记录并保留 ' + pending + ' 条仅保存在本机的改动。重建失败时保留当前缓存。'
        : '会重新读取账号里的记录。重建失败时保留当前缓存。',
      confirmText: '重建',
      success: (result) => {
        if (!result.confirm) return;
        ui.retryWithFeedback(() => sync.rebuild(), {
          loadingTitle: '正在重建',
          okTitle: '本机缓存已重建',
          failTitle: '重建未完成，原缓存保留，请检查网络后重试'
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
      content: '这会删除该账号的资料、记录、提醒和会话。导出备份后再继续，此操作无法恢复。',
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
            // 删除前尽力冲刷未同步写入：让最近的改动先落到云端再删除，而不是随账号一起消失
            const flushFirst = store.state.queue.length ? sync.flush().catch(() => {}) : Promise.resolve();
            flushFirst.then(() => api.deleteAccount()).then(() => {
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

  /*
   * 退出账号（R01/R07）：未同步队列、被拒写入、本机缓存写失败是「只存在本机的唯一副本」，
   * 退出前必须让用户确认处置 —— 先自动尝试同步，仍不干净时提供「导出本机副本」或取消；
   * 清理范围与文案一致：本机同步缓存、队列、随记草稿、搜索历史（store.resetLocal 统一清除）。
   */
  logout() {
    if (this.__logoutAttempt || ui.isRepeatedTap(this, 'logout-tap', 800)) return;
    const attempt = {};
    this.__logoutAttempt = attempt;
    const safety = store.assessDataSafety(store.state);
    if (safety.pendingCount > 0 && store.state.syncState !== 'offline') {
      wx.showLoading({ title: '正在保存改动', mask: true });
      const finish = () => {
        if (this.__logoutAttempt !== attempt || attempt.showing) return;
        wx.hideLoading();
        this.warnLocalOnlyLogout(attempt);
      };
      const guard = setTimeout(finish, 15000);
      sync.flush().catch(() => {})
        .then(() => sync.pull())
        .catch(() => {})
        .then(() => { clearTimeout(guard); finish(); });
      return;
    }
    this.warnLocalOnlyLogout(attempt);
  },
  finishLogoutAttempt(attempt) {
    if (this.__logoutAttempt === attempt) this.__logoutAttempt = null;
  },
  warnLocalOnlyLogout(attempt) {
    if (this.__logoutAttempt !== attempt || attempt.showing) return;
    attempt.showing = true;
    const safety = store.assessDataSafety(store.state);
    if (!safety.hasLocalOnly) return this.confirmLogout(attempt);
    const parts = [];
    if (safety.persistError) parts.push('本机缓存保存失败');
    if (safety.rejectedCount) parts.push(safety.rejectedCount + ' 条改动未能保存到账号');
    if (safety.pendingCount) parts.push(safety.pendingCount + ' 条改动还在等待保存到账号');
    wx.showModal({
      title: '有内容只保存在本机',
      content: parts.join('，') + '。退出会清掉这些仅存于本机的内容，建议先导出本机副本再退出。',
      confirmText: '导出副本',
      cancelText: '取消',
      confirmColor: theme.activeTokens()['--amber'],
      success: (result) => {
        if (result.confirm) this.exportCopyThenLogout(attempt);
        else this.finishLogoutAttempt(attempt);
      },
      fail: () => this.finishLogoutAttempt(attempt)
    });
  },
  /* 导出副本（离线可用）后再确认一次：未同步内容将被清除，用户知情后才执行 */
  exportCopyThenLogout(attempt = this.__logoutAttempt) {
    const copyFailed = () => {
      this.finishLogoutAttempt(attempt);
      wx.showToast({ title: '复制失败，未退出，请重试或取消', icon: 'none' });
    };
    let json;
    try { json = JSON.stringify(backup.buildLocalBackup()); } catch (error) { return copyFailed(); }
    wx.setClipboardData({
      data: json,
      success: () => {
        wx.showModal({
          title: '本机副本已复制',
          content: '建议立即粘贴到备忘录或文档保存。仍要退出吗？仅保存在本机的内容将被清除。',
          confirmText: '仍要退出',
          confirmColor: theme.activeTokens()['--red'],
          success: (result) => {
            if (result.confirm) this.performLogout();
            else this.finishLogoutAttempt(attempt);
          },
          fail: () => this.finishLogoutAttempt(attempt)
        });
      },
      fail: copyFailed
    });
  },
  confirmLogout(attempt) {
    wx.showModal({
      title: '退出当前账号？',
      content: '退出会清除本机缓存、随记和记账草稿、搜索历史与临时跳转记录。已保存到账号的记录可在重新登录后查看。',
      confirmColor: theme.activeTokens()['--amber'],
      success: (result) => {
        if (result.confirm) this.performLogout();
        else this.finishLogoutAttempt(attempt);
      },
      fail: () => this.finishLogoutAttempt(attempt)
    });
  },
  performLogout() {
    this.__logoutAttempt = null;
    sync.destroy();
    store.resetLocal();
    try { wx.removeStorageSync('wb_life_seeded'); } catch (e) { /* ignore */ }
    api.clearLogin();
    wx.reLaunch({ url: '/pages/login/login' });
  },
  editProfile() { wx.navigateTo({ url: '/pages/login/login?edit=1' }); },
  goLegal(event) {
    const doc = event.currentTarget.dataset.doc || 'service';
    wx.navigateTo({ url: '/pages/legal/legal?doc=' + encodeURIComponent(doc) });
  }
});
