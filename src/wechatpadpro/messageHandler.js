const { getSettings } = require('../settings');
const config = require('../config');
const { resolveDisplayName, resolveWxidByName } = require('./memberResolver');
const { runWorkflow } = require('../dify');
const store = require('../inspection/store');
const imageStore = require('./imageStore');
const { matchLine } = require('../lines');
const { sendSessionXlsx } = require('../inspection/deliver');
const { pushSession } = require('../inspection/push');
const { sendQuote, sendText } = require('./sender');

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

/* ------------------------- 撤回识别（treeWatch） ------------------------- */

const RECALL_WINDOW_SEC = 180;

function isRecallEvent(msg) {
  return String(msg.kind) === 'system'
    && (Number(msg.type) === 10002 || (msg.system && msg.system.category === 'message_recalled'));
}

/**
 * 撤回先于记录落库到达的竞态：暂存未命中的撤回（按群+撤回人），
 * 待 pending 记录出现时补判。方向性条件：撤回时间 ≥ 报送时间，
 * 避免"先撤回闲聊再报送"误删新记录。
 */
const pendingRecalls = new Map();

function stashPendingRecall(groupId, senderId, at) {
  if (!senderId) return;
  const list = (pendingRecalls.get(groupId) || []).filter((item) => at - item.at <= RECALL_WINDOW_SEC);
  list.push({ senderId, at });
  pendingRecalls.set(groupId, list);
}

function popMatchingRecall(groupId, record) {
  const list = pendingRecalls.get(groupId);
  if (!list) return false;
  const idx = list.findIndex((item) => item.senderId === record.senderId
    && item.at >= record.capturedAt
    && item.at - record.capturedAt <= RECALL_WINDOW_SEC);
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}

/**
 * 记录删除时连带清理其辅证照片：缓存条目（含已下载文件）按记录 id 反查删除，
 * 兜底按记录 photos 上的文件路径直接删（缓存条目缺失时）。
 * @returns {number} 清理的照片张数
 */
function purgeRecordPhotos(record) {
  const count = (record.photos || []).length;
  for (const entry of imageStore.findByRecordId(record.id)) imageStore.removeImage(entry.svrId);
  for (const photo of record.photos || []) imageStore.deleteFile(photo.file);
  record.photos = [];
  return count;
}

/**
 * 撤回事件处理：实时推送的撤回系统消息不含被撤消息 ID（已实测确认），启发式删除——
 * 把「撤回人时间窗内最近一条记录」与「撤回人时间窗内最近一张缓存图片」放进同一时间线，取较新者：
 * - 撤到图片：已挂接记录 → 仅摘删该辅证照片（记录保留），群内反馈「已删除辅证照片」；未挂接 → 静默清缓存；
 * - 撤到记录：删记录并连带删除其全部辅证照片，群内文本反馈「已删除」（无法引用已撤回的消息）；
 * - 撤回人两者皆无时兜底群内时间窗内最近一条记录（群主撤回他人消息等场景）。
 * 竞态处理：撤回先于记录落库到达时暂存撤回事件，记录出现时以「撤回时间 ≥ 报送时间」补判删除（可区分"先撤回闲聊再报送"）；
 * 提取进行中记录被撤回的，提取返回后跳过落库与「已记录」反馈。
 * 局限：同一发送者连续报送时，撤回只能定位到其最近一条消息项，无法精确到被撤的那一条；
 * 「引用图片发文字」后撤回图片的，因记录（引用文字）比图片更新，会按撤记录处理（整条删除）。
 */
