const assert = require('assert');
const {
  normalizeMemory,
  normalizeTags,
  filterMemories,
  groupMemoriesByDate,
  buildMemorySummary,
  recentTags,
  makeDraftKey
} = require('../miniprogram/utils/memory-utils');

const memories = [
  { id: 'm1', data: { content: '早晨喝了一杯手冲咖啡，心情很好。', occurredAt: '2026-09-04T08:30', mood: 'happy', tags: ['咖啡', '日常'] }, updatedAt: 4 },
  { id: 'm2', data: { content: '下班路上散步，风很舒服。', occurredAt: '2026-09-04T18:20', mood: 'calm', tags: ['散步'] }, updatedAt: 3 },
  { id: 'm3', data: { content: '完成了本周的预算整理。', occurredAt: '2026-09-03T21:00', mood: 'energized', tags: ['财务', '日常'] }, updatedAt: 2 },
  { id: 'deleted', data: { content: '不应出现', occurredAt: '2026-09-04T09:00', mood: '', tags: [] }, deletedAt: 9, updatedAt: 9 }
];

assert.deepStrictEqual(normalizeTags(['  日常 ', '咖啡', '日常', '', '很长很长很长很长很长很长很长']), ['日常', '咖啡']);
assert.deepStrictEqual(normalizeMemory({ content: '  留下这一刻  ', occurredAt: '2026-09-04T08:30', mood: 'happy', tags: ['日常', '日常'] }), {
  content: '留下这一刻', occurredAt: '2026-09-04T08:30', mood: 'happy', tags: ['日常']
});
assert.strictEqual(makeDraftKey('new'), 'wb_life_memory_draft_new');

const coffee = filterMemories(memories, { keyword: '咖啡' });
assert.deepStrictEqual(coffee.map((item) => item.id), ['m1'], '关键词应命中正文和标签');
assert.deepStrictEqual(filterMemories(memories, { mood: 'calm' }).map((item) => item.id), ['m2']);
assert.deepStrictEqual(filterMemories(memories, { tag: '日常', date: '2026-09-04' }).map((item) => item.id), ['m1']);

const groups = groupMemoriesByDate(memories);
assert.deepStrictEqual(groups.map((group) => [group.date, group.items.length]), [['2026-09-04', 2], ['2026-09-03', 1]], '时间线应按日期倒序分组');
assert.strictEqual(groups[0].items[0].id, 'm2', '同日应按发生时间倒序');

const summary = buildMemorySummary(memories, '2026-09');
assert.deepStrictEqual(summary, {
  count: 3,
  days: 2,
  topTags: [{ tag: '日常', count: 2 }, { tag: '咖啡', count: 1 }, { tag: '散步', count: 1 }],
  moods: [{ mood: 'happy', count: 1 }, { mood: 'calm', count: 1 }, { mood: 'energized', count: 1 }]
});
assert.deepStrictEqual(recentTags(memories, 3), ['日常', '咖啡', '散步']);

console.log('MEMORY_UTILS_TEST_PASSED');
