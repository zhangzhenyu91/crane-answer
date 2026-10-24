const { getSettings } = require('../settings');
const config = require('../config');
const { resolveDisplayName, resolveWxidByName } = require('./memberResolver');
const { runWorkflow } = require('../dify');
const store = require('../inspection/store');
const chatlog = require('../inspection/chatlog');
const imageStore = require('./imageStore');
const fileStore = require('./fileStore');
const { handleGroupAsk } = require('../ask/groupAsk');
const { matchLine } = require('../lines');
const { sendSessionXlsx } = require('../inspection/deliver');
const { pushSession, pushRecord, pushDelete } = require('../inspection/push');
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
 * 记录目标在该群树障/交跨两类日桶的时间窗内（含跨午夜）取较新者，与「撤回人最近一张缓存图片」
 * （仅树障记录有辅证照片，交跨纯文字台账不参与图片时间线）放进同一时间线比较：
 * - 撤到图片：已挂接记录 → 仅摘删该辅证照片（记录保留）并实时重推该条，群内反馈「已删除辅证照片」；
 *   未挂接 → 静默清缓存；
 * - 撤到记录：先实时推送删除至壹匣（pushDelete；失败入删除重试队列由失败重扫补推，不丢失），
 *   再删本地记录并连带删除其全部辅证照片，群内文本反馈「已删除」（无法引用已撤回的消息）；
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
  // 群级撤回定位：图片时间线仅对树障记录生效（交跨为纯文字台账、无辅证照片）；
  // 记录目标取该群树障桶与交跨桶时间窗内较新者，删除推送按被删记录所在桶 kind 自动选 ingest 地址
  const recalledImage = recallerWxid ? imageStore.findRecallImage(conversationId, recallerWxid, RECALL_WINDOW_SEC) : null;
  const treeTarget = store.findRecallTarget(conversationId, recallerWxid, RECALL_WINDOW_SEC, 'tree');
  const crossTarget = store.findRecallTarget(conversationId, recallerWxid, RECALL_WINDOW_SEC, 'crossing');
  const target = !treeTarget ? crossTarget
    : (!crossTarget ? treeTarget
      : (crossTarget.record.capturedAt > treeTarget.record.capturedAt ? crossTarget : treeTarget));
  const logPrefix = target && store.bucketKind(target.session) === 'crossing' ? '[交跨排查]' : '[树木排查]';

  // 同一时间线取较新者：图片比记录新 → 按「撤回图片」处理（仅删辅证照片，记录保留）
  if (recalledImage && (!target || recalledImage.capturedAt >= target.record.capturedAt)) {
    if (recalledImage.recordId) {
      const found = store.findRecord(recalledImage.recordId);
      const photo = found && store.removePhoto(found.record, recalledImage.svrId);
      imageStore.removeImage(recalledImage.svrId);
      if (found) {
        // 协作供图人的照片被摘光时协作人同步失效（发现人恢复为记录者单人，随本次重推生效）
        if (found.record.coSenderId
          && !(found.record.photos || []).some((item) => item.senderId === found.record.coSenderId)) {
          found.record.coSenderId = '';
          found.record.coSenderName = '';
        }
        store.saveSession(found.session);
        // 辅证变更实时重推该条（evidence_photos 为当前剩余照片，清空即清除壹匣辅证）；失败静默落库待重扫
        pushRecord(found.session, found.record)
          .then((result) => {
            if (!result.ok) console.error(`${logPrefix} 记录 ${found.record.id} 辅证变更重推壹匣失败：${result.message}`);
          })
          .catch((err) => console.error(`${logPrefix} 记录 ${found.record.id} 辅证变更重推壹匣异常：${err.message}`));
      }
      console.log(
        `${logPrefix} 辅证照片因图片撤回已删除（记录 ${recalledImage.recordId}${photo ? '' : ' 上未找到该照片'}，撤回人=${recallerWxid}）`
      );
      sendText(conversationId, '已删除辅证照片')
        .catch((err) => console.error(`${logPrefix} 「已删除辅证照片」反馈发送失败：${err.message}`));
    } else {
      imageStore.removeImage(recalledImage.svrId);
      console.log(`${logPrefix} 未挂接的缓存图片因撤回已清理（${group.name}，撤回人=${recallerWxid}）`);
    }
    return;
  }

  if (!target) {
    console.log(`${logPrefix} 撤回事件未命中任何记录（${group.name}，撤回人=${recallerWxid || '-'}），暂存待补判`);
    stashPendingRecall(conversationId, recallerWxid, Number(msg.created_at) || Math.floor(Date.now() / 1000));
    return;
  }
  // 整条删除：记录先标 deleting 并入删除重试队列（持久化、崩溃安全，且与记录推送重试互斥），
  // 再实时推送删除至壹匣（先推后删）；失败不丢——由失败重扫按队列补推，本地删除与群内回执照常
  target.record.deleting = true;
  const delEvent = store.enqueuePendingDelete(target.session, target.record);
  const pushResult = await pushDelete(target.session, target.record)
    .catch((err) => ({ ok: false, message: err.message }));
  if (pushResult.ok) {
    store.removePendingDelete(delEvent.id);
  } else {
    store.settlePendingDelete(delEvent.id, pushResult.message);
    console.error(`${logPrefix} 记录 ${target.record.id} 删除推送壹匣失败，已入删除重试队列（本地仍删除）：${pushResult.message}`);
  }
  const photoCount = purgeRecordPhotos(target.record);
  store.removeRecord(target.session, target.record.id);
  console.log(
    `${logPrefix} 记录 ${target.record.id} 因消息撤回已删除（匹配方式=${target.matchedBy}，连带辅证照片 ${photoCount} 张）：${target.record.content.slice(0, 40)}`
  );
  sendText(conversationId, '已删除')
    .catch((err) => console.error(`${logPrefix} 「已删除」反馈发送失败：${err.message}`));
}

