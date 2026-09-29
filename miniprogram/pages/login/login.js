const api = require('../../utils/api');
const sync = require('../../utils/sync');
const { buildTextAvatar } = require('../../utils/text-avatar');
const { BUILD_VERSION } = require('../../config/build');
const theme = require('../../utils/theme');
const share = require('../../utils/share');

const TERMS_VERSION = 'v2';
const TERMS_KEY = 'wb_life_terms_' + TERMS_VERSION;

function hasAcceptedTerms() {
  try { return Boolean(wx.getStorageSync && wx.getStorageSync(TERMS_KEY)); } catch (error) { return false; }
}

function rememberTerms() {
  try { wx.setStorageSync && wx.setStorageSync(TERMS_KEY, Date.now()); } catch (error) { /* local acknowledgement is best effort */ }
}

function profileData(profile) {
  const value = profile || {};
  const avatar = buildTextAvatar(value.nickname || '');
  return {
    nickname: value.nickname || '',
    avatarText: avatar.label,
    avatarTone: avatar.tone
  };
}

/* 传输类失败给可执行的下一步，而不是只报「失败」 */
function loginErrorMessage(error) {
  const category = error && error.category;
  if (category === 'network_reset') return '连接被中断，已自动重试仍未成功。请切换 WiFi / 移动网络后重新登录。';
  if (category === 'network_refused') return '服务器拒绝了连接，已自动重试仍未成功。请切换网络后重新登录。';
  if (category === 'network_timeout') return '连接服务器超时，已自动重试仍未成功。请检查网络后重新登录。';
  if (category === 'wx_login_failed') return '暂时无法获取微信登录凭证，请重新登录。';
  if (category === 'http_401') return '微信登录校验失败，请稍后重新登录。';
  if (category === 'http_429') return '登录请求过于频繁，请稍后再试。';
  if (category && /^http_5\d\d$/.test(category)) return '登录服务暂时不可用，请稍后重新登录。';
  return '登录失败，请检查网络后重新登录。';
}

