const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const imageStore = require('../wechatpadpro/imageStore');

let state = null;

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function storeFile() {
  return path.join(config.dataDir, 'inspection-sessions.json');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

// Unix 秒 → 北京时间自然日 'yyyy-MM-dd'（日桶 ID 与跨天归并用，独立于服务器时区）
function beijingDateString(unixSeconds) {
  const d = new Date((Number(unixSeconds) + 8 * 3600) * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 同群当天日桶 ID（北京时间自然天）：kind='crossing' 交跨桶带 '_crossing' 后缀，缺省树障保持旧 ID */
function todayBucketId(groupId, kind = 'tree') {
  const crossing = kind === 'crossing';
  return `${groupId}_${beijingDateString(Math.floor(Date.now() / 1000))}${crossing ? '_crossing' : ''}`;
}

/** 北京时间当天 'yyyy-MM-dd'（日桶日期口径，供调用方做跨天判断） */
function beijingToday() {
  return beijingDateString(Math.floor(Date.now() / 1000));
}

/**
 * 桶 ID 是否属于北京时间当天：桶 ID 形态为 `<群ID>_<yyyy-MM-dd>[_crossing]`，
 * 群 ID 本身可能含下划线，故去掉 `_crossing` 后缀后取末段下划线后的日期比对。
 */
function isTodayBucketId(bucketId, today) {
  const base = bucketId.endsWith('_crossing') ? bucketId.slice(0, -'_crossing'.length) : bucketId;
  const idx = base.lastIndexOf('_');
  return idx >= 0 && base.slice(idx + 1) === today;
}

/**
 * 日桶自动销毁：只保留北京时间当天的日桶（树障桶与交跨桶一视同仁），过期桶整体清除。
 * 取舍（README 已注明）：桶内未推送成功（pushStatus 非 ok）的记录随桶销毁、此后不再补推，
 * 已推送壹匣的记录不受影响（壹匣侧留存）；pendingDeletes 删除事件队列不动（快照独立仍需补推）。
 * 桶内记录的辅证照片：缓存条目按记录 id 反查清除，本地文件逐个删除（失败仅记日志）。
 * 需在 initStore/initImageStore 之后调用。
 * @returns {number} 清除的日桶数量
 */
function purgeExpiredBuckets() {
  const today = beijingToday();
  const current = getState();
  const expired = current.buckets.filter((bucket) => !isTodayBucketId(bucket.id, today));
  if (!expired.length) return 0;
  console.log(`[排查日桶] 自动销毁 ${expired.length} 个非当天日桶：${expired.map((bucket) => bucket.id).join('，')}`);
  for (const bucket of expired) {
    for (const record of bucket.records) {
      for (const entry of imageStore.findByRecordId(record.id)) imageStore.removeImage(entry.svrId);
      for (const photo of record.photos || []) {
        try {
          imageStore.deleteFile(photo.file);
        } catch (err) {
          console.error(`[排查日桶] 过期桶辅证照片清理失败（桶 ${bucket.id}，文件 ${photo.file}）：${err.message}`);
        }
      }
    }
  }
  const expiredIds = new Set(expired.map((bucket) => bucket.id));
  current.buckets = current.buckets.filter((bucket) => !expiredIds.has(bucket.id));
  persist();
  return expired.length;
}

/**
 * 旧版会话数据迁移：把 { version:1, sessions:[...] } 的会话 records 按 capturedAt 的北京时间日期
 * 归并入日桶（桶 ID = <groupId>_<yyyy-MM-dd>），纯结构转换不丢数据。
 * 记录推送状态：旧会话已整体推送过的视为已同步（pushStatus=ok），其余标 pending 由失败重扫补推。
 */
function migrateLegacySessions(loaded) {
  const now = Math.floor(Date.now() / 1000);
  const buckets = [];
  const index = new Map();
  const merge = (session, at) => {
    const bucketId = `${session.groupId}_${beijingDateString(at || session.startedAt || now)}`;
    let bucket = index.get(bucketId);
    if (!bucket) {
      bucket = {
        id: bucketId,
        ruleId: session.ruleId || '',
        ruleName: session.ruleName || '',
        groupId: session.groupId || '',
        groupName: session.groupName || '',
        teamName: session.teamName || '',
        status: 'active',
        startedAt: at || session.startedAt || now,
        lastActivityAt: at || session.startedAt || now,
        sentAt: null,
        pushedAt: null,
        pushMode: '',
        pushResult: '',
        records: [],
      };
      index.set(bucketId, bucket);
      buckets.push(bucket);
    }
    if (at) {
      if (at < bucket.startedAt) bucket.startedAt = at;
      if (at > bucket.lastActivityAt) bucket.lastActivityAt = at;
    }
    if (session.sentAt && (!bucket.sentAt || session.sentAt > bucket.sentAt)) bucket.sentAt = session.sentAt;
    if (session.pushedAt && (!bucket.pushedAt || session.pushedAt > bucket.pushedAt)) {
      bucket.pushedAt = session.pushedAt;
      bucket.pushMode = session.pushMode || bucket.pushMode;
      bucket.pushResult = session.pushResult || bucket.pushResult;
    }
    return bucket;
  };
  for (const session of loaded.sessions || []) {
    const records = Array.isArray(session.records) ? session.records : [];
    if (!records.length) {
      merge(session, null);
      continue;
    }
    for (const record of records) {
      const bucket = merge(session, record.capturedAt || null);
      if (!record.pushStatus) {
        record.pushStatus = session.pushedAt ? 'ok' : 'pending';
        record.pushedAt = session.pushedAt || null;
        record.pushError = '';
      }
      bucket.records.push(record);
    }
  }
  return buckets;
}

function initStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(loaded.buckets)) {
      state = {
        version: 2,
        buckets: loaded.buckets,
        pendingDeletes: Array.isArray(loaded.pendingDeletes) ? loaded.pendingDeletes : [],
        deleteNoticeAt: Number(loaded.deleteNoticeAt) || 0,
      };
    } else {
      // 旧版 sessions 结构：启动时迁移为日桶并原子写回
      state = {
        version: 2,
        buckets: migrateLegacySessions(loaded),
        pendingDeletes: [],
        deleteNoticeAt: 0,
      };
      persist();
    }
    return;
  }
  state = { version: 2, buckets: [], pendingDeletes: [], deleteNoticeAt: 0 };
  persist();
}

