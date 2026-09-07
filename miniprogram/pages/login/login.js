const api = require('../../utils/api');
const sync = require('../../utils/sync');
const { buildTextAvatar } = require('../../utils/text-avatar');
const theme = require('../../utils/theme');

const TERMS_VERSION = 'v1';
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
    avatarTone: avatar.tone,
    hasPhone: Boolean(value.hasPhone),
    phoneText: value.phone || '未绑定手机号'
  };
}

function connectionErrorMessage(error) {
  const message = String((error && error.message) || '');
  if (/connection refused|err_connection_refused|econnrefused/i.test(message)) {
    return '暂时无法连接服务，请稍后重试。';
  }
  return '暂时无法连接服务，请检查网络后重试。';
}

Page({
  data: {
    loggedIn: false,
    loggingIn: false,
    saving: false,
    phoneLoading: false,
    editingProfile: false,
    serverError: '',
    nickname: '',
    avatarText: '生',
    avatarTone: 'avatar-tone-0',
    hasPhone: false,
    phoneText: '未绑定手机号',
    termsAccepted: false,
    existingSessionNeedsTerms: false
  },

  onLoad(options) {
    theme.applyToPage(this);
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
    api.validateSession()
      .then((profile) => {
        this.setData({ loggedIn: true, ...profileData(profile) });
        if (editingProfile) return;
        if (!this.data.termsAccepted) {
          this.setData({ loggedIn: false, existingSessionNeedsTerms: true, serverError: '继续使用前，请先阅读并同意用户协议与隐私政策。' });
          return;
        }
        sync.init();
        wx.switchTab({ url: '/pages/today/today' });
      })
      .catch((error) => {
        this.setData({ serverError: connectionErrorMessage(error) });
      });
  },

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
    this.setData({ loggingIn: true, serverError: '' });
    wx.showLoading({ title: '登录中' });
    api.login()
      .then((profile) => {
        rememberTerms();
        this.setData({ loggedIn: true, ...profileData(profile) });
        wx.hideLoading();
        wx.showToast({ title: '登录成功', icon: 'success' });
      })
      .catch((error) => {
        const serverError = connectionErrorMessage(error);
        this.setData({ serverError });
        wx.hideLoading();
        wx.showToast({ title: serverError.indexOf('未启动') >= 0 ? '本地后端未启动' : '登录失败', icon: 'none' });
      })
      .finally(() => this.setData({ loggingIn: false }));
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

  onGetPhoneNumber(event) {
    const detail = event.detail || {};
    if (!detail.code) {
      wx.showToast({ title: '你暂未授权手机号', icon: 'none' });
      return;
    }
    if (this.data.phoneLoading) return;
    this.setData({ phoneLoading: true });
    wx.showLoading({ title: '绑定手机号' });
    api.requirePrivacyAuthorization()
      .then((authorized) => {
        if (!authorized) throw new Error('privacy_not_authorized');
        return api.updateProfile({ phoneCode: detail.code });
      })
      .then((profile) => {
        this.setData(profileData(profile));
        wx.hideLoading();
        wx.showToast({ title: '手机号已绑定', icon: 'success' });
      })
      .catch((error) => {
        const title = error && error.message === 'privacy_not_authorized'
          ? '同意隐私指引后才可授权手机号'
          : error && error.code === 'phone_exchange_failed'
          ? '手机号授权失败，请用真机重试'
          : '手机号保存失败，请重试';
        wx.hideLoading();
        wx.showToast({ title, icon: 'none' });
      })
      .finally(() => this.setData({ phoneLoading: false }));
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
