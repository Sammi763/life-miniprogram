/*
 * 主题只保存一个受控的主题 ID；页面使用内联 CSS 变量承接配色，避免把用户输入
 * 拼进 style。选择会写入 settings.app，因而能跟随同步记录在设备间保持一致。
 * v2.11 起允许 'auto'（跟随系统深浅）：settings.theme 可存 auto，本机存储
 * wb_life_theme 只记「最后一个具体主题」，auto 浅色时回退到它（见 lastLightThemeId）。
 */
const THEME_STORAGE_KEY = 'wb_life_theme';
const DEFAULT_THEME_ID = 'forest';
const AUTO_THEME_ID = 'auto';

const THEMES = [
  {
    id: 'forest', name: '雾林', detail: '静谧绿', preview: 'linear-gradient(135deg, #315C52 0%, #E3EEE8 100%)',
    navigation: '#F3F5F2',
    tokens: {
      '--bg': '#F3F5F2', '--card': '#FFFFFF', '--surface': '#FAFBF9', '--ink': '#1C2520', '--ink-2': '#78817B', '--line': '#E2E7E1',
      '--accent': '#315C52', '--accent-strong': '#23483F', '--accent-soft': '#E3EEE8', '--accent-wash': '#F0F5F1',
      '--green': '#39745D', '--green-soft': '#E3F0E8', '--red': '#B95755', '--amber': '#9A7338', '--danger-soft': '#F8EBEA', '--warn-soft': '#F8F0DF',
      '--card-border': 'rgba(210,220,212,.82)', '--shadow-color': 'rgba(31,56,43,.045)', '--pressed-shadow': 'rgba(31,56,43,.09)',
      '--button-shadow': 'rgba(35,72,63,.18)', '--button-shadow-strong': 'rgba(35,72,63,.28)', '--mask-color': 'rgba(17,30,25,.42)', '--sheet-shadow': 'rgba(18,37,29,.12)',
      '--hero-start': '#2E564C', '--hero-end': '#203F38', '--hero-shadow': 'rgba(29,68,58,.20)', '--hero-edit': '#E4F0E8', '--hero-soft': '#D9E9DE', '--hero-soft-ink': '#23483F',
      '--tab-bg': 'rgba(255,255,255,.96)', '--tab-line': 'rgba(210,220,212,.88)', '--tab-text': '#7A827D', '--tab-selected': '#203F38', '--tab-selected-bg': '#E3EEE8'
    }
  },
  {
    id: 'paper', name: '暖纸', detail: '柔和米杏', preview: 'linear-gradient(135deg, #8B5E3C 0%, #F4E8D7 100%)',
    navigation: '#F7F1E8',
    tokens: {
      '--bg': '#F7F1E8', '--card': '#FFFDF9', '--surface': '#FCF8F1', '--ink': '#302921', '--ink-2': '#83766A', '--line': '#E9DED1',
      '--accent': '#8B5E3C', '--accent-strong': '#6C4429', '--accent-soft': '#F2E4D3', '--accent-wash': '#FAF1E7',
      '--green': '#527362', '--green-soft': '#E3EFE7', '--red': '#B85C55', '--amber': '#9A7438', '--danger-soft': '#F9ECE6', '--warn-soft': '#F7EDDC',
      '--card-border': 'rgba(224,208,192,.88)', '--shadow-color': 'rgba(80,57,34,.05)', '--pressed-shadow': 'rgba(80,57,34,.10)',
      '--button-shadow': 'rgba(108,68,41,.18)', '--button-shadow-strong': 'rgba(108,68,41,.27)', '--mask-color': 'rgba(42,31,22,.42)', '--sheet-shadow': 'rgba(65,43,25,.13)',
      '--hero-start': '#7A5033', '--hero-end': '#5F3C26', '--hero-shadow': 'rgba(101,62,34,.20)', '--hero-edit': '#F7E9D9', '--hero-soft': '#F2E1D0', '--hero-soft-ink': '#5F3C26',
      '--tab-bg': 'rgba(255,253,249,.97)', '--tab-line': 'rgba(226,211,195,.92)', '--tab-text': '#84776B', '--tab-selected': '#674129', '--tab-selected-bg': '#F2E4D3'
    }
  },
  {
    id: 'sky', name: '月白', detail: '清透灰蓝', preview: 'linear-gradient(135deg, #2E637D 0%, #E2EEF3 100%)',
    navigation: '#F1F5F8',
    tokens: {
      '--bg': '#F1F5F8', '--card': '#FEFFFF', '--surface': '#F8FBFC', '--ink': '#1E2B33', '--ink-2': '#70808A', '--line': '#DCE6EB',
      '--accent': '#2E637D', '--accent-strong': '#234D63', '--accent-soft': '#E0EDF3', '--accent-wash': '#EDF5F8',
      '--green': '#397263', '--green-soft': '#E1F0EA', '--red': '#B75859', '--amber': '#92723D', '--danger-soft': '#F8ECEE', '--warn-soft': '#F5F0E0',
      '--card-border': 'rgba(205,218,225,.88)', '--shadow-color': 'rgba(30,58,71,.045)', '--pressed-shadow': 'rgba(30,58,71,.10)',
      '--button-shadow': 'rgba(35,77,99,.18)', '--button-shadow-strong': 'rgba(35,77,99,.28)', '--mask-color': 'rgba(17,35,44,.42)', '--sheet-shadow': 'rgba(25,50,63,.12)',
      '--hero-start': '#315F76', '--hero-end': '#244858', '--hero-shadow': 'rgba(36,72,88,.20)', '--hero-edit': '#E2F0F5', '--hero-soft': '#DCEBF1', '--hero-soft-ink': '#244858',
      '--tab-bg': 'rgba(254,255,255,.97)', '--tab-line': 'rgba(207,220,228,.92)', '--tab-text': '#72818A', '--tab-selected': '#244858', '--tab-selected-bg': '#E0EDF3'
    }
  },
  {
    id: 'violet', name: '暮紫', detail: '克制紫灰', preview: 'linear-gradient(135deg, #6C557C 0%, #ECE4F0 100%)',
    navigation: '#F6F3F8',
    tokens: {
      '--bg': '#F6F3F8', '--card': '#FFFEFF', '--surface': '#FBF9FC', '--ink': '#292430', '--ink-2': '#7B7485', '--line': '#E5DFE9',
      '--accent': '#6C557C', '--accent-strong': '#513D62', '--accent-soft': '#EAE3EF', '--accent-wash': '#F3EEF6',
      '--green': '#467263', '--green-soft': '#E0EEE8', '--red': '#B85A64', '--amber': '#92723F', '--danger-soft': '#F8ECEF', '--warn-soft': '#F5EFE2',
      '--card-border': 'rgba(218,210,226,.88)', '--shadow-color': 'rgba(60,45,76,.045)', '--pressed-shadow': 'rgba(60,45,76,.10)',
      '--button-shadow': 'rgba(81,61,98,.18)', '--button-shadow-strong': 'rgba(81,61,98,.28)', '--mask-color': 'rgba(31,24,38,.42)', '--sheet-shadow': 'rgba(47,35,59,.12)',
      '--hero-start': '#65506F', '--hero-end': '#483752', '--hero-shadow': 'rgba(72,55,82,.20)', '--hero-edit': '#EEE6F3', '--hero-soft': '#E9DFEF', '--hero-soft-ink': '#483752',
      '--tab-bg': 'rgba(255,254,255,.97)', '--tab-line': 'rgba(222,215,229,.92)', '--tab-text': '#7D7586', '--tab-selected': '#4C3958', '--tab-selected-bg': '#EAE3EF'
    }
  },
  {
    /* 夜间主题：仅手动切换（不跟随系统），token 键集与其余主题完全一致（theme-night 测试钉住）。
       原生导航栏前景色随主题切换：浅色主题黑字，夜间白字。 */
    id: 'night', name: '夜间', detail: '深色护眼', preview: 'linear-gradient(135deg, #22323B 0%, #171B1E 100%)',
    navigation: '#171B1E',
    navigationFront: '#ffffff',
    tokens: {
      '--bg': '#171B1E', '--card': '#1F2428', '--surface': '#232930', '--ink': '#E7ECEA', '--ink-2': '#8B9793', '--line': '#31383D',
      '--accent': '#5E9C8B', '--accent-strong': '#7FB5A6', '--accent-soft': '#24332E', '--accent-wash': '#1E2B27',
      '--green': '#6FB294', '--green-soft': '#1F3029', '--red': '#C97B76', '--amber': '#B99050', '--danger-soft': '#33231F', '--warn-soft': '#332B1E',
      '--card-border': 'rgba(70,80,86,.72)', '--shadow-color': 'rgba(0,0,0,.20)', '--pressed-shadow': 'rgba(0,0,0,.32)',
      '--button-shadow': 'rgba(0,0,0,.30)', '--button-shadow-strong': 'rgba(0,0,0,.40)', '--mask-color': 'rgba(0,0,0,.62)', '--sheet-shadow': 'rgba(0,0,0,.42)',
      '--hero-start': '#22323B', '--hero-end': '#161F26', '--hero-shadow': 'rgba(0,0,0,.35)', '--hero-edit': '#2A3B44', '--hero-soft': '#24343D', '--hero-soft-ink': '#BFD6D0',
      '--tab-bg': 'rgba(26,30,33,.97)', '--tab-line': 'rgba(60,68,74,.90)', '--tab-text': '#8B9793', '--tab-selected': '#9FD3C4', '--tab-selected-bg': '#24332E'
    }
  }
];

