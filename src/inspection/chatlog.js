/**
 * 聊天日志兜底归档（treeWatch 规则内子能力）：收集绑定群内**未被任何规则消费**且非监听账号
 * 自身发送的消息，每天定时由 WF4（Dify）总结成当日纪要，连同文档类文件推送壹匣
 * `POST /api/v1/chatlog/ingest` 写入 WeKnora 知识库（壹匣侧落 `/{yyyy}/{M.d}/` 文件夹，同名先删后传）。
 *
 * 收集口径（消费 = 不进兜底，消费判定见 messageHandler.dispatchRules）：@监听账号的一切消息
 * （指令/提问，未启用提问也静默算消费）、树障/交跨捕获、更正、撤回处理、图片/视频/语音媒体
 * 备查；「交跨闸命中但未配交跨 Key 被忽略」也算消费（记日志不进兜底）；文档类文件消息即使被
 * fileStore 缓存下载参数（供群内提问引用）也算未消费，照样登记留痕，白名单外类型打
 * unsupported 标记（仅纪要尾部「未归档」组留痕，不上传）；监听账号自身发送内容（含已记录/
 * 已更正回执与 Call Me 回答 md）天然排除；系统消息/撤回事件不入网，私聊、非绑定群不收集。
 * 扩展约定：新增规则 handler 需返回消费布尔，未消费消息才会进兜底归档。
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

// WeKnora 可入库的文档扩展名白名单（小写不含点，与壹匣 callme 的 ATTACHMENT_EXTS 对齐）；
// zip/rar/7z/dwg/ofd/音视频/图片/无扩展名不入库——消息仍留痕（纪要尾部「未归档」组 + unsupported 标记），只是不上传
const SUPPORTED_DOC_EXTS = ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xlsx', 'xls', 'epub', 'mhtml', 'csv', 'md', 'markdown', 'txt', 'json', 'html'];
const SUPPORTED_DOC_RE = new RegExp(`\\.(${SUPPORTED_DOC_EXTS.join('|')})$`, 'i');

/** 文档名是否在可入库白名单内 */
function isSupportedDocName(name) {
  return SUPPORTED_DOC_RE.test(String(name || '').trim());
}

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
 * 登记一条未被消费的群文本消息（XML 形态内容、媒体类消息、监听账号自身消息不登记）。
 * 引用消息由调用方把可见文字（app.title）传入 content。
 */
function collectMessage({ conversationId, groupName, msg, senderId, senderName, content }) {
  const { wechat } = getSettings();
  const botWxid = (wechat.botWxid || '').trim();
  if (msg.direction === 'outgoing') return;
  if (botWxid && senderId === botWxid) return;
  const kind = String(msg.kind || 'text');
  if (!['text', 'quote', 'app'].includes(kind)) return; // 图片/语音/视频/文件等媒体类不在这里登记（文件走 collectDocument）
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
 * 登记一条未被消费的群文档类文件消息（fileStore 参数缓存不算消费，照样登记留痕；
 * 白名单外类型打 unsupported 标记，仅纪要尾部「未归档」组留痕不上传）。
 * 白名单外类型记 unsupported 标记：不进上传清单，仅在纪要尾部「未归档」组留痕，防反复重推。
 * 同一天同群按消息 svr_id 去重——同群多规则分流时只登记一次。
 */
function collectDocument(conversationId, groupName, mediaEntry, msg, senderId, senderName) {
  const day = ensureDay(beijingToday());
  const entry = ensureGroup(day, conversationId, groupName);
  const ref = String((mediaEntry && mediaEntry.svrId) || '');
  if (ref && entry.documents.some((item) => item.ref === ref)) return;
  const name = String((mediaEntry && mediaEntry.fileName) || '未命名文件');
  entry.documents.push({
    time: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    senderId: senderId || '',
    senderName: senderName || senderId || '',
    name,
    ref,
    unsupported: !isSupportedDocName(name),
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

/** 推送一条聊天归档（kind=digest / file），复用 push 层超时重试口径；业务 ok:false 视为失败（unsupported_file 打标记） */
async function postChatlogIngest(body) {
  if (!config.yixia.baseUrl || !config.yixia.token) throw new Error('未配置壹匣推送');
  const data = await postIngestWithRetry(
    `${config.yixia.baseUrl}/api/v1/chatlog/ingest`,
    body,
    { logPrefix: '[聊天归档]' },
  );
  if (data && data.ok === false) {
    const err = new Error(`壹匣返回失败：${data.code || '-'} ${data.message || ''}`);
    if (data.code === 'unsupported_file') err.unsupportedFile = true;
    throw err;
  }
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
  const archivedDocs = entry.documents.filter((doc) => !doc.unsupported);
  const skippedDocs = entry.documents.filter((doc) => doc.unsupported);
  const docTail = `原始消息 ${entry.messages.length} 条 / 归档文档 ${archivedDocs.length} 个：${archivedDocs.map((doc) => doc.name).join('、') || '无'}`
    + (skippedDocs.length
      ? ` / 未归档文档 ${skippedDocs.length} 个（类型不支持入库）：${skippedDocs.map((doc) => doc.name).join('、')}`
      : '');
  const digestMd = [
    `# ${groupName} ${date} 聊天纪要`,
    '',
    summary,
    '',
    '---',
    '',
    docTail,
    '',
  ].join('\n');
  // 纪要先行（壹匣侧同名先删后传，重跑幂等）
  await postChatlogIngest({ date, group_name: groupName, kind: 'digest', digest_md: digestMd });
  console.log(`[聊天归档] ${groupName} ${date} 纪要已推送知识库（原始消息 ${entry.messages.length} 条）`);
  for (const doc of entry.documents) {
    if (doc.unsupported) continue; // 类型不支持入库（或已被壹匣 unsupported_file 拒收标记）：终态，不再重推
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
      if (err && err.unsupportedFile) {
        // 壹匣以 unsupported_file 拒收：该文件视为终态，移入「未归档」记录（落盘标记防反复重推），整批不算失败
        doc.unsupported = true;
        persist();
        console.warn(`[聊天归档] 文档被壹匣拒收（unsupported_file），移入未归档记录：${doc.name}`);
        continue;
      }
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
  isSupportedDocName,
  runDailyDigests,
  runStaleDigests,
};
