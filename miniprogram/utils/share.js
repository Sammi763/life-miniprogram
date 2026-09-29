/*
 * 转发（微信好友）与分享到朋友圈。
 *
 * 隐私约定：分享卡片只用**固定中性文案**，本模块不 require store、不读取任何本机记录，
 * 因此卡片标题里不可能出现金额、习惯、随记正文、体重等个人信息；
 * 同时显式指定 imageUrl 为包内 logo，避免微信默认使用「当前页面截图」当分享图
 * （记账页、时间线页的截图会带上用户自己的数据）。
 *
 * 说明：好友点开卡片后是在**自己设备**上打开小程序并用自己的账号登录，
 * 看不到分享者的数据；这里防的主要是卡片本身的文案与截图。
 */

/* 与登录页品牌位同一张图，已在包内，无需新增资源 */
const SHARE_IMAGE = '/assets/logo.png';

/* 每条只描述「这个应用是什么」，不含任何用户数据 */
const TARGETS = {
  login: { title: '生活记忆 life · 记账、习惯、随记，一处安放', path: '/pages/login/login' },
  today: { title: '生活记忆 life · 每天一眼看清今天', path: '/pages/today/today' },
  money: { title: '生活记忆 life · 记账和预算，够用就好', path: '/pages/money/money' },
  habit: { title: '生活记忆 life · 习惯打卡与连续天数', path: '/pages/habit/habit' },
  mine: { title: '生活记忆 life · 数据留在自己手里', path: '/pages/mine/mine' },
  plan: { title: '生活记忆 life · 日程与重复事项', path: '/pages/plan/plan' },
  shopping: { title: '生活记忆 life · 待买清单不丢事', path: '/pages/shopping/shopping' },
  media: { title: '生活记忆 life · 书影音收藏', path: '/pages/media/media' },
  fitness: { title: '生活记忆 life · 体重趋势与健身计划', path: '/pages/fitness/fitness' },
  report: { title: '生活记忆 life · 月度生活报告', path: '/pages/report/report' },
  memory: { title: '生活记忆 life · 生活时间线', path: '/pages/memory/memory' },
  review: { title: '生活记忆 life · 每周复盘', path: '/pages/review/review' }
};

const FALLBACK_KEY = 'today';

function targetFor(key) {
  return TARGETS[key] || TARGETS[FALLBACK_KEY];
}

/* 返回可直接挂到 Page({ onShareAppMessage }) 的处理函数 */
function onShareAppMessage(key) {
  return function shareAppMessage() {
    const target = targetFor(key);
    /* 不带 query：避免把本机筛选状态、记录 id 等带进分享链接 */
    return { title: target.title, path: target.path, imageUrl: SHARE_IMAGE };
  };
}

/* 朋友圈卡片只支持 query、不支持 path，同样不带任何参数 */
function onShareTimeline(key) {
  return function shareTimeline() {
    return { title: targetFor(key).title, query: '', imageUrl: SHARE_IMAGE };
  };
}

/*
 * 默认「转发」会随 onShareAppMessage 出现；朋友圈需要在页面 onShow 里显式打开菜单项。
 * 不支持的宿主环境（旧基础库）静默跳过，不影响页面其他逻辑。
 */
function enableShareMenu() {
  if (typeof wx === 'undefined' || typeof wx.showShareMenu !== 'function') return false;
  try {
    wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] });
    return true;
  } catch (error) {
    return false;
  }
}

module.exports = { SHARE_IMAGE, TARGETS, targetFor, onShareAppMessage, onShareTimeline, enableShareMenu };
