/*
 * 主题只保存一个受控的主题 ID；页面使用内联 CSS 变量承接配色，避免把用户输入
 * 拼进 style。选择会写入 settings.app，因而能跟随同步记录在设备间保持一致。
 */
const THEME_STORAGE_KEY = 'wb_life_theme';
const DEFAULT_THEME_ID = 'forest';

const THEMES = [
  {
    id: 'forest', name: '雾林', detail: '静谧绿', preview: 'linear-gradient(135deg, #315C52 0%, #E3EEE8 100%)',
    navigation: '#F3F5F2',
    tokens: {
      '--bg': '#F3F5F2', '--card': '#FFFFFF', '--surface': '#FAFBF9', '--ink': '#1C2520', '--ink-2': '#78817B', '--line': '#E2E7E1',
      '--accent': '#315C52', '--accent-strong': '#23483F', '--accent-soft': '#E3EEE8', '--accent-wash': '#F0F5F1',
      '--green': '#39745D', '--green-soft': '#E3F0E8', '--red': '#B95755', '--amber': '#9A7338',
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
      '--green': '#527362', '--green-soft': '#E3EFE7', '--red': '#B85C55', '--amber': '#9A7438',
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
      '--green': '#397263', '--green-soft': '#E1F0EA', '--red': '#B75859', '--amber': '#92723D',
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
      '--green': '#467263', '--green-soft': '#E0EEE8', '--red': '#B85A64', '--amber': '#92723F',
      '--card-border': 'rgba(218,210,226,.88)', '--shadow-color': 'rgba(60,45,76,.045)', '--pressed-shadow': 'rgba(60,45,76,.10)',
      '--button-shadow': 'rgba(81,61,98,.18)', '--button-shadow-strong': 'rgba(81,61,98,.28)', '--mask-color': 'rgba(31,24,38,.42)', '--sheet-shadow': 'rgba(47,35,59,.12)',
      '--hero-start': '#65506F', '--hero-end': '#483752', '--hero-shadow': 'rgba(72,55,82,.20)', '--hero-edit': '#EEE6F3', '--hero-soft': '#E9DFEF', '--hero-soft-ink': '#483752',
      '--tab-bg': 'rgba(255,254,255,.97)', '--tab-line': 'rgba(222,215,229,.92)', '--tab-text': '#7D7586', '--tab-selected': '#4C3958', '--tab-selected-bg': '#EAE3EF'
    }
  }
];

const THEME_MAP = Object.fromEntries(THEMES.map((theme) => [theme.id, theme]));
let appliedThemeId = '';

function normalizeThemeId(value) {
  return THEME_MAP[value] ? value : DEFAULT_THEME_ID;
}

function readStoredThemeId() {
  try {
    return normalizeThemeId(wx.getStorageSync(THEME_STORAGE_KEY));
  } catch (error) {
    return DEFAULT_THEME_ID;
  }
}

function readSyncedThemeId() {
  try {
    const store = require('./store');
    const setting = store.state.records.settings && store.state.records.settings.app;
    const value = setting && !setting.deletedAt && setting.data && setting.data.theme;
    return THEME_MAP[value] ? value : '';
  } catch (error) {
    return '';
  }
}

function saveThemeId(id) {
  try { wx.setStorageSync(THEME_STORAGE_KEY, id); } catch (error) { /* local preference is best effort */ }
}

function getThemeId(preferredId) {
  return normalizeThemeId(preferredId || readSyncedThemeId() || readStoredThemeId());
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
  const activeId = getThemeId(preferredId);
  return THEMES.map((theme) => ({
    id: theme.id,
    name: theme.name,
    detail: theme.detail,
    preview: theme.preview,
    selected: theme.id === activeId
  }));
}

function applyNativeChrome(theme) {
  if (appliedThemeId === theme.id || typeof wx === 'undefined') return;
  appliedThemeId = theme.id;
  try {
    if (typeof wx.setNavigationBarColor === 'function') {
      wx.setNavigationBarColor({ frontColor: '#000000', backgroundColor: theme.navigation, animation: { duration: 180, timingFunc: 'easeIn' } });
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
  const id = getThemeId(preferredId);
  saveThemeId(id);
  return applyToOpenPages(id);
}

module.exports = {
  DEFAULT_THEME_ID,
  THEMES,
  normalizeThemeId,
  getThemeId,
  getTheme,
  getThemeStyle,
  getThemeData,
  getThemeOptions,
  applyToPage,
  applyToOpenPages,
  selectTheme
};