/* ------------------------- 树木排查日桶捕获（treeWatch） ------------------------- */

const POLE_RANGE_RE = /\d+\s*#?\s*[-—~－至]\s*#?\s*\d+/;
const POLE_SINGLE_RE = /\d+\s*(?:#|号)(?:塔底)?/;
const FEATURE_WORD_RE = /棵|垂距|垂直|超高|水平/;
const TREE_WORD_RE = /树|棵/;
const MEASURE_WORD_RE = /水平|垂距|垂直|超高/;
const CROSS_EXCLUDE_RE = /交叉|跨越/;
// 交跨排查（treeWatch 规则内子能力）初筛包含特征词：命中其一且含杆号即进 Dify 提取终审
const CROSS_INCLUDE_RE = /交叉|跨越|交跨/;

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

/**
 * 交跨排查初筛（treeWatch 子能力第一层，宽进严出，终审由 Dify is_crossing 完成）：
 * 命中交叉/跨越/交跨特征词且含杆号区间或单杆号；命中后还需该群配置交跨提取 Key 才真正捕获。
 */
function passesCrossingGate(text) {
  if (!CROSS_INCLUDE_RE.test(text)) return false;
  return POLE_RANGE_RE.test(text) || POLE_SINGLE_RE.test(text);
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
  // 兼容实体转义形态（&lt;refermsg&gt;，群消息 source 常见双重转义）：先反转义再匹配，最多两轮
  let text = String(raw || '');
  for (let i = 0; i < 2 && !/<refermsg[\s>]/.test(text); i += 1) {
    const unescaped = unescapeXml(text);
    if (unescaped === text) break;
    text = unescaped;
  }
  const block = text.match(/<refermsg[^>]*>([\s\S]*?)<\/refermsg>/);
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
    createtime: pick('createtime'), // 「引用记录发图片」extcommoninfo 简形仅有 svrid/signature/createtime，作记录定位兜底
  };
}

function quoteTitle(content) {
  const m = String(content || '').match(/<title>([\s\S]*?)<\/title>/);
  return m ? unescapeXml(m[1]).trim() : String(content || '').trim();
}

/**
 * refermsg 块候选源收集：一级源为已知字符串字段；兜底深扫 msg 全部字符串值
 * （限深、限长，跳过 reply_context 自身回显子树，README 已明示不可用于引用判定），
 * 兼容结构化 refermsg 对象（key 形如 refermsg/refer_msg 且值含 svrid/createtime）。
 * 返回首个带非空 svrid 的 parseReferXml 结果 | null。
 */
function findReferSource(msg, content) {
  const direct = [
    content,
    msg.content,
    msg.raw,
    msg.msg_source,
    msg.source,
    msg.go_fields && (msg.go_fields.Content || msg.go_fields.content),
    msg.GoFields && (msg.GoFields.Content || msg.GoFields.content),
  ];
  for (const item of direct) {
    if (typeof item !== 'string' || !item.trim()) continue;
    const refer = parseReferXml(item);
    if (refer && refer.svrid) return refer;
  }
  // 结构化/深扫兜底：报文字段形态未知时逐层遍历，字符串值过 parseReferXml、refermsg 形对象直接组装
  const found = { value: null };
  const walk = (node, depth) => {
    if (found.value || depth > 6 || node == null) return;
    if (typeof node === 'string') {
      if (node.length > 65536 || !/refermsg|refer_msg/i.test(node)) return;
      const refer = parseReferXml(node);
      if (refer && refer.svrid) found.value = refer;
      return;
    }
    if (typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (found.value) return;
      if (key === 'reply_context') continue;
      if (/^refer_?msg$/i.test(key) && value && typeof value === 'object') {
        const svrid = String(value.svrid || value.svr_id || value.new_msg_id || '').trim();
        if (svrid) {
          found.value = {
            svrid,
            type: String(value.type != null ? value.type : ''),
            content: String(value.content || ''),
            fromusr: String(value.fromusr || value.from_user_name || ''),
            chatusr: String(value.chatusr || value.chat_user_name || ''),
            createtime: String(value.createtime || value.create_time || ''),
          };
          return;
        }
      }
      walk(value, depth + 1);
    }
  };
  walk(msg, 0);
  return found.value;
}

