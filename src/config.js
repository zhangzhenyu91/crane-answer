require('dotenv').config();

const config = {
  // WeChatPadPro Cloud Access Token
  token: process.env.WECHATPADPRO_TOKEN || '',
  // 换票接口（HTTP）
  apiBase: (process.env.WECHATPADPRO_API_BASE || 'https://api.wechatpadpro.com').replace(/\/+$/, ''),
  // 实测可用路径为 /cloud/v1/...；文档中的 /api/cloud/v1/... 在该域名下返回 404，如需可在此覆盖
  ticketPath: process.env.WECHATPADPRO_TICKET_PATH || '/cloud/v1/Runtime/WebSocketTicket',
  // WebSocket 握手地址（不含 query）
  wsUrl: process.env.WECHATPADPRO_WS_URL || 'wss://api.wechatpadpro.com/ws/sync',
  // 打印原始推送报文
  logRawMessage: process.env.LOG_RAW_MESSAGE === '1',
  // Dify API 地址（所有群共用）
  difyApiBase: (process.env.DIFY_API_BASE || 'https://ai.j1net.com/v1').replace(/\/+$/, ''),
  // Dify workflow 的 user 标识
  difyUser: process.env.DIFY_USER || 'zhangzhenyu91',
  // Dify 调用超时（blocking 模式会等 workflow 跑完）
  difyTimeoutMs: Number(process.env.DIFY_TIMEOUT_MS) || 60000,
  // 监听的群 → 该群使用的 Dify API Key
  // 格式：群id1:app-key1,群id2:app-key2
  groupDifyKeys: parsePairs(process.env.DIFY_GROUP_KEYS || ''),
  // 发送者 wxid → 显示名的手动覆盖（可选）。默认走群成员接口自动解析（群昵称>微信昵称>wxid）
  // 格式：wxid1:显示名1,wxid2:显示名2
  senderNameMap: parsePairs(process.env.SENDER_NAME_MAP || ''),
};

function parsePairs(raw) {
  const map = new Map();
  for (const pair of raw.split(',')) {
    const idx = pair.indexOf(':');
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (key && value) map.set(key, value);
  }
  return map;
}

if (!config.token) {
  console.error('[config] 缺少 WECHATPADPRO_TOKEN，请通过环境变量或 .env 文件配置');
  process.exit(1);
}

module.exports = config;
