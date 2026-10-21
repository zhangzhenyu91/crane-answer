const config = require('./config');
const { initSettings, getSettings } = require('./settings');
const WeChatPadProClient = require('./wechatpadpro/client');
const { handleMessage, hasPendingCapture } = require('./wechatpadpro/messageHandler');
const { createServer } = require('./server');
const {
  initStore,
  listUnpushedRecords,
  listPendingDeletes,
  removePendingDelete,
  settlePendingDelete,
  pendingDeleteDue,
  shouldNoticePendingDeletes,
} = require('./inspection/store');
const { pushRecord, pushDeleteEvent, isRecordPushInFlight } = require('./inspection/push');
const { initImageStore } = require('./wechatpadpro/imageStore');
const { initLines } = require('./lines');

const client = new WeChatPadProClient({
  onMessage: handleMessage,
  onReady: () => console.log('[app] 开始接收微信群消息推送'),
});
const server = createServer({ client });
let shuttingDown = false;

// 失败重扫：记录/删除事件距上次推送尝试满 5 分钟才重试，避免与实时推送抢跑
const PUSH_RETRY_AFTER_SEC = 5 * 60;

/**
 * 壹匣推送失败重扫：遍历所有日桶中 pushStatus 非 ok 的记录逐条 pushRecord 补推。
 * 排除提取进行中、推送进行中与已删/待删记录；错误只汇总打一条日志，不刷屏。
 */
async function rescanPushFailures() {
  const now = Math.floor(Date.now() / 1000);
  const targets = listUnpushedRecords().filter(({ record }) =>
    !hasPendingCapture(record.id)
    && !isRecordPushInFlight(record.id)
    && (!record.pushedAt || now - record.pushedAt >= PUSH_RETRY_AFTER_SEC));
  if (!targets.length) return;
  let failed = 0;
  let firstError = '';
  for (const { bucket, record } of targets) {
    const result = await pushRecord(bucket, record);
    if (!result.ok) {
      failed += 1;
      if (!firstError) firstError = result.message;
    }
  }
  if (failed) {
    console.error(`[壹匣重扫] ${targets.length} 条待推送记录重推完成，失败 ${failed} 条${firstError ? `：${firstError}` : ''}`);
  } else {
    console.log(`[壹匣重扫] ${targets.length} 条待推送记录已补推壹匣`);
  }
}

/**
 * 删除事件失败重扫：补推删除重试队列中的事件（撤回删除时壹匣不可达的兜底）。
 * 节奏与记录重试一致（≥5 分钟），超过 20 次降级为每天一次（store.pendingDeleteDue）；
 * 成功出队，失败仅在前几次记单条日志，之后并入每日一条汇总日志。
 */
async function rescanPendingDeletes() {
  const now = Math.floor(Date.now() / 1000);
  const queue = listPendingDeletes();
  const due = queue.filter((event) => pendingDeleteDue(event, now));
  for (const event of due) {
    const result = await pushDeleteEvent(event);
    if (result.ok) {
      removePendingDelete(event.id);
      console.log(`[壹匣重扫] 删除事件已补推并出队（记录 ${event.craneRecordId}）`);
      continue;
    }
    const updated = settlePendingDelete(event.id, result.message);
    const attempts = updated ? updated.attempts : 0;
    // 前 3 次失败记单条日志便于定位，之后并入每日汇总，避免长时间不可达时刷屏
    if (attempts <= 3) {
      console.error(`[壹匣重扫] 删除事件补推失败（第 ${attempts} 次，记录 ${event.craneRecordId}）：${result.message}`);
    }
  }
  // 队列非空时至多每天打一条汇总日志（含降级中的事件），提醒运维关注
  if (shouldNoticePendingDeletes(now)) {
    const total = listPendingDeletes().length;
    const worst = listPendingDeletes()[0];
    console.error(
      `[壹匣重扫] 仍有 ${total} 条删除事件待补推（壹匣侧残留已删记录）` +
      `${worst ? `，示例：记录 ${worst.craneRecordId} 累计失败 ${worst.attempts} 次：${worst.lastError || '-'}` : ''}`
    );
  }
}

async function main() {
  initSettings();
  initStore();
  initImageStore();
  initLines();
  const retryTimer = setInterval(() => {
    Promise.resolve()
      .then(() => rescanPendingDeletes())
      .then(() => rescanPushFailures())
      .catch((err) => console.error(`[壹匣重扫] 失败重扫异常：${err.stack || err}`));
  }, 60 * 1000);
  retryTimer.unref();
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
