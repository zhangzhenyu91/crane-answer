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

const PUSH_TIMEOUT_MS = 20000;
const PUSH_RETRIES = 2;
const PUSH_RETRY_DELAY_MS = 3000;

const MODE_LABELS = { direct: '入库', staging: '暂存' };

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
  };
}

async function postIngest(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);
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
    if (!res.ok) throw new Error(`壹匣接口返回 HTTP ${res.status}：${raw.slice(0, 200)}`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 失败重试 2 次（共 3 次尝试），间隔 3 秒。
 */
async function postIngestWithRetry(url, body) {
  let lastError;
  for (let attempt = 0; attempt <= PUSH_RETRIES; attempt += 1) {
    try {
      return await postIngest(url, body);
    } catch (err) {
      lastError = err;
      if (attempt < PUSH_RETRIES) {
        console.warn(`[报送壹匣] 调用失败，${PUSH_RETRY_DELAY_MS / 1000}s 后重试（第 ${attempt + 2} 次尝试）：${err.message}`);
        await sleep(PUSH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastError;
}

/**
 * 把会话有效记录（status=active）以结构化 JSON 推送至壹匣后端，并附带汇总 xlsx base64 存档。
 * 前置条件不满足（模式非法/未配置壹匣/规则未配归属班组/无有效记录）直接抛错；
 * 接口调用失败则落会话 pushResult='fail: 原因' 并返回 { ok: false }。
 * @param {object} session 排查会话
 * @param {'direct'|'staging'} mode direct=审核通过直接入库；staging=需修改进壹匣暂存区
 * @param {{ wxid?: string, name?: string }} [pusher] 推送人（群指令为发送者，管理端为管理员）
 * @param {string} [reviewNote] 审核备注（staging 随表提交，可空串；direct 固定空串）
 * @returns {Promise<{ ok: boolean, message: string, data: object|null }>}
 */
async function pushSession(session, mode, pusher = {}, reviewNote = '') {
  if (!MODE_LABELS[mode]) throw createError(`不支持的推送模式：${mode}`);
  if (!config.yixia.baseUrl || !config.yixia.token) throw createError('未配置壹匣推送');
  const rule = getSettings().rules.find((item) => item.id === session.ruleId);
  const teamName = ((rule && rule.teamName) || '').trim();
  if (!teamName) throw createError('该规则未配置归属班组');
  const records = session.records.filter((item) => item.status === 'active').map(buildRecordPayload);
  if (!records.length) throw createError('会话无有效记录');

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
    const summary = ['inserted', 'updated', 'skipped']
      .filter((key) => data && typeof data[key] === 'number')
      .map((key) => `${key}=${data[key]}`)
      .join(' ');
    session.pushResult = `ok: ${summary || `records=${records.length}`}`;
    store.saveSession(session);
    console.log(`[报送壹匣] 会话 ${session.id} 报送成功（${MODE_LABELS[mode]} ${records.length} 条）：${session.pushResult}`);
    const message = mode === 'direct' ? `已报送壹匣：入库 ${records.length} 条` : `已报送暂存：${records.length} 条`;
    return { ok: true, message, data };
  } catch (err) {
    session.pushResult = `fail: ${err.message}`;
    store.saveSession(session);
    console.error(`[报送壹匣] 会话 ${session.id} 报送失败：${err.stack || err}`);
    return { ok: false, message: err.message, data: null };
  }
}

module.exports = { pushSession };
