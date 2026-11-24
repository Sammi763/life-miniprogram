# 性能基线与优化记录（v2.12）

日期：2026-10-28。对应优化方案 `docs/ux-review-2026-10-27/优化方案.md` §5（流畅性）。

## 1. 结论先行

- 本轮建立了**可重复的 JS 侧性能基线**（`tests/perf-baseline.test.js`，随 CI 运行），
  并用确定性断言锁住三项治理成果：数据未变重复渲染 **0 次 setData**、
  同步状态变化只走**轻量局部更新**、隐藏页只标 dirty 不渲染。
- 本基线全部在 **Node 环境、内存 wx mock** 下测得。**没有任何真机/开发者工具帧率、
  触控时延、启动耗时数据** —— 按方案要求，不据此宣称真机性能指标。
  真机验收项见 §6。

## 2. 测试环境与数据规模

| 项 | 值 |
|---|---|
| 运行环境 | Node 24（macOS arm64，CI 同规格），内存 wx mock |
| 数据规模（日常压载） | money 2000 条 · memories 1500 条 · habit 定义 20 + 打卡 1500 · plan 600 · shopping 400 |
| 计时口径 | `process.hrtime.bigint()`，仅记录不作断言 |
| 断言口径 | 只断言确定性行为（setData 次数、载荷相对大小、缓存复用），不断言耗时 |

## 3. 基线数据（2026-10-28 实测，Node）

| 操作 | 耗时 | setData 次数 | 单次载荷（JSON 字符） |
|---|---|---|---|
| 今日页首次渲染（冷，含全部派生计算） | 28.9 ms | 1 | 78,412 |
| 今日页重复渲染（数据未变，onShow/无关通知） | 0.1 ms | **0** | 0 |
| 今日页仅同步状态变化（renderSyncState 轻更新） | — | 1 | **34** |
| 随记页首次渲染（1500 条，首屏分批 60 条） | 9.2 ms | 1 | 11,495 |
| 随记页重复渲染（数据未变） | 6.8 ms | **0** | 0 |
| 记账页首次渲染（2000 条月流水，首批条数预算 120） | 4.9 ms | 1 | 16,633 |

要点：

- 优化前，一次无关 `store.notify()` 会让所有存活页面全量 `setData`；
  优化后无关集合的通知**不进入**页面（订阅过滤），进入页面的相同值**不触发** setData（值守卫）。
- 同步状态从「同步中 → 已同步」这类高频变化，载荷从整页 78KB 量级降到 34 字符。

## 4. 已落地的治理手段与失效条件

| 手段 | 位置 | 失效条件（缓存何时重算） |
|---|---|---|
| 按集合订阅（`store.subscribe(fn, collections)`） | store.js + 10 个页面 | 无缓存，只是过滤；订阅名单见各页 `bindStore` 调用 |
| 隐藏页 dirty 标记（onHide 置位，onShow 合并刷新） | `ui.bindStore` + 各页 onHide/onShow | 页面显示（onShow）时无条件刷新一次 |
| 同步状态轻更新（`__sync__` 通道 → `renderSyncState`） | 各页 renderSyncState | 只更新 offline/syncLabel 等状态字段 |
| 值守卫 `ui.diffSetData` | today/memory/shopping/money/habit/review/plan/fitness/media 的 render | 值不同才 setData；比较基于 JSON 序列化 |
| 今日页派生缓存（汇总/习惯/队列/最近记录） | today.js `computeTodayModel` | key = 9 个相关集合版本号 + 日期；任一集合写入（含服务端回写、重建换装）推进版本号，跨天重算 |
| 随记搜索 300ms 防抖 | memory.js onKeyword（与统一搜索同一策略） | 停止输入 300ms |
| 记账首批条数预算（分组 10 + 记录 120 条） | money.js visibleGroups/visibleItems | 筛选/切月/切视图重置；loadMore 双预算递增 |
| 待买已买列表分批（50 条/批） | shopping.js DONE_PAGE_SIZE | loadMoreDone 递增 |

集合版本号（`store.version(collection)`）在 `applyLocalUpsert / applyLocalDelete /
forceApplyServer / swapRecords` 中推进 —— 即本机写入、服务端回写、缓存重建三类路径
都会正确失效派生缓存，不存在「缓存导致账本不一致」的路径（有专门断言覆盖）。

## 5. 明确不做的事（与方案约束一致）

- 不延长落盘防抖（仍为 250ms，另加 App.onHide 同步落盘兜底）。
- 不引入重型图表库、不切换渲染框架、不做列表窗口化（未达实测阈值）。

## 6. 真机待验证项（本轮无证据，不得宣称）

以下指标需要 iOS + 中低端 Android 真机按方案 §5 采样后才算数：

- 点按到可感知反馈 p95 ≤ 100ms；本地保存反馈 p95 ≤ 200ms。
- 一次本地变更不触发无关隐藏页面 setData（真机 setData 回调观测）。
- 长列表滚动帧率与慢帧分布；键盘弹起、前后台切换、冷/热启动耗时。
- 首批载荷在微信渲染层的实际耗时（本基线的 78KB 是 JSON 字符量，不是渲染层耗时）。