/**
 * 引用消息识别：真实推送中引用消息为 kind=app 且 app.category='quote'，
 * app.reference 携带被引用消息的 svr_id/new_msg_id/content/display_name/msg_type（msg_type=3 表示被引用者是图片）。
 * 注意：reply_context 是普通消息的自身回显（svr_id 指向自己），不能用于引用判定。
 * 兜底解析 refermsg 块（appmsg type=57 XML；「引用记录发图片」的图片消息（kind=image）不带 app 结构，
 * 引用信息在图片 XML 自身 extcommoninfo 的 refermsg 简形中，仅 svrid/signature/createtime），
 * 候选源经 findReferSource 一级字段 + 深扫收集，兼容 XML 实体转义形态。
 * 返回 { svrid, content, text, msgType, createtime } | null，text 为引用者新发的内容，msgType 为被引用消息类型（可空）。
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
      createtime: String(ref.createtime || ref.create_time || ''),
    };
  }
  const refer = findReferSource(msg, content);
  if (refer && (refer.svrid || refer.content)) {
    return {
      svrid: refer.svrid,
      content: refer.content,
      text: quoteTitle(content),
      msgType: refer.type ? Number(refer.type) : null,
      createtime: refer.createtime || '',
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

// is_crossing 判定：与 isTreeHazard 同口径（显式 false/否/0 才丢弃，其余视为交跨报送）
function isCrossingReport(value) {
  return isTreeHazard(value);
}

/**
 * 进行中的提取任务：recordId -> { sessionId(日桶 id), promise }。
 * 报送先落库为 pending 记录再调 Dify；更正与汇总指令据此等待提取完成，
 * 避免「提取未返回时更正找不到记录」的竞态。
 */
const pendingCaptures = new Map();

function hasPendingCapture(recordId) {
  return pendingCaptures.has(recordId);
}

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
 * 落库成功后实时推送该条至壹匣（失败时引用报送回复「报送失败，请私聊报送班管及超管」；
 * 记录保留，pushStatus=failed 由失败重扫补推）。
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
      // 省略线路名称（line_name / line_name_raw 均为空）时按该成员最近一次记录的线路自动补全，
      // 未命中则不补（上送后壹匣按缺线路 skipped）；补全只填 line_name_raw，后续 matchLine 正常归一化
      let lineNameRaw = String(extracted.line_name || '').trim();
      let autoFilledLine = '';
      if (!lineNameRaw && !String(extracted.line_name_raw || '').trim()) {
        const recentLine = store.findRecentLineBySender(senderId);
        if (recentLine) {
          lineNameRaw = recentLine;
          autoFilledLine = recentLine;
          console.log(`[树木排查] 记录 ${record.id} 省略线路名称，按 ${senderName} 上次记录自动补全为「${recentLine}」`);
        }
      }
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
            // 多人配合：被引用图片的发送者≠记录者时记为协作供图人（发现人展示「记录者 供图者」，上限两人）
            if (cached.senderId && cached.senderId !== senderId && !record.coSenderId) {
              record.coSenderId = cached.senderId;
              record.coSenderName = await resolveDisplayName(session.groupId, cached.senderId);
            }
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
      // 回执注明线路补全，便于当场发现补错走更正；与辅证回执变体叠加（追加在其后）
      const lineNote = autoFilledLine ? `（线路按你上次记录补为：${autoFilledLine}）` : '';
      sendQuote(session.groupId, `已记录${photoNote}${lineNote}`, msg)
        .then(() => console.log(`[树木排查] 「已记录」反馈已发送（${record.id}）`))
        .catch((err) => console.error(`[树木排查] 「已记录」反馈发送失败：${err.message}`));
      // 实时推送该条至壹匣；失败引用报送回复「报送失败，请私聊报送班管及超管」（记录保留，仍由失败重扫补推）
      pushRecord(session, record)
        .then((pushResult) => {
          if (pushResult.ok) return;
          console.error(`[树木排查] 记录 ${record.id} 实时推送壹匣失败：${pushResult.message}`);
          sendQuote(session.groupId, '报送失败，请私聊报送班管及超管', msg)
            .then(() => console.log(`[树木排查] 「报送失败」反馈已发送（${record.id}）`))
            .catch((err) => console.error(`[树木排查] 「报送失败」反馈发送失败：${err.message}`));
        })
        .catch((err) => console.error(`[树木排查] 记录 ${record.id} 实时推送壹匣异常：${err.message}`));
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
 * 交跨排查捕获（treeWatch 规则内子能力）：流程仿 captureRecord 裁剪——落 pending → WF1c 提取 → is_crossing 终审 →
 * 省略线路按该成员最近一次「交跨」记录补全 + matchLine 归一 → finalize → 引用回执「已记录」→ 实时推送壹匣。
 * 与树障差异：提取用该群 crossingApiKey，无辅证照片与协作供图人，终审字段 is_crossing，推送走 crossing ingest。
 */
