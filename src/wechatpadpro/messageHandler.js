const { getSettings } = require('../settings');
const { resolveDisplayName } = require('./memberResolver');
const { runWorkflow } = require('../dify');
const store = require('../inspection/store');
const { matchLine } = require('../lines');
const { sendSessionXlsx } = require('../inspection/deliver');
const { sendQuote } = require('./sender');

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
    lng: String(extracted.longitude ?? ''),
    lat: String(extracted.latitude ?? ''),
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

/* ------------------------- 树木排查会话（treeWatch） ------------------------- */

const POLE_RANGE_RE = /\d+\s*#?\s*[-—~－至]\s*#?\s*\d+/;
const POLE_SINGLE_RE = /\d+\s*(?:#|号)(?:塔底)?/;
const FEATURE_WORD_RE = /棵|垂距|垂直|超高|水平/;
const TREE_WORD_RE = /树|棵/;
const MEASURE_WORD_RE = /水平|垂距|垂直|超高/;
const CROSS_EXCLUDE_RE = /交叉|跨越/;

/**
 * 捕获初筛（第一层，宽进严出，终审由 Dify is_tree_hazard 完成）：
 * 杆号+特征词，或树种词+量测词；纯交叉跨越排除。
 */
function passesCaptureGate(text) {
  if (CROSS_EXCLUDE_RE.test(text) && !/棵/.test(text)) return false;
  const hasPole = POLE_RANGE_RE.test(text) || POLE_SINGLE_RE.test(text);
  if (hasPole && FEATURE_WORD_RE.test(text)) return true;
  return TREE_WORD_RE.test(text) && MEASURE_WORD_RE.test(text);
}

function msgIdOf(msg) {
  return String(msg.svr_id || msg.new_msg_id || msg.id || msg.svrid || msg.srvid || msg.msg_id || '');
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

function parseReferXml(raw) {
  const block = String(raw || '').match(/<refermsg>([\s\S]*?)<\/refermsg>/);
  if (!block) return null;
  const body = block[1];
  const pick = (tag) => {
    const m = body.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
    return m ? unescapeXml(m[1]).trim() : '';
  };
  return {
    svrid: pick('svrid'),
    content: pick('content'),
    fromusr: pick('fromusr'),
    chatusr: pick('chatusr'),
  };
}

function quoteTitle(content) {
  const m = String(content || '').match(/<title>([\s\S]*?)<\/title>/);
  return m ? unescapeXml(m[1]).trim() : String(content || '').trim();
}

/**
 * 引用消息识别：真实推送中引用消息为 kind=app 且 app.category='quote'，
 * app.reference 携带被引用消息的 svr_id/new_msg_id/content/display_name。
 * 注意：reply_context 是普通消息的自身回显（svr_id 指向自己），不能用于引用判定。
 * 兜底解析 content/raw 中的 appmsg type=57 XML（refermsg 块）。
 * 返回 { svrid, content, text } | null，text 为引用者新发的内容。
 */
function extractQuote(msg, content) {
  const app = msg.app;
  if (app && app.category === 'quote' && app.reference) {
    const ref = app.reference;
    return {
      svrid: String(ref.svr_id || ref.new_msg_id || ref.msg_id || ''),
      content: String(ref.content || ''),
      text: String(app.title || content || '').trim(),
    };
  }
  const rawText = [msg.raw, msg.msg_source, content].filter((v) => typeof v === 'string').join('\n');
  const refer = parseReferXml(rawText);
  if (refer && (refer.svrid || refer.content)) {
    return { svrid: refer.svrid, content: refer.content, text: quoteTitle(content) };
  }
  return null;
}

/**
 * @检测：优先匹配推送中的 at 列表字段与 msgsource XML 的 atuserlist；
 * 兜底匹配文本 "@群昵称"（监听账号群昵称经成员接口解析）。
 */
async function botMentioned(msg, content, conversationId, wechat) {
  const botWxid = (wechat.botWxid || '').trim();
  if (!botWxid) return false;
  const listed = [];
  for (const key of ['mention_list', 'at_list', 'atUserList', 'at_users', 'mentions', 'atUserIds', 'at_user_ids']) {
    if (Array.isArray(msg[key])) listed.push(...msg[key]);
  }
  const src = msg.msg_source || msg.msgsource;
  if (src && typeof src === 'object') {
    for (const key of ['at_user_ids', 'atUserList', 'mentions']) {
      if (Array.isArray(src[key])) listed.push(...src[key]);
    }
  }
  const rawText = [msg.content, msg.raw, typeof src === 'string' ? src : ''].filter(Boolean).join('\n');
  const atMatch = rawText.match(/<atuserlist>([\s\S]*?)<\/atuserlist>/);
  if (atMatch) listed.push(...atMatch[1].split(','));
  if (listed.some((item) => String(item).trim() === botWxid)) return true;
  try {
    const botName = await resolveDisplayName(conversationId, botWxid);
    if (botName && botName !== botWxid && String(content).includes(`@${botName}`)) return true;
  } catch {
    // 成员解析失败时仅以 at 列表为准
  }
  return false;
}

function stripMentions(content) {
  return String(content || '').replace(/@[^\s@]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseWorkflowOutputs(result) {
  const outputs = (result && result.data && result.data.outputs) || {};
  let data = outputs;
  if (typeof outputs.result === 'string') {
    try {
      data = JSON.parse(outputs.result);
    } catch {
      data = outputs;
    }
  } else if (outputs.result && typeof outputs.result === 'object') {
    data = outputs.result;
  }
  return data && typeof data === 'object' ? data : null;
}

function isTreeHazard(value) {
  if (value === false || value === 0) return false;
  if (typeof value === 'string' && /^(false|否|不是|no|0)$/i.test(value.trim())) return false;
  return true;
}

/**
 * 进行中的提取任务：recordId -> { sessionId, promise }。
 * 报送先落库为 pending 记录再调 Dify；更正与结束指令据此等待提取完成，
 * 避免「提取未返回时更正找不到记录」的竞态。
 */
const pendingCaptures = new Map();

function flushSessionCaptures(sessionId) {
  const tasks = [];
  for (const entry of pendingCaptures.values()) {
    if (entry.sessionId === sessionId) tasks.push(entry.promise);
  }
  return Promise.allSettled(tasks);
}

async function captureRecord(rule, group, session, msg, senderId, content) {
  const senderName = await resolveDisplayName(session.groupId, senderId);
  const record = store.addRecord(session, {
    msgId: msgIdOf(msg),
    senderId,
    senderName,
    content,
    capturedAt: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    pending: true,
  });
  const task = (async () => {
    try {
      const result = await runWorkflow(group.apiKey, {
        text: content,
        nickname: senderName,
        wxid: senderId,
        group: session.groupName || '',
      });
      const extracted = parseWorkflowOutputs(result);
      if (!extracted) {
        console.warn(`[树木排查] Dify 提取结果无法解析，原文：${content.slice(0, 60)}`);
        store.removeRecord(session, record.id);
        return false;
      }
      if (!isTreeHazard(extracted.is_tree_hazard)) {
        console.log(`[树木排查] 判定为非树障消息，已丢弃：${content.slice(0, 60)}`);
        store.removeRecord(session, record.id);
        return false;
      }
      const lineNameRaw = String(extracted.line_name || '').trim();
      const match = lineNameRaw ? matchLine(lineNameRaw) : { status: 'unmatched' };
      store.finalizeRecord(record, {
        extracted,
        lineNameRaw,
        matchedLine: match.status === 'ok' ? match.line : null,
        matchStatus: match.status,
        matchCandidates: match.status === 'ambiguous' ? match.candidates : [],
        handledNote: String(extracted.status_note || '').trim(),
      });
      store.saveSession(session);
      console.log(
        `[树木排查] 捕获记录 ${record.id}：线路=${lineNameRaw || '-'}→${record.matchedLine ? record.matchedLine.name : '待确认'}` +
        ` 区段=${extracted.pole_from ?? ''}-${extracted.pole_to ?? ''} 发送者=${senderName}`
      );
      sendQuote(session.groupId, '已记录', msg)
        .then(() => console.log(`[树木排查] 「已记录」反馈已发送（${record.id}）`))
        .catch((err) => console.error(`[树木排查] 「已记录」反馈发送失败：${err.message}`));
      return true;
    } catch (err) {
      console.error(`[树木排查] 提取调用失败，记录已丢弃：${err.message}，原文：${content.slice(0, 60)}`);
      store.removeRecord(session, record.id);
      return false;
    } finally {
      pendingCaptures.delete(record.id);
    }
  })();
  pendingCaptures.set(record.id, { sessionId: session.id, promise: task });
}

async function handleCorrection(rule, group, session, msg, senderId, quote) {
  let record = store.findRecordByMsgId(session, quote.svrid);
  if (!record) record = store.findRecordByContent(session, quote.content);
  if (!record) {
    console.log(`[树木排查] 引用消息未命中本会话记录（svrid=${quote.svrid || '-'}），忽略`);
    return;
  }
  if (record.status === 'pending') {
    const pending = pendingCaptures.get(record.id);
    if (pending) {
      console.log(`[树木排查] 记录 ${record.id} 提取进行中，更正等待其完成…`);
      const captured = await pending.promise;
      if (!captured) {
        console.log(`[树木排查] 目标记录提取未成功（已丢弃），更正忽略：${quote.text.slice(0, 60)}`);
        return;
      }
    }
  }
  const correctionText = quote.text;
  if (!correctionText) {
    console.log('[树木排查] 引用消息无更正内容，忽略');
    return;
  }
  const senderName = await resolveDisplayName(session.groupId, senderId);
  const result = await runWorkflow(group.correctApiKey, {
    correction_text: correctionText,
    quoted_text: quote.content || record.content,
    current_record: JSON.stringify(record.extracted),
    nickname: senderName,
    wxid: senderId,
  });
  const outputs = parseWorkflowOutputs(result);
  if (!outputs || !outputs.action) {
    console.warn(`[树木排查] 更正工作流返回无法解析：${JSON.stringify(result).slice(0, 200)}`);
    return;
  }
  let patches = outputs.patches;
  if (typeof patches === 'string') {
    try {
      patches = JSON.parse(patches);
    } catch {
      patches = null;
    }
  }
  if (outputs.action === 'correct' && patches && typeof patches === 'object') {
    store.applyCorrection(record, {
      patches,
      correctionText,
      byMsgId: msgIdOf(msg),
      bySenderId: senderId,
      bySenderName: senderName,
    });
    store.saveSession(session);
    console.log(`[树木排查] 记录 ${record.id} 已更正：${JSON.stringify(patches)}（by ${senderName}）`);
    sendQuote(session.groupId, '已更正', msg)
      .then(() => console.log(`[树木排查] 「已更正」反馈已发送（${record.id}）`))
      .catch((err) => console.error(`[树木排查] 「已更正」反馈发送失败：${err.message}`));
    return;
  }
  if (outputs.action === 'status') {
    store.markHandled(record, {
      note: String(outputs.status || correctionText),
      bySenderId: senderId,
      bySenderName: senderName,
    });
    store.saveSession(session);
    console.log(`[树木排查] 记录 ${record.id} 标记状态：${outputs.status || correctionText}（by ${senderName}）`);
    return;
  }
  console.log(`[树木排查] 更正工作流判定无关（action=${outputs.action}）：${correctionText.slice(0, 60)}`);
}

async function handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content) {
  const { wechat } = getSettings();
  const botWxid = (wechat.botWxid || '').trim();
  if (msg.direction === 'outgoing') return;
  if (botWxid && senderId === botWxid) return;

  if (await botMentioned(msg, content, conversationId, wechat)) {
    const commandText = stripMentions(content);
    if ((rule.startKeywords || []).some((k) => commandText.includes(k))) {
      const starterName = await resolveDisplayName(conversationId, senderId);
      const { session, created } = store.startSession({
        ruleId: rule.id,
        ruleName: rule.name,
        groupId: conversationId,
        groupName: group.name,
        startedBy: senderId,
        startedByName: starterName,
      });
      console.log(created
        ? `[树木排查] 会话开始：${group.name}（${conversationId}），发起人=${starterName}`
        : `[树木排查] ${group.name} 已有进行中的会话，忽略重复开始`);
      const feedbackText = created ? '开始记录树障信息' : '已有进行中的记录会话，可直接报送；如需重新开始，请先 @我 发送「结束」';
      sendQuote(conversationId, feedbackText, msg)
        .then(() => console.log('[树木排查] 「开始记录」反馈已发送'))
        .catch((err) => console.error(`[树木排查] 「开始记录」反馈发送失败：${err.message}`));
      return;
    }
    if ((rule.endKeywords || []).some((k) => commandText.includes(k))) {
      const session = store.getActiveSession(conversationId);
      if (session) {
        const pendingCount = [...pendingCaptures.values()].filter((item) => item.sessionId === session.id).length;
        if (pendingCount) console.log(`[树木排查] 结束指令：等待 ${pendingCount} 条进行中的提取完成…`);
        await flushSessionCaptures(session.id);
        store.endSession(session.id, 'keyword');
        const finalSession = store.getSession(session.id);
        console.log(`[树木排查] 会话结束：${group.name}（${conversationId}），共捕获 ${finalSession.records.length} 条`);
        if (finalSession.records.length) {
          sendSessionXlsx(finalSession)
            .then(({ fileName, bytes }) => console.log(`[树木排查] 汇总已发送至群：${fileName}（${bytes} 字节）`))
            .catch((err) => console.error(`[树木排查] 汇总发送失败：${err.stack || err}`));
        } else {
          console.log('[树木排查] 会话无记录，跳过群内发送');
        }
      } else {
        console.log(`[树木排查] ${group.name} 无进行中的会话，忽略结束指令`);
      }
      return;
    }
  }

  const session = store.getActiveSession(conversationId);
  if (!session) return;

  const quote = extractQuote(msg, content);
  if (quote) {
    await handleCorrection(rule, group, session, msg, senderId, quote);
    return;
  }

  if (msg.kind && !['text', 'quote', 'app'].includes(String(msg.kind))) return;
  if (!content || content.trim().startsWith('<')) return;
  if (!passesCaptureGate(content)) return;
  await captureRecord(rule, group, session, msg, senderId, content.trim());
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

  if (!isGroup) return;
  const { rules } = getSettings();
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const group = (rule.groups || []).find((item) => item.groupId === conversationId && item.apiKey);
    if (!group) continue;
    if (rule.trigger === 'location' && rule.action === 'dify') {
      if (msg.kind !== 'location' || !msg.location) continue;
      handleLocationTrigger(msg, conversationId, group.apiKey, rule.name)
        .catch((err) => console.error(`[触发] 规则“${rule.name}”处理失败：${err.stack || err}`));
    } else if (rule.trigger === 'treeWatch' && rule.action === 'dify') {
      handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content)
        .catch((err) => console.error(`[树木排查] 规则“${rule.name}”处理失败：${err.stack || err}`));
    }
  }
}

module.exports = { handleMessage };