function getState() {
  if (!state) throw new Error('排查记录存储尚未初始化');
  return state;
}

/**
 * 桶类型：'tree'（树障，默认）| 'crossing'（交跨排查）。旧桶无 kind 字段视同 tree。
 */
function bucketKind(bucket) {
  return bucket && bucket.kind === 'crossing' ? 'crossing' : 'tree';
}

/**
 * 取该群今天（北京时间自然天）的日桶，无则自动创建。全天候捕获下每条消息都经此取桶，status 恒为 active。
 * 同群可并存树障/交跨两类日桶：交跨桶 ID 加 '_crossing' 后缀（treeWatch 保持旧 ID，旧数据零迁移）。
 * @param {string} groupId 群 ID
 * @param {{ ruleId?: string, ruleName?: string, groupName?: string, teamName?: string, kind?: 'tree'|'crossing' }} [meta] 建桶元信息
 */
function getTodayBucket(groupId, meta = {}) {
  const now = Math.floor(Date.now() / 1000);
  const kind = meta.kind === 'crossing' ? 'crossing' : 'tree';
  const bucketId = todayBucketId(groupId, kind);
  const existing = getState().buckets.find((item) => item.id === bucketId);
  if (existing) return existing;
  const bucket = {
    id: bucketId,
    kind,
    ruleId: meta.ruleId || '',
    ruleName: meta.ruleName || '',
    groupId,
    groupName: meta.groupName || '',
    teamName: meta.teamName || '',
    status: 'active',
    startedAt: now,
    lastActivityAt: now,
    sentAt: null, // 标记该桶当天已发过汇总 xlsx，供「报送」幂等参考，不作为推送前提
    pushedAt: null,
    pushMode: '',
    pushResult: '',
    records: [],
  };
  getState().buckets.push(bucket);
  persist();
  return bucket;
}

/** 该群今天指定类型（kind，缺省 tree）日桶内的全部有效（status=active）记录 */
function listTodayRecords(groupId, kind = 'tree') {
  const bucketId = todayBucketId(groupId, kind);
  const bucket = getState().buckets.find((item) => item.id === bucketId);
  if (!bucket) return [];
  return bucket.records.filter((item) => item.status === 'active');
}

function touchSession(session) {
  session.lastActivityAt = Math.floor(Date.now() / 1000);
}

/**
 * 新增捕获记录。pending=true 时先落库为「解析中」，提取完成后 finalizeRecord 回填，
 * 提取失败或判定非树障时 removeRecord 丢弃——保证提取期间的引用更正能定位到记录。
 * pushStatus：pending=待推送 / ok=已推送成功 / failed=推送失败（失败重扫补推）。
 */