async function captureCrossing(rule, group, session, msg, senderId, content) {
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
    console.log(`[交跨排查] 记录落库前检测到对应撤回，已删除且不再提取：${content.slice(0, 40)}`);
    sendText(session.groupId, '已删除')
      .catch((err) => console.error(`[交跨排查] 「已删除」反馈发送失败：${err.message}`));
    return;
  }
  const task = (async () => {
    try {
      const result = await runWorkflow(group.crossingApiKey, {
        text: content,
        nickname: senderName,
        wxid: senderId,
        group: session.groupName || '',
      }, { retries: 5 });
      if (!session.records.some((item) => item.id === record.id)) {
        console.log(`[交跨排查] 记录 ${record.id} 在提取期间已被撤回删除，跳过落库与「已记录」反馈`);
        return false;
      }
      const extracted = parseWorkflowOutputs(result);
      if (!extracted) {
        console.warn(`[交跨排查] Dify 提取结果无法解析，原文：${content.slice(0, 60)}`);
        store.removeRecord(session, record.id);
        return false;
      }
      if (!isCrossingReport(extracted.is_crossing)) {
        console.log(`[交跨排查] 判定为非交跨消息，已丢弃：${content.slice(0, 60)}`);
        store.removeRecord(session, record.id);
        return false;
      }
      // 省略线路名称（line_name / line_name_raw 均为空）时按该成员最近一次交跨记录的线路自动补全，
      // 未命中则不补（上送后壹匣侧按缺线路 skipped）；补全只填 line_name_raw，后续 matchLine 正常归一化
      let lineNameRaw = String(extracted.line_name || '').trim();
      let autoFilledLine = '';
      if (!lineNameRaw && !String(extracted.line_name_raw || '').trim()) {
        const recentLine = store.findRecentLineBySender(senderId, 'crossing');
        if (recentLine) {
          lineNameRaw = recentLine;
          autoFilledLine = recentLine;
          console.log(`[交跨排查] 记录 ${record.id} 省略线路名称，按 ${senderName} 上次交跨记录自动补全为「${recentLine}」`);
        }
      }
      const match = lineNameRaw ? matchLine(lineNameRaw) : { status: 'unmatched' };
      store.finalizeRecord(record, {
        extracted,
        lineNameRaw,
        matchedLine: match.status === 'ok' ? match.line : null,
        matchStatus: match.status,
        matchCandidates: match.status === 'ambiguous' ? match.candidates : [],
      });
      store.saveSession(session);
      console.log(
        `[交跨排查] 捕获记录 ${record.id}：线路=${lineNameRaw || '-'}→${record.matchedLine ? record.matchedLine.name : '待确认'}` +
        ` 区段=${extracted.pole_from ?? ''}-${extracted.pole_to ?? ''} 跨越物=${extracted.crossing_type || '-'} 发送者=${senderName}`
      );
      // 回执注明线路补全，便于当场发现补错后引用更正
      const lineNote = autoFilledLine ? `（线路按你上次记录补为：${autoFilledLine}）` : '';
      sendQuote(session.groupId, `已记录${lineNote}`, msg)
        .then(() => console.log(`[交跨排查] 「已记录」反馈已发送（${record.id}）`))
        .catch((err) => console.error(`[交跨排查] 「已记录」反馈发送失败：${err.message}`));
      // 实时推送该条至壹匣；失败引用报送回复「报送失败，请私聊报送班管及超管」（记录保留，仍由失败重扫补推）
      pushRecord(session, record)
        .then((pushResult) => {
          if (pushResult.ok) return;
          console.error(`[交跨排查] 记录 ${record.id} 实时推送壹匣失败：${pushResult.message}`);
          sendQuote(session.groupId, '报送失败，请私聊报送班管及超管', msg)
            .then(() => console.log(`[交跨排查] 「报送失败」反馈已发送（${record.id}）`))
            .catch((err) => console.error(`[交跨排查] 「报送失败」反馈发送失败：${err.message}`));
        })
        .catch((err) => console.error(`[交跨排查] 记录 ${record.id} 实时推送壹匣异常：${err.message}`));
      return true;
    } catch (err) {
      console.error(`[交跨排查] 提取调用失败（重试 5 次后仍失败），记录已丢弃：${err.message}，原文：${content.slice(0, 60)}`);
      store.removeRecord(session, record.id);
      sendQuote(session.groupId, '记录失败', msg)
        .then(() => console.log(`[交跨排查] 「记录失败」反馈已发送（${record.id}）`))
        .catch((sendErr) => console.error(`[交跨排查] 「记录失败」反馈发送失败：${sendErr.message}`));
      return false;
    } finally {
      pendingCaptures.delete(record.id);
    }
  })();
  pendingCaptures.set(record.id, { sessionId: session.id, promise: task });
}

/**
 * 日桶内图片消息（treeWatch）：
 * - 裸发图片：缓存 CDN 下载参数备查（不下载本体、不反馈），待「引用图片发文字」时查表挂接；
 * - 引用记录发图片（图片消息自身带 refermsg 引用块）：下载并挂到被引用记录为辅证照片，
 *   反馈「已添加辅证照片」并实时重推该条——与文字更正严格分流（图片消息无更正文本，不进更正工作流）。
 */
