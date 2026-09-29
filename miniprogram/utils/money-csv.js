/* 账本 CSV 导出：仅针对 money 集合的流水，按日期升序，输出到剪贴板。
 * 格式约定：首行中文表头；带 UTF-8 BOM（\uFEFF），Excel 直接打开不乱码；
 * 字段含逗号/引号/换行时按 RFC 4180 加引号转义。转账行保留（类型=转账）。 */

const { formatMoney } = require('./finance');

const CSV_HEADERS = ['日期', '类型', '分类', '金额', '备注'];
const TYPE_TEXT = { expense: '支出', income: '收入', transfer: '转账' };

function escapeField(value) {
  const text = String(value === undefined || value === null ? '' : value);
  if (/[",\n\r]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
  return text;
}

function buildMoneyCsv(moneyRecords) {
  const rows = Object.values(moneyRecords || {})
    .filter((record) => record && !record.deletedAt && record.data && record.data.date)
    .sort((a, b) => String(a.data.date).localeCompare(String(b.data.date)) || String(a.id).localeCompare(String(b.id)))
    .map((record) => {
      const data = record.data;
      const type = TYPE_TEXT[data.type] || '支出';
      const category = data.type === 'transfer' ? '账户转账' : (data.category || '其他');
      return [
        data.date,
        type,
        category,
        formatMoney(Number(data.amount) || 0),
        data.note || ''
      ].map(escapeField).join(',');
    });
  return '\uFEFF' + CSV_HEADERS.join(',') + (rows.length ? '\n' + rows.join('\n') : '');
}

module.exports = { buildMoneyCsv, escapeField, CSV_HEADERS };
