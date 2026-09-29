/* 服务端记录校验。实现统一放在 miniprogram/utils/record-validation.js（客户端导入备份
 * 复用同一套字段白名单），这里只做薄 re-export —— 与 ai-insights 复用 miniprogram/utils
 * 是同一个跨目录共享模式，部署时必须保证 miniprogram/utils 目录随服务器分发。 */
module.exports = require('../miniprogram/utils/record-validation');