async function handleImageMessage(rule, group, session, msg, senderId, content) {
  const entry = imageStore.cacheImage(msg, session.groupId, senderId);
  const quote = extractQuote(msg, content);
  if (!quote || !quote.svrid) {
    if (entry) console.log(`[树木排查] 缓存群图片 ${entry.svrId}（${session.groupName}，发送者=${senderId}），待引用挂接`);
    // 诊断：报文含 refer 特征却解析不出引用时 dump 原始报文，便于对齐真实字段形态
    const serialized = JSON.stringify(msg) || '';
    if (/refermsg|refer_msg|extcommoninfo/i.test(serialized)) {
      const dump = {
        kind: msg.kind,
        svr_id: msg.svr_id,
        new_msg_id: msg.new_msg_id,
        msg_id: msg.msg_id,
        content: msg.content,
        raw: msg.raw,
        msg_source: msg.msg_source,
        source: msg.source,
        go_fields: msg.go_fields,
      };
      console.warn(`[树木排查] 图片报文含引用特征但未解析出 refermsg，原始报文：${JSON.stringify(dump).slice(0, 4000)}`);
    }
    return;
  }
  // 记录定位：svrid（引用 svr_id）优先 → 引用原文兜底 → createtime 兜底
  // （extcommoninfo 简形无 content 标签，svr_id/new_msg_id 口径不一致时按被引用消息创建时间 ±2s 定位）
  let record = store.findRecordByMsgId(session, quote.svrid);
  if (!record) record = store.findRecordByContent(session, quote.content);
  if (!record && quote.createtime) {
    const quotedAt = Number(quote.createtime);
    if (Number.isFinite(quotedAt) && quotedAt > 0) {
      const candidates = session.records.filter((item) => Math.abs(Number(item.capturedAt || 0) - quotedAt) <= 2);
      record = candidates.length ? candidates[candidates.length - 1] : null;
      if (record) console.log(`[树木排查] 图片引用按 createtime 兜底定位到记录 ${record.id}（svrid=${quote.svrid} 未命中 msgId）`);
    }
  }
  if (!record) {
    console.log(`[树木排查] 图片引用的消息未命中当日记录（svrid=${quote.svrid}），仅缓存不挂接`);
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
    // 多人配合：为他人记录补挂辅证时，补图者记为协作供图人（已有协作人则不再追加）
    if (senderId && senderId !== record.senderId && !record.coSenderId) {
      record.coSenderId = senderId;
      record.coSenderName = await resolveDisplayName(session.groupId, senderId);
    }
    store.saveSession(session);
    console.log(`[树木排查] 辅证照片已挂接：记录 ${record.id}（图片 ${entry.svrId}，${got.bytes} 字节）`);
    sendQuote(session.groupId, '已添加辅证照片', msg)
      .catch((err) => console.error(`[树木排查] 「已添加辅证照片」反馈发送失败：${err.message}`));
    // 辅证新增实时重推该条（evidence_photos 随记录整组替换）；失败静默落库待重扫
    pushRecord(session, record)
      .then((pushResult) => {
        if (!pushResult.ok) console.error(`[树木排查] 记录 ${record.id} 辅证新增重推壹匣失败：${pushResult.message}`);
      })
      .catch((err) => console.error(`[树木排查] 记录 ${record.id} 辅证新增重推壹匣异常：${err.message}`));
  } catch (err) {
    console.error(`[树木排查] 辅证照片下载失败（记录 ${record.id}）：${err.message}`);
    sendQuote(session.groupId, '辅证照片下载失败', msg)
      .catch((sendErr) => console.error(`[树木排查] 「辅证照片下载失败」反馈发送失败：${sendErr.message}`));
  }
}

/**
 * 引用更正（树障/交跨共用）：记录先在同群当天两类日桶内定位（先树障桶、后交跨桶），
 * 按记录所在桶类型路由更正工作流——树障用 correctApiKey（WF2，含 status 分支），
 * 交跨用 crossingCorrectApiKey（WF2c，仅 correct/none）；交跨记录未配交跨更正 Key 时记日志忽略。
 */
async function handleCorrection(rule, group, conversationId, msg, senderId, quote) {
  const located = store.findTodayRecord(conversationId, { msgId: quote.svrid, content: quote.content });
  if (!located) {
    console.log(`[树木排查] 引用消息未命中当日记录（svrid=${quote.svrid || '-'}），忽略`);
    return;
  }
  const { session, record, kind } = located;
  const logPrefix = kind === 'crossing' ? '[交跨排查]' : '[树木排查]';
  if (record.status === 'pending') {
    const pending = pendingCaptures.get(record.id);
    if (pending) {
      console.log(`${logPrefix} 记录 ${record.id} 提取进行中，更正等待其完成…`);
      const captured = await pending.promise;
      if (!captured) {
        console.log(`${logPrefix} 目标记录提取未成功（已丢弃），更正忽略：${quote.text.slice(0, 60)}`);
        return;
      }
    }
  }
  const correctionText = quote.text;
  if (!correctionText) {
    console.log(`${logPrefix} 引用消息无更正内容，忽略`);
    return;
  }
  // 按记录所在桶类型路由更正 Key；交跨更正 Key 未配置时忽略（树障更正 Key 为必填，理论上不会缺）
  const correctKey = kind === 'crossing' ? group.crossingCorrectApiKey : group.correctApiKey;
  if (!correctKey) {
    console.log(`${logPrefix} 更正被忽略（监听群 ${group.name} 未配置${kind === 'crossing' ? '交跨更正' : '更正提取'} API Key）：${correctionText.slice(0, 60)}`);
    return;
  }
  const senderName = await resolveDisplayName(session.groupId, senderId);
  let result;
  try {
    result = await runWorkflow(correctKey, {
      correction_text: correctionText,
      quoted_text: quote.content || record.content,
      current_record: JSON.stringify(record.extracted),
      nickname: senderName,
      wxid: senderId,
    }, { retries: 5 });
  } catch (err) {
    console.error(`${logPrefix} 更正工作流调用失败（重试 5 次后仍失败）：${err.message}`);
    sendQuote(session.groupId, '更正失败', msg)
      .then(() => console.log(`${logPrefix} 「更正失败」反馈已发送（${record.id}）`))
      .catch((sendErr) => console.error(`${logPrefix} 「更正失败」反馈发送失败：${sendErr.message}`));
    return;
  }
  const outputs = parseWorkflowOutputs(result);
  if (!outputs || !outputs.action) {
    console.warn(`${logPrefix} 更正工作流返回无法解析：${JSON.stringify(result).slice(0, 200)}`);
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
    console.log(`${logPrefix} 记录 ${record.id} 已更正：${JSON.stringify(patches)}（by ${senderName}）`);
    sendQuote(session.groupId, '已更正', msg)
      .then(() => console.log(`${logPrefix} 「已更正」反馈已发送（${record.id}）`))
      .catch((err) => console.error(`${logPrefix} 「已更正」反馈发送失败：${err.message}`));
    // 更正落库后实时重推该条；失败静默落库待重扫
    pushRecord(session, record)
      .then((pushResult) => {
        if (!pushResult.ok) console.error(`${logPrefix} 记录 ${record.id} 更正后重推壹匣失败：${pushResult.message}`);
      })
      .catch((err) => console.error(`${logPrefix} 记录 ${record.id} 更正后重推壹匣异常：${err.message}`));
    return;
  }
  if (outputs.action === 'status') {
    store.markHandled(record, {
      note: String(outputs.status || correctionText),
      bySenderId: senderId,
      bySenderName: senderName,
    });
    store.saveSession(session);
    console.log(`${logPrefix} 记录 ${record.id} 标记状态：${outputs.status || correctionText}（by ${senderName}）`);
    return;
  }
  console.log(`${logPrefix} 更正工作流判定无关（action=${outputs.action}）：${correctionText.slice(0, 60)}`);
}

