/* AI 洞察领域测试：只允许发送经过裁剪的生活摘要，并验证缓存与失败兜底。 */
const assert = require('assert');
const {
  AI_SECRET_NAME,
  buildInsightContext,
  createInsightService,
  normalizeInsightText,
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
  console.log('AI_INSIGHTS_TEST_PASSED');
})().catch((error) => {
  console.error('FAIL:', error.stack || error.message);
  process.exit(1);
});