const THEME_MAP = Object.fromEntries(THEMES.map((theme) => [theme.id, theme]));

/* 「跟随系统」选择器项：预览图为上浅下深双色渐变，只作为选项存在，不是真实主题 */
const AUTO_THEME_OPTION = {
  id: 'auto',
  name: '跟随系统',
  detail: '深浅随系统切换',
  preview: 'linear-gradient(180deg, #F3F5F2 0%, #F3F5F2 49%, #171B1E 51%, #171B1E 100%)'
};

function normalizeThemeId(value) {
  return THEME_MAP[value] ? value : DEFAULT_THEME_ID;
}

/* 选择入口用：允许 'auto'，其余未知值回退具体主题（normalizeThemeId 保持旧语义供旧调用兼容） */
function normalizeThemeChoice(value) {
  return value === AUTO_THEME_ID ? AUTO_THEME_ID : normalizeThemeId(value);
}

/* 系统当前深浅；拿不到（旧基础库/异常）时按浅色处理 */
function systemPrefersDark() {
  try {
    if (typeof wx === 'undefined') return false;
    let value = '';
    if (typeof wx.getAppBaseInfo === 'function') {
      const info = wx.getAppBaseInfo();
      if (info && info.theme) value = info.theme;
    }
    if (!value && typeof wx.getSystemInfoSync === 'function') {
      const info = wx.getSystemInfoSync();
      if (info && info.theme) value = info.theme;
    }
    return value === 'dark';
  } catch (error) {
    return false;
  }
}