/* ------------------------- 报送壹匣指令（treeWatch） ------------------------- */

/**
 * 「汇总」指令：树障/交跨两类日桶各自等待进行中的提取完成后，有记录的把当天汇总 xlsx 发群
 * （两类各有记录则各发一份，无记录的那类不发）；统一回执「今日汇总表已发送」，
 * 两类都无记录回执「今日暂无记录」。未配置交跨 Key 的群不触碰交跨桶。
 */
async function handleSummaryCommand(msg, rule, group, conversationId) {
  let sentAny = false;
  for (const kind of ['tree', 'crossing']) {
    if (kind === 'crossing' && !group.crossingApiKey) continue;
    const logPrefix = kind === 'crossing' ? '[交跨排查]' : '[树木排查]';
    const bucket = store.getTodayBucket(conversationId, {
      ruleId: rule.id,
      ruleName: rule.name,
      groupName: group.name,
      teamName: rule.teamName,
      kind,
    });
    const pendingCount = [...pendingCaptures.values()].filter((item) => item.sessionId === bucket.id).length;
    if (pendingCount) console.log(`${logPrefix} 汇总指令：等待 ${pendingCount} 条进行中的提取完成…`);
    await flushSessionCaptures(bucket.id);
    const current = store.getSession(bucket.id);
    const activeCount = current.records.filter((item) => item.status === 'active').length;
    if (!activeCount) {
      console.log(`${logPrefix} 今日无记录，跳过群内发送`);
      continue;
    }
    try {
      const { fileName, bytes } = await sendSessionXlsx(current);
      sentAny = true;
      console.log(`${logPrefix} 今日汇总已发送至群：${fileName}（${bytes} 字节）`);
    } catch (err) {
      console.error(`${logPrefix} 汇总发送失败：${err.stack || err}`);
    }
  }
  if (sentAny) {
    sendQuote(conversationId, '今日汇总表已发送', msg)
      .catch((err) => console.error(`[树木排查] 「今日汇总表已发送」回执发送失败：${err.message}`));
  } else {
    console.log('[树木排查] 今日无记录，跳过群内发送');
    sendQuote(conversationId, '今日暂无记录', msg)
      .catch((err) => console.error(`[树木排查] 「今日暂无记录」回执发送失败：${err.message}`));
  }
}

/**
 * 群内 @监听账号 的「报送」指令：当天树障桶与交跨桶各自以 direct 模式整体重推壹匣
 * （兜底补推用；实时推送已逐条上送，重推幂等覆盖；push 层按桶 kind 自动选 ingest 地址）。
 * 回执合并为一条：「今日树木 N 条、交跨 M 条已重新报送壹匣」（仅一类有记录时只提一类），
 * 两类都无记录回「今日暂无记录」。回执统一用纯文本 sendText。
 */
async function handleYixiaPushCommand(conversationId, senderId, rule, group) {
  const reply = (text) => sendText(conversationId, text)
    .catch((err) => console.error(`[报送壹匣] 回执发送失败：${err.message}`));
  if (!config.yixia.baseUrl || !config.yixia.token) {
    await reply('未配置壹匣推送');
    return;
  }
  const meta = { ruleId: rule.id, ruleName: rule.name, groupName: group.name, teamName: rule.teamName };
  const results = [];
  for (const kind of ['tree', 'crossing']) {
    const records = store.listTodayRecords(conversationId, kind);
    if (!records.length) continue;
    const bucket = store.getTodayBucket(conversationId, { ...meta, kind });
    const senderName = await resolveDisplayName(conversationId, senderId);
    const result = await pushSession(bucket, 'direct', { wxid: senderId, name: senderName })
      .catch((err) => ({ ok: false, message: err.message }));
    if (!result.ok) {
      await reply(`报送失败：${result.message}`);
      return;
    }
    results.push({ kind, count: records.length });
  }
  if (!results.length) {
    await reply('今日暂无记录');
    return;
  }
  console.log(`[报送壹匣] 当天日桶整体重推成功（${results.map((item) => `${item.kind}=${item.count}`).join('，')}）`);
  const parts = results.map((item) => (item.kind === 'crossing' ? `交跨 ${item.count} 条` : `树木 ${item.count} 条`));
  await reply(`今日${parts.join('、')}已重新报送壹匣`);
}

