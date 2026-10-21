/**
 * 群媒体消息（文件/视频/语音）参数缓存与下载（群内提问引用场景用）。
 *
 * 三类媒体的报文字段形态与下载接口参数尚无真实报文实测（2026-10 首版）：
 * - 文件：POST {apiBase}/v1/Tools/DownloadFileBinary，按 section 分片下载（单片 512KB，总长以 data_len 为准）；
 * - 视频：POST {apiBase}/v1/Tools/DownloadVideo，同款分片下载；
 * - 语音：POST {apiBase}/v1/Tools/DownloadVoiceBinary，一次性取回 silk 编码音频再转 WAV。
 * 网关参数一律小写驼峰（图片下载接口已实测只认小写）；user_name / to_wxid / to_user_name 的
 * 确切语义未实测，按示例填充（文件 user_name=文件发送者 wxid；视频 to_wxid、语音 to_user_name=
 * 监听账号 wxid）；app_id 取报文自带值，无则用 settings.wechat.fileAppId（缺省 ID_10001）。
 * 真机首验时打开「打印原始推送报文」核对字段形态，解析不全会把原始报文打进日志。
 *
 * 缓存持久化在 data/media-cache.json（临时文件 + rename 原子写，与 settings/image-cache 同口径），
 * 只存下载参数不存二进制，条目 3 天过期清理。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSettings } = require('../settings');

const CACHE_TTL_SEC = 3 * 24 * 3600;
const DOWNLOAD_TIMEOUT_MS = 20000;
const DOWNLOAD_RETRIES = 2; // 失败重试次数（共 3 次尝试）
const DOWNLOAD_RETRY_DELAY_MS = 3000;
const CHUNK_SIZE = 512 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MEDIA_KIND_BY_MSG_KIND = { file: 'file', video: 'video', voice: 'voice' };

let state = null;

function cacheFile() {
  return path.join(config.dataDir, 'media-cache.json');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = cacheFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 过期清理：仅清理超龄条目（本模块不存二进制，无文件连带删除） */
function sweepExpired() {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [key, item] of Object.entries(state.media)) {
    if (now - (item.capturedAt || 0) <= CACHE_TTL_SEC) continue;
    delete state.media[key];
    changed = true;
  }
  return changed;
}

/** 懒加载（首个媒体消息到达时才读盘），与 imageStore 初始化口径一致 */
function getState() {
  if (state) return state;
  const file = cacheFile();
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { version: 1, media: loaded.media && typeof loaded.media === 'object' ? loaded.media : {} };
    } catch {
      state = { version: 1, media: {} };
    }
  } else {
    state = { version: 1, media: {} };
  }
  if (sweepExpired()) { /* 顺手清理 */ }
  return state;
}

function unescapeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * 从 XML 报文解析媒体下载参数（文件 / 视频 / 语音）。
 * 返回字段按报文实际携带情况部分为空，缺失由缓存或调用方兜底。
 * @returns {object|null} { kind, fileName, appId, attachId, dataLen, msgId, newMsgId, masterBufId, length, fromUserName } | null
 */