function addRecord(session, record) {
  const entry = {
    id: id('rec'),
    msgId: record.msgId || '',
    senderId: record.senderId || '',
    senderName: record.senderName || '',
    coSenderId: record.coSenderId || '', // 协作供图人（引用他人图片报送/为他人记录补图时记录；发现人展示「记录者 供图者」，上限两人）
    coSenderName: record.coSenderName || '',
    content: record.content || '',
    capturedAt: record.capturedAt || Math.floor(Date.now() / 1000),
    extracted: record.extracted || {},
    lineNameRaw: record.lineNameRaw || '',
    matchedLine: record.matchedLine || null,
    matchStatus: record.matchStatus || 'unmatched',
    matchCandidates: record.matchCandidates || [],
    status: record.pending ? 'pending' : 'active',
    handledNote: record.handledNote || '',
    correctionHistory: [],
    photos: [], // 辅证照片：[{ id, msgId(图片消息 svr_id), senderId, capturedAt, file(相对 dataDir), bytes }]
    pushStatus: 'pending',
    pushedAt: null,
    pushError: '',
  };
  session.records.push(entry);
  touchSession(session);
  persist();
  return entry;
}

function finalizeRecord(record, fields) {
  Object.assign(record, fields);
  record.status = 'active';
}

function removeRecord(session, recordId) {
  session.records = session.records.filter((item) => item.id !== recordId);
  persist();
}

/**
 * 挂接辅证照片到记录（photos 字段防御初始化：兼容旧数据无该字段）。
 * photo: { msgId, senderId, capturedAt, file, bytes }，返回挂接条目。
 */
function addPhoto(record, photo) {
  if (!Array.isArray(record.photos)) record.photos = [];
  const entry = {
    id: id('pho'),
    msgId: photo.msgId || '',
    senderId: photo.senderId || '',
    capturedAt: photo.capturedAt || Math.floor(Date.now() / 1000),
    file: photo.file || '',
    bytes: Number(photo.bytes) || 0,
  };
  record.photos.push(entry);
  persist();
  return entry;
}

/** 按照片 id 或来源图片消息 svr_id 摘除记录的辅证照片，返回被摘条目（文件清理由调用方负责） */
function removePhoto(record, key) {
  if (!Array.isArray(record.photos)) return null;
  const idx = record.photos.findIndex((item) => item.id === key || (key && item.msgId === key));
  if (idx < 0) return null;
  const [removed] = record.photos.splice(idx, 1);
  persist();
  return removed;
}

function findRecordByMsgId(session, msgId) {
  if (!msgId) return null;
  return session.records.find((item) => item.msgId === msgId) || null;
}

function findRecordByContent(session, quotedContent) {
  const needle = String(quotedContent || '').trim();
  if (!needle) return null;
  const exact = session.records.filter((item) => item.content.trim() === needle);
  if (exact.length) return exact[exact.length - 1];
  const partial = session.records.filter((item) => needle.includes(item.content.trim()) || item.content.trim().includes(needle));
  return partial.length ? partial[partial.length - 1] : null;
}

/**
 * 应用更正补丁：原字段快照进 correctionHistory，再原地合并 patches。
 */
function applyCorrection(record, { patches, correctionText, byMsgId, bySenderId, bySenderName }) {
  record.correctionHistory.push({
    at: Math.floor(Date.now() / 1000),
    byMsgId: byMsgId || '',
    bySenderId: bySenderId || '',
    bySenderName: bySenderName || '',
    correctionText: correctionText || '',
    patches: patches || {},
    before: JSON.parse(JSON.stringify(record.extracted)),
  });
  Object.assign(record.extracted, patches || {});
}

function markHandled(record, { note, bySenderId, bySenderName }) {
  record.handledNote = note || '已处理';
  record.correctionHistory.push({
    at: Math.floor(Date.now() / 1000),
    bySenderId: bySenderId || '',
    bySenderName: bySenderName || '',
    correctionText: note || '',
    patches: null,
    before: null,
    kind: 'status',
  });
}

function saveSession(session) {
  touchSession(session);
  persist();
}

function markSessionSent(sessionId) {
  const session = getState().buckets.find((item) => item.id === sessionId);
  if (!session) return null;
  session.sentAt = Math.floor(Date.now() / 1000);
  persist();
  return session;
}

