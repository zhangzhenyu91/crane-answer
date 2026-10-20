/**
 * 群图片消息缓存与下载（树木排查辅证照片用）。
 *
 * 实测结论（2026-10-20 私聊实测，见 README「图片挂接」节）：
 * - 图片消息（kind=image / type=3）的 image.cdn_download_contexts[] 自带 CDN 下载参数
 *   （file_no + file_aes_key，variant=standard 为原图 / thumbnail 为缩略图）；
 * - 下载走云端网关 POST {apiBase}/v1/Tools/CdnDownloadImage，X-Cloud-Access-Token 鉴权，
 *   参数为小写 file_no / file_aes_key，返回 Data.Image 为服务端已解密的完整原图 base64；
 *   （GetMsgBigImg / DownloadImg 等旧接口已实测不可用，勿回退。）
 * - 引用消息（kind=app, app.category='quote'）不含图片 CDN 参数，
 *   引用报文只能靠 app.reference.svr_id 关联 → 图片到达时按 svr_id 缓存下载参数，引用到来时查表下载。
 *
 * 缓存持久化在 data/image-cache.json（临时文件 + rename 原子写，与 settings/inspection 同口径）；
 * 图片本体存 data/attachments/evi-<svrId>.jpg。未挂接记录的条目 3 天过期清理；已挂接的条目随记录存续。
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSettings } = require('../settings');

const CACHE_TTL_SEC = 3 * 24 * 3600; // 未挂接记录的缓存条目保留时长
const DOWNLOAD_TIMEOUT_MS = 20000;
const DOWNLOAD_RETRIES = 2; // 失败重试次数（共 3 次尝试）
const DOWNLOAD_RETRY_DELAY_MS = 3000;

let state = null;

function cacheFile() {
  return path.join(config.dataDir, 'image-cache.json');
}

function attachmentsDir() {
  return path.join(config.dataDir, 'attachments');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = cacheFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

/** 过期清理：仅清理未挂接记录且超龄的条目（含其已下载文件）；已挂接条目随记录存续不清 */
function sweepExpired() {
  const now = Math.floor(Date.now() / 1000);
  let changed = false;
  for (const [svrId, item] of Object.entries(state.images)) {
    if (item.recordId) continue;
    if (now - (item.capturedAt || 0) <= CACHE_TTL_SEC) continue;
    if (item.file) deleteFile(item.file);
    delete state.images[svrId];
    changed = true;
  }
  return changed;
}

function initImageStore() {
  fs.mkdirSync(attachmentsDir(), { recursive: true });
  const file = cacheFile();
  if (fs.existsSync(file)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = { version: 1, images: loaded.images && typeof loaded.images === 'object' ? loaded.images : {} };
    } catch {
      state = { version: 1, images: {} };
    }
  } else {
    state = { version: 1, images: {} };
  }
  if (sweepExpired()) persist();
  if (!fs.existsSync(file)) persist();
}

function getState() {
  if (!state) throw new Error('图片缓存尚未初始化');
  return state;
}

/**
 * 从图片消息提取 CDN 下载参数（variant=standard 原图优先，退化 thumbnail / 顶层 standard_file_no）。
 * 返回 { fileNo, aesKey, dataLen } | null。
 */
function extractCdnParams(msg) {
  const image = msg.image;
  if (!image || typeof image !== 'object') return null;
  const contexts = Array.isArray(image.cdn_download_contexts) ? image.cdn_download_contexts : [];
  const standard = contexts.find((item) => item && item.variant === 'standard') || contexts[0] || null;
  const fileNo = String((standard && standard.file_no) || image.standard_file_no || '').trim();
  const aesKey = String((standard && standard.file_aes_key) || image.aes_key || '').trim();
  if (!fileNo || !aesKey) return null;
  return { fileNo, aesKey, dataLen: Number(image.data_len) || 0 };
}

/**
 * 缓存一条群图片消息的下载参数（不下载本体；裸图片仅备查，被引用时才下载）。
 * @returns {object|null} 缓存条目；消息不含可用 CDN 参数时返回 null
 */
function cacheImage(msg, groupId, senderId) {
  const svrId = String(msg.svr_id || msg.new_msg_id || '');
  if (!svrId) return null;
  const params = extractCdnParams(msg);
  if (!params) return null;
  const entry = {
    svrId,
    groupId: String(groupId || ''),
    senderId: String(senderId || ''),
    capturedAt: Number(msg.created_at) || Math.floor(Date.now() / 1000),
    fileNo: params.fileNo,
    aesKey: params.aesKey,
    dataLen: params.dataLen,
    file: (getState().images[svrId] && getState().images[svrId].file) || '',
    recordId: (getState().images[svrId] && getState().images[svrId].recordId) || '',
  };
  getState().images[svrId] = entry;
  if (sweepExpired()) { /* 顺手清理 */ }
  persist();
  return entry;
}

