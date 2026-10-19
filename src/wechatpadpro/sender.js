const { getSettings } = require('../settings');

async function postMsgApi(path, body) {
  const { wechat } = getSettings();
  if (!wechat.token) throw new Error('未配置 WeChatPadPro Cloud Access Token');
  const res = await fetch(`${wechat.apiBase}${path}`, {
    method: 'POST',
    headers: {
      'X-Cloud-Access-Token': wechat.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`消息接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }
  if (!res.ok || parsed.Success === false || (typeof parsed.Code === 'number' && parsed.Code !== 0)) {
    throw new Error(`消息接口调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  return parsed;
}

/**
 * 发送文件到群聊（或私聊）。
 * @param {string} toWxid 目标 wxid，群聊填群 ID（xxx@chatroom）
 * @param {Buffer} buffer 文件内容
 * @param {string} fileName 文件名
 */
async function sendFile(toWxid, buffer, fileName) {
  return postMsgApi('/v1/Msg/SendFile', {
    Base64: buffer.toString('base64'),
    FileName: fileName,
    ToWxid: toWxid,
  });
}

/**
 * 发送引用消息：引用群内某条消息并回复文字反馈。
 * 入站消息自带的 reply_context 即该消息的上下文回显，直接透传作为引用上下文；
 * 64 位 svr_id/new_msg_id 按接口要求使用字符串。
 * @param {string} toWxid 目标群 ID
 * @param {string} text 回复内容
 * @param {object} quotedMsg 被引用的入站消息对象
 */
async function sendQuote(toWxid, text, quotedMsg) {
  const rc = quotedMsg.reply_context || {};
  const replyContext = {
    chat_user_id: String(rc.chat_user_id || rc.conversation_id || toWxid),
    conversation_id: String(rc.conversation_id || toWxid),
    from_user_id: String(rc.from_user_id || quotedMsg.sender_id || ''),
    msg_id: Number(rc.msg_id || quotedMsg.msg_id || 0),
    msg_type: Number(rc.msg_type || quotedMsg.type || 1),
    new_msg_id: String(rc.new_msg_id || quotedMsg.new_msg_id || ''),
    quote_content: String(rc.quote_content || (typeof quotedMsg.content === 'string' ? quotedMsg.content : '') || ''),
    sequence: Number(rc.sequence || quotedMsg.sequence || 0),
    svr_id: String(rc.svr_id || quotedMsg.svr_id || ''),
    to_wxid: String(rc.to_wxid || rc.chat_user_id || ''),
  };
  return postMsgApi('/v1/Msg/Quote', {
    chat_user_id: replyContext.chat_user_id,
    content: text,
    display_name: String(quotedMsg.push_content ? quotedMsg.push_content.split(' : ')[0] : ''),
    from_user_id: replyContext.from_user_id,
    msg_type: replyContext.msg_type,
    new_msg_id: replyContext.new_msg_id,
    quote_content: replyContext.quote_content,
    reply_context: replyContext,
    sequence: String(replyContext.sequence || ''),
    svr_id: replyContext.svr_id,
    to_wxid: toWxid,
  });
}

/**
 * 发送文本消息到群聊（或私聊）。
 * @param {string} toWxid 目标 wxid，群聊填群 ID（xxx@chatroom）
 * @param {string} content 文本内容
 */
async function sendText(toWxid, content) {
  return postMsgApi('/v1/Msg/SendTxt', {
    Content: content,
    ToWxid: toWxid,
  });
}

module.exports = { sendFile, sendQuote, sendText };