/**
 * 输电班组运维消息入口（treeWatch）：树障/交跨双漏斗 + 群内提问。
 * 返回是否消费该消息——消费（true）= 不进入聊天日志兜底归档；未消费（false）由调用方收集。
 * 新增分支/规则时保持该约定：被本 handler 认领（含忽略类）一律返回 true。
 * @returns {Promise<boolean>}
 */
async function handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content) {
  const { wechat } = getSettings();
  const botWxid = (wechat.botWxid || '').trim();
  if (msg.direction === 'outgoing') return true;
  if (botWxid && senderId === botWxid) return true;

  if (await botMentioned(msg, content, conversationId, wechat)) {
    const commandText = stripMentions(content);
    // 「报送」指令锚定判定（全等），优先于关键词包含判定，
    // 避免备注文本里混入「汇总」等关键词被误吞
    if (commandText === '报送') {
      await handleYixiaPushCommand(conversationId, senderId, rule, group);
      return true;
    }
    // 汇总：树障/交跨两类日桶各自有记录则各发一份当天汇总 xlsx 到群
    const summaryKeywords = Array.isArray(rule.summaryKeywords) && rule.summaryKeywords.length ? rule.summaryKeywords : ['汇总'];
    if (summaryKeywords.some((k) => commandText.includes(k))) {
      await handleSummaryCommand(msg, rule, group, conversationId);
      return true;
    }
    // 群内提问：@监听账号 未命中「报送」全等与汇总关键词后按六形态提问（未启用时静默忽略）
    await handleGroupAsk({ msg, rule, group, conversationId, senderId, content, commandText, quote: extractQuote(msg, content) });
    return true;
  }

  // 全天候捕获：自动取/建当天树障日桶（北京时间自然天，跨天自动换桶），不再有「未开始」闸门。
  // 树障/交跨双漏斗分流：交跨闸（交叉|跨越|交跨 + 杆号）命中走交跨桶（需该群配交跨提取 Key），
  // 否则走树障闸；两类日桶同群并存、互不混入。
  const session = store.getTodayBucket(conversationId, {
    ruleId: rule.id,
    ruleName: rule.name,
    groupName: group.name,
    teamName: rule.teamName,
  });

  // 图片消息先行分流：裸发缓存备查；引用记录发图 → 挂辅证照片（图片无更正文本，不进更正流程）
  if (String(msg.kind) === 'image' || (msg.image && typeof msg.image === 'object')) {
    await handleImageMessage(rule, group, session, msg, senderId, content);
    return true;
  }

  const quote = extractQuote(msg, content);
  if (quote) {
    // 先在当天树障/交跨两类日桶内定位记录（先树障后交跨）：命中 → 更正流程（按桶 kind 路由更正 Key）；
    // 未命中 → 按「引用图片发文字」走捕获，交跨闸优先（命中则不挂辅证），否则树障带辅证
    const located = store.findTodayRecord(conversationId, { msgId: quote.svrid, content: quote.content });
    const imageHit = quote.svrid ? imageStore.getImage(quote.svrid) : null;
    const quotingImage = !located && (Number(quote.msgType) === 3 || !!imageHit);
    if (quotingImage) {
      if (!quote.text) {
        console.log(`[树木排查] 引用图片但未附文字（svrid=${quote.svrid}），忽略`);
        return true;
      }
      if (passesCrossingGate(quote.text)) {
        if (!group.crossingApiKey) {
          console.log(`[交跨排查] 引用图片的交跨报送未被捕获（监听群 ${group.name} 未配置交跨提取 API Key）：${quote.text.slice(0, 60)}`);
          return true;
        }
        const crossingSession = store.getTodayBucket(conversationId, {
          ruleId: rule.id,
          ruleName: rule.name,
          groupName: group.name,
          teamName: rule.teamName,
          kind: 'crossing',
        });
        await captureCrossing(rule, group, crossingSession, msg, senderId, quote.text);
        return true;
      }
      if (!passesCaptureGate(quote.text)) {
        console.log(`[树木排查] 引用图片的文字未过初筛，忽略：${quote.text.slice(0, 60)}`);
        return true;
      }
      await captureRecord(rule, group, session, msg, senderId, quote.text, quote.svrid);
      return true;
    }
    await handleCorrection(rule, group, conversationId, msg, senderId, quote);
    return true;
  }

  // 文件/视频/语音等媒体消息：解析下载参数缓存备查（群内提问引用时用），不进捕获。
  // 文档类文件（kind=file，不限扩展名）即使参数被缓存备查也算未消费——进聊天归档清单（白名单
  // 分流/unsupported 标记在 chatlog 登记时完成），返回 false；视频/语音等媒体备查算消费。
  if (msg.kind && !['text', 'quote', 'app'].includes(String(msg.kind))) {
    const mediaEntry = fileStore.cacheMedia(msg, conversationId, senderId);
    if (mediaEntry && mediaEntry.kind === 'file') {
      collectDocumentAsync(conversationId, group, mediaEntry, msg, senderId);
      return false;
    }
    return true;
  }
  if (!content || content.trim().startsWith('<')) {
    // app 形态的文件/视频/语音消息内容为 XML：仍尝试解析缓存下载参数备查（群内提问引用时用）
    if (content && content.trim().startsWith('<')) {
      const mediaEntry = fileStore.cacheMedia(msg, conversationId, senderId);
      if (mediaEntry && mediaEntry.kind === 'file') {
        collectDocumentAsync(conversationId, group, mediaEntry, msg, senderId);
        return false;
      }
    }
    return true;
  }
  // 双漏斗：交跨闸优先（命中即交跨捕获；未配交跨 Key 记日志忽略，算消费、不进兜底）
  if (passesCrossingGate(content)) {
    if (!group.crossingApiKey) {
      console.log(`[交跨排查] 交跨报送未被捕获（监听群 ${group.name} 未配置交跨提取 API Key）：${content.slice(0, 60)}`);
      return true;
    }
    const crossingSession = store.getTodayBucket(conversationId, {
      ruleId: rule.id,
      ruleName: rule.name,
      groupName: group.name,
      teamName: rule.teamName,
      kind: 'crossing',
    });
    await captureCrossing(rule, group, crossingSession, msg, senderId, content.trim());
    return true;
  }
  if (!passesCaptureGate(content)) return false;
  await captureRecord(rule, group, session, msg, senderId, content.trim());
  return true;
}

