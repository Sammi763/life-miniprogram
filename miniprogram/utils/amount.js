// 金额在同步与备份中以元保存，运算时换算为整数分。
function toCents(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return NaN;
  const source = String(value).trim();
  // 指数仅用于兼容 Number 的十进制表示，表单只接受普通小数。
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(source);
  if (!match || !(match[2] || match[3]) || (typeof value === 'string' && match[4])) return NaN;
  const digits = match[2] + (match[3] || '');
  const significant = digits.replace(/^0+/, '');
  if (!significant) return 0;
  const cut = match[2].length + Number(match[4] || 0) + 2 - (digits.length - significant.length);
  if (cut < 0) return 0;
  if (cut > 16) return NaN;
  const cents = Number(significant.slice(0, cut).padEnd(cut, '0')) + (significant[cut] >= '5' ? 1 : 0);
  if (!Number.isSafeInteger(cents)) return NaN;
  return match[1] === '-' && cents ? -cents : cents;
}

function fromCents(cents) {
  return cents / 100;
}

function parseMoneyInput(value, allowNegative = false) {
  const source = String(value ?? '').trim();
  if (!source) return 0;
  if (!allowNegative && source.startsWith('-') && Number(source) < 0) return NaN;
  return fromCents(toCents(value));
}

function amountError(value, amount) {
  return amount === 0 && Number(value) > 0 ? '金额不足 0.01 元' : '请输入正确金额';
}

function moneyInputText(value, allowNegative = false, requirePositive = false) {
  const amount = parseMoneyInput(value, allowNegative);
  if (!String(value ?? '').trim() || !Number.isFinite(amount) || (requirePositive && amount === 0 && Number(value) > 0)) return value;
  const cents = Math.abs(toCents(value));
  return (amount < 0 ? '-' : '') + Math.floor(cents / 100) + '.' + String(cents % 100).padStart(2, '0');
}

const MONEY_FIELDS = {
  __proto__: null,
  money: ['amount'],
  accounts: ['balance', 'openingBalance', 'manualAdjustment', 'minimumPayment', 'currentBill'],
  shopping: ['price'],
  settings: ['budget']
};

function monetaryFields(collection, data, visit) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return;
  for (const field of MONEY_FIELDS[collection] || []) visit(data, field, field);
  if (collection === 'settings' && data.categoryBudgets && typeof data.categoryBudgets === 'object' && !Array.isArray(data.categoryBudgets)) {
    for (const key of Object.keys(data.categoryBudgets)) visit(data.categoryBudgets, key, 'categoryBudgets.' + key);
  }
  if (collection === 'moneyRules' && Array.isArray(data.versions)) {
    data.versions.forEach((rule, index) => {
      if (rule && typeof rule === 'object' && !Array.isArray(rule)) visit(rule, 'amount', 'versions.' + index + '.amount');
    });
  }
}

function normalizeMoneyData(collection, data) {
  const changes = new Map();
  monetaryFields(collection, data, (target, field) => {
    const original = target[field];
    if (typeof original !== 'number') return;
    const amount = fromCents(toCents(original));
    if (!Number.isFinite(amount) || amount === original || (original < 0 && amount === 0 && field !== 'manualAdjustment')) return;
    if (!changes.has(target)) changes.set(target, { ...target });
    Object.defineProperty(changes.get(target), field, { value: amount, enumerable: true, writable: true, configurable: true });
  });
  if (!changes.size) return data;
  const result = changes.get(data) || { ...data };
  if (changes.has(data.categoryBudgets)) result.categoryBudgets = changes.get(data.categoryBudgets);
  if (collection === 'moneyRules') result.versions = data.versions.map((rule) => changes.get(rule) || rule);
  return result;
}

module.exports = { toCents, fromCents, parseMoneyInput, amountError, moneyInputText, monetaryFields, normalizeMoneyData };
