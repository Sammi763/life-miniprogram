const { MySqlStore } = require('./mysql-store');
const { FileStore } = require('./file-store');

function createStore(config) {
  if (config.storageDriver === 'file') return new FileStore(config);
  if (config.storageDriver === 'mysql') return new MySqlStore(config);
  throw new Error('Unsupported STORAGE_DRIVER: ' + config.storageDriver);
}

module.exports = { createStore };
