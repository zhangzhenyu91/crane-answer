/**
 * 聊天日志兜底归档（treeWatch 规则内子能力）：收集绑定群内**未被任何规则消费**的消息，
 * 每天定时由 WF4（Dify）总结成当日纪要，连同未消费的文档类文件推送壹匣
 * `POST /api/v1/chatlog/ingest` 写入 WeKnora 知识库（壹匣侧落 `/{yyyy}/{M.d}/` 文件夹，同名先删后传）。
 *
 * 收集口径（消费 = 不进兜底）：@监听账号的一切消息、捕获/更正/撤回处理的消息、
 * 图片/视频/语音消息、监听账号自身消息、系统/撤回事件、私聊、非绑定群；
 * 文档类文件消息即使被 fileStore 缓存了下载参数（供群内提问引用）也照样进归档清单。
 *
 * 存储：data/chatlog-sessions.json（顶层版本号 + days 数组），临时文件 + rename 原子写。
 * 失败口径：整组失败 attempts+1 保留（次日启动补跑存量），attempts ≥3 丢弃并 error 日志；
 * 单个文档下载参数缺失或超 30MB 只跳过该文档（记日志），不阻断整批。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSettings } = require('../settings');
const { beijingToday } = require('./store');
const fileStore = require('../wechatpadpro/fileStore');
const { runWorkflow } = require('../dify');
const { postIngestWithRetry } = require('./push');

const DIGEST_MAX_MESSAGES = 400; // WF4 输入消息条数上限
const DIGEST_MAX_CHARS = 20000; // WF4 输入总字符上限
const DOC_MAX_BYTES = 30 * 1024 * 1024; // 单文档归档上限（契约 ≤30MB）

let state = null;

function storeFile() {
  return path.join(config.dataDir, 'chatlog-sessions.json');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function getState() {
  if (state) return state;
  const file = storeFile();
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { version: 1, days: Array.isArray(loaded.days) ? loaded.days : [] };
    } catch {
      state = { version: 1, days: [] };
    }
  } else {
    state = { version: 1, days: [] };
  }
  return state;
}

function ensureDay(date) {
  const current = getState();
  let day = current.days.find((item) => item.date === date);
  if (!day) {
    day = { date, groups: {} };
    current.days.push(day);
  }
  return day;
}

function ensureGroup(day, groupId, groupName) {
  if (!day.groups[groupId]) {
    day.groups[groupId] = {
      groupName: groupName || groupId,
      messages: [],
      documents: [],
      status: 'pending',
      attempts: 0,
    };
  }
  return day.groups[groupId];
}

/**
 * 登记一条未被消费的文本消息（XML 形态内容、媒体/系统消息、监听账号自身消息不进兜底）。
 */
function collectMessage({ conversationId, groupName, msg, senderId, senderName, content }) {
  const { wechat } = getSettings();
  const botWxid = (wechat.botWxid || '').trim();
  if (msg.direction === 'outgoing') return;
  if (botWxid && senderId === botWxid) return;
  if (String(msg.kind || 'text') !== 'text') return;
  const text = String(content || '').trim();
  if (!text || text.startsWith('<')) return;
  const day = ensureDay(beijingToday());
  const entry = ensureGroup(day, conversationId, groupName);
  entry.messages.push({
    time: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    senderId: senderId || '',
    senderName: senderName || senderId || '',
    content: text,
  });
  persist();
}

/**
 * 登记一条未被消费的文档类文件消息（fileStore 参数缓存不算业务消费，照样归档）。
 * 同一天同群按消息 svr_id 去重——同群多规则分流时只登记一次。
 */
function collectDocument(conversationId, groupName, mediaEntry, msg, senderId, senderName) {
  const day = ensureDay(beijingToday());
  const entry = ensureGroup(day, conversationId, groupName);
  const ref = String((mediaEntry && mediaEntry.svrId) || '');
  if (ref && entry.documents.some((item) => item.ref === ref)) return;
  entry.documents.push({
    time: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    senderId: senderId || '',
    senderName: senderName || senderId || '',
    name: String((mediaEntry && mediaEntry.fileName) || '未命名文件'),
    ref,
  });
  persist();
}

