const WeChatPadProClient = require('./wechatpadpro/client');
const { handleMessage } = require('./wechatpadpro/messageHandler');

const client = new WeChatPadProClient({
  onMessage: handleMessage,
  onReady: () => console.log('[app] 开始接收微信群消息推送'),
});

client.start().catch((err) => {
  console.error(`[app] 启动失败：${err.stack || err}`);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`[app] 收到 ${signal}，正在退出…`);
  client.stop();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
