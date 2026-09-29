/*
 * 核心可用性回归：不依赖微信开发者工具，直接运行页面逻辑。
 * 运行：node tests/usability-flow.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const api = require(path.join(root, 'miniprogram', 'utils', 'api'));
const sync = require(path.join(root, 'miniprogram', 'utils', 'sync'));
const store = require(path.join(root, 'miniprogram', 'utils', 'store'));

function loadPage(relativePath) {
  const absolutePath = path.join(root, relativePath);
  const originalPage = global.Page;
  let definition = null;
  global.Page = (page) => { definition = page; };
  delete require.cache[require.resolve(absolutePath)];
  require(absolutePath);
  global.Page = originalPage;
  return definition;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assignPath(target, key, value) {
  const parts = key.split('.');
  let current = target;
  for (let index = 0; index < parts.length - 1; index++) {
    const part = parts[index];
    if (!current[part] || typeof current[part] !== 'object') current[part] = {};
    current = current[part];
  }
  current[parts[parts.length - 1]] = value;
}

function makePage(definition) {
  return {
    ...definition,
    data: clone(definition.data),
    setData(update, callback) {
      Object.keys(update).forEach((key) => assignPath(this.data, key, update[key]));
      if (callback) callback();
    }
  };
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function mondayText() {
  const date = new Date();
  const day = date.getDay() || 7;
  date.setDate(date.getDate() - day + 1);
  return sync.fmtDate(date);
}

async function main() {
  const original = {
    getBaseUrl: api.getBaseUrl,
    getProfile: api.getProfile,
    getToken: api.getToken,
    login: api.login,
    updateProfile: api.updateProfile,
    validateSession: api.validateSession,
    init: sync.init,
    upsert: sync.upsert,
    wx: global.wx
  };
  const originalSettings = store.state.records.settings;
  const originalFitness = store.state.records.fitness;

  try {
    const events = [];
    global.wx = {
      showToast: () => events.push('toast'),
      showLoading: () => events.push('loading:show'),
      switchTab: (options) => events.push('tab:' + options.url),
      hideLoading: () => events.push('loading:hide'),
      createCanvasContext: () => ({})
    };

    // 编辑资料必须留在资料页，保存后回到「我的」，不能被登录页自动跳走。
    api.getBaseUrl = () => 'http://127.0.0.1:8787';
    api.getProfile = () => ({ nickname: '旧昵称' });
    api.getToken = () => 'session-token';
    api.validateSession = () => Promise.resolve({ nickname: '已登录用户' });
    api.updateProfile = (patch) => Promise.resolve(patch);
    sync.init = () => events.push('sync:init');
    const login = makePage(loadPage('miniprogram/pages/login/login.js'));
    login.onLoad.call(login, { edit: '1' });
    await tick();
    assert.strictEqual(login.data.loggedIn, true, '已有登录态进入编辑资料页时应展示资料表单');
    assert.strictEqual(login.data.editingProfile, true, '编辑资料页必须保留编辑态');
    assert.deepStrictEqual(events, [], '编辑资料页不能初始化同步或跳转首页');
    login.data.nickname = '新昵称';
    login.completeProfile.call(login);
    await tick();
    assert.ok(events.includes('tab:/pages/mine/mine'), '资料保存后应回到我的页');

    // 登录连续失败后必须结束加载态，并允许用户再次点击；昵称留空仍可进入首页。
    let attempts = 0;
    let loginPage;
    api.login = (options) => {
      attempts++;
      if (attempts === 1) {
        options.onRetry({ retry: 1, maxRetries: 1, category: 'network_timeout' });
        assert.match(loginPage.data.loginStatus, /重新获取凭证并重试/);
        return Promise.reject({ category: 'network_timeout' });
      }
      return Promise.resolve({ nickname: '' });
    };
    loginPage = makePage(loadPage('miniprogram/pages/login/login.js'));
    loginPage.data.termsAccepted = true;
    loginPage.onLogin.call(loginPage);
    await tick();
    assert.strictEqual(loginPage.data.loggingIn, false, 'failed login must clear loading state');
    assert.strictEqual(loginPage.data.loginFailed, true, 'failed login must expose a retry state');
    // 失败文案必须同时说明「已重试」与「下一步怎么做」，不能只说失败
    assert.match(loginPage.data.serverError, /重试/);
    assert.match(loginPage.data.serverError, /仍未成功/);
    assert.match(loginPage.data.serverError, /切换网络|检查网络/);
    assert.strictEqual(loginPage.data.loginStatus, '', 'final failure replaces transient retry status');
    assert.ok(events.includes('loading:hide'), 'loading indicator must always be hidden after failure');

    loginPage.onLogin.call(loginPage);
    await tick();
    assert.strictEqual(attempts, 2, 'a second button click must start a new login');
    assert.strictEqual(loginPage.data.loggedIn, true);
    assert.strictEqual(loginPage.data.loggingIn, false);
    assert.strictEqual(loginPage.data.loginFailed, false);
    loginPage.completeProfile.call(loginPage);
    await tick();
    assert.ok(events.includes('tab:/pages/today/today'), 'an empty optional nickname must continue to the home page');

    const loginTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/login/login.wxml'), 'utf8');
    const mineTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/mine/mine.wxml'), 'utf8');
    assert.doesNotMatch(loginTemplate + mineTemplate, /getPhoneNumber|手机号|phoneCode|hasPhone/);
    assert.match(loginTemplate, /昵称可留空跳过/);

    // 预算与健身设置共用 settings.app，保存预算不能覆盖身高和目标体重。
    const upserts = [];
    sync.upsert = (...args) => upserts.push(args);
    store.state.records.settings = {
      app: { id: 'app', data: { height: 175, targetWeight: 65, budget: 3000 }, updatedAt: 1, deletedAt: 0 }
    };
    const mine = makePage(loadPage('miniprogram/pages/mine/mine.js'));
    mine.data.budgetInput = '5200.50';
    mine.saveBudget.call(mine);
    assert.deepStrictEqual(upserts.pop(), [
      'settings',
      { height: 175, targetWeight: 65, budget: 5200.5 },
      'app'
    ], '保存预算必须保留已有个人设置');

    // 编辑习惯要复用原定义 id，才能保留历史打卡记录。
    const habit = makePage(loadPage('miniprogram/pages/habit/habit.js'));
    habit.data.form = { id: 'habit-reading', name: '阅读', mode: 'count', target: '30', unit: '分钟' };
    habit.save.call(habit);
    const habitWrite = upserts.pop();
    assert.strictEqual(habitWrite[0], 'habit');
    assert.strictEqual(habitWrite[2], 'habit-reading', '编辑习惯必须写回原 id');
    assert.deepStrictEqual(habitWrite[1], {
      kind: 'def', name: '阅读', mode: 'count', target: 30, unit: '分钟'
    });

    // 书影音从图片封面切换为文字卡片后，保存时不能再写入 cover 字段。
    const media = makePage(loadPage('miniprogram/pages/media/media.js'));
    media.data.form = {
      id: 'media-book', kind: 'book', title: '旧书', status: 'done', rating: 4,
      comment: '一条纯文字短评', date: '2026-08-03'
    };
    media.save.call(media);
    const mediaWrite = upserts.pop();
    assert.strictEqual(mediaWrite[0], 'media');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(mediaWrite[1], 'cover'), false, '新书影音记录不能再写入封面地址');

    // 本周运动计划不能把上一周的安排带到新一周；最近记录需要可回看多条体重。
    const currentWeek = mondayText();
    store.state.records.fitness = {
      'weight-1': { id: 'weight-1', data: { kind: 'weight', date: '2026-08-01', weight: 73.2 }, updatedAt: 1, deletedAt: 0 },
      'weight-2': { id: 'weight-2', data: { kind: 'weight', date: '2026-08-02', weight: 72.8 }, updatedAt: 2, deletedAt: 0 },
      'weight-3': { id: 'weight-3', data: { kind: 'weight', date: '2026-08-03', weight: 72.4 }, updatedAt: 3, deletedAt: 0 },
      'plan-old': { id: 'plan-old', data: { kind: 'plan', weekday: 1, content: '上周旧计划', date: '2026-08-03' }, updatedAt: 99, deletedAt: 0 },
      'plan-current': { id: 'plan-current', data: { kind: 'plan', weekday: 1, content: '本周计划', date: currentWeek, weekStart: currentWeek }, updatedAt: 4, deletedAt: 0 }
    };
    const fitness = makePage(loadPage('miniprogram/pages/fitness/fitness.js'));
    fitness.drawChart = () => {};
    fitness.render.call(fitness);
    assert.deepStrictEqual(fitness.data.plans.map((item) => item.id), ['plan-current'], '只展示本周计划');
    assert.deepStrictEqual(fitness.data.latestRows.map((item) => item.id), ['weight-3', 'weight-2', 'weight-1'], '最近体重记录应按新到旧展示多条');
    fitness.data.planForm = { id: '', weekday: 2, content: '快走 30 分钟', done: false };
    fitness.savePlan.call(fitness);
    const planWrite = upserts.pop();
    assert.strictEqual(planWrite[0], 'fitness');
    assert.strictEqual(planWrite[1].weekStart, currentWeek, '新计划必须带本周起始日期');

    // 首页必须真正把已计算出的今日收支渲染出来。
    const todayTemplate = fs.readFileSync(path.join(root, 'miniprogram/pages/today/today.wxml'), 'utf8');
    assert.match(todayTemplate, /今日收支/);
    assert.match(todayTemplate, /\{\{todayIn\}\}/);
    assert.match(todayTemplate, /\{\{todayOut\}\}/);

    console.log('USABILITY_FLOW_TEST_PASSED');
  } finally {
    api.getBaseUrl = original.getBaseUrl;
    api.getProfile = original.getProfile;
    api.getToken = original.getToken;
    api.login = original.login;
    api.updateProfile = original.updateProfile;
    api.validateSession = original.validateSession;
    sync.init = original.init;
    sync.upsert = original.upsert;
    store.state.records.settings = originalSettings;
    store.state.records.fitness = originalFitness;
    global.wx = original.wx;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
