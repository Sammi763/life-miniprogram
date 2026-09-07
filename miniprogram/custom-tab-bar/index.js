Component({
  data: {
    selected: 0,
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
      this.setData({ selected: index });
      wx.switchTab({ url: '/' + item.pagePath });
    }
  }
});
