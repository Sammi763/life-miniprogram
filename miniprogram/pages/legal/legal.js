const api = require('../../utils/api');
const theme = require('../../utils/theme');

const DOCUMENTS = {
  service: {
    key: 'service',
    tab: '服务协议',
    title: '用户服务协议',
    intro: '本协议说明服务范围、账号使用及你的数据权利。',
    sections: [
      { heading: '一、服务说明', paragraphs: ['“生活记忆 life”由Soy Sauce提供，是供用户自愿手工记录日常、账本、日程、习惯和文字随记的工具。账户余额、欠款和消费信息均由用户手工输入；本服务不会读取银行、支付宝、微信、征信或其他金融机构的真实数据。'] },
      { heading: '二、账号与使用', paragraphs: ['你可通过微信登录使用服务；在当前小程序 AppID 下，同一微信账号会进入同一专属数据空间。昵称可选，留空也可继续使用。本版本不请求或使用手机号，也不提供手机号找回功能。请妥善保管自己的微信账号和设备，不要利用服务制作、复制、发布或传播违法违规内容。'] },
      { heading: '三、数据与功能边界', paragraphs: ['你的记录默认仅在你的账号空间内可见。月度报告、周复盘和基础提醒均基于你的记录生成；财务统计和生活提示仅供个人整理参考，不构成投资、信贷、医疗、心理或其他专业建议。'] },
      { heading: '四、变更、暂停与终止', paragraphs: ['在法律允许的范围内，我们可能因维护、安全、功能迭代或不可抗力调整服务，并会在合理范围内提示。你可在“我的 → 数据管理”导出记录，也可在“我的 → 账号”永久删除账户与数据。'] },
      { heading: '五、联系我们', paragraphs: ['运营者： Soy Sauce', '联系邮箱： yang5780520@163.com', '生效日期： 自小程序首次正式发布之日起'] }
    ]
  },
  privacy: {
    key: 'privacy',
    tab: '隐私政策',
    title: '隐私政策',
    intro: '本政策说明我们为提供记录服务处理的信息、留存方式和你的选择。',
    sections: [
      { heading: '一、我们处理的信息', paragraphs: ['为登录和隔离你的数据空间，我们会处理你点击微信登录后产生的登录凭证，以及服务端从微信获得的用户唯一标识。同一小程序 AppID 下，同一微信账号会对应同一数据空间。', '昵称和头像均由你选择填写，用于展示账号资料。头像在你保存时上传到自建服务器的私有存储，同一账号可跨设备查看，并可在编辑资料中清除。本版本不请求、绑定或使用手机号，也不提供手机号找回功能；为兼容历史资料，此前版本已保存的掩码手机号可能继续保留至你删除账户，不用于登录、找回或第三方处理。', '为保存账号记录并提供时间线、日程、习惯、账本、账户、周/月复盘与导出，我们会处理你主动填写的纯文字记录、金额、日期、账户名称、目标和状态。'] },
      { heading: '二、本地存储、备份与留存', paragraphs: ['未保存的随记草稿只保存在当前设备；已保存的记录会上传至自建服务器，按账号存储。你主动复制本机备份、导出账号备份或导出账本 CSV 时，内容写入系统剪贴板。你也可主动粘贴 JSON 备份，经预览和确认后合并缺失记录。', '账号记录保留至你主动删除账户；会话在持续使用期间滑动续期，最长闲置 30 天后清理；已结束的提醒任务默认保留 90 天；MySQL 压缩备份文件存放于访问受限的运维目录，默认保留 30 天。'] },
      { heading: '三、你的权利与联系我们', paragraphs: ['你可在“我的 → 数据管理”导出 JSON 副本，或在“我的 → 账号”发起永久删除。删除前将要求一次新的微信登录校验，随后删除账号资料（含头像）、生活记录、会话、提醒和相关缓存；已生成的服务器备份会在保留期结束后清除。', '运营者： Soy Sauce', '个人信息保护联系方式： yang5780520@163.com', '生效日期： 自小程序首次正式发布之日起'] }
    ]
  },
  sharing: {
    key: 'sharing',
    tab: '第三方说明',
    title: '第三方处理说明',
    intro: '以下是本版本使用的微信平台能力。',
    sections: [
      { heading: '微信开放能力', paragraphs: ['用途：微信登录、用户主动选择头像、用户主动订阅提醒（如日程、习惯打卡和还款），以及查看微信平台的隐私保护指引。', '处理信息：登录凭证、用户唯一标识、你选择的头像、订阅授权结果。本版本不调用手机号快速验证能力。'] },
      { heading: '不使用的能力', paragraphs: ['图片能力仅用于微信头像选择。生活记录维持文字输入。本版本不单独调用相机、麦克风、位置、通讯录或通用文件选取，不读取银行、支付或征信平台的数据，也不向外部 AI 服务发送生活记录。'] }
    ]
  }
};

const TRIAL_AI_NOTICE = {
  heading: '体验版个性化 AI 文案',
  paragraphs: [
    '默认关闭。主动同意开启后，服务器会向 DeepSeek API 发送裁剪后的随记片段、任务标题和汇总统计，用于生成今日轻提醒和月度一句话。',
    '可在“我的 → 设置”随时关闭。服务端不会向 DeepSeek 发送手机号、账户余额或原始账本备注。'
  ]
};

function resolveDocument(key) {
  const document = DOCUMENTS[key] || DOCUMENTS.service;
  if (api.getRuntimeConfig().envVersion !== 'trial' || document.key === 'service') return document;
  const sections = document.key === 'sharing'
    ? document.sections.map((section) => ({
      ...section,
      paragraphs: section.paragraphs.map((paragraph) => paragraph.replace('，也不向外部 AI 服务发送生活记录', ''))
    }))
    : document.sections;
  return { ...document, sections: [...sections, TRIAL_AI_NOTICE] };
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
    /* 切换文档后回到顶部：否则长文档滚到中部切 tab 会停在原地，像内容缺失 */
    wx.pageScrollTo({ scrollTop: 0, duration: 0 });
  },
  /* 节内锚点：长文档快速跳转 */
  jumpToSection(event) {
    const index = Number(event.currentTarget.dataset.index) || 0;
    wx.pageScrollTo({ selector: '#section-' + index, duration: 200, fail: () => {} });
  },
  openWechatPrivacy() {
    api.openPrivacyContract().catch(() => {
      wx.showToast({ title: '暂时无法打开微信隐私指引', icon: 'none' });
    });
  }
});
