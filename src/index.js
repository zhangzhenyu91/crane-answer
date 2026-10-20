const config = require('./config');
const { initSettings, getSettings } = require('./settings');
const WeChatPadProClient = require('./wechatpadpro/client');
const { handleMessage } = require('./wechatpadpro/messageHandler');
const { createServer } = require('./server');
const { initStore, sweepStaleSessions } = require('./inspection/store');
const { initImageStore } = require('./wechatpadpro/imageStore');
const { initLines } = require('./lines');

const client = new WeChatPadProClient({
  onMessage: handleMessage,
  onReady: () => console.log('[app] 开始接收微信群消息推送'),
});
const server = createServer({ client });
let shuttingDown = false;

async function main() {
  initSettings();
  initStore();
  initImageStore();
  initLines();
  const sweepTimer = setInterval(() => {
    try {
      const ended = sweepStaleSessions((session) => {
        const rule = getSettings().rules.find((item) => item.id === session.ruleId);
        return (rule && rule.sessionTimeoutHours) || 12;
      });
      for (const session of ended) {
        console.log(`[树木排查] 会话超时自动结束：${session.groupName || session.groupId}，共捕获 ${session.records.length} 条`);
      }
    } catch (err) {
      console.error(`[树木排查] 超时扫描异常：${err.stack || err}`);
    }
  }, 60 * 1000);
  sweepTimer.unref();
  const { wechat, rules } = getSettings();
  if (!wechat.botWxid && rules.some((rule) => rule.enabled && rule.trigger === 'treeWatch')) {
    console.warn('[app] 存在已启用的树木排查规则但未配置监听账号 wxid，@检测与自身消息排除将不生效');
  }
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.log(`[app] Web 管理页已启动：http://${config.host}:${config.port}`);
  if (config.adminPassword === 'Admin@123') {
    console.warn('[app] 正在使用默认管理员密码，请在部署环境变量中修改 ADMIN_PASSWORD');
  }
  client.start().catch((err) => console.error(`[app] 微信监听启动异常：${err.stack || err}`));
}

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[app] 收到 ${signal}，正在退出…`);
  client.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  console.error(`[app] 启动失败：${err.stack || err}`);
  process.exit(1);
});