function readStoredRawThemeId() {
  try {
    return wx.getStorageSync(THEME_STORAGE_KEY);
  } catch (error) {
    return '';
  }
}

function readStoredThemeId() {
  return normalizeThemeId(readStoredRawThemeId());
}

/* auto 浅色分支：本机存的最后一个「具体浅色」主题；存了 night/auto/未知值则回退 forest */
function lastLightThemeId() {
  const raw = readStoredRawThemeId();
  return THEME_MAP[raw] && raw !== 'night' ? raw : DEFAULT_THEME_ID;
}

function readSyncedThemeId() {
  try {
    const store = require('./store');
    const setting = store.state.records.settings && store.state.records.settings.app;
    const value = setting && !setting.deletedAt && setting.data && setting.data.theme;
    if (value === AUTO_THEME_ID) return AUTO_THEME_ID;
    return THEME_MAP[value] ? value : '';
  } catch (error) {
    return '';
  }
}

function saveThemeId(id) {
  try { wx.setStorageSync(THEME_STORAGE_KEY, id); } catch (error) { /* local preference is best effort */ }
}

function resolveThemeId(preferredId) {
  const raw = preferredId === undefined || preferredId === null || preferredId === ''
    ? readSyncedThemeId()
    : preferredId;
  if (raw === AUTO_THEME_ID) return systemPrefersDark() ? 'night' : lastLightThemeId();
  return normalizeThemeId(raw || readStoredThemeId());
}