async function handleRecall(msg, group, conversationId) {
  let recallerWxid = msg.sender_id && !String(msg.sender_id).endsWith('@chatroom') ? String(msg.sender_id) : '';
  if (!recallerWxid) {
    const m = String(msg.content || '').match(/^["“](.+?)["”]\s*撤回了一条消息/);
    if (m) recallerWxid = await resolveWxidByName(conversationId, m[1]);
  }
  const recalledImage = recallerWxid ? imageStore.findRecallImage(conversationId, recallerWxid, RECALL_WINDOW_SEC) : null;
  const target = store.findRecallTarget(conversationId, recallerWxid, RECALL_WINDOW_SEC);

  // 同一时间线取较新者：图片比记录新 → 按「撤回图片」处理（仅删辅证照片，记录保留）
  if (recalledImage && (!target || recalledImage.capturedAt >= target.record.capturedAt)) {
    if (recalledImage.recordId) {
      const found = store.findRecord(recalledImage.recordId);
      const photo = found && store.removePhoto(found.record, recalledImage.svrId);
      imageStore.removeImage(recalledImage.svrId);
      if (found) store.saveSession(found.session);
      console.log(
        `[树木排查] 辅证照片因图片撤回已删除（记录 ${recalledImage.recordId}${photo ? '' : ' 上未找到该照片'}，撤回人=${recallerWxid}）`
      );
      sendText(conversationId, '已删除辅证照片')
        .catch((err) => console.error(`[树木排查] 「已删除辅证照片」反馈发送失败：${err.message}`));
    } else {
      imageStore.removeImage(recalledImage.svrId);
      console.log(`[树木排查] 未挂接的缓存图片因撤回已清理（${group.name}，撤回人=${recallerWxid}）`);
    }
    return;
  }

  if (!target) {
    console.log(`[树木排查] 撤回事件未命中任何记录（${group.name}，撤回人=${recallerWxid || '-'}），暂存待补判`);
    stashPendingRecall(conversationId, recallerWxid, Number(msg.created_at) || Math.floor(Date.now() / 1000));
    return;
  }
  const photoCount = purgeRecordPhotos(target.record);
  store.removeRecord(target.session, target.record.id);
  console.log(
    `[树木排查] 记录 ${target.record.id} 因消息撤回已删除（匹配方式=${target.matchedBy}，连带辅证照片 ${photoCount} 张）：${target.record.content.slice(0, 40)}`
  );
  sendText(conversationId, '已删除')
    .catch((err) => console.error(`[树木排查] 「已删除」反馈发送失败：${err.message}`));
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
    type: pick('type'), // 被引用消息类型：3=图片（引用图片发文字时据此与更正分流）
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
 * app.reference 携带被引用消息的 svr_id/new_msg_id/content/display_name/msg_type（msg_type=3 表示被引用者是图片）。
 * 注意：reply_context 是普通消息的自身回显（svr_id 指向自己），不能用于引用判定。
 * 兜底解析 content/raw 中的 appmsg type=57 XML（refermsg 块）；
 * 「引用记录发图片」的图片消息（kind=image）不带 app 结构，引用信息在其 source/go_fields.Content 的 refermsg 块中。
 * 返回 { svrid, content, text, msgType } | null，text 为引用者新发的内容，msgType 为被引用消息类型（可空）。
 */
function extractQuote(msg, content) {
  const app = msg.app;
  if (app && app.category === 'quote' && app.reference) {
    const ref = app.reference;
    return {
      svrid: String(ref.svr_id || ref.new_msg_id || ref.msg_id || ''),
      content: String(ref.content || ''),
      text: String(app.title || content || '').trim(),
      msgType: ref.msg_type != null ? Number(ref.msg_type) : null,
    };
  }
  const rawText = [
    msg.raw,
    msg.msg_source,
    msg.source,
    msg.go_fields && msg.go_fields.Content,
    content,
  ].filter((v) => typeof v === 'string').join('\n');
  const refer = parseReferXml(rawText);
  if (refer && (refer.svrid || refer.content)) {
    return {
      svrid: refer.svrid,
      content: refer.content,
      text: quoteTitle(content),
      msgType: refer.type ? Number(refer.type) : null,
    };
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

// 「报送修改」备注提取专用：仅剥 @ 提及、压缩空格/制表符，保留备注内换行
function stripMentionsPreserveNewlines(content) {
  return String(content || '').replace(/@[^\s@]+/g, ' ').replace(/[^\S\n]+/g, ' ').trim();
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

/**
 * 捕获报送消息：先落库 pending 记录再调 Dify 提取。
 * photoSvrId 可选：「引用图片发记录文字」场景被引用图片的 svr_id——
 * 提取确认是树障后下载该图并挂为记录辅证照片（下载失败不影响记录本体，反馈中带明）。
 */
async function captureRecord(rule, group, session, msg, senderId, content, photoSvrId) {
  const senderName = await resolveDisplayName(session.groupId, senderId);
  const record = store.addRecord(session, {
    msgId: msgIdOf(msg),
    senderId,
    senderName,
    content,
    capturedAt: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    pending: true,
  });
  if (popMatchingRecall(session.groupId, record)) {
    store.removeRecord(session, record.id);
    console.log(`[树木排查] 记录落库前检测到对应撤回，已删除且不再提取：${content.slice(0, 40)}`);
    sendText(session.groupId, '已删除')
      .catch((err) => console.error(`[树木排查] 「已删除」反馈发送失败：${err.message}`));
    return;
  }
  const task = (async () => {
    try {
      const result = await runWorkflow(group.apiKey, {
        text: content,
        nickname: senderName,
        wxid: senderId,
        group: session.groupName || '',
      }, { retries: 5 });
      if (!session.records.some((item) => item.id === record.id)) {
        console.log(`[树木排查] 记录 ${record.id} 在提取期间已被撤回删除，跳过落库与「已记录」反馈`);
        return false;
      }
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
      // 辅证照片：提取确认是树障后才下载被引用图片；下载期间记录被撤回的，删掉已下载文件并静默退出
      let photoNote = '';
      if (photoSvrId) {
        const cached = imageStore.getImage(photoSvrId);
        if (!cached) {
          photoNote = '，但未找到引用的图片';
          console.warn(`[树木排查] 记录 ${record.id} 引用的图片 ${photoSvrId} 不在缓存中（可能已过期或服务重启前收到），辅证缺失`);
        } else {
          try {
            const got = await imageStore.downloadImage(photoSvrId);
            if (!session.records.some((item) => item.id === record.id)) {
              imageStore.deleteFile(got.file);
              console.log(`[树木排查] 记录 ${record.id} 在辅证下载期间已被撤回删除，已清理下载文件`);
              return false;
            }
            store.addPhoto(record, {
              msgId: photoSvrId,
              senderId: cached.senderId || senderId,
              capturedAt: cached.capturedAt,
              file: got.file,
              bytes: got.bytes,
            });
            imageStore.attachToRecord(photoSvrId, record.id);
            store.saveSession(session);
          } catch (photoErr) {
            photoNote = '，但辅证照片下载失败';
            console.error(`[树木排查] 记录 ${record.id} 辅证照片下载失败（记录保留）：${photoErr.message}`);
          }
        }
      }
      console.log(
        `[树木排查] 捕获记录 ${record.id}：线路=${lineNameRaw || '-'}→${record.matchedLine ? record.matchedLine.name : '待确认'}` +
        ` 区段=${extracted.pole_from ?? ''}-${extracted.pole_to ?? ''} 发送者=${senderName} 辅证=${(record.photos || []).length} 张`
      );
      sendQuote(session.groupId, `已记录${photoNote}`, msg)
        .then(() => console.log(`[树木排查] 「已记录」反馈已发送（${record.id}）`))
        .catch((err) => console.error(`[树木排查] 「已记录」反馈发送失败：${err.message}`));
      return true;
    } catch (err) {
      console.error(`[树木排查] 提取调用失败（重试 5 次后仍失败），记录已丢弃：${err.message}，原文：${content.slice(0, 60)}`);
      store.removeRecord(session, record.id);
      sendQuote(session.groupId, '记录失败', msg)
        .then(() => console.log(`[树木排查] 「记录失败」反馈已发送（${record.id}）`))
        .catch((sendErr) => console.error(`[树木排查] 「记录失败」反馈发送失败：${sendErr.message}`));
      return false;
    } finally {
      pendingCaptures.delete(record.id);
    }
  })();
  pendingCaptures.set(record.id, { sessionId: session.id, promise: task });
}

/**
 * 会话内图片消息（treeWatch）：
 * - 裸发图片：缓存 CDN 下载参数备查（不下载本体、不反馈），待「引用图片发文字」时查表挂接；
 * - 引用记录发图片（图片消息自身带 refermsg 引用块）：下载并挂到被引用记录为辅证照片，
 *   反馈「已添加辅证照片」——与文字更正严格分流（图片消息无更正文本，不进更正工作流）。
 */
async function handleImageMessage(rule, group, session, msg, senderId, content) {
  const entry = imageStore.cacheImage(msg, session.groupId, senderId);
  const quote = extractQuote(msg, content);
  if (!quote || !quote.svrid) {
    if (entry) console.log(`[树木排查] 缓存群图片 ${entry.svrId}（${session.groupName}，发送者=${senderId}），待引用挂接`);
    return;
  }
  let record = store.findRecordByMsgId(session, quote.svrid);
  if (!record) record = store.findRecordByContent(session, quote.content);
  if (!record) {
    console.log(`[树木排查] 图片引用的消息未命中本会话记录（svrid=${quote.svrid}），仅缓存不挂接`);
    return;
  }
  if (record.status === 'pending') {
    const pending = pendingCaptures.get(record.id);
    if (pending) {
      console.log(`[树木排查] 记录 ${record.id} 提取进行中，辅证挂接等待其完成…`);
      const captured = await pending.promise;
      if (!captured) {
        console.log('[树木排查] 目标记录提取未成功（已丢弃），辅证挂接忽略');
        return;
      }
    }
  }
  if (!entry) {
    console.warn(`[树木排查] 图片消息缺少 CDN 下载参数，无法挂接辅证（记录 ${record.id}）`);
    sendQuote(session.groupId, '辅证照片下载失败', msg)
      .catch((err) => console.error(`[树木排查] 「辅证照片下载失败」反馈发送失败：${err.message}`));
    return;
  }
  try {
    const got = await imageStore.downloadImage(entry.svrId);
    if (!session.records.some((item) => item.id === record.id)) {
      imageStore.removeImage(entry.svrId); // 下载期间记录被撤回删除，清理文件与缓存
      console.log(`[树木排查] 记录 ${record.id} 在辅证下载期间已被撤回删除，已清理下载文件`);
      return;
    }
    store.addPhoto(record, {
      msgId: entry.svrId,
      senderId,
      capturedAt: entry.capturedAt,
      file: got.file,
      bytes: got.bytes,
    });
    imageStore.attachToRecord(entry.svrId, record.id);
    store.saveSession(session);
    console.log(`[树木排查] 辅证照片已挂接：记录 ${record.id}（图片 ${entry.svrId}，${got.bytes} 字节）`);
    sendQuote(session.groupId, '已添加辅证照片', msg)
      .catch((err) => console.error(`[树木排查] 「已添加辅证照片」反馈发送失败：${err.message}`));
  } catch (err) {
    console.error(`[树木排查] 辅证照片下载失败（记录 ${record.id}）：${err.message}`);
    sendQuote(session.groupId, '辅证照片下载失败', msg)
      .catch((sendErr) => console.error(`[树木排查] 「辅证照片下载失败」反馈发送失败：${sendErr.message}`));
  }
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
  let result;
  try {
    result = await runWorkflow(group.correctApiKey, {
      correction_text: correctionText,
      quoted_text: quote.content || record.content,
      current_record: JSON.stringify(record.extracted),
      nickname: senderName,
      wxid: senderId,
    }, { retries: 5 });
  } catch (err) {
    console.error(`[树木排查] 更正工作流调用失败（重试 5 次后仍失败）：${err.message}`);
    sendQuote(session.groupId, '更正失败', msg)
      .then(() => console.log(`[树木排查] 「更正失败」反馈已发送（${record.id}）`))
      .catch((sendErr) => console.error(`[树木排查] 「更正失败」反馈发送失败：${sendErr.message}`));
    return;
  }
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

/* ------------------------- 报送壹匣指令（treeWatch） ------------------------- */

/**
 * 群内 @监听账号 的报送指令：「报送」= 审核通过直接入库（direct）；「报送修改」+备注 = 进壹匣暂存区（staging）。
 * 两种模式推送成功均结束会话（报送即闭环，避免下次排查记录混入旧会话；修改在壹匣暂存区完成）。
 * 推送对象为该群最近一次已发汇总 xlsx 的会话；回执统一用纯文本 sendText。
 */
async function handleYixiaPushCommand(conversationId, senderId, mode, reviewNote) {
  const reply = (text) => sendText(conversationId, text)
    .catch((err) => console.error(`[报送壹匣] 回执发送失败：${err.message}`));
  if (!config.yixia.baseUrl || !config.yixia.token) {
    await reply('未配置壹匣推送');
    return;
  }
  const session = store.findLatestSentSession(conversationId);
  if (!session) {
    await reply('暂无可推送的排查汇总');
    return;
  }
  if (!session.records.some((item) => item.status === 'active')) {
    await reply('会话无有效记录');
    return;
  }
  const senderName = await resolveDisplayName(conversationId, senderId);
  const result = await pushSession(session, mode, { wxid: senderId, name: senderName }, reviewNote)
    .catch((err) => ({ ok: false, message: err.message }));
  if (!result.ok) {
    await reply(`报送失败：${result.message}`);
    return;
  }
  store.endSession(session.id, 'reported');
  console.log(`[报送壹匣] 报送成功（${mode}），会话 ${session.id} 已结束（reported）`);
  const suffix = mode === 'staging' ? '，备注已随表提交' : '';
  await reply(`${result.message}（${senderName}）${suffix}`);
}

async function handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content) {
  const { wechat } = getSettings();
  const botWxid = (wechat.botWxid || '').trim();
  if (msg.direction === 'outgoing') return;
  if (botWxid && senderId === botWxid) return;

  if (await botMentioned(msg, content, conversationId, wechat)) {
    const commandText = stripMentions(content);
    // 报送指令锚定判定（全等/前缀），优先于关键词包含判定，
    // 避免备注文本里混入「汇总」「结束」等关键词被误吞
    const reportText = stripMentionsPreserveNewlines(content);
    if (reportText === '报送' || reportText.startsWith('报送修改')) {
      const mode = reportText === '报送' ? 'direct' : 'staging';
      const reviewNote = mode === 'staging' ? reportText.slice('报送修改'.length).trim() : '';
      await handleYixiaPushCommand(conversationId, senderId, mode, reviewNote);
      return;
    }
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
    // 汇总是独立步骤指令：发表后不结束会话，可继续捕获/更正并再次汇总
    const summaryKeywords = Array.isArray(rule.summaryKeywords) && rule.summaryKeywords.length ? rule.summaryKeywords : ['汇总'];
    if (summaryKeywords.some((k) => commandText.includes(k))) {
      const session = store.getActiveSession(conversationId);
      if (session) {
        const pendingCount = [...pendingCaptures.values()].filter((item) => item.sessionId === session.id).length;
        if (pendingCount) console.log(`[树木排查] 汇总指令：等待 ${pendingCount} 条进行中的提取完成…`);
        await flushSessionCaptures(session.id);
        const current = store.getSession(session.id);
        if (current.records.length) {
          try {
            const { fileName, bytes } = await sendSessionXlsx(current);
            console.log(`[树木排查] 汇总已发送至群：${fileName}（${bytes} 字节），会话 ${current.id} 继续记录中`);
            sendQuote(conversationId, '汇总表已发送，会话仍在记录中；审核无误请 @我 发送「报送」，需修改请发送「报送修改」+备注', msg)
              .catch((err) => console.error(`[树木排查] 「汇总已发送」回执发送失败：${err.message}`));
          } catch (err) {
            console.error(`[树木排查] 汇总发送失败：${err.stack || err}`);
          }
        } else {
          console.log('[树木排查] 会话无记录，跳过群内发送');
        }
      } else {
        console.log(`[树木排查] ${group.name} 无进行中的会话，忽略汇总指令`);
      }
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
        if (finalSession.sentAt) {
          console.log('[树木排查] 会话已汇总发表过，结束不再重复发送');
        } else if (finalSession.records.length) {
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

  // 图片消息先行分流：裸发缓存备查；引用记录发图 → 挂辅证照片（图片无更正文本，不进更正流程）
  if (String(msg.kind) === 'image' || (msg.image && typeof msg.image === 'object')) {
    await handleImageMessage(rule, group, session, msg, senderId, content);
    return;
  }

  const quote = extractQuote(msg, content);
  if (quote) {
    // 引用图片发记录文字（app.reference.msg_type=3，或被引用 svr_id 命中图片缓存且非记录）
    // → 作为新报送捕获并把被引用图片挂为辅证；引用记录文字 → 更正流程（不变）
    const recordHit = store.findRecordByMsgId(session, quote.svrid);
    const imageHit = quote.svrid ? imageStore.getImage(quote.svrid) : null;
    const quotingImage = Number(quote.msgType) === 3 || (!recordHit && !!imageHit);
    if (quotingImage) {
      if (!quote.text) {
        console.log(`[树木排查] 引用图片但未附文字（svrid=${quote.svrid}），忽略`);
        return;
      }
      if (!passesCaptureGate(quote.text)) {
        console.log(`[树木排查] 引用图片的文字未过初筛，忽略：${quote.text.slice(0, 60)}`);
        return;
      }
      await captureRecord(rule, group, session, msg, senderId, quote.text, quote.svrid);
      return;
    }
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
      if (isRecallEvent(msg)) {
        handleRecall(msg, group, conversationId)
          .catch((err) => console.error(`[树木排查] 规则“${rule.name}”撤回处理失败：${err.stack || err}`));
        continue;
      }
      handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content)
        .catch((err) => console.error(`[树木排查] 规则“${rule.name}”处理失败：${err.stack || err}`));
    }
  }
}

module.exports = { handleMessage };
