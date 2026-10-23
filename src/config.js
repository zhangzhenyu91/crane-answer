require('dotenv').config();

const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const port = Number(process.env.PORT) || 3000;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('[config] PORT 必须是 1-65535 的整数');
}

module.exports = {
  host: process.env.HOST || '0.0.0.0',
  port,
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || 'data'),
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'Admin@123',
  // 壹匣后端对接（树障隐患记录直推）；任一为空则推送不可用
  yixia: {
    baseUrl: String(process.env.YIXIA_BASE_URL || '').replace(/\/+$/, ''),
    token: String(process.env.YIXIA_INGEST_TOKEN || '').trim(),
  },
  // 聊天日志兜底归档的每日执行时点（北京时间 HH:mm，见 src/inspection/chatlog.js）
  chatlogDigestTime: process.env.CHATLOG_DIGEST_TIME || '23:26',
  legacy: process.env,
};