function listSessions(filter = {}) {
  const list = getState().buckets
    .filter((item) => (!filter.groupId || item.groupId === filter.groupId)
      && (!filter.status || item.status === filter.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  return list.map((item) => ({
    id: item.id,
    kind: bucketKind(item),
    ruleId: item.ruleId,
    ruleName: item.ruleName,
    groupId: item.groupId,
    groupName: item.groupName,
    teamName: item.teamName || '',
    startedAt: item.startedAt,
    lastActivityAt: item.lastActivityAt,
    sentAt: item.sentAt || null,
    pushedAt: item.pushedAt || null,
    pushMode: item.pushMode || '',
    pushResult: item.pushResult || '',
    status: item.status,
    recordCount: item.records.length,
    pendingCount: item.records.filter((rec) => rec.matchStatus !== 'ok').length,
    pushFailedCount: item.records.filter((rec) => rec.pushStatus === 'failed').length,
  }));
}

function getSession(sessionId) {
  return getState().buckets.find((item) => item.id === sessionId) || null;
}

/** 删除本地日桶（仅删本地数据，不联动壹匣删除已上报记录） */
function deleteSession(sessionId) {
  const current = getState();
  const before = current.buckets.length;
  current.buckets = current.buckets.filter((item) => item.id !== sessionId);
  if (current.buckets.length === before) return false;
  persist();
  return true;
}

function findRecord(recordId) {
  for (const bucket of getState().buckets) {
    const record = bucket.records.find((item) => item.id === recordId);
    if (record) return { session: bucket, record };
  }
  return null;
}

/* ------------------------- 删除事件重试队列 ------------------------- */

// 前 20 次按失败重扫节奏（≥5 分钟）补推；超过后降级为每天至多补推一次，事件保留至成功（删除不丢失）
const DELETE_RETRY_FAST_ATTEMPTS = 20;
const DELETE_RETRY_FAST_SEC = 5 * 60;
const DELETE_RETRY_SLOW_SEC = 24 * 3600;

/**
 * 删除事件入队（持久化，随日桶结构同一文件原子落盘，重启不丢）。
 * 幂等：同一记录只保留一条删除事件。应在推壹匣前调用（崩溃安全：重启后由重扫补推）。
 * event: { bucketId, ruleId, groupId, groupName, teamName, craneRecordId, msgId }
 */
function enqueuePendingDelete(session, record) {
  const current = getState();
  const existing = current.pendingDeletes.find((item) => item.craneRecordId === record.id);
  if (existing) return existing;
  const event = {
    id: id('del'),
    bucketId: session.id,
    kind: bucketKind(session), // 删除事件快照桶类型，补推时据此选择 treehazard / crossing ingest 地址
    ruleId: session.ruleId || '',
    groupId: session.groupId || '',
    groupName: session.groupName || '',
    teamName: session.teamName || '',
    craneRecordId: record.id,
    msgId: record.msgId || '',
    enqueuedAt: Math.floor(Date.now() / 1000),
    lastAttemptAt: null,
    attempts: 0,
    lastError: '',
  };
  current.pendingDeletes.push(event);
  persist();
  return event;
}

function listPendingDeletes() {
  return getState().pendingDeletes;
}

function removePendingDelete(eventId) {
  const current = getState();
  const before = current.pendingDeletes.length;
  current.pendingDeletes = current.pendingDeletes.filter((item) => item.id !== eventId);
  if (current.pendingDeletes.length === before) return false;
  persist();
  return true;
}

/** 删除事件一次补推失败：attempts+1 并记录时间/原因，返回最新条目 */
function settlePendingDelete(eventId, errorMessage) {
  const event = getState().pendingDeletes.find((item) => item.id === eventId);
  if (!event) return null;
  event.attempts += 1;
  event.lastAttemptAt = Math.floor(Date.now() / 1000);
  event.lastError = String(errorMessage || '');
  persist();
  return event;
}

/** 删除事件当前是否到补推时机（前 20 次 ≥5 分钟，之后每天一次） */
function pendingDeleteDue(event, now = Math.floor(Date.now() / 1000)) {
  const interval = event.attempts < DELETE_RETRY_FAST_ATTEMPTS ? DELETE_RETRY_FAST_SEC : DELETE_RETRY_SLOW_SEC;
  return !event.lastAttemptAt || now - event.lastAttemptAt >= interval;
}

/** 删除事件降级汇总日志节流：至多每天一次，返回 true 时调用方应打一条汇总日志 */
function shouldNoticePendingDeletes(now = Math.floor(Date.now() / 1000)) {
  const current = getState();
  if (!current.pendingDeletes.length) return false;
  if (now - (current.deleteNoticeAt || 0) < 24 * 3600) return false;
  current.deleteNoticeAt = now;
  persist();
  return true;
}

/**
 * 枚举所有桶中推送未成功的有效记录（失败重扫用）。
 * 已删/待删记录（deleting 标记或已有删除事件）一律跳过，避免把已删记录重新 upsert 回壹匣。
 */
function listUnpushedRecords() {
  const current = getState();
  const deletingIds = new Set(current.pendingDeletes.map((item) => item.craneRecordId));
  const out = [];
  for (const bucket of current.buckets) {
    for (const record of bucket.records) {
      if (record.status !== 'active' || record.pushStatus === 'ok') continue;
      if (record.deleting || deletingIds.has(record.id)) continue;
      out.push({ bucket, record });
    }
  }
  return out;
}

/**
 * 取该成员最近一次有效记录的线路名称（省略线路报送时自动补全用）：
 * 优先归一化匹配后的线路名（matchedLine.name），为空回退原始线路名（lineNameRaw）；
 * 仅统计 status=active 且未标 deleting 的记录，按 capturedAt 取最近一条。
 * kind 过滤：树障/交跨各自的线路补全只取同类桶记录（旧桶无 kind 视同 tree）。
 * @returns {string|null} 线路名或 null
 */
function findRecentLineBySender(senderId, kind = 'tree') {
  if (!senderId) return null;
  let best = null;
  for (const bucket of getState().buckets) {
    if (bucketKind(bucket) !== kind) continue;
    for (const record of bucket.records) {
      if (record.status !== 'active' || record.deleting) continue;
      if (record.senderId !== senderId) continue;
      const name = String((record.matchedLine && record.matchedLine.name) || record.lineNameRaw || '').trim();
      if (!name) continue;
      if (!best || record.capturedAt > best.capturedAt) best = { capturedAt: record.capturedAt, name };
    }
  }
  return best ? best.name : null;
}

/**
 * 撤回消息定位记录：推送的撤回事件不含被撤消息 ID，只能启发式匹配——
 * 在该群所有同类型（kind，缺省 tree）日桶中取最近 N 分钟内的记录（覆盖跨午夜边界）：
 * 优先撤回人时间窗内最近的一条记录；群主撤回他人消息等场景兜底为该群时间窗内最近一条。
 */
function findRecallTarget(groupId, senderId, windowSec = 180, kind = 'tree') {
  const now = Math.floor(Date.now() / 1000);
  const candidates = [];
  for (const bucket of getState().buckets) {
    if (bucket.groupId !== groupId) continue;
    if (bucketKind(bucket) !== kind) continue;
    for (const record of bucket.records) {
      if (now - record.capturedAt <= windowSec) candidates.push({ session: bucket, record });
    }
  }
  candidates.sort((a, b) => b.record.capturedAt - a.record.capturedAt);
  if (senderId) {
    const own = candidates.find((item) => item.record.senderId === senderId);
    if (own) return { session: own.session, record: own.record, matchedBy: 'sender' };
  }
  return candidates.length
    ? { session: candidates[0].session, record: candidates[0].record, matchedBy: 'latest' }
    : null;
}

/**
 * 同群当天两类日桶（树障/交跨）内依次定位记录：先树障桶、后交跨桶，
 * msgId（引用 svr_id）优先，content（引用原文）兜底。
 * 引用更正等需要跨桶定位的场景使用。
 * @returns {{ session: object, record: object, kind: 'tree'|'crossing' } | null}
 */
function findTodayRecord(groupId, { msgId = '', content = '' } = {}) {
  for (const kind of ['tree', 'crossing']) {
    const session = getState().buckets.find((item) => item.id === todayBucketId(groupId, kind));
    if (!session) continue;
    const record = (msgId && findRecordByMsgId(session, msgId))
      || (content && findRecordByContent(session, content));
    if (record) return { session, record, kind };
  }
  return null;
}

function assignRecordLine(recordId, matchedLine) {
  const found = findRecord(recordId);
  if (!found) return null;
  found.record.matchedLine = matchedLine;
  found.record.matchStatus = 'ok';
  found.record.matchCandidates = [];
  persist();
  return found.record;
}

module.exports = {
  initStore,
  bucketKind,
  beijingToday,
  purgeExpiredBuckets,
  getTodayBucket,
  listTodayRecords,
  addRecord,
  finalizeRecord,
  removeRecord,
  addPhoto,
  removePhoto,
  findRecordByMsgId,
  findRecordByContent,
  applyCorrection,
  markHandled,
  saveSession,
  markSessionSent,
  listSessions,
  getSession,
  deleteSession,
  findRecord,
  listUnpushedRecords,
  findRecentLineBySender,
  findRecallTarget,
  findTodayRecord,
  assignRecordLine,
  enqueuePendingDelete,
  listPendingDeletes,
  removePendingDelete,
  settlePendingDelete,
  pendingDeleteDue,
  shouldNoticePendingDeletes,
};