/** Unix 秒 → 北京时间 HH:mm（WF4 输入行的时刻前缀） */
function formatHHmm(unixSeconds) {
  const d = new Date((Number(unixSeconds) + 8 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

/**
 * 拼装 WF4 输入文本：每行「HH:mm 昵称：内容」，最多 400 条、总字符 ≤20000，
 * 截断时末尾补一行「（其余 N 条从略）」。
 */
function buildDigestInput(messages) {
  const lines = [];
  let used = 0;
  let total = 0;
  for (const message of messages) {
    if (used >= DIGEST_MAX_MESSAGES) break;
    const line = `${formatHHmm(message.time)} ${message.senderName || message.senderId}：${String(message.content).replace(/\s+/g, ' ').trim()}`;
    if (used > 0 && total + line.length > DIGEST_MAX_CHARS) break;
    lines.push(line);
    used += 1;
    total += line.length + 1;
  }
  if (used < messages.length) lines.push(`（其余 ${messages.length - used} 条从略）`);
  return lines.join('\n');
}

/** WF4 输出解析：outputs.summary，兼容 result 包裹 JSON 或直接字符串 */
function extractSummary(result) {
  const outputs = (result && result.data && result.data.outputs) || {};
  if (typeof outputs.summary === 'string' && outputs.summary.trim()) return outputs.summary.trim();
  if (outputs.result && typeof outputs.result === 'object' && typeof outputs.result.summary === 'string') {
    return outputs.result.summary.trim();
  }
  if (typeof outputs.result === 'string' && outputs.result.trim()) {
    try {
      const parsed = JSON.parse(outputs.result);
      if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) return parsed.summary.trim();
    } catch {
      // 非 JSON 时按原文本兜底
    }
    return outputs.result.trim();
  }
  throw new Error('WF4 未返回 summary');
}

/** 推送一条聊天归档（kind=digest / file），复用 push 层超时重试口径；业务 ok:false 视为失败 */
async function postChatlogIngest(body) {
  if (!config.yixia.baseUrl || !config.yixia.token) throw new Error('未配置壹匣推送');
  const data = await postIngestWithRetry(
    `${config.yixia.baseUrl}/api/v1/chatlog/ingest`,
    body,
    { logPrefix: '[聊天归档]' },
  );
  if (data && data.ok === false) throw new Error(`壹匣返回失败：${data.code || '-'} ${data.message || ''}`);
  return data;
}

/**
 * 归档某群某天：WF4 总结 → digest 先行 → 逐个文档取二进制推送。
 * 单个文档下载参数缺失或超 30MB 跳过（记日志不阻断）；其余失败抛错交调用方计 attempts。
 */
async function archiveGroupDay(day, groupId, entry, rule) {
  const date = day.date;
  const groupName = entry.groupName || groupId;
  const digestInput = buildDigestInput(entry.messages);
  const result = await runWorkflow(rule.digestApiKey, { date, group: groupName, messages: digestInput });
  const summary = extractSummary(result);
  const docList = entry.documents.map((doc) => doc.name).join('、') || '无';
  const digestMd = [
    `# ${groupName} ${date} 聊天纪要`,
    '',
    summary,
    '',
    '---',
    '',
    `原始消息 ${entry.messages.length} 条 / 归档文档 ${entry.documents.length} 个：${docList}`,
    '',
  ].join('\n');
  // 纪要先行（壹匣侧同名先删后传，重跑幂等）
  await postChatlogIngest({ date, group_name: groupName, kind: 'digest', digest_md: digestMd });
  console.log(`[聊天归档] ${groupName} ${date} 纪要已推送知识库（原始消息 ${entry.messages.length} 条）`);
  for (const doc of entry.documents) {
    try {
      const media = doc.ref ? fileStore.getMedia(doc.ref) : null;
      if (!media || media.kind !== 'file') {
        console.warn(`[聊天归档] 文档下载参数缺失，跳过归档（${doc.name}，ref=${doc.ref || '-'}）`);
        continue;
      }
      const buffer = await fileStore.downloadFileBuffer({
        appId: media.appId,
        attachId: media.attachId,
        dataLen: media.dataLen,
        fileName: media.fileName,
        userName: media.fromUserName,
      });
      if (buffer.length > DOC_MAX_BYTES) {
        console.warn(`[聊天归档] 文档超过 30MB 上限，跳过归档：${doc.name}（${buffer.length} 字节）`);
        continue;
      }
      await postChatlogIngest({
        date,
        group_name: groupName,
        kind: 'file',
        file: { name: doc.name, data_base64: buffer.toString('base64') },
      });
      console.log(`[聊天归档] 文档已推送知识库：${doc.name}（${buffer.length} 字节）`);
    } catch (err) {
      if (err && err.code === 'file_too_large') {
        console.warn(`[聊天归档] 文档超过下载上限，跳过归档：${doc.name}（${err.message}）`);
        continue;
      }
      throw new Error(`文档归档失败（${doc.name}）：${err.message}`);
    }
  }
}

/** 第一个覆盖该群且配了 digestApiKey 的启用 treeWatch 规则（多规则同群去重取首个） */
function findDigestRule(groupId) {
  const { rules } = getSettings();
  for (const rule of rules) {
    if (!rule.enabled || rule.trigger !== 'treeWatch' || !rule.digestApiKey) continue;
    if ((rule.groups || []).some((group) => group.groupId === groupId)) return rule;
  }
  return null;
}

/**
 * 定时归档：处理所有存档天数（当天到点执行 + 此前存量补跑）。
 * 全空群跳过；成功清理该群当天数据；失败 attempts+1 保留待下次，≥3 丢弃并 error 日志。
 * 未配 digestApiKey 的群：当天数据保留，过期天丢弃（无归档消费者，避免无限累积）。
 */
async function runDailyDigests(onlyBeforeToday = false) {
  const today = beijingToday();
  const current = getState();
  for (const day of [...current.days]) {
    if (onlyBeforeToday && day.date >= today) continue;
    for (const groupId of Object.keys(day.groups)) {
      const entry = day.groups[groupId];
      const rule = findDigestRule(groupId);
      if (!rule) {
        if (day.date !== today) {
          console.log(`[聊天归档] ${day.date} ${entry.groupName || groupId} 未配置聊天总结 Key，过期数据已丢弃（消息 ${entry.messages.length} 条 / 文档 ${entry.documents.length} 个）`);
          delete day.groups[groupId];
          persist();
        }
        continue;
      }
      if (!entry.messages.length && !entry.documents.length) {
        delete day.groups[groupId];
        persist();
        continue;
      }
      try {
        await archiveGroupDay(day, groupId, entry, rule);
        delete day.groups[groupId];
        persist();
      } catch (err) {
        entry.attempts = (Number(entry.attempts) || 0) + 1;
        entry.status = 'failed';
        entry.lastError = String(err.message || err);
        persist();
        if (entry.attempts >= 3) {
          console.error(`[聊天归档] ${day.date} ${entry.groupName || groupId} 归档连续失败 ${entry.attempts} 次，丢弃当天数据：${entry.lastError}`);
          delete day.groups[groupId];
          persist();
        } else {
          console.error(`[聊天归档] ${day.date} ${entry.groupName || groupId} 归档失败（第 ${entry.attempts} 次），保留待补跑：${entry.lastError}`);
        }
      }
    }
    if (!Object.keys(day.groups).length) {
      current.days = current.days.filter((item) => item !== day);
      persist();
    }
  }
}

/** 启动补跑：只处理今天之前存量的归档（今天的留给定时到点执行，避免过早归档半成品） */
async function runStaleDigests() {
  const today = beijingToday();
  const hasStale = getState().days.some((day) => day.date < today && Object.keys(day.groups).length);
  if (!hasStale) return;
  console.log('[聊天归档] 检测到历史存量，启动补跑');
  await runDailyDigests(true);
}

module.exports = {
  collectMessage,
  collectDocument,
  buildDigestInput,
  runDailyDigests,
  runStaleDigests,
};
