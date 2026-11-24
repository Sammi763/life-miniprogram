/* AI 洞察领域测试：只允许发送经过裁剪的生活摘要，并验证缓存与失败兜底。 */
const assert = require('assert');
const { execFileSync } = require('child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { FileStore } = require('../server/db/file-store');
const { MySqlStore } = require('../server/db/mysql-store');
const { loadConfig } = require('../server/config');
const {
  AI_SECRET_NAME,
  buildInsightContext,
  createInsightService,
  normalizeInsightText,
  insightKey,
  stableHash
} = require('../server/ai-insights');

const records = {
  money: {
    m1: { data: { type: 'expense', amount: 42, category: '餐饮', date: '2026-09-04', note: '不应发送的长备注' }, updatedAt: 1, deletedAt: 0 }
  },
  plan: {
    p1: { data: { title: '晚上散步', date: '2026-09-04', time: '19:00', done: false }, updatedAt: 1, deletedAt: 0 }
  },
  habit: {
    h1: { data: { kind: 'def', name: '喝水', mode: 'count', target: 8, unit: '杯' }, updatedAt: 1, deletedAt: 0 },
    h2: { data: { kind: 'entry', habitId: 'h1', date: '2026-09-04', value: 5 }, updatedAt: 1, deletedAt: 0 }
  },
  memories: {
    r1: { data: { content: '午后完成了一次短暂散步，心情放松', occurredAt: '2026-09-04T15:20', mood: 'calm', tags: ['散步', '日常'] }, updatedAt: 1, deletedAt: 0 }
  },
  accounts: {
    a1: { data: { name: '招商银行卡', balance: 999999 }, updatedAt: 1, deletedAt: 0 }
  },
  settings: {
    app: { data: { aiConsent: true }, updatedAt: 1, deletedAt: 0 }
  }
};

const context = buildInsightContext(records, 'today', '2026-09-04', new Date('2026-09-04T18:00:00'));
assert.strictEqual(context.scope, 'today');
assert.ok(context.today.tasks.some((item) => item.title === '晚上散步'), '今日任务应保留用于个性化');
assert.ok(context.today.memories.some((item) => item.content.includes('短暂散步')), '文字记忆应保留用于个性化');
assert.strictEqual(context.today.money.expense, 42);
assert.strictEqual(context.accounts, undefined, '账户余额不可发送给 AI');
assert.doesNotMatch(JSON.stringify(context), /招商银行|999999|不应发送的长备注|phone/i, '上下文不得包含账户、手机号或原始备注');
assert.strictEqual(stableHash(context), stableHash(JSON.parse(JSON.stringify(context))), '相同上下文的缓存指纹必须稳定');
assert.strictEqual(normalizeInsightText('```text\n今天先散步一小段。\n```'), '今天先散步一小段。');
assert.strictEqual(AI_SECRET_NAME, 'deepseek_api_key');

async function checkStoredConsent() {
  const dataDir = await mkdtemp(join(tmpdir(), 'life-ai-consent-'));
  const config = { ...loadConfig(), dataDir, ai: { enabled: true, trialEnabled: true } };
  const store = process.env.LIFE_AI_MYSQL === '1' ? new MySqlStore(config) : new FileStore(config);
  const ownerId = 'consent-owner';
  const period = '2026-09-04';
  const now = new Date(period + 'T18:00:00');
  const regularKey = insightKey('today', period);
  const trialKey = 'trial:' + regularKey;
  let revision = 0;
  const writeSettings = (data) => store.upsert(ownerId, 'settings', 'app', data, ++revision);
  const cache = async (isTrial) => {
    const consent = await store.getAiConsentRevision(ownerId, isTrial);
    return store.saveAiInsight(ownerId, isTrial ? trialKey : regularKey, 'fixture', '已有文案。', consent);
  };
  try {
    await store.init();
    await writeSettings({ aiConsent: true, trialAiConsent: true });
    assert.strictEqual(await cache(false), true);
    assert.strictEqual(await cache(true), true);
    await writeSettings({ aiConsent: true, trialAiConsent: false });
    assert.strictEqual(await store.getAiInsight(ownerId, trialKey), null);
    assert.ok(await store.getAiInsight(ownerId, regularKey), '撤回体验版应保留普通渠道缓存');

    await writeSettings({ trialAiConsent: true });
    assert.strictEqual(await store.getAiInsight(ownerId, regularKey), null);
    assert.strictEqual(await cache(true), true);
    await writeSettings({ trialAiConsent: true, budget: 100 });
    assert.ok(await store.getAiInsight(ownerId, trialKey), '仅同意体验版的账号修改预算应保留体验缓存');

    const otherOwner = 'other-consent-owner';
    await store.upsert(otherOwner, 'settings', 'app', { trialAiConsent: true }, 1);
    const otherConsent = await store.getAiConsentRevision(otherOwner, true);
    await store.saveAiInsight(otherOwner, trialKey, 'fixture', '另一账号文案。', otherConsent);

    await store.upsert(ownerId, 'money', 'm1', records.money.m1.data, ++revision);
    await store.setSecret(AI_SECRET_NAME, 'test-key');
    let finishProvider;
    let providerStarted;
    const started = new Promise((resolve) => { providerStarted = resolve; });
    const pendingProvider = new Promise((resolve) => { finishProvider = resolve; });
    const service = createInsightService({
      store, config,
      fetchImpl: () => { providerStarted(); return pendingProvider; }
    });
    const result = service.getInsight(ownerId, 'today', period, now, true);
    await Promise.race([started, result.then(() => assert.fail('应进入模型请求'))]);
    await writeSettings({ trialAiConsent: false });
    assert.strictEqual(await store.getAiInsight(ownerId, trialKey), null);
    await writeSettings({ trialAiConsent: true });
    finishProvider({ ok: true, json: async () => ({ choices: [{ message: { content: '迟到的文案。' } }] }) });
    assert.strictEqual((await result).source, 'local');
    assert.strictEqual(await store.getAiInsight(ownerId, trialKey), null, '撤回前在途请求不能在重新授权后写回缓存');
    assert.ok(await store.getAiInsight(otherOwner, trialKey), '清理应限制在当前账号');
    assert.strictEqual(await cache(true), true);
    await store.remove(ownerId, 'settings', 'app', ++revision);
    assert.strictEqual(await store.getAiInsight(ownerId, trialKey), null);
  } finally {
    await store.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  const cache = new Map();
  let requestCount = 0;
  let secretName = '';
  const service = createInsightService({
    store: {
      exportRecords: async () => records,
      getSecret: async (name) => { secretName = name; return 'test-key'; },
      setSecret: async () => {},
      getAiInsight: async (_ownerId, key) => cache.get(key) || null,
      saveAiInsight: async (_ownerId, key, contextHash, content) => { cache.set(key, { key, contextHash, content, generatedAt: Date.now() }); }
    },
    config: {
      aiSecretEncryptionKey: 'test-master-key',
      ai: { enabled: true, provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', maxTokens: 120 }
    },
    fetchImpl: async (url, options) => {
      requestCount++;
      assert.strictEqual(url, 'https://api.deepseek.com/chat/completions');
      assert.strictEqual(options.headers.Authorization, 'Bearer test-key');
      assert.strictEqual(JSON.parse(options.body).model, 'deepseek-flash');
      assert.doesNotMatch(options.body, /test-master-key/);
      assert.doesNotMatch(options.body, /999999|招商银行/);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '今天先完成散步，再给自己留一点安静时间。' } }] }) };
    }
  });

  const first = await service.getInsight('owner-1', 'today', '2026-09-04', new Date('2026-09-04T18:00:00'));
  const second = await service.getInsight('owner-1', 'today', '2026-09-04', new Date('2026-09-04T18:00:00'));
  assert.strictEqual(first.source, 'ai');
  assert.strictEqual(second.source, 'cache');
  assert.strictEqual(requestCount, 1, '相同数据只能调用一次模型');
  assert.strictEqual(secretName, AI_SECRET_NAME);
  assert.match(first.content, /散步/);

  const disabled = createInsightService({
    store: {
      exportRecords: async () => ({ ...records, settings: { app: { data: { aiConsent: false }, updatedAt: 2, deletedAt: 0 } } }),
      getSecret: async () => 'test-key',
      setSecret: async () => {}
    },
    config: { aiSecretEncryptionKey: 'test-master-key', ai: { enabled: true } },
    fetchImpl: async () => { throw new Error('AI must not be called without consent'); }
  });
  const local = await disabled.getInsight('owner-2', 'today', '2026-09-04', new Date('2026-09-04T18:00:00'));
  assert.strictEqual(local.source, 'local', '未开启 AI 时必须只返回本地文案');
  execFileSync(process.execPath, ['-e',
    "require('assert').strictEqual(require('./server/config').loadConfig().ai.enabled, false)"
  ], {
    cwd: require('path').resolve(__dirname, '..'),
    env: { ...process.env, DEV_MODE: '0', AI_ENABLED: '1' }
  });
  const production = createInsightService({
    store: {
      exportRecords: async () => records,
      getAiInsight: async () => assert.fail('正式版不读取先前生成的 AI 缓存'),
      getSecret: async () => assert.fail('正式版不读取模型密钥')
    },
    config: { ai: { enabled: false } },
    fetchImpl: async () => assert.fail('正式版不调用外部模型')
  });
  assert.strictEqual((await production.getInsight('owner-1', 'today', '2026-09-04')).source, 'fallback');
  let consentSettings = { aiConsent: true };
  let trialRequests = 0;
  const trialService = createInsightService({
    store: {
      exportRecords: async () => ({ ...records, settings: { app: { data: consentSettings } } }),
      getSecret: async () => 'test-key',
      setSecret: async () => {}
    },
    config: { ai: { enabled: false, trialEnabled: true } },
    fetchImpl: async () => {
      trialRequests++;
      return { ok: true, json: async () => ({ choices: [{ message: { content: '留一点时间散步。' } }] }) };
    }
  });
  const trialInsight = (channel) => trialService.getInsight('owner-1', 'today', '2026-09-04', new Date('2026-09-04T18:00:00'), channel);
  assert.strictEqual((await trialInsight(true)).source, 'local', '体验版需单独同意');
  consentSettings = { ...consentSettings, trialAiConsent: true };
  assert.strictEqual((await trialInsight(false)).source, 'fallback', '试用开关不能放行普通请求');
  assert.strictEqual((await trialInsight(true)).source, 'ai');
  consentSettings.trialAiConsent = false;
  assert.strictEqual((await trialInsight(true)).source, 'local', '关闭同意后回到本机文案');
  assert.strictEqual(trialRequests, 1);
  await checkStoredConsent();
  console.log('AI_INSIGHTS_TEST_PASSED');
})().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
