const { getSettings } = require('../settings');
const { resolveDisplayName } = require('./memberResolver');
const { runWorkflow } = require('../dify');

/**
 * 群消息里，发送者通常在 sender_id / reply_context.from_user_id，
 * 部分场景在 content 前缀 "wxid_xxx:\n实际内容" 中。返回 { senderId, content }。
 */
function extractSender(msg) {
  let senderId = msg.sender_id || (msg.reply_context && msg.reply_context.from_user_id) || '';
  let content = typeof msg.content === 'string' ? msg.content : '';

  if (msg.is_group && content) {
    const m = content.match(/^([^\s:]{1,64}):\n([\s\S]*)$/);
    if (m) {
      if (!senderId) senderId = m[1];
      content = m[2];
    }
  }
  return { senderId, content };
}

function formatTime(unixSeconds) {
  if (!unixSeconds) return '-';
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 位置消息触发：提取发送者与经纬度，调用该群对应的 Dify workflow。
 */
async function handleLocationTrigger(msg, conversationId, difyApiKey, ruleName) {
  const loc = msg.location || {};
  const senderUsername = msg.sender_id
    || (msg.reply_context && msg.reply_context.from_user_id)
    || loc.from_user_name
    || '';
  const senderDisplayName = await resolveDisplayName(conversationId, senderUsername);

  const extracted = {
    ruleName,
    groupId: conversationId,
    senderUsername,
    senderDisplayName,
    longitude: loc.longitude,
    latitude: loc.latitude,
    label: loc.label || '',
    poiName: loc.poi_name || '',
  };
  console.log(`[触发] 监听到位置消息，提取结果：${JSON.stringify(extracted)}`);

  const result = await runWorkflow(difyApiKey, {
    lng: extracted.longitude,
    lat: extracted.latitude,
    nickname: senderDisplayName,
    wxid: senderUsername,
  });
  const outputs = result.data && result.data.outputs;
  console.log(
    `[触发] Dify 调用完成：run_id=${result.workflow_run_id || (result.data && result.data.id) || '-'}` +
    ` 状态=${(result.data && result.data.status) || '-'} 输出=${JSON.stringify(outputs) || '-'}`
  );
  return extracted;
}

/**
 * 单条消息入口。
 */
function handleMessage(msg) {
  const conversationId = String(msg.conversation_id || '');
  const isGroup = Boolean(msg.is_group) || conversationId.endsWith('@chatroom');
  const { senderId, content } = extractSender(msg);
  const preview = String(content).replace(/\s+/g, ' ').slice(0, 120);

  console.log(
    `[消息] ${formatTime(msg.created_at)} | ${isGroup ? '群聊' : '私聊'}` +
    ` | 会话=${conversationId || '-'} | 发送者=${senderId || '-'} ` +
    ` | 方向=${msg.direction || '-'} | 类型=${msg.kind || '-'} | ${preview}`
  );

  if (!isGroup || msg.kind !== 'location' || !msg.location) return;
  const { rules } = getSettings();
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger !== 'location' || rule.action !== 'dify') continue;
    const group = (rule.groups || []).find((item) => item.groupId === conversationId && item.apiKey);
    if (!group) continue;
    handleLocationTrigger(msg, conversationId, group.apiKey, rule.name)
      .catch((err) => console.error(`[触发] 规则“${rule.name}”处理失败：${err.stack || err}`));
  }
}

module.exports = { handleMessage };
