/*
 * 数据可信回归（docs/ux-review-2026-10-27/优化方案.md R01–R07）。
 * 用真实源码模块 + 内存 wx mock 复现 source-probes.json 的 7 类问题，
 * 断言修复后的目标行为；在未修复的实现上运行必然失败。
 * 覆盖：下载游标分离（R03）、真实同步状态（R02）、退出保护与清理范围（R01/R07）、
 *       随记草稿时序（R05）、队列可靠持久化与原子重建（R06）。
 */
const assert = require('assert');
const path = require('path');

const storage = {};
const originalWx = global.wx;

global.wx = {
  getStorageSync: (key) => storage[key],
  // 按值快照（真实 wx getStorageSync 返回反序列化副本）：否则 deepStrictEqual 断言因引用别名恒真
  setStorageSync: (key, value) => { storage[key] = value === undefined ? value : JSON.parse(JSON.stringify(value)); },
  removeStorageSync: (key) => { delete storage[key]; },
  getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
  showToast: () => {},
  clearTimeout,
  setTimeout
};

const store = require('../miniprogram/utils/store');

function resetStore() {
  for (const key of Object.keys(storage)) delete storage[key];
  store.resetLocal({ keepAuxiliary: true });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  /* ---------- R03 · 本机写入不得推进下载游标 ---------- */
  resetStore();
  store.state.since = 1000;
  store.state.sinceSeq = 500;
  const beforeSeq = store.state.sinceSeq;
  const beforeSince = store.state.since;
  store.applyLocalUpsert('money', { id: 'm-local', data: { amount: 1, date: '2026-10-27' }, updatedAt: 2000 });
  assert.strictEqual(store.state.sinceSeq, beforeSeq, '本机写入不得修改下载游标 sinceSeq');
  assert.strictEqual(store.state.since, beforeSince, '本机写入不得推进 since（下载游标与客户端编辑时间分离）');
  // 服务端来源的写入才推进 since（legacy 模式兜底仍需它）
  store.applyLocalUpsert('money', { id: 'm-remote', data: { amount: 2, date: '2026-10-27' }, updatedAt: 1500 }, { fromServer: true });
  assert.strictEqual(store.state.since, 1500, '服务端回写应推进 since');

  /* ---------- R02 · 队列非空时不得显示「已安全同步」 ---------- */
  resetStore();
  store.state.syncState = 'idle';
  store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: Date.now() });
  let status = store.syncStatus(store.state);
  assert.notStrictEqual(status.text, '已安全同步', '队列非空时不得显示已安全同步');
  assert.match(status.text, /待同步/, '应明确显示待同步条数');
  store.state.syncState = 'syncing';
  status = store.syncStatus(store.state);
  assert.match(status.text, /正在同步/, '同步中应如实显示（不得与待同步混淆）');
  store.state.syncState = 'offline';
  status = store.syncStatus(store.state);
  assert.match(status.text, /暂存本机|待同步/, '离线且有待同步时不得谎称已同步');
  store.state.queue = [];
  store.state.syncState = 'idle';
  status = store.syncStatus(store.state);
  assert.strictEqual(status.text, '已安全同步', '队列空且在线时才是已同步');
  // 被拒绝的写入优先显示，且不能显示「已暂存本机」承诺（被拒内容不会自动同步）
  store.state.rejectedWrites = [{ item: { type: 'put', collection: 'money', id: 'x', data: {} }, statusCode: 422, code: 'bad', at: 1 }];
  status = store.syncStatus(store.state);
  assert.match(status.text, /拒绝|未同步/, '被拒写入必须显示出来');
  // 本机持久化错误优先级最高：不能承诺「已暂存本机」
  store.state.persistError = '本机缓存写入失败（约 900KB）';
  status = store.syncStatus(store.state);
  assert.strictEqual(status.level, 'error', '持久化错误必须是最高优先级状态');
  assert.ok(!/暂存/.test(status.detail), '有持久化错误时不得承诺已暂存本机');
  store.state.persistError = '';
  store.state.rejectedWrites = [];

  /* ---------- R01 · 退出风险评估：未同步/被拒/持久化错误都要拦截 ---------- */
  resetStore();
  let safety = store.assessDataSafety(store.state);
  assert.strictEqual(safety.hasLocalOnly, false, '干净状态可以直接退出');
  store.enqueue({ type: 'put', collection: 'money', id: 'm1', data: {}, updatedAt: 1 });
  safety = store.assessDataSafety(store.state);
  assert.strictEqual(safety.hasLocalOnly, true, '有待同步写入时退出必须被拦截');
  store.state.queue = [];
  store.state.rejectedWrites = [{ item: { type: 'put', collection: 'money', id: 'x' }, statusCode: 422, code: '', at: 1 }];
  safety = store.assessDataSafety(store.state);
  assert.strictEqual(safety.hasLocalOnly, true, '有被拒写入时退出必须被拦截（那是唯一副本）');
  store.state.rejectedWrites = [];
  store.state.persistError = '本机缓存写入失败';
  safety = store.assessDataSafety(store.state);
  assert.strictEqual(safety.hasLocalOnly, true, '持久化错误时退出必须被拦截');
  store.state.persistError = '';

  /* ---------- R07 · 退出清理范围与文案一致：草稿与搜索历史一并清除 ---------- */
  resetStore();
  storage['wb_life_memory_draft_new'] = { content: '草稿', occurredAt: '2026-10-27T10:00' };
  storage['wb_life_memory_draft_abc123'] = { content: '草稿2', occurredAt: '2026-10-27T10:00' };
  storage['wb_life_search_history'] = ['咖啡'];
  storage['wb_life_pending_open'] = { kind: 'money', id: 'x', at: 1 };
  storage['wb_life_queue'] = [];
  storage['unrelated_key'] = '保留';
  store.resetLocal();
  assert.strictEqual(storage['wb_life_memory_draft_new'], undefined, '退出应清除随记草稿');
  assert.strictEqual(storage['wb_life_memory_draft_abc123'], undefined, '退出应清除所有随记草稿');
  assert.strictEqual(storage['wb_life_search_history'], undefined, '退出应清除搜索历史');
  assert.strictEqual(storage['wb_life_pending_open'], undefined, '退出应清除临时深链');
  assert.strictEqual(storage['wb_life_state'], undefined, '退出应清除主快照');
  assert.strictEqual(storage['wb_life_queue'], undefined, '退出应清除队列快照');
  assert.strictEqual(storage['unrelated_key'], '保留', '不得误清无关 key');

  /* ---------- R06 · 写队列独立可靠持久化：入队即同步落盘，不依赖 250ms 防抖 ---------- */
  resetStore();
  store.enqueue({ type: 'put', collection: 'money', id: 'q1', data: { amount: 5, date: '2026-10-27' }, updatedAt: 1 });
  assert.deepStrictEqual(storage['wb_life_queue'].queue, store.state.queue, '入队后专用 key 必须立即落盘（同步，无防抖）');
  store.state.queue.shift();
  store.persistQueue();
  assert.deepStrictEqual(storage['wb_life_queue'].queue, [], '出队后专用 key 同步更新');

  resetStore();
  const firstWrite = { type: 'put', collection: 'money', id: 'first', data: { amount: 5 }, updatedAt: 1 };
  storage.wb_life_queue = [firstWrite];
  store.loadLocal();
  assert.deepStrictEqual(store.state.queue, [firstWrite], '主快照缺失也恢复专用队列');
  assert.deepStrictEqual(store.state.records.money.first.data, firstWrite.data, '待提交记录重启后立即可见');
  storage.wb_life_state = { records: { money: { first: { id: 'first', data: { amount: 2 }, updatedAt: 0 } } }, sinceSeq: 0 };
  storage.wb_life_queue.queue.push({ ...firstWrite, data: { amount: 7 }, updatedAt: 2 });
  store.loadLocal();
  assert.equal(store.state.records.money.first.data.amount, 7, '旧快照叠加同 ID 的最新待提交记录');

  /* ---------- R06 · 旧快照迁移：无专用队列 key 时从快照恢复并补写 ---------- */
  resetStore();
  storage['wb_life_state'] = {
    records: { money: { m1: { id: 'm1', data: { amount: 3, date: '2026-10-27' }, updatedAt: 10, deletedAt: 0 } } },
    since: 10,
    queue: [{ type: 'put', collection: 'money', id: 'legacy', data: {}, updatedAt: 11 }],
    rejectedWrites: []
  };
  store.loadLocal();
  assert.strictEqual(store.state.sinceSeq, -1, '旧版本快照缺少 sinceSeq：置 -1 哨兵，下次拉取做一次完整补拉');
  assert.strictEqual(store.state.queue.length, 1, '旧快照中的队列必须恢复');
  assert.deepStrictEqual(storage['wb_life_queue'].queue, store.state.queue, '迁移时补写专用队列 key');

  /* ---------- R05 · 随记草稿时序 ---------- */
  {
    const makeMemoryPage = (definition) => ({
      ...definition,
      data: JSON.parse(JSON.stringify(definition.data)),
      setData(update) {
        for (const [key, value] of Object.entries(update)) {
          const keys = key.split('.');
          let cur = this.data;
          for (let i = 0; i < keys.length - 1; i++) {
            if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
            cur = cur[keys[i]];
          }
          cur[keys[keys.length - 1]] = value;
        }
      }
    });
    const loadMemoryPage = () => {
      const target = path.resolve(__dirname, '../miniprogram/pages/memory/memory.js');
      const originalPage = global.Page;
      let definition;
      global.Page = (page) => { definition = page; };
      delete require.cache[require.resolve(target)];
      require(target);
      global.Page = originalPage;
      return makeMemoryPage(definition);
    };

    // 场景 A（probe: saved-memory-draft-reappears）：输入 → 立即保存 → 350ms 定时器不得复活已清掉的草稿
    const page = loadMemoryPage();
    page.onLoad.call(page, {});
    page.openComposer.call(page);
    page.onContent.call(page, { detail: { value: '打断定时器再保存' } });
    page.saveMemory.call(page);
    await wait(420);
    assert.strictEqual(storage['wb_life_memory_draft_new'], undefined, '保存后草稿定时器不得把已保存内容重新写成草稿');

    // 场景 B（probe: fast-back-loses-latest-draft）：输入后立刻关闭（350ms 内）→ 最后输入必须落盘
    page.openComposer.call(page);
    page.onContent.call(page, { detail: { value: '还没落盘就退出的内容' } });
    page.closeComposer.call(page);
    const draft = storage['wb_life_memory_draft_new'];
    assert.ok(draft && draft.content === '还没落盘就退出的内容', '关闭弹层时必须立即提交最后一份草稿');
    assert.ok(draft.savedAt > 0, '草稿必须带保存时间，用于过期判断');

    // 场景 C：onUnload 时弹层仍开着 → 同步提交草稿
    page.openComposer.call(page);
    page.onContent.call(page, { detail: { value: '卸载前的最后一份' } });
    page.onUnload.call(page);
    assert.ok(storage['wb_life_memory_draft_new'] && storage['wb_life_memory_draft_new'].content === '卸载前的最后一份',
      'onUnload 必须先落盘最后输入再取消定时器');

    // 场景 D：编辑既有记录时，草稿比记录旧 → 不把陈旧草稿当成当前内容
    const page2 = loadMemoryPage();
    store.state.records.memories = { memo1: { id: 'memo1', data: { content: '云端新内容', occurredAt: '2026-10-27T09:00' }, updatedAt: 9999, deletedAt: 0 } };
    storage['wb_life_memory_draft_memo1'] = { content: '很旧的草稿', occurredAt: '2026-10-27T08:00', savedAt: 5, tags: [] };
    page2.onLoad.call(page2, { id: 'memo1' });
    assert.strictEqual(page2.data.form.content, '云端新内容', '草稿早于记录更新时间时必须用云端内容，不恢复陈旧草稿');
  }

  /* ---------- R03 · 服务端变更序号：本机写入后另一设备的记录仍可拉到（file-store 集成） ---------- */
  {
    const os = require('os');
    const fs = require('fs');
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-seq-'));
    const { FileStore } = require('../server/db/file-store');
    const fileStore = new FileStore({ dataDir, tokenTtlDays: 1 });
    await fileStore.init();
    // 设备 A 建号并写入一条
    await fileStore.upsert('ownerA', 'money', 'a1', { amount: 1, date: '2026-10-27' }, 1000);
    // 设备 B 上次读到 seq=cursor1；此时设备 A 又写了一条（时间戳更旧，模拟晚到上传）
    const first = await fileStore.getChangesBySeq('ownerA', 0);
    assert.ok(typeof first.cursor === 'number' && first.cursor >= 1, 'getChangesBySeq 必须返回服务端游标');
    await fileStore.upsert('ownerA', 'money', 'a2', { amount: 2, date: '2026-10-26' }, 900);
    // 设备 B 本机新增（客户端行为），随后按旧游标拉取 —— 晚到的 a2 必须仍在结果里
    const second = await fileStore.getChangesBySeq('ownerA', first.cursor);
    assert.ok(second.changes.money && second.changes.money.some((r) => r.id === 'a2'),
      '本机写入之后按旧服务端游标拉取不得漏掉其他设备的记录');
    assert.ok(second.cursor > first.cursor, '新写入必须推进服务端游标');
    // LWW 被拒（applied:false）不消耗序号
    const headBefore = second.cursor;
    await fileStore.upsert('ownerA', 'money', 'a2', { amount: 9, date: '2026-10-26' }, 100); // 更旧的写入被拒
    const third = await fileStore.getChangesBySeq('ownerA', headBefore);
    assert.strictEqual(Object.keys(third.changes).length, 0, '被 LWW 拒绝的写入不得产生变更序号');
    await fileStore.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }

  /* ---------- R06 · 原子重建：拉取失败保留旧快照，成功后队列叠加回新快照 ---------- */
  {
    resetStore();
    const sync = require('../miniprogram/utils/sync');
    storage['wb_life_state'] = {
      records: {
        money: { old1: { id: 'old1', data: { amount: 1, date: '2026-10-27' }, updatedAt: 10, deletedAt: 0 } }
      },
      since: 10, sinceSeq: 3, queue: [{ type: 'put', collection: 'money', id: 'local-only', data: { amount: 7 }, updatedAt: 20 }], rejectedWrites: []
    };
    store.loadLocal();
    const originalApiSync = require('../miniprogram/utils/api').apiSync;
    const apiModule = require('../miniprogram/utils/api');
    // 失败路径：网络错误 → 旧记录保留
    apiModule.apiSync = () => Promise.reject(new Error('network down'));
    let failed = false;
    try { await sync.rebuild(); } catch (e) { failed = true; }
    assert.ok(failed, '重建失败必须向上报错');
    assert.ok(store.state.records.money.old1, '重建失败不得清空旧快照（页面不能先变空白）');
    // 成功路径：云端只有 cloud1（old1 已在云端被删 → 墓碑），叠加未同步 local-only
    apiModule.apiSync = () => Promise.resolve({
      serverTime: 1, cursor: 9,
      changes: { money: [{ id: 'old1', data: null, updatedAt: 15, deletedAt: 15 }, { id: 'cloud1', data: { amount: 2, date: '2026-10-27' }, updatedAt: 12, deletedAt: 0 }] }
    });
    await sync.rebuild();
    assert.ok(store.state.records.money.old1 && store.state.records.money.old1.deletedAt, '重建后云端墓碑生效');
    assert.ok(store.state.records.money.cloud1, '重建后云端新记录生效');
    assert.ok(store.state.records.money['local-only'] && !store.state.records.money['local-only'].deletedAt,
      '未同步队列必须叠加回新快照，唯一副本不得丢失');
    assert.strictEqual(store.state.sinceSeq, 9, '重建完成后游标推进到服务端 cursor');
    assert.strictEqual(store.state.since, 15, '仅用云端记录计算旧协议游标');

    const savedRecords = store.state.records;
    const originalSet = wx.setStorageSync;
    const originalError = console.error;
    wx.setStorageSync = () => { throw new Error('write failure'); };
    console.error = () => {};
    apiModule.apiSync = () => Promise.resolve({ cursor: 10, changes: {} });
    try {
      await assert.rejects(sync.rebuild(), /rebuild_persist_failed/);
      assert.strictEqual(store.state.records, savedRecords, '落盘失败保留内存记录');
      assert.strictEqual(store.state.sinceSeq, 9, '落盘失败保留游标');
      assert.ok(storage.wb_life_state.records.money.cloud1, '落盘失败保留磁盘快照');
    } finally {
      wx.setStorageSync = originalSet;
      console.error = originalError;
    }

    const originalApiPut = apiModule.apiPut;
    resetStore();
    const reads = [];
    const writes = [];
    apiModule.apiSync = (since, seq) => new Promise((resolve) => reads.push({ seq, resolve }));
    apiModule.apiPut = (...args) => new Promise((resolve) => writes.push({ args, resolve }));
    try {
      store.state.sinceSeq = 1;
      store.enqueue({ type: 'put', collection: 'money', id: 'same', data: { amount: 1 }, updatedAt: 10 });
      store.enqueue({ type: 'put', collection: 'money', id: 'same', data: { amount: 2 }, updatedAt: 11 });
      const pulling = sync.pull();
      const flushing = sync.flush();
      const rebuilding = sync.rebuild();
      assert.deepStrictEqual(reads.map((read) => read.seq), [1]);
      reads[0].resolve({ cursor: 2, changes: {} });
      await pulling;
      assert.equal(reads.length, 1, '在途写未完成时不能开始重建');
      writes[0].resolve({ applied: true });
      await wait(0);
      writes[1].resolve({ applied: true });
      await flushing;
      await wait(0);
      assert.deepStrictEqual(reads.map((read) => read.seq), [1, 0], '等待在途操作后完整拉取');
      assert.equal(await sync.pull(), false, '重建期间把普通拉取排至完成后');
      reads[1].resolve({ cursor: 3, changes: { money: [
        { id: 'same', data: { amount: 2 }, updatedAt: 11 },
        { id: 'remote', data: { amount: 8 }, updatedAt: 12 }
      ] } });
      await rebuilding;
      assert.equal(store.state.records.money.same.data.amount, 2, '已确认的最新数据不被旧队列覆盖');
      assert.equal(store.state.records.money.remote.data.amount, 8);
      assert.equal(store.state.sinceSeq, 3);
    } finally {
      sync.destroy();
      apiModule.apiPut = originalApiPut;
    }
    apiModule.apiSync = originalApiSync;
  }

  /* ---------- R03 · 订阅过滤：一次无关集合变更不触发无关订阅 ---------- */
  {
    resetStore();
    let moneyCalls = 0;
    let habitCalls = 0;
    store.subscribe(() => { moneyCalls++; }, ['money']);
    store.subscribe(() => { habitCalls++; }, ['habit']);
    // applyLocalUpsert 只改数据不通知（由引擎按变更集合调用 notify），这里模拟 sync.applyChanges 的通知路径
    store.applyLocalUpsert('money', { id: 'x', data: {}, updatedAt: 1 }, { fromServer: true });
    store.notify(['money']);
    assert.strictEqual(moneyCalls, 1, '相关集合变更必须通知');
    assert.strictEqual(habitCalls, 0, '无关集合变更不得触发订阅（减少全局广播）');
    store.notify(['habit']);
    assert.strictEqual(habitCalls, 1, '自身集合变更必须通知');
    store.setSyncState('syncing');
    assert.strictEqual(habitCalls, 1, '同步状态变化只通知订阅了 __sync__ 通道的页面');
    store.setSyncState('idle');
  }

  {
    resetStore();
    store.loadLocal();
    const sync = require('../miniprogram/utils/sync');
    const api = require('../miniprogram/utils/api');
    const originalPut = api.apiPut;
    const originalSync = api.apiSync;
    const setStorage = wx.setStorageSync;
    try {
      api.apiPut = async () => { throw Object.assign(new Error('rejected'), { statusCode: 422 }); };
      const localOnly = { type: 'put', collection: 'money', id: 'local-only', data: { amount: 5 }, updatedAt: 80 };
      store.enqueue(localOnly);
      wx.setStorageSync = (key, value) => {
        if (key === 'wb_life_queue') throw new Error('simulated storage failure');
        setStorage(key, value);
      };
      const initialConsole = console.error;
      try {
        console.error = () => {};
        await assert.rejects(sync.flush(), /rejected/);
      } finally {
        console.error = initialConsole;
      }
      assert.strictEqual(store.state.queue.length, 1, '拒绝副本落盘失败时保留队列');
      assert.ok(store.state.persistError);
      wx.setStorageSync = setStorage;
      await sync.flush();
      assert.strictEqual(storage.wb_life_state, undefined, '重启发生在主快照首次落盘之前');
      store.loadLocal();
      assert.strictEqual(store.state.queue.length, 0);
      assert.strictEqual(store.state.rejectedWrites[0].item.id, localOnly.id);
      assert.strictEqual(store.state.records.money[localOnly.id].data.amount, 5);

      store.enqueue({ type: 'put', collection: 'money', id: 'waiting', data: { amount: 7 }, updatedAt: 101 });
      api.apiPut = () => new Promise(() => {});
      store.state.sinceSeq = 98;
      store.state.since = 100;
      store.state.syncGeneration = 'before-restore';
      store.applyLocalUpsert('money', { id: 'discarded', data: { amount: 1 }, updatedAt: 99 });
      store.applyLocalUpsert('money', { id: 'reverted', data: { amount: 20 }, updatedAt: 100 });
      const requests = [];
      api.apiSync = async (since, seq, generation) => {
        requests.push([since, seq, generation]);
        return {
          cursor: 3, generation: 'after-restore', reset: seq > 3,
          changes: { money: [{ id: 'reverted', data: { amount: 10 }, updatedAt: 40 }] }
        };
      };
      assert.strictEqual(await sync.pull(), true);
      assert.deepStrictEqual(requests, [[100, 98, 'before-restore'], [0, 0, undefined]]);
      assert.strictEqual(store.state.sinceSeq, 3);
      assert.strictEqual(store.state.syncGeneration, 'after-restore');
      assert.strictEqual(store.state.records.money.discarded, undefined);
      assert.strictEqual(store.state.records.money.reverted.data.amount, 10);
      assert.strictEqual(store.state.records.money[localOnly.id].data.amount, 5);
      assert.strictEqual(store.state.records.money.waiting.data.amount, 7);
      assert.strictEqual(store.state.queue[0].id, 'waiting');
      assert.strictEqual(storage.wb_life_state.syncGeneration, 'after-restore');
    } finally {
      wx.setStorageSync = setStorage;
      api.apiPut = originalPut;
      api.apiSync = originalSync;
      sync.destroy();
    }
  }

  console.log('data-trust.test.js 通过');
}

main().catch((error) => { console.error(error); process.exit(1); });
