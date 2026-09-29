/*
 * 删除撤销条：删除类操作立即执行后底部浮出，窗口期内可一键恢复。
 * 计时与状态由 utils/ui.js 的 armUndo/performUndo 管理，本组件只负责展示与转发点击。
 * 组件渲染在页面 DOM 内，直接继承页面的主题 CSS 变量，无需单独传 themeStyle
 * （custom-tab-bar 才需要手动传，因为它是独立于页面的渲染树）。
 */
Component({
  properties: {
    show: { type: Boolean, value: false },
    text: { type: String, value: '已删除' },
    /* Tab 页里 tabbar 悬浮在底部，撤销条需要抬到它上方 */
    aboveTab: { type: Boolean, value: false }
  },
  methods: {
    onUndo() { this.triggerEvent('undo'); }
  }
});
