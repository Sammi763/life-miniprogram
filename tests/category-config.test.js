/*
 * 记账分类配置 —— 收藏 / 隐藏 / 自定义按「收支方向＋名称」识别，旧扁平配置兼容迁移。
 *
 * 设计要点（详见 miniprogram/utils/category-utils.js 头注释）：
 * - 支出与收入允许同名分类（内置「其他」两边都有），收藏/隐藏/改名/删除必须带方向；
 * - 历史流水以名字字符串存储，隐藏/改名/删除都不改写流水；分类预算按名字匹配继续可读；
 * - 旧扁平字符串配置读取时展开为「名字实际存在的每个方向」各一条（loadLocal 落盘迁移）。
 *
 * 运行：node tests/category-config.test.js
 */
const assert = require('assert');
const path = require('path');

const root = path.resolve(__dirname, '..');
const categoryUtils = require(path.join(root, 'miniprogram', 'utils', 'category-utils'));
const { validateRecordData } = require(path.join(root, 'server', 'validation'));

const SETTINGS = {
  data: {
    budget: 3000,
    customCategories: [{ name: '咖啡', type: 'expense' }, { name: '宠物用品', type: 'expense' }, { name: '副业收入', type: 'income' }],
    favoriteCategories: [{ name: '餐饮', type: 'expense' }],
    hiddenCategories: [{ name: '宠物用品', type: 'expense' }]
  }
};
const MONEY = {
  m1: { id: 'm1', data: { type: 'expense', amount: 10, category: '餐饮', date: '2026-09-01' }, updatedAt: 10, deletedAt: 0 },
  m2: { id: 'm2', data: { type: 'expense', amount: 20, category: '交通', date: '2026-09-02' }, updatedAt: 20, deletedAt: 0 },
  m3: { id: 'm3', data: { type: 'expense', amount: 30, category: '餐饮', date: '2026-09-03' }, updatedAt: 30, deletedAt: 0 },
  m4: { id: 'm4', data: { type: 'expense', amount: 40, category: '咖啡', date: '2026-09-04' }, updatedAt: 40, deletedAt: 0 },
  tombstone: { id: 't', data: { type: 'expense', amount: 1, category: '已删分类', date: '2026-09-05' }, updatedAt: 50, deletedAt: 50 }
};