/** 文档类文件进聊天归档清单（发送者显示名异步解析后登记，失败仅记日志） */
function collectDocumentAsync(conversationId, group, mediaEntry, msg, senderId) {
  resolveDisplayName(conversationId, senderId)
    .then((senderName) => chatlog.collectDocument(conversationId, group.name, mediaEntry, msg, senderId, senderName))
    .catch((err) => console.error(`[聊天归档] 文档登记失败（${group.name}）：${err.message}`));
}

/** 该群是否绑定了启用中的 treeWatch 规则，是则返回首个匹配的群配置（聊天归档的收集范围） */
function boundTreeWatchGroup(rules, conversationId) {
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger !== 'treeWatch') continue;
    const group = (rule.groups || []).find((item) => item.groupId === conversationId);
    if (group) return group;
  }
  return null;
}

/**
 * 规则分发：返回该消息是否被任一规则消费（消费 = 不进入聊天日志兜底归档）。
 * 同一消息在多个规则间的消费状态取并集；处理异常视为已消费，避免异常消息进归档。
 * 新增规则的 handler 需返回消费布尔（未消费消息才会进兜底归档），在此汇总。
 */
async function dispatchRules(msg, conversationId, senderId, content) {
  const { rules } = getSettings();
  let consumed = false;
  const tasks = [];
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const group = (rule.groups || []).find((item) => item.groupId === conversationId && item.apiKey);
    if (!group) continue;
    if (rule.trigger === 'location' && rule.action === 'dify') {
      if (msg.kind !== 'location' || !msg.location) continue;
      consumed = true; // 位置消息由位置规则消费
      handleLocationTrigger(msg, conversationId, group.apiKey, rule.name)
        .catch((err) => console.error(`[触发] 规则“${rule.name}”处理失败：${err.stack || err}`));
    } else if (rule.trigger === 'treeWatch' && rule.action === 'dify') {
      if (isRecallEvent(msg)) {
        handleRecall(msg, group, conversationId)
          .catch((err) => console.error(`[树木排查] 规则“${rule.name}”撤回处理失败：${err.stack || err}`));
        consumed = true;
        continue;
      }
      tasks.push(
        handleTreeWatchMessage(msg, rule, group, conversationId, senderId, content)
          .then((hit) => { if (hit) consumed = true; })
          .catch((err) => {
            consumed = true;
            console.error(`[树木排查] 规则“${rule.name}”处理失败：${err.stack || err}`);
          }),
      );
    }
  }
  await Promise.all(tasks);
  return consumed;
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
  const treeGroup = boundTreeWatchGroup(getSettings().rules, conversationId);
  dispatchRules(msg, conversationId, senderId, content)
    .then(async (consumed) => {
      // 兜底归档：绑定启用 treeWatch 规则的群里，未被任何规则消费且非监听账号自身的消息
      if (consumed || !treeGroup) return;
      // 引用消息的可见文字在 app.title（content 为空时兜底）；XML 形态内容跳过
      const text = (typeof content === 'string' && content.trim())
        ? content.trim()
        : String((msg.app && msg.app.title) || '').trim();
      if (!text || text.startsWith('<')) return;
      const senderName = await resolveDisplayName(conversationId, senderId);
      chatlog.collectMessage({ conversationId, groupName: treeGroup.name, msg, senderId, senderName, content: text });
    })
    .catch((err) => console.error(`[聊天归档] 兜底收集异常：${err.stack || err}`));
}

module.exports = { handleMessage, hasPendingCapture, extractQuote };
