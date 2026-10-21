/**
 * 群内提问（treeWatch 规则「群内提问」区块）。
 *
 * 群成员 @监听账号 且未命中「报送」全等与汇总关键词时，以该成员 wxid 对应的壹匣账号身份
 * 调壹匣 Call Me（POST {yixia.baseUrl}/api/v1/callme/ingest-chat，契约见 README《群内提问》），
 * 回答经 Dify WF3 命名后写成 md 文件发回群；未启用（开关关闭或文件名生成 Key 未配置）静默忽略。
 *
 * 提问六形态：纯文字 / 引用文字 / 引用图片 / 引用文件 / 引用视频 / 引用语音。
 * 媒体下载参数由 fileStore 在消息到达时缓存，或从被引用消息 XML 直接解析（字段形态待真机首验对齐）。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { runWorkflow } = require('../dify');
const { postIngestWithRetry } = require('../inspection/push');
const { resolveDisplayName } = require('../wechatpadpro/memberResolver');
const imageStore = require('../wechatpadpro/imageStore');
const fileStore = require('../wechatpadpro/fileStore');
const { sendQuote, sendFile } = require('../wechatpadpro/sender');

const ASK_TIMEOUT_MS = 320000; // Call Me 含模型思考，单次超时 320s；非幂等，不重试
const ANSWER_NAME_INPUT_LEN = 4000; // WF3 的 answer 输入截取长度
const ANSWER_FALLBACK_LEN = 500; // 文本兜底的回答截取长度
const FILENAME_MAX = 40;

/** 提问启用条件：规则开启群内提问且配置文件名生成工作流 Key */
function isAskEnabled(rule) {
  return Boolean(rule.ask && rule.ask.enabled && String(rule.ask.nameApiKey || '').trim());
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateTime(unixSeconds) {
  const d = unixSeconds ? new Date(unixSeconds * 1000) : new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatStamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}

/** 文件名净化：去 \/:*?"<>| 与换行，截 40 字 */
function sanitizeFileName(name) {
  return String(name == null ? '' : name)
    .replace(/[\\/:*?"<>|\r\n]+/g, '')
    .trim()
    .slice(0, FILENAME_MAX);
}

/** Dify 输出解析（与 messageHandler.parseWorkflowOutputs 同思路：兼容 result 为 JSON 字符串/对象） */
function parseOutputs(result) {
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

/** 壹匣失败响应 → 群内回执文案 */
function mapErrorReply(result) {
  if (!result || typeof result !== 'object') return '';
  const code = String(result.code || '');
  const message = String(result.message || '');
  if (code === 'user_not_found') return '你的微信尚未绑定壹匣账号，请联系超管录入';
  if (code === 'no_permission') return '你暂无 Call Me 使用权限';
  if (code === 'model_not_found') {
    const names = (Array.isArray(result.models) ? result.models : [])
      .map((item) => String((item && item.name) || '').trim())
      .filter(Boolean);
    return `未添加该模型，当前可调用模型：\n${names.join('\n')}`;
  }
  if (code === 'unsupported_file') return '该文件类型暂不支持';
  if (code === 'file_too_large') return '文件超过 50MB 上限';
  return message ? `提问失败：${message}` : '';
}

function reply(conversationId, msg, text) {
  return sendQuote(conversationId, text, msg)
    .catch((err) => console.error(`[群内提问] 回执发送失败：${err.message}`));
}

function quoteXmlSources(quote, content) {
  return [quote && quote.content, content].filter((v) => typeof v === 'string' && v.trim()).join('\n');
}

/** 引用消息被引用内容形态：text / image / file / video / voice / other */
function detectQuoteKind(quote, content) {
  const msgType = quote && quote.msgType != null ? Number(quote.msgType) : null;
  if (msgType === 3 || (quote && quote.svrid && imageStore.getImage(quote.svrid))) return 'image';
  const xml = quoteXmlSources(quote, content);
  if (msgType === 6
    || /<appattach[\s>]/.test(xml)
    || /<appmsg[^>]*type="6"/.test(xml)
    || /<appmsg[^>]*>[\s\S]*?<type>\s*6\s*<\/type>/.test(xml)) return 'file';
  if (msgType === 43 || /<videomsg[\s>]/.test(xml)) return 'video';
  if (msgType === 34 || /<voicemsg[\s>]/.test(xml)) return 'voice';
  if (msgType == null || msgType === 1) return 'text';
  return 'other';
}

/**
 * 按六形态装配提问载荷。
 * @returns {Promise<{query, image?, file?}|{error: string}|null>} null=空提问静默忽略
 */
async function buildAskPayload({ quote, content, commandText, conversationId, senderId }) {
  const cmd = String(commandText || '').trim();
  if (!quote) {
    return cmd ? { query: cmd } : null;
  }
  const kind = detectQuoteKind(quote, content);
  const xml = quoteXmlSources(quote, content);
  const cached = quote.svrid ? fileStore.getMedia(quote.svrid) : null;

  if (kind === 'text') {
    // 引用文字：新提问 + 被引用正文（未附文字则只用被引用正文）
    const quotedText = String(quote.content || '').trim() || String(quote.text || '').trim();
    const query = cmd ? `${cmd}\n\n${quotedText}`.trim() : quotedText;
    return query ? { query } : null;
  }

  if (kind === 'image') {
    const entry = imageStore.getImage(quote.svrid);
    if (!entry) return { error: '图片已过期，请重新发送后引用' };
    const got = await imageStore.downloadImage(quote.svrid);
    const bytes = fs.readFileSync(path.join(config.dataDir, got.file));
    const mime = String(got.file).endsWith('.png') ? 'image/png' : 'image/jpeg';
    return {
      query: cmd || '请回答图片中的问题',
      image: `data:${mime};base64,${bytes.toString('base64')}`,
    };
  }

  if (kind === 'file') {
    const parsed = fileStore.parseMediaFromXml(xml) || {};
    const title = parsed.fileName || (cached && cached.fileName) || '';
    const attachId = parsed.attachId || (cached && cached.attachId) || '';
    const dataLen = Number(parsed.dataLen) || Number(cached && cached.dataLen) || 0;
    const appId = parsed.appId || (cached && cached.appId) || '';
    if (!title || !attachId || !dataLen) return { error: '文件信息解析失败，请重新发送文件后引用' };
    const buf = await fileStore.downloadFileBuffer({
      appId,
      attachId,
      dataLen,
      fileName: title,
      userName: (cached && cached.fromUserName) || senderId,
    });
    return {
      query: cmd || '请分析这个文件',
      file: { name: sanitizeFileName(title) || '文件', data_base64: buf.toString('base64') },
    };
  }

  if (kind === 'video') {
    const parsed = fileStore.parseMediaFromXml(xml) || {};
    const msgId = parsed.msgId || (cached && cached.msgId) || parsed.newMsgId || (cached && cached.newMsgId) || quote.svrid;
    const dataLen = Number(parsed.dataLen) || Number(cached && cached.dataLen) || 0;
    if (!msgId || !dataLen) return { error: '文件信息解析失败，请重新发送文件后引用' };
    const buf = await fileStore.downloadVideoBuffer({ msgId, dataLen });
    return {
      query: cmd || '请分析这段视频',
      file: { name: `视频-${formatStamp()}.mp4`, data_base64: buf.toString('base64') },
    };
  }

  if (kind === 'voice') {
    const parsed = fileStore.parseMediaFromXml(xml) || {};
    const voice = {
      groupId: conversationId,
      clientMsgId: parsed.msgId || (cached && cached.msgId) || '',
      fromUserName: parsed.fromUserName || (cached && cached.fromUserName) || senderId,
      length: Number(parsed.length) || Number(cached && cached.length) || 0,
      masterBufId: parsed.masterBufId || (cached && cached.masterBufId) || '',
      msgId: parsed.msgId || (cached && cached.msgId) || '',
      newMsgId: parsed.newMsgId || (cached && cached.newMsgId) || quote.svrid,
    };
    if (!(voice.msgId || voice.newMsgId) || !voice.masterBufId || !voice.length) {
      return { error: '语音解析失败，请改用文字提问' };
    }
    let out;
    try {
      out = await fileStore.convertVoice(await fileStore.downloadVoiceBuffer(voice));
    } catch (err) {
      console.error(`[群内提问] 语音解析失败：${err.message}`);
      return { error: '语音解析失败，请改用文字提问' };
    }
    return {
      query: cmd ? `${cmd}\n请回答语音中的问题` : '请回答语音中的问题',
      file: { name: `语音-${formatStamp()}.${out.ext}`, data_base64: out.buffer.toString('base64') },
    };
  }

  return { error: '暂支持文字、图片、文件、视频、语音提问' };
}

/**
 * 群内提问主流程：六形态装配 → 受理回执 → 调壹匣 Call Me → WF3 命名 → md 文件发回群。
 * 不抛错，所有失败回执到群（发送失败仅记日志）。
 */
async function handleGroupAsk({ msg, rule, group, conversationId, senderId, content, commandText, quote }) {
  if (!isAskEnabled(rule)) return; // 未启用（开关关闭或 Key 未配置）静默忽略
  if (!config.yixia.baseUrl || !config.yixia.token) {
    await reply(conversationId, msg, '未配置壹匣对接');
    return;
  }
  let payload;
  try {
    payload = await buildAskPayload({ quote, content, commandText, conversationId, senderId });
  } catch (err) {
    console.error(`[群内提问] 提问媒体准备失败（${group && group.name ? group.name : conversationId}）：${err.message}`);
    await reply(conversationId, msg, err && err.code === 'file_too_large' ? '文件超过 50MB 上限' : `提问失败：${err.message}`);
    return;
  }
  if (!payload) return; // 空提问静默忽略
  if (payload.error) {
    await reply(conversationId, msg, payload.error);
    return;
  }

  // 受理回执（失败仅记日志，不打断提问）
  sendQuote(conversationId, '正在思考，请稍候', msg)
    .catch((err) => console.error(`[群内提问] 「正在思考」回执发送失败：${err.message}`));

  const body = {
    wxid: senderId,
    query: payload.query,
    session_title: `${String(rule.teamName || '').trim()}群内提问`,
    web_search: true,
  };
  if (payload.image) body.image = payload.image;
  if (payload.file) body.file = payload.file;

  let result;
  try {
    // 非幂等（可能扣费/重复回答），retries=0 不重试
    result = await postIngestWithRetry(`${config.yixia.baseUrl}/api/v1/callme/ingest-chat`, body, {
      timeoutMs: ASK_TIMEOUT_MS,
      retries: 0,
      logPrefix: '[群内提问]',
    });
  } catch (err) {
    console.error(`[群内提问] 调壹匣 Call Me 失败：${err.message}`);
    await reply(conversationId, msg, mapErrorReply(err.body) || `提问失败：${err.message}`);
    return;
  }
  if (!result || result.ok !== true) {
    await reply(conversationId, msg, mapErrorReply(result) || '提问失败：壹匣返回异常');
    return;
  }
  const answer = String((result.data && result.data.answer) || '');
  if (!answer) {
    await reply(conversationId, msg, '提问失败：壹匣未返回回答');
    return;
  }

  // WF3 文件名生成；失败/空名用「群内问答-时间戳」兜底，仍把 md 发回群
  let filename = '';
  try {
    const wf = await runWorkflow(String(rule.ask.nameApiKey).trim(), {
      question: payload.query,
      answer: answer.slice(0, ANSWER_NAME_INPUT_LEN),
    }, { retries: 2 });
    filename = sanitizeFileName((parseOutputs(wf) || {}).filename);
  } catch (err) {
    console.error(`[群内提问] WF3 文件名生成失败（改用兜底文件名）：${err.message}`);
  }
  if (!filename) filename = `群内问答-${formatStamp()}`;

  const senderName = await resolveDisplayName(conversationId, senderId);
  const md = `# ${filename}\n\n提问人：${senderName}\n提问：${payload.query}\n时间：${formatDateTime(Number(msg.created_at) || 0)}\n\n---\n\n${answer}`;
  try {
    await sendFile(conversationId, Buffer.from(md, 'utf8'), `${filename}.md`);
    console.log(`[群内提问] ${senderName} 的提问已回复文件 ${filename}.md（回答 ${answer.length} 字）`);
  } catch (err) {
    console.error(`[群内提问] 回答文件发送失败：${err.message}`);
    await reply(conversationId, msg, `回答已生成但文件发送失败\n${answer.slice(0, ANSWER_FALLBACK_LEN)}`);
  }
}

module.exports = { handleGroupAsk };