function getThemeId(preferredId) {
  return resolveThemeId(preferredId);
}

function getTheme(preferredId) {
  return THEME_MAP[getThemeId(preferredId)];
}

function getThemeStyle(preferredId) {
  const tokens = getTheme(preferredId).tokens;
  return Object.keys(tokens).map((key) => key + ':' + tokens[key]).join(';') + ';';
}

function getThemeData(preferredId) {
  const theme = getTheme(preferredId);
  return {
    themeId: theme.id,
    themeStyle: getThemeStyle(theme.id),
    themeAccent: theme.tokens['--accent']
  };
}

function getThemeOptions(preferredId) {
  const isAuto = preferredId === AUTO_THEME_ID;
  const activeId = resolveThemeId(preferredId);
  return [Object.assign({ selected: isAuto }, AUTO_THEME_OPTION)].concat(THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    detail: theme.detail,
    preview: theme.preview,
    selected: !isAuto && theme.id === activeId
  })));
}

/*
 * 取当前主题的原始 token 值，供 CSS 变量覆盖不到的场景使用：
 * wx.showModal 的 confirmColor 只接受字面量、Canvas 2D 取色等。
 */
function activeTokens(preferredId) {
  return getTheme(preferredId).tokens;
}

/* 原生导航栏颜色是页面级的：微信每次页面切换都会回到 app.json 默认配色，
 * 因此这里绝不能按「主题没变」跳过 —— 每次应用主题都要重设导航栏（跨页测试钉住）。 */
function applyNativeChrome(theme) {
  if (typeof wx === 'undefined') return;
  try {
    if (typeof wx.setNavigationBarColor === 'function') {
      // 前景色只接受 #ffffff / #000000：夜间主题白字，其余黑字
      wx.setNavigationBarColor({ frontColor: theme.navigationFront || '#000000', backgroundColor: theme.navigation, animation: { duration: 180, timingFunc: 'easeIn' } });
    }
    if (typeof wx.setBackgroundColor === 'function') wx.setBackgroundColor({ backgroundColor: theme.navigation, backgroundColorBottom: theme.navigation });
  } catch (error) { /* older base libraries can safely keep the app.json color */ }
}

function applyToPage(page, preferredId) {
  const data = getThemeData(preferredId);
  applyNativeChrome(getTheme(data.themeId));
  if (page && typeof page.setData === 'function' && (!page.data || page.data.themeId !== data.themeId)) page.setData(data);
  return data;
}

function applyToOpenPages(preferredId) {
  const data = getThemeData(preferredId);
  applyNativeChrome(getTheme(data.themeId));
  if (typeof getCurrentPages !== 'function') return data;
  getCurrentPages().forEach((page) => {
    if (page && typeof page.setData === 'function') page.setData(data);
    const tabBar = page && typeof page.getTabBar === 'function' ? page.getTabBar() : null;
    if (tabBar && typeof tabBar.setData === 'function') tabBar.setData({ themeStyle: data.themeStyle });
  });
  return data;
}

function selectTheme(preferredId) {
  const id = resolveThemeId(preferredId);
  /* auto 只改变设置记录里的意图，不覆盖本机「最后一个具体主题」——浅色回退要用它 */
  if (preferredId !== AUTO_THEME_ID) saveThemeId(id);
  return applyToOpenPages(id);
}

module.exports = {
  AUTO_THEME_ID,
  DEFAULT_THEME_ID,
  THEMES,
  normalizeThemeId,
  normalizeThemeChoice,
  getThemeId,
  getTheme,
  getThemeStyle,
  getThemeData,
  getThemeOptions,
  activeTokens,
  applyToPage,
  applyToOpenPages,
  selectTheme
};