(async () => {
  /* ---------- 1. 选择器排序：收藏 → 最近使用 → 其余内置 → 自定义；该方向的隐藏不出现 ---------- */
  const list = categoryUtils.buildCategoryList(SETTINGS, MONEY, { type: 'expense' });
  assert.strictEqual(list[0], '餐饮', '收藏分类必须置顶');
  assert.ok(!list.includes('宠物用品'), '已隐藏分类（expense 方向）不得出现在新记录选择器');
  assert.ok(list.includes('咖啡'), '未被隐藏的自定义分类必须出现');
  assert.ok(list.indexOf('交通') < list.indexOf('买菜'), '最近使用的分类排在前面');
  assert.ok(!list.includes('已删分类'), '已删除流水不参与最近使用排序');
  // 隐藏 expense 的「宠物用品」不影响 income 方向的同名分类（若存在）
  const incomeList = categoryUtils.buildCategoryList(SETTINGS, MONEY, { type: 'income' });
  assert.ok(incomeList.includes('副业收入'), 'income 自定义分类必须出现在收入选择器');

  /* 编辑旧流水：原分类即使已隐藏也保留在选择器中 */
  const hiddenSettings = { data: { hiddenCategories: [{ name: '交通', type: 'expense' }] } };
  const editList = categoryUtils.buildCategoryList(hiddenSettings, MONEY, { type: 'expense', current: '交通' });
  assert.ok(editList.includes('交通'), '编辑时原分类（已隐藏）必须保留');
  const newList = categoryUtils.buildCategoryList(hiddenSettings, MONEY, { type: 'expense' });
  assert.ok(!newList.includes('交通'), '新建记录时隐藏分类不出现');

  /* ---------- 2. 同名分类按方向隔离：隐藏/收藏一边不影响另一边 ---------- */
  const bothSettings = { data: { hiddenCategories: [{ name: '其他', type: 'expense' }], favoriteCategories: [{ name: '其他', type: 'income' }] } };
  const expenseAfterHide = categoryUtils.buildCategoryList(bothSettings, MONEY, { type: 'expense' });
  const incomeAfterFav = categoryUtils.buildCategoryList(bothSettings, MONEY, { type: 'income' });
  assert.ok(!expenseAfterHide.includes('其他'), '隐藏支出「其他」后，支出选择器不再出现');
  assert.strictEqual(incomeAfterFav[0], '其他', '收藏收入「其他」后，收入选择器置顶且不受支出隐藏影响');

  /* ---------- 3. 管理列表：含隐藏与自定义、引用计数、墓碑不计 ---------- */
  const manage = categoryUtils.buildCategoryManageList(SETTINGS, MONEY);
  const coffeeRow = manage.expense.find((row) => row.name === '咖啡');
  assert.ok(coffeeRow && coffeeRow.custom && coffeeRow.usage === 1, '自定义分类需带引用数');
  const foodRow = manage.expense.find((row) => row.name === '餐饮');
  assert.ok(foodRow && !foodRow.custom && foodRow.favorite && foodRow.usage === 2, '内置分类带收藏与引用数');
  const petRow = manage.expense.find((row) => row.name === '宠物用品');
  assert.ok(petRow && petRow.hidden && !petRow.favorite, '隐藏标记按方向识别');
  assert.ok(!manage.expense.some((row) => row.name === '已删分类'), '已删除流水不计数');

  /* ---------- 4. 配置变更纯函数（全部按方向+名称） ---------- */
  const emptyConfig = { custom: [], favorites: [], hidden: [] };
  const fav = categoryUtils.toggleFavorite(emptyConfig, '餐饮', 'expense');
  assert.deepStrictEqual(fav.config.favorites, [{ name: '餐饮', type: 'expense' }]);
  assert.deepStrictEqual(categoryUtils.toggleFavorite(fav.config, '餐饮', 'expense').config.favorites, [], '同方向再点一次取消收藏');
  assert.deepStrictEqual(
    categoryUtils.toggleFavorite(fav.config, '餐饮', 'income').config.favorites.map((item) => item.type),
    ['expense', 'income'], '另一方向同名分类是独立条目'
  );
  let capped = { config: emptyConfig };
  for (let i = 0; i < categoryUtils.MAX_FAVORITES; i++) capped = categoryUtils.toggleFavorite(capped.config, '内置' + i, 'expense');
  assert.ok(categoryUtils.toggleFavorite(capped.config, '餐饮', 'expense').error, '收藏超上限必须报错');

  const added = categoryUtils.addCustomCategory(emptyConfig, '宠物用品 ', 'expense');
  assert.deepStrictEqual(added.config.custom, [{ name: '宠物用品', type: 'expense' }], '名称必须去首尾空格');
  assert.ok(categoryUtils.addCustomCategory(added.config, '餐饮', 'expense').error, '与内置重名必须拒绝');
  assert.ok(categoryUtils.addCustomCategory(added.config, '宠物用品', 'expense').error, '同方向自定义重复必须拒绝');
  assert.ok(!categoryUtils.addCustomCategory(added.config, '宠物用品', 'income').error, '另一方向同名自定义允许');

  const renamed = categoryUtils.renameCustomCategory(added.config, '宠物用品', '猫粮', 'expense');
  assert.deepStrictEqual(renamed.config.custom.map((item) => item.name), ['猫粮']);
  const bothDirections = categoryUtils.addCustomCategory(added.config, '宠物用品', 'income').config;
  const renamedOneSide = categoryUtils.renameCustomCategory(bothDirections, '宠物用品', '猫粮', 'expense');
  assert.deepStrictEqual(renamedOneSide.config.custom, [{ name: '猫粮', type: 'expense' }, { name: '宠物用品', type: 'income' }], '改名只作用于指定方向，另一方向同名不受影响');
  const favThenRename = categoryUtils.renameCustomCategory(
    { ...added.config, favorites: [{ name: '宠物用品', type: 'expense' }], hidden: [{ name: '宠物用品', type: 'expense' }] }, '宠物用品', '猫粮', 'expense'
  );
  assert.deepStrictEqual(favThenRename.config.favorites, [{ name: '猫粮', type: 'expense' }], '收藏跟随改名迁移');
  assert.deepStrictEqual(favThenRename.config.hidden, [{ name: '猫粮', type: 'expense' }], '隐藏跟随改名迁移');

  const used = categoryUtils.removeCustomCategory(emptyConfig, '咖啡', 'expense', 3);
  assert.ok(used.error, '有流水引用的自定义分类不可直接删除');
  const removed = categoryUtils.removeCustomCategory(bothDirections, '宠物用品', 'expense', 0);
  assert.deepStrictEqual(removed.config.custom, [{ name: '宠物用品', type: 'income' }], '删除只作用于指定方向');
  assert.ok(!removed.config.favorites.some((item) => item.name === '宠物用品' && item.type === 'expense'), '删除后该方向的收藏同步清除');

  /* ---------- 5. 旧扁平字符串配置兼容迁移 ---------- */
  const legacy = categoryUtils.readConfig({
    deletedAt: 0,
    data: { favoriteCategories: ['餐饮', '其他'], hiddenCategories: ['其他', '已删的自定义'], customCategories: [{ name: '咖啡', type: 'expense' }] }
  });
  assert.deepStrictEqual(legacy.favorites, [{ name: '餐饮', type: 'expense' }, { name: '其他', type: 'expense' }, { name: '其他', type: 'income' }], '字符串展开为实际存在的每个方向');
  assert.deepStrictEqual(legacy.hidden.map((item) => item.type + '|' + item.name).sort(), ['expense|其他', 'expense|已删的自定义', 'income|其他'], '未知名字按 expense 保留，不静默丢弃');
  // 「其他」是两边同名的内置分类：旧扁平字符串迁移后覆盖两个方向（与旧版行为一致），
  // 用户随后可按方向单独取消隐藏 —— 新写入是 typed 条目，不再互相误伤。
  const legacyConfig = categoryUtils.readConfig({ deletedAt: 0, data: { hiddenCategories: ['其他'] } });
  const legacyHidden = categoryUtils.buildCategoryList(
    { deletedAt: 0, data: { hiddenCategories: legacyConfig.hidden } }, MONEY, { type: 'income' }
  );
  assert.ok(!legacyHidden.includes('其他'), '旧扁平隐藏迁移后两个方向都隐藏（与旧版行为一致）');
  const fixed = categoryUtils.toggleHidden(legacyConfig, '其他', 'income');
  const incomeAfterFix = categoryUtils.buildCategoryList(
    { deletedAt: 0, data: { hiddenCategories: fixed.config.hidden } }, MONEY, { type: 'income' }
  );
  const expenseAfterFix = categoryUtils.buildCategoryList(
    { deletedAt: 0, data: { hiddenCategories: fixed.config.hidden } }, MONEY, { type: 'expense' }
  );
  assert.ok(incomeAfterFix.includes('其他'), '取消收入方向隐藏后 income 恢复');
  assert.ok(!expenseAfterFix.includes('其他'), 'expense 方向的隐藏不受另一方向操作影响');

  const migrated = categoryUtils.migrateSettingsCategories({ budget: 1, favoriteCategories: ['餐饮'] });
  assert.deepStrictEqual(migrated.favoriteCategories, [{ name: '餐饮', type: 'expense' }], '迁移函数必须转换旧格式');
  assert.strictEqual(categoryUtils.migrateSettingsCategories({ budget: 1, favoriteCategories: [{ name: '餐饮', type: 'expense' }] }), null, '已是新格式则无需迁移');
  assert.strictEqual(categoryUtils.migrateSettingsCategories({ budget: 1 }), null, '无分类字段不迁移');

  /* ---------- 6. 服务端白名单：typed 条目、越界拒绝、旧格式写入被拒（新格式由客户端迁移） ---------- */
  const valid = {
    budget: 3000,
    customCategories: [{ name: '咖啡', type: 'expense' }],
    favoriteCategories: [{ name: '餐饮', type: 'expense' }, { name: '其他', type: 'income' }],
    hiddenCategories: [{ name: '宠物', type: 'expense' }]
  };
  assert.strictEqual(validateRecordData('settings', valid), '');
  assert.strictEqual(validateRecordData('settings', { budget: 1 }), '', '旧格式（无新字段）必须继续可同步');
  assert.notStrictEqual(validateRecordData('settings', { customCategories: [{ name: '' }] }), '', '空名称必须被拒');
  assert.notStrictEqual(validateRecordData('settings', { customCategories: [{ name: '咖啡', type: 'other' }] }), '', '非法 type 必须被拒');
  assert.notStrictEqual(validateRecordData('settings', { favoriteCategories: ['餐饮'] }), '', '扁平字符串不再是合法写入格式');
  const tooMany = { customCategories: [] };
  for (let i = 0; i < 31; i++) tooMany.customCategories.push({ name: '分类' + i, type: 'expense' });
  assert.notStrictEqual(validateRecordData('settings', tooMany), '', '自定义分类超过 30 个必须被拒');
  assert.notStrictEqual(validateRecordData('settings', { favoriteCategories: new Array(13).fill({ name: '餐饮', type: 'expense' }) }), '', '收藏超过 12 个必须被拒');
  assert.notStrictEqual(validateRecordData('settings', { hiddenCategories: new Array(41).fill({ name: '餐饮', type: 'expense' }) }), '', '隐藏超过 40 个必须被拒');

  /* ---------- 7. settings 同步链路：loadLocal 自动迁移旧格式且不丢配置 ---------- */
  const mem = {};
  global.wx = {
    getStorageSync: (k) => (k in mem ? mem[k] : ''),
    setStorageSync: (k, v) => { mem[k] = v; },
    removeStorageSync: (k) => { delete mem[k]; },
    onNetworkStatusChange() {},
    connectSocket: () => ({ onOpen() {}, onMessage() {}, onClose() {}, onError() {}, close() {}, send() {} })
  };
  const store = require(path.join(root, 'miniprogram', 'utils', 'store'));
  const { pickSettings } = require(path.join(root, 'miniprogram', 'utils', 'settings-utils'));
  const picked = pickSettings({ ...valid, serverUrl: 'http://127.0.0.1:8787' });
  assert.deepStrictEqual(picked.favoriteCategories, valid.favoriteCategories, 'pickSettings 必须保留 typed 收藏');
  assert.strictEqual(picked.serverUrl, undefined, '技术字段仍被清理');
  mem['wb_life_state'] = {
    records: { settings: { app: { id: 'app', data: { budget: 3000, favoriteCategories: ['餐饮', '其他'] } } } },
    since: 0, queue: [], rejectedWrites: []
  };
  store.loadLocal();
  const saved = store.state.records.settings.app.data;
  assert.deepStrictEqual(saved.favoriteCategories, [{ name: '餐饮', type: 'expense' }, { name: '其他', type: 'expense' }, { name: '其他', type: 'income' }], 'loadLocal 必须迁移旧扁平收藏');
  assert.strictEqual(mem['wb_life_state'].records.settings.app.data.favoriteCategories[0].type, 'expense', '迁移结果落盘');

  console.log('CATEGORY_CONFIG_TEST_PASSED');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