function parseMediaFromXml(xmlText) {
  const raw = String(xmlText || '');
  if (!raw) return null;
  let kind = '';
  if (/<appattach[\s>]/.test(raw)
    || /<appmsg[^>]*type="6"/.test(raw)
    || /<appmsg[^>]*>[\s\S]*?<type>\s*6\s*<\/type>/.test(raw)) {
    kind = 'file';
  } else if (/<videomsg[\s>]/.test(raw)) {
    kind = 'video';
  } else if (/<voicemsg[\s>]/.test(raw)) {
    kind = 'voice';
  }
  if (!kind) return null;
  const tag = (name) => {
    const m = raw.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? unescapeXml(m[1]).trim() : '';
  };
  const attr = (name) => {
    // 左边界限定，避免 msgid 误匹配 newmsgid / clientmsgid 等长属性名
    const m = raw.match(new RegExp(`(?:^|[\\s"'\\]])${name}\\s*=\\s*"([^"]*)"`, 'i'));
    return m ? unescapeXml(m[1]).trim() : '';
  };
  const num = (value) => {
    const n = Number(String(value == null ? '' : value).trim());
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  return {
    kind,
    fileName: tag('title') || attr('file_name') || '',
    appId: attr('appid') || attr('app_id') || '',
    attachId: tag('attachid') || attr('attachid') || attr('attach_id') || '',
    dataLen: num(tag('totallen') || attr('totallen') || tag('data_len') || attr('data_len') || attr('length') || tag('length')),
    msgId: tag('msg_id') || attr('msg_id') || attr('msgid') || attr('clientmsgid') || '',
    newMsgId: tag('new_msg_id') || attr('newmsgid') || attr('new_msg_id') || '',
    masterBufId: tag('master_buf_id') || attr('masterbufid') || attr('master_buf_id') || attr('bufid') || '',
    length: num(attr('length') || tag('length')),
    fromUserName: tag('from_user_name') || attr('from_user_name') || attr('fromusername') || '',
  };
}

function collectXmlSources(msg) {
  return [
    msg.content,
    msg.raw,
    msg.msg_source,
    msg.source,
    msg.go_fields && msg.go_fields.Content,
  ].filter((v) => typeof v === 'string' && v.trim()).join('\n');
}

/** 解析不全时打印原始报文，便于真机首验对齐字段形态 */
function logRawMedia(msg, reason) {
  const dump = {
    reason,
    kind: msg.kind,
    svr_id: msg.svr_id,
    new_msg_id: msg.new_msg_id,
    msg_id: msg.msg_id,
    content: msg.content,
    raw: msg.raw,
    msg_source: msg.msg_source,
    go_fields: msg.go_fields,
  };
  console.log(`[媒体] 媒体消息解析未对齐，原始报文：${JSON.stringify(dump).slice(0, 4000)}`);
}

/**
 * 解析并缓存一条文件/视频/语音消息的下载参数（不下载本体；被引用提问时才下载）。
 * kind 非媒体（表情/名片等）静默忽略；识别为媒体但关键字段不全时缓存已有参数并打印原始报文。
 * @returns {object|null} 缓存条目；消息不含可用参数时返回 null
 */
function cacheMedia(msg, groupId, senderId) {
  const parsed = parseMediaFromXml(collectXmlSources(msg)) || {};
  const kind = parsed.kind || MEDIA_KIND_BY_MSG_KIND[String(msg.kind || '').toLowerCase()] || '';
  if (!kind) return null;
  const key = String(msg.svr_id || msg.new_msg_id || '');
  const entry = {
    kind,
    svrId: key,
    groupId: String(groupId || ''),
    fileName: parsed.fileName || '',
    attachId: parsed.attachId || '',
    dataLen: Number(parsed.dataLen) || 0,
    msgId: parsed.msgId || String(msg.msg_id || msg.new_msg_id || msg.svr_id || ''),
    newMsgId: parsed.newMsgId || String(msg.new_msg_id || msg.svr_id || ''),
    masterBufId: parsed.masterBufId || '',
    length: Number(parsed.length) || 0,
    fromUserName: parsed.fromUserName || String(senderId || ''),
    appId: parsed.appId || '',
    capturedAt: Number(msg.created_at) || Math.floor(Date.now() / 1000),
  };
  const complete = kind === 'file'
    ? Boolean(entry.attachId && entry.dataLen && entry.fileName)
    : kind === 'video'
      ? Boolean(entry.msgId && entry.dataLen)
      : Boolean((entry.msgId || entry.newMsgId) && entry.masterBufId && entry.length);
  if (!complete) logRawMedia(msg, `${kind} 关键字段不全`);
  if (!key) {
    logRawMedia(msg, '缺少 svr_id/new_msg_id，无法缓存');
    return null;
  }
  getState().media[key] = entry;
  if (sweepExpired()) { /* 顺手清理 */ }
  persist();
  return entry;
}

/** 按消息 svr_id/new_msg_id 查缓存条目（引用场景拿被引用媒体的下载参数） */
function getMedia(svrId) {
  return getState().media[String(svrId || '')] || null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeError(message, code) {
  const err = new Error(message);
  if (code) err.code = code;
  return err;
}

/** 单次调用媒体下载接口（小写驼峰参数，20s 超时），返回解析后的 JSON body */
async function toolsPostOnce(apiPath, body) {
  const { wechat } = getSettings();
  if (!wechat.token) throw new Error('未配置 WeChatPadPro Cloud Access Token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${wechat.apiBase}${apiPath}`, {
      method: 'POST',
      headers: {
        'X-Cloud-Access-Token': wechat.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`媒体下载接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok || parsed.Success === false || (typeof parsed.Code === 'number' && parsed.Code !== 0)) {
      throw new Error(`媒体下载接口调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/** 失败按 3 秒间隔重试 2 次（共 3 次尝试） */
async function toolsPost(apiPath, body) {
  let lastError;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      return await toolsPostOnce(apiPath, body);
    } catch (err) {
      lastError = err;
      if (attempt < DOWNLOAD_RETRIES) {
        console.warn(`[媒体] 下载失败，${DOWNLOAD_RETRY_DELAY_MS / 1000}s 后重试（第 ${attempt + 2} 次尝试）：${err.message}`);
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

/** 返回二进制可能 base64 包裹，探测 Data 下 Buffer/Data/Image/File 等字段（仿图片下载 Image 字段处理） */
function extractBinary(parsed) {
  const data = parsed && parsed.Data;
  const candidates = [];
  if (typeof data === 'string') candidates.push(data);
  if (data && typeof data === 'object') {
    for (const key of ['Buffer', 'Data', 'Image', 'File', 'Content', 'Binary', 'buffer', 'data', 'image', 'file']) {
      if (typeof data[key] === 'string') candidates.push(data[key]);
    }
  }
  for (const b64 of candidates) {
    const buf = Buffer.from(b64, 'base64');
    if (buf.length) return buf;
  }
  throw new Error('媒体下载接口未返回二进制数据');
}

/**
 * 分片下载文件本体（POST /v1/Tools/DownloadFileBinary，单片 512KB）。
 * @param {{ appId?: string, attachId: string, dataLen: number, fileName: string, userName: string }} params
 * @returns {Promise<Buffer>}
 */
async function downloadFileBuffer(params) {
  const dataLen = Number(params.dataLen) || 0;
  if (dataLen > MAX_FILE_BYTES) throw makeError('file_too_large', '文件超过 50MB 上限');
  if (!params.attachId) throw new Error('缺少 attachid，无法下载文件');
  if (dataLen <= 0) throw new Error('缺少 totallen，无法分片下载文件');
  const { wechat } = getSettings();
  const appId = String(params.appId || '').trim() || String(wechat.fileAppId || '').trim() || 'ID_10001';
  const chunks = [];
  for (let pos = 0; pos < dataLen; pos += CHUNK_SIZE) {
    const sectionLen = Math.min(CHUNK_SIZE, dataLen - pos);
    const parsed = await toolsPost('/v1/Tools/DownloadFileBinary', {
      app_id: appId,
      attach_id: String(params.attachId || ''),
      data_len: dataLen,
      file_name: String(params.fileName || ''),
      user_name: String(params.userName || ''),
      section: { start_pos: pos, data_len: sectionLen },
    });
    chunks.push(extractBinary(parsed));
  }
  return Buffer.concat(chunks);
}

/**
 * 分片下载视频本体（POST /v1/Tools/DownloadVideo，单片 512KB）。
 * @param {{ msgId: string, dataLen: number }} params
 * @returns {Promise<Buffer>}
 */
async function downloadVideoBuffer(params) {
  const dataLen = Number(params.dataLen) || 0;
  if (dataLen > MAX_FILE_BYTES) throw makeError('file_too_large', '视频超过 50MB 上限');
  if (!params.msgId) throw new Error('缺少 msg_id，无法下载视频');
  if (dataLen <= 0) throw new Error('缺少 data_len，无法分片下载视频');
  const { wechat } = getSettings();
  const chunks = [];
  for (let pos = 0; pos < dataLen; pos += CHUNK_SIZE) {
    const sectionLen = Math.min(CHUNK_SIZE, dataLen - pos);
    const parsed = await toolsPost('/v1/Tools/DownloadVideo', {
      compress_type: 0,
      data_len: dataLen,
      msg_id: String(params.msgId || ''),
      section: { start_pos: pos, data_len: sectionLen },
      to_wxid: String(wechat.botWxid || '').trim(),
    });
    chunks.push(extractBinary(parsed));
  }
  return Buffer.concat(chunks);
}

/**
 * 一次性下载语音本体（POST /v1/Tools/DownloadVoiceBinary，silk 编码）。
 * @param {{ groupId: string, clientMsgId?: string, fromUserName: string, length: number, masterBufId: string, msgId: string, newMsgId: string }} params
 * @returns {Promise<Buffer>}
 */
async function downloadVoiceBuffer(params) {
  const { wechat } = getSettings();
  const parsed = await toolsPost('/v1/Tools/DownloadVoiceBinary', {
    chat_room_name: String(params.groupId || ''),
    client_msg_id: String(params.clientMsgId || params.msgId || ''),
    file_name: 'voice.silk',
    format: 1,
    from_user_name: String(params.fromUserName || ''),
    length: Number(params.length) || 0,
    master_buf_id: String(params.masterBufId || ''),
    msg_id: String(params.msgId || ''),
    new_msg_id: String(params.newMsgId || ''),
    to_user_name: String(wechat.botWxid || '').trim(),
  });
  return extractBinary(parsed);
}

/** WAV 文件头包装（PCM 16bit 单声道，采样率取解码结果） */
function wrapWav(pcm, sampleRate) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'latin1');
  header.write('fmt ', 12, 'latin1');
  header.writeUInt32LE(16, 16); // fmt 块长度
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // 单声道
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // 字节率
  header.writeUInt16LE(2, 32); // 块对齐
  header.writeUInt16LE(16, 34); // 位深
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function loadSilkWasm() {
  try {
    return require('silk-wasm');
  } catch {
    throw new Error('silk-wasm 未安装，语音转码不可用');
  }
}

// silk-wasm v3 的 decode 要求传入采样率且不回传（微信语音 silk 常规 24kHz，待真机试听对齐）
const SILK_DECODE_RATE = 24000;

/**
 * 语音下载内容转可发送音频：魔数探测 wav / mp3 直出，silk 用 silk-wasm 解码 PCM 后封装 WAV。
 * silk-wasm v3 的 decode 不回传采样率，但输出即按入参采样率重采样（已本地实测），
 * 故 WAV 头直接写 SILK_DECODE_RATE；微信语音 silk 常规 24kHz，待真机试听对齐。
 * @returns {Promise<{ buffer: Buffer, ext: 'wav'|'mp3' }>}
 */
async function convertVoice(buf) {
  if (!buf || !buf.length) throw new Error('语音内容为空');
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WAVE') {
    return { buffer: buf, ext: 'wav' };
  }
  if (buf.subarray(0, 3).toString('latin1') === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) {
    return { buffer: buf, ext: 'mp3' };
  }
  if (!buf.includes(Buffer.from('#!SILK_V3'))) throw new Error('语音编码无法识别（非 wav/mp3/silk）');
  const silk = loadSilkWasm();
  const decoded = await silk.decode(buf, SILK_DECODE_RATE);
  if (!decoded || !decoded.data || !decoded.data.length) throw new Error('silk 解码结果为空');
  return { buffer: wrapWav(Buffer.from(decoded.data), SILK_DECODE_RATE), ext: 'wav' };
}

module.exports = {
  cacheMedia,
  getMedia,
  parseMediaFromXml,
  downloadFileBuffer,
  downloadVideoBuffer,
  downloadVoiceBuffer,
  convertVoice,
};
