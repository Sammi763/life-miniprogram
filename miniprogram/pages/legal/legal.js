const api = require('../../utils/api');
const theme = require('../../utils/theme');

const DOCUMENTS = {
  service: {
    key: 'service',
    tab: '服务协议',
    title: '用户服务协议',
    intro: '请在使用前阅读。本页为上线版条款模板，运营者名称、联系方式和生效日期必须按实际信息补全后再提交审核。',
    sections: [
      { heading: '一、服务说明', paragraphs: ['“生活记忆 life”由【运营者名称】提供，是供用户自愿手工记录日常、账本、日程、习惯和文字随记的工具。账户余额、欠款和消费信息均由用户手工输入；本服务不会读取银行、支付宝、微信、征信或其他金融机构的真实数据。'] },
      { heading: '二、账号与使用', paragraphs: ['你可通过微信登录使用服务。昵称和手机号均为可选信息；手机号仅在你主动授权后用于账号保护。请妥善保管自己的微信账号和设备，不要利用服务制作、复制、发布或传播违法违规内容。'] },
      { heading: '三、数据与功能边界', paragraphs: ['你的记录默认仅在你的账号空间内可见。月度报告、周复盘和基础提醒均基于你的记录生成；财务统计、生活建议和 AI 文案仅供个人整理参考，不构成投资、信贷、医疗、心理或其他专业建议。'] },
      { heading: '四、变更、暂停与终止', paragraphs: ['在法律允许的范围内，我们可能因维护、安全、功能迭代或不可抗力调整服务，并会在合理范围内提示。你可随时在“我的 → 数据与隐私”导出记录或永久删除账户与数据。'] },
      { heading: '五、联系我们', paragraphs: ['运营者： 【运营者名称】', '联系邮箱： 【联系邮箱】', '生效日期： 【生效日期】'] }
    ]
  },
  privacy: {
    key: 'privacy',
    tab: '隐私政策',
    title: '隐私政策',
    intro: '我们遵循最小必要原则处理你的信息。请同时在微信小程序后台配置与实际调用能力一致的《用户隐私保护指引》。',
    sections: [
      { heading: '一、我们处理的信息', paragraphs: ['为登录和隔离你的数据空间，我们会处理你点击微信登录后产生的登录凭证，以及服务端从微信获得的用户唯一标识。', '为展示个人资料，我们会在你主动填写时处理昵称；为保护账号，我们只在你主动授权手机号后短暂处理微信返回的手机号，并仅保存掩码形式（如 138****0000），不接受前端直接提交完整手机号。', '为提供同步、时间线、日程、习惯、账本、账户、周/月复盘与导出，我们会处理你主动填写的纯文字记录、金额、日期、账户名称、目标和状态。'] },
      { heading: '二、本地存储、备份与留存', paragraphs: ['未保存的随记草稿只保存在当前设备；保存后的记录进入你的同步队列并存于项目自建服务器。你主动点击“复制本机备份”或“导出云端备份”时，内容会写入系统剪贴板。', '账号记录保留至你主动删除账户；会话在持续使用期间滑动续期，最长闲置 30 天后清理；已结束的提醒任务默认保留 90 天；加密的 MySQL 备份默认保留 30 天。'] },
      { heading: '三、可选的个性化 AI', paragraphs: ['个性化 AI 默认关闭。只有你在“我的 → 数据与隐私”主动开启“个性化 AI 文案”后，服务端才会向 DeepSeek API 发送经过裁剪的必要内容，用于生成“轻提醒”和“本月一句话”。发送内容可能包括部分随记正文、任务标题、心情/标签和汇总统计；不会发送手机号、登录凭证、账户余额、原始账本备注或完整同步库。', '你可以随时关闭该开关。关闭后不再调用第三方 AI，并会删除已缓存的 AI 文案；基础页面仍使用本机规则生成的文案。'] },
      { heading: '四、你的权利与联系我们', paragraphs: ['你可在“我的 → 数据与隐私”导出 JSON 副本，或发起永久删除。删除前将要求一次新的微信登录校验，随后删除账号资料、同步记录、会话、提醒和 AI 缓存。', '运营者： 【运营者名称】', '个人信息保护联系方式： 【联系邮箱】'] }
    ]
  },
  sharing: {
    key: 'sharing',
    tab: '第三方说明',
    title: '第三方处理说明',
    intro: '除以下经过用户主动开启或微信授权的必要服务外，我们不会出售、出租或公开你的生活记录。',
    sections: [
      { heading: '微信开放能力', paragraphs: ['用途：微信登录、用户主动授权手机号、用户主动订阅一次性日程提醒，以及微信后台的隐私授权流程。', '处理信息：登录凭证、用户唯一标识、手机号授权 code、订阅授权结果。手机号 code 仅用于向微信官方接口换取手机号后立即掩码保存。'] },
      { heading: 'DeepSeek API（可选）', paragraphs: ['用途：在你主动开启个性化 AI 文案后，生成轻提醒和月度一句话。', '处理信息：经过裁剪的部分随记正文、任务标题、心情/标签和汇总统计；不包含手机号、登录凭证、账户余额、原始账本备注和完整数据库。', '第三方主体及隐私政策链接： 【请按实际使用的 DeepSeek 服务主体与链接补全】'] },
      { heading: '不使用的能力', paragraphs: ['本版本不使用相册、相机、麦克风、位置、通讯录、文件上传，不读取任何银行、支付或征信平台的真实数据。'] }
    ]
  }
};

function resolveDocument(key) {
  return DOCUMENTS[key] || DOCUMENTS.service;
}

Page({
  data: {
    documents: Object.values(DOCUMENTS).map((item) => ({ key: item.key, tab: item.tab })),
    active: 'service',
    document: DOCUMENTS.service
  },
  onLoad(options) {
    theme.applyToPage(this);
    this.setDocument(options && options.doc);
  },
  onShow() { theme.applyToPage(this); },
  selectDocument(event) {
    this.setDocument(event.currentTarget.dataset.doc);
  },
  setDocument(key) {
    const document = resolveDocument(key);
    wx.setNavigationBarTitle({ title: document.title });
    this.setData({ active: document.key, document });
  },
  openWechatPrivacy() {
    api.openPrivacyContract().catch(() => {
      wx.showToast({ title: '请先在微信后台完成隐私指引配置', icon: 'none' });
    });
  }
});
