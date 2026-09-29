Component({
  data: {
    selected: 0,
    /*
     * 弹层打开期间整体隐藏悬浮导航。
     * 必须由页面显式驱动：自定义 tabBar 与页面内容不在同一层叠上下文，
     * 实测把 .sheet 提到 z-index:200 仍被 .tabbar-shell(100) 压住（截图可证），
     * 页面内任何 z-index 都盖不住它，只能把它藏起来。
     */
    hidden: false,
    /* 角标计数：{ [tabIndex]: count }，由页面经 utils/tabbar.js 的 syncTabBar 下发 */
    badges: {},
    list: [
      { pagePath: 'pages/today/today', text: '今日', glyph: '今' },
      { pagePath: 'pages/money/money', text: '记账', glyph: '账' },
      { pagePath: 'pages/habit/habit', text: '习惯', glyph: '习' },
      { pagePath: 'pages/mine/mine', text: '我的', glyph: '我' }
    ]
  },
  attached() { this.syncSelected(); },
  pageLifetimes: {
    show() { this.syncSelected(); }
  },
  methods: {
    syncSelected() {
      const pages = getCurrentPages();
      const page = pages[pages.length - 1];
      const route = page && page.route || '';
      const selected = this.data.list.findIndex((item) => item.pagePath === route);
      if (selected >= 0 && selected !== this.data.selected) this.setData({ selected });
    },
    onTabTap(event) {
      const index = Number(event.currentTarget.dataset.index);
      const item = this.data.list[index];
      if (!item || index === this.data.selected) return;
      /* 切 Tab 是高频导航，不加震动反馈（完成类操作才有），避免频繁震动打扰 */
      this.setData({ selected: index });
      /* 失败兜底：switchTab 失败时按实际页面栈回正选中态，避免高亮与页面错位 */
      wx.switchTab({ url: '/' + item.pagePath, fail: () => this.syncSelected() });
    }
  }
});