function getImage(svrId) {
  return getState().images[String(svrId || '')] || null;
}

/** 标注缓存条目已挂接某条记录（不再参与过期清理；撤回判定时据此区分「删照片」与「删缓存」） */
function attachToRecord(svrId, recordId) {
  const entry = getImage(svrId);
  if (!entry) return null;
  entry.recordId = String(recordId || '');
  persist();
  return entry;
}

/** 撤回/记录删除时按记录 id 反查其全部辅证缓存条目 */
function findByRecordId(recordId) {
  return Object.values(getState().images).filter((item) => item.recordId === recordId);
}

/**
 * 撤回启发式取图：撤回事件不含被撤消息 ID，取撤回人时间窗内最近一条缓存图片。
 */
function findRecallImage(groupId, senderId, windowSec) {
  if (!senderId) return null;
  const now = Math.floor(Date.now() / 1000);
  return Object.values(getState().images)
    .filter((item) => item.groupId === groupId && item.senderId === senderId && now - item.capturedAt <= windowSec)
    .sort((a, b) => b.capturedAt - a.capturedAt)[0] || null;
}

function deleteFile(relFile) {
  if (!relFile) return;
  const abs = path.join(config.dataDir, relFile);
  fs.unlink(abs, () => {});
}

/** 删除缓存条目及其已下载文件（撤回未挂接图片 / 清理挂接解除后的残留） */
function removeImage(svrId) {
  const entry = getImage(svrId);
  if (!entry) return false;
  if (entry.file) deleteFile(entry.file);
  delete getState().images[entry.svrId];
  persist();
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cdnDownloadOnce(entry) {
  const { wechat } = getSettings();
  if (!wechat.token) throw new Error('未配置 WeChatPadPro Cloud Access Token');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(`${wechat.apiBase}/v1/Tools/CdnDownloadImage`, {
      method: 'POST',
      headers: {
        'X-Cloud-Access-Token': wechat.token,
        'Content-Type': 'application/json',
      },
      // 实测确认：该网关仅认小写参数（大写 FileNo 报「请求参数错误：CDN 图片下载需要 file_no、file_aes_key」）
      body: JSON.stringify({ file_no: entry.fileNo, file_aes_key: entry.aesKey }),
      signal: controller.signal,
    });
    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`图片下载接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok || body.Success === false || (typeof body.Code === 'number' && body.Code !== 0)) {
      throw new Error(`图片下载接口调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    const b64 = body.Data && body.Data.Image;
    if (!b64 || typeof b64 !== 'string') throw new Error('图片下载接口未返回图像数据');
    return Buffer.from(b64, 'base64');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 下载图片本体到 data/attachments/evi-<svrId>.jpg（失败按 3 秒间隔重试 2 次）。
 * 魔数校验 JPEG/PNG；成功后回写缓存条目的 file 字段。
 * @returns {Promise<{ file: string, bytes: number }>} file 为相对 dataDir 的路径
 */
async function downloadImage(svrId) {
  const entry = getImage(svrId);
  if (!entry) throw new Error('未找到该图片的缓存（可能已过期或收到时服务未运行）');
  if (entry.file) {
    const abs = path.join(config.dataDir, entry.file);
    if (fs.existsSync(abs)) return { file: entry.file, bytes: fs.statSync(abs).size };
  }
  let lastError;
  for (let attempt = 0; attempt <= DOWNLOAD_RETRIES; attempt += 1) {
    try {
      const buf = await cdnDownloadOnce(entry);
      const isJpeg = buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8;
      const isPng = buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
      if (!isJpeg && !isPng) throw new Error(`下载内容不是 JPEG/PNG 图片（前 4 字节 ${buf.subarray(0, 4).toString('hex')}）`);
      const ext = isPng ? 'png' : 'jpg';
      const rel = `attachments/evi-${entry.svrId}.${ext}`;
      fs.mkdirSync(attachmentsDir(), { recursive: true });
      fs.writeFileSync(path.join(config.dataDir, rel), buf, { mode: 0o600 });
      entry.file = rel;
      persist();
      return { file: rel, bytes: buf.length };
    } catch (err) {
      lastError = err;
      if (attempt < DOWNLOAD_RETRIES) {
        console.warn(`[图片] 下载失败，${DOWNLOAD_RETRY_DELAY_MS / 1000}s 后重试（第 ${attempt + 2} 次尝试）：${err.message}`);
        await sleep(DOWNLOAD_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

module.exports = {
  initImageStore,
  cacheImage,
  getImage,
  attachToRecord,
  findByRecordId,
  findRecallImage,
  removeImage,
  deleteFile,
  downloadImage,
};
