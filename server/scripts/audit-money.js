// 从账户的 v1 备份或云端导出读取数据，输出以分为单位的 JSON 对账报告。
const fs = require('node:fs');
const { buildMoneyAudit } = require('../../miniprogram/utils/money-audit');

function run() {
  const filename = process.argv[2];
  if (!filename) throw new Error('用法：node server/scripts/audit-money.js <备份.json 或 ->');
  const backup = JSON.parse(fs.readFileSync(filename === '-' ? 0 : filename, 'utf8'));
  if (!backup || !backup.records || typeof backup.records !== 'object' || Array.isArray(backup.records) ||
      (backup.format && (backup.format !== 'life-backup' || Number(backup.version) !== 1)) ||
      !backup.records.money || typeof backup.records.money !== 'object') {
    throw new Error('请选择包含账本记录的 v1 备份或云端导出');
  }
  const report = buildMoneyAudit(backup.records);
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

try {
  run();
} catch (error) {
  console.error(error instanceof SyntaxError ? '备份 JSON 无法解析' : error.message);
  process.exitCode = 1;
}
