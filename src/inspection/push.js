const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getSettings } = require('../settings');
const store = require('./store');
const {
  buildSessionWorkbook,
  formatSection,
  formatVertical,
  formatSideDistance,
  resolveFinderName,
} = require('./export');

const PUSH_TIMEOUT_MS = 60000; // 辅证照片随记录上送、壹匣侧入 COS 耗时，超时放宽到 60s
const PUSH_RETRIES = 2;
const PUSH_RETRY_DELAY_MS = 3000;

const MODE_LABELS = { direct: '入库', staging: '暂存' };

// 正在实时推送中的记录 id：避免失败重扫与实时推送并发重复上送
const inFlightPushes = new Set();

function isRecordPushInFlight(recordId) {
  return inFlightPushes.has(recordId);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function text(value) {
  return value == null ? '' : String(value).trim();
}

// capturedAt（Unix 秒）→ 'yyyy-MM-dd'
function formatFoundAt(unixSeconds) {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 归属班组（壹匣 team_name）：取规则「归属班组」，桶/事件元信息兜底（旧数据迁移桶可能规则已删） */
function resolveTeamName(source) {
  const rule = getSettings().rules.find((item) => item.id === source.ruleId);
  return String((rule && rule.teamName) || source.teamName || '').trim();
}

/**
 * 装配记录辅证照片：读本地缓存文件转 base64 dataURL（与壹匣照片上传同口径）。
 * 字段恒为数组（可为空）——壹匣侧据此区分「无辅证」（重推时清除既有辅证）与「旧版未上报」（不动既有辅证）；
 * 文件缺失的单张跳过并记日志。
 */
function buildEvidencePhotos(record) {
  const photos = [];
  for (const photo of record.photos || []) {
    try {
      const buf = fs.readFileSync(path.join(config.dataDir, photo.file));
      const mime = photo.file.endsWith('.png') ? 'image/png' : 'image/jpeg';
      photos.push({ msg_id: photo.msgId || '', image: `data:${mime};base64,${buf.toString('base64')}` });
    } catch (err) {
      console.error(`[报送壹匣] 记录 ${record.id} 辅证照片 ${photo.file} 读取失败，已跳过：${err.message}`);
    }
  }
  return photos;
}

/**
 * 装配单条推送记录；区段/侧别距离/垂直距离/发现人的展示文本与 export.js 汇总列保持一致。
 */
function buildRecordPayload(record) {
  const ex = record.extracted || {};
  return {
    crane_record_id: record.id,
    msg_id: record.msgId || '',
    voltage_level: (record.matchedLine && record.matchedLine.voltage) || '',
    line_name: (record.matchedLine && record.matchedLine.name) || '',
    line_name_raw: record.lineNameRaw || '',
    section: formatSection(record),
    pole_from: Number(ex.pole_from) || null,
    pole_to: Number(ex.pole_to) || null,
    position_note: text(ex.position_note),
    tree_species: text(ex.tree_species),
    tree_count: text(ex.tree_count),
    dist_small: formatSideDistance(record, 'small'),
    dist_big: formatSideDistance(record, 'big'),
    diameter: text(ex.diameter),
    horizontal: text(ex.horizontal),
    vertical: formatVertical(record),
    finder_name: resolveFinderName(record.senderId, record.senderName),
    found_at: formatFoundAt(record.capturedAt),
    evidence_photos: buildEvidencePhotos(record),
  };
}

/**
 * 单次调用壹匣 ingest 类接口。
 * options.timeoutMs：单次超时（默认 PUSH_TIMEOUT_MS）；HTTP 非 2xx 时把业务错误体挂到 err.body
 * 供调用方映射 code/message 回执（如 callme/ingest-chat 的 user_not_found 等）。
 */
async function postIngest(url, body, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : PUSH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-Token': config.yixia.token,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await res.text();
    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      // 非 JSON 响应不视为失败，仅丢弃解析结果
    }
    if (!res.ok) {
      const err = new Error(`壹匣接口返回 HTTP ${res.status}：${raw.slice(0, 200)}`);
      err.body = data;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 失败重试（默认 2 次，共 3 次尝试），间隔 3 秒。
 * options.retries：重试次数（0 = 不重试，非幂等接口用）；options.logPrefix：日志前缀（默认「报送壹匣」）；
 * options.timeoutMs 透传给 postIngest。
 */
async function postIngestWithRetry(url, body, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : PUSH_RETRIES;
  const logPrefix = options.logPrefix || '[报送壹匣]';
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await postIngest(url, body, options);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.warn(`${logPrefix} 调用失败，${PUSH_RETRY_DELAY_MS / 1000}s 后重试（第 ${attempt + 2} 次尝试）：${err.message}`);
        await sleep(PUSH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

/**
 * 实时推送单条记录至壹匣（记录落库 / 更正 / 辅证变更后调用）。
 * 不抛错：结果回写 record.pushStatus（ok/failed）/pushedAt/pushError 并落库，
 * 调用方按返回值决定日志与回执（推送失败不影响群内「已记录」反馈）。
 * @returns {Promise<{ ok: boolean, message: string, data: object|null }>}
 */
async function pushRecord(bucket, record) {
  // 待删除/已删记录不再上送，避免把已删记录重新 upsert 回壹匣
  if (record.deleting) return { ok: false, message: '记录待删除，跳过推送', data: null };
  if (inFlightPushes.has(record.id)) return { ok: false, message: '该记录正在推送中', data: null };
  inFlightPushes.add(record.id);
  const settle = (okFlag, message, data = null) => {
    record.pushStatus = okFlag ? 'ok' : 'failed';
    record.pushedAt = Math.floor(Date.now() / 1000);
    record.pushError = okFlag ? '' : message;
    store.saveSession(bucket);
    return { ok: okFlag, message, data };
  };
  try {
    if (!config.yixia.baseUrl || !config.yixia.token) return settle(false, '未配置壹匣推送');
    const teamName = resolveTeamName(bucket);
    if (!teamName) return settle(false, '该规则未配置归属班组');
    const body = {
      session_id: bucket.id,
      group_id: bucket.groupId,
      group_name: bucket.groupName || '',
      team_name: teamName,
      mode: 'direct',
      pusher: { wxid: '', name: '' },
      records: [buildRecordPayload(record)],
    };
    const url = `${config.yixia.baseUrl}/api/v1/treehazard/ingest`;
    try {
      const data = await postIngestWithRetry(url, body);
      return settle(true, 'ok', data);
    } catch (err) {
      return settle(false, err.message);
    }
  } finally {
    inFlightPushes.delete(record.id);
  }
}

/**
 * 删除事件统一出口：前置校验 + 调用 ingest deletes 契约 + 超时重试封装。
 * 不抛错，失败返回原因由调用方决定入重试队列或记日志。
 */
async function sendDeletePayload(body) {
  if (!config.yixia.baseUrl || !config.yixia.token) return { ok: false, message: '未配置壹匣推送', data: null };
  if (!body.team_name) return { ok: false, message: '该规则未配置归属班组', data: null };
  try {
    const data = await postIngestWithRetry(`${config.yixia.baseUrl}/api/v1/treehazard/ingest`, body);
    return { ok: true, message: 'ok', data };
  } catch (err) {
    return { ok: false, message: err.message, data: null };
  }
}

/**
 * 实时推送单条删除至壹匣（整条记录被撤回删除时先调本接口再做本地删除）。
 * 壹匣按 (team_id, crane_record_id) 定位删除记录行 + 辅证照片行 + COS 对象并写墓碑，找不到计 skipped。
 * 不抛错，失败仅返回原因——调用方须把失败事件存入删除重试队列（store.enqueuePendingDelete），
 * 不能只记日志，否则壹匣不可达期间的删除会永久丢失。
 * @returns {Promise<{ ok: boolean, message: string, data: object|null }>}
 */
async function pushDelete(bucket, record) {
  return sendDeletePayload({
    session_id: bucket.id,
    team_name: resolveTeamName(bucket),
    group_name: bucket.groupName || '',
    mode: 'direct',
    deletes: [{ crane_record_id: record.id, msg_id: record.msgId || '' }],
  });
}

/**
 * 按删除重试队列条目补推删除事件（失败重扫用）。事件字段在入队时已快照，
 * 即使记录已本地删除、日桶/规则后续变更也能重建 deletes 契约 body。
 * @returns {Promise<{ ok: boolean, message: string, data: object|null }>}
 */
async function pushDeleteEvent(event) {
  return sendDeletePayload({
    session_id: event.bucketId,
    team_name: resolveTeamName(event),
    group_name: event.groupName || '',
    mode: 'direct',
    deletes: [{ crane_record_id: event.craneRecordId, msg_id: event.msgId || '' }],
  });
}

/**
 * 把日桶有效记录（status=active）以结构化 JSON 整体重推至壹匣后端，并附带汇总 xlsx base64 存档。
 * 供群内「报送」指令与管理端手动重推（兜底补推用；实时推送已逐条上送，重推幂等覆盖）。
 * 待删除（deleting）记录排除在外，避免把已删记录重新 upsert 回壹匣。
 * 前置条件不满足（模式非法/未配置壹匣/规则未配归属班组/无有效记录）直接抛错；
 * 接口调用失败则落日桶 pushResult='fail: 原因' 并返回 { ok: false }。
 * 推送成功后把本次涉及 records 的 pushStatus 置 'ok'。
 * @param {object} session 排查日桶
 * @param {'direct'|'staging'} mode direct=入库；staging=进壹匣暂存区
 * @param {{ wxid?: string, name?: string }} [pusher] 推送人（群指令为发送者，管理端为管理员）
 * @param {string} [reviewNote] 审核备注（staging 随表提交，可空串；direct 固定空串）
 * @returns {Promise<{ ok: boolean, message: string, data: object|null }>}
 */
async function pushSession(session, mode, pusher = {}, reviewNote = '') {
  if (!MODE_LABELS[mode]) throw createError(`不支持的推送模式：${mode}`);
  if (!config.yixia.baseUrl || !config.yixia.token) throw createError('未配置壹匣推送');
  const teamName = resolveTeamName(session);
  if (!teamName) throw createError('该规则未配置归属班组');
  const active = session.records.filter((item) => item.status === 'active' && !item.deleting);
  if (!active.length) throw createError('日桶无有效记录');
  const records = active.map(buildRecordPayload);

  const workbook = await buildSessionWorkbook(session);
  const xlsxBase64 = Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
  const body = {
    session_id: session.id,
    group_id: session.groupId,
    group_name: session.groupName || '',
    team_name: teamName,
    mode,
    review_note: mode === 'staging' ? String(reviewNote || '').trim() : '',
    pusher: { wxid: pusher.wxid || '', name: pusher.name || '' },
    xlsx_base64: xlsxBase64,
    records,
  };
  const url = `${config.yixia.baseUrl}/api/v1/treehazard/ingest`;

  session.pushedAt = Math.floor(Date.now() / 1000);
  session.pushMode = mode;
  try {
    const data = await postIngestWithRetry(url, body);
    const now = Math.floor(Date.now() / 1000);
    for (const item of active) {
      item.pushStatus = 'ok';
      item.pushedAt = now;
      item.pushError = '';
    }
    const summary = ['inserted', 'updated', 'skipped', 'photos_failed', 'deleted']
      .filter((key) => data && typeof data[key] === 'number')
      .map((key) => `${key}=${data[key]}`)
      .join(' ');
    session.pushResult = `ok: ${summary || `records=${records.length}`}`;
    store.saveSession(session);
    console.log(`[报送壹匣] 日桶 ${session.id} 报送成功（${MODE_LABELS[mode]} ${records.length} 条）：${session.pushResult}`);
    const message = mode === 'direct' ? `已报送壹匣：入库 ${records.length} 条` : `已报送暂存：${records.length} 条`;
    return { ok: true, message, data };
  } catch (err) {
    session.pushResult = `fail: ${err.message}`;
    store.saveSession(session);
    console.error(`[报送壹匣] 日桶 ${session.id} 报送失败：${err.stack || err}`);
    return { ok: false, message: err.message, data: null };
  }
}

module.exports = {
  pushSession,
  pushRecord,
  pushDelete,
  pushDeleteEvent,
  isRecordPushInFlight,
  postIngestWithRetry,
};