/* 自检结论：先区分「服务端整体不可达」与「仅登录失败」，再决定给什么建议 */
function diagnosticMessage(error) {
  const category = error && error.category;
  if (category === 'network_reset') return '服务器连接被中断，当前网络到服务器不通。请切换 WiFi / 移动网络后重试。';
  if (category === 'network_refused') return '服务器拒绝连接，当前网络到服务器不通。请切换网络后重试。';
  if (category === 'network_timeout') return '自检请求超时，网络到服务器不通。请切换网络后重试。';
  if (category && /^http_5\d\d$/.test(category)) return '服务器可达但返回异常，稍后重试即可。';
  if (category && /^http_4\d\d$/.test(category)) return '服务器可达但拒绝了自检请求，请稍后重试。';
  return '无法确认服务器状态，请检查网络后重试。';
}

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    /* 本地已有会话、正在校验并准备自动进入时为 true：展示静默过渡页，避免登录卡闪现后跳转 */
    entering: false,
    loginFailed: false,
    loginStatus: '',
    saving: false,
    editingProfile: false,
    serverError: '',
    diagnosing: false,
    diagnostic: '',
    diagnosticFailed: false,
    buildVersion: BUILD_VERSION,
    nickname: '',
    avatarText: '生',
    avatarTone: 'avatar-tone-0',
    termsAccepted: false,
    existingSessionNeedsTerms: false
  },

  onLoad(options) {
    theme.applyToPage(this);
    share.enableShareMenu();
    const editingProfile = Boolean(options && options.edit === '1');
    const cached = api.getProfile();
    const runtime = api.getRuntimeConfig();
    this.setData({
      editingProfile,
      termsAccepted: hasAcceptedTerms(),
      serverError: runtime.apiConfigured ? '' : '服务暂未配置完成，请稍后再试。',
      ...profileData(cached)
    });
    if (!api.getToken()) return;
    this.setData({ entering: !editingProfile });
    api.validateSession()
      .then((profile) => {
        if (editingProfile) {
          this.setData({ entering: false, loggedIn: true, ...profileData(profile) });
          return;
        }
        if (!this.data.termsAccepted) {
          this.setData({ entering: false, existingSessionNeedsTerms: true, serverError: '继续使用前，请先阅读并同意用户协议与隐私政策。' });
          return;
        }
        sync.init();
        wx.switchTab({ url: '/pages/today/today', fail: () => this.setData({ entering: false }) });
      })
      .catch((error) => {
        this.setData({ entering: false, serverError: loginErrorMessage(error), loginFailed: true });
      });
  },

  onShareAppMessage: share.onShareAppMessage('login'),
  onShareTimeline: share.onShareTimeline('login'),

  onLogin() {
    if (this.data.loggingIn) return;
    if (!this.data.termsAccepted) {
      wx.showToast({ title: '请先阅读并同意相关协议', icon: 'none' });
      return;
    }
    if (!api.getBaseUrl()) {
      this.setData({ serverError: '服务暂未配置完成，请稍后再试。' });
      return;
    }
    this.setData({ loggingIn: true, loginFailed: false, loginStatus: '正在获取微信登录凭证…', serverError: '', diagnostic: '', diagnosticFailed: false });
    wx.showLoading({ title: '微信登录中', mask: true });
    let completionToast = null;
    api.login({
      onRetry: ({ retry, maxRetries }) => this.setData({ loginStatus: `网络连接中断，正在重新获取凭证并重试（${retry}/${maxRetries}）…` })
    })
      .then((profile) => {
        rememberTerms();
        this.setData({ loggedIn: true, loginStatus: '', loginFailed: false, ...profileData(profile) });
        completionToast = { title: '登录成功', icon: 'success' };
      })
      .catch((error) => {
        this.setData({ serverError: loginErrorMessage(error), loginStatus: '', loginFailed: true });
        completionToast = { title: '登录失败，可重新点击登录', icon: 'none' };
      })
      .finally(() => {
        wx.hideLoading();
        this.setData({ loggingIn: false });
        if (completionToast) wx.showToast(completionToast);
      });
  },

  /*
   * 只读自检：只探测 /api/health，不登录、不写本地数据、不发敏感信息。
   * 结论给用户，也方便报障时说清「域名不通」还是「登录接口不通」。
   */
  onDiagnose() {
    if (this.data.diagnosing) return;
    this.setData({ diagnosing: true, diagnostic: '', diagnosticFailed: false });
    api.checkHealth()
      .then(() => this.setData({ diagnostic: '服务器可达。请稍后重新点击登录；若仍失败，多为微信登录凭证或登录接口问题。', diagnosticFailed: false }))
      .catch((error) => this.setData({ diagnostic: diagnosticMessage(error), diagnosticFailed: true }))
      .finally(() => this.setData({ diagnosing: false }));
  },

  onNickname(event) {
    const nickname = (event.detail && event.detail.value) || '';
    const avatar = buildTextAvatar(nickname);
    this.setData({ nickname, avatarText: avatar.label, avatarTone: avatar.tone });
  },

  onTermsChange(event) {
    const values = event.detail && event.detail.value || [];
    this.setData({ termsAccepted: values.includes('accepted'), serverError: this.data.serverError === '继续使用前，请先阅读并同意用户协议与隐私政策。' ? '' : this.data.serverError });
  },

  openLegal(event) {
    const doc = event.currentTarget.dataset.doc || 'service';
    wx.navigateTo({ url: '/pages/legal/legal?doc=' + encodeURIComponent(doc) });
  },

  completeProfile() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    api.updateProfile({ nickname: String(this.data.nickname || '').trim() })
      .then(() => {
        if (this.data.editingProfile) {
          wx.switchTab({ url: '/pages/mine/mine' });
          return;
        }
        sync.init();
        wx.switchTab({ url: '/pages/today/today' });
      })
      .catch(() => wx.showToast({ title: '资料保存失败，请重试', icon: 'none' }))
      .finally(() => this.setData({ saving: false }));
  }
});
