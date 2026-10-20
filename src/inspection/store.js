const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

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

function initStore() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = storeFile();
  if (fs.existsSync(file)) {
    const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
    state = {
      version: 1,
      sessions: Array.isArray(loaded.sessions) ? loaded.sessions : [],
    };
    return;
  }
  state = { version: 1, sessions: [] };
  persist();
}

function getState() {
  if (!state) throw new Error('排查记录存储尚未初始化');
  return state;
}

function getActiveSession(groupId) {
  return getState().sessions.find((item) => item.groupId === groupId && item.status === 'active') || null;
}

function startSession({ ruleId, ruleName, groupId, groupName, startedBy, startedByName }) {
  const existing = getActiveSession(groupId);
  if (existing) return { session: existing, created: false };
  const now = Math.floor(Date.now() / 1000);
  const session = {
    id: id('ses'),
    ruleId,
    ruleName,
    groupId,
    groupName,
    startedBy,
    startedByName,
    startedAt: now,
    lastActivityAt: now,
    endedAt: null,
    endReason: null,
    status: 'active',
    records: [],
  };
  getState().sessions.push(session);
  persist();
  return { session, created: true };
}

function endSession(sessionId, reason) {
  const session = getState().sessions.find((item) => item.id === sessionId);
  if (!session || session.status !== 'active') return null;
  session.status = 'ended';
  session.endedAt = Math.floor(Date.now() / 1000);
  session.endReason = reason || 'manual';
  persist();
  return session;
}

/**
 * 超时扫描：活动会话自最后活动起超过 timeoutHours 未捕获新内容则自动结束。
 * @param {(session: object) => number} resolveTimeoutHours 按会话所属规则取超时小时数
 * @returns {object[]} 本次被结束的会话
 */
function sweepStaleSessions(resolveTimeoutHours) {
  const now = Math.floor(Date.now() / 1000);
  const ended = [];
  for (const session of getState().sessions) {
    if (session.status !== 'active') continue;
    const hours = Number(resolveTimeoutHours(session)) || 12;
    if (now - (session.lastActivityAt || session.startedAt) >= hours * 3600) {
      session.status = 'ended';
      session.endedAt = now;
      session.endReason = 'timeout';
      ended.push(session);
    }
  }
  if (ended.length) persist();
  return ended;
}

function touchSession(session) {
  session.lastActivityAt = Math.floor(Date.now() / 1000);
}

/**
 * 新增捕获记录。pending=true 时先落库为「解析中」，提取完成后 finalizeRecord 回填，
 * 提取失败或判定非树障时 removeRecord 丢弃——保证提取期间的引用更正能定位到记录。
 */
function addRecord(session, record) {
  const entry = {
    id: id('rec'),
    msgId: record.msgId || '',
    senderId: record.senderId || '',
    senderName: record.senderName || '',
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
  const session = getState().sessions.find((item) => item.id === sessionId);
  if (!session) return null;
  session.sentAt = Math.floor(Date.now() / 1000);
  persist();
  return session;
}

/**
 * 取该群最近一次已成功发送汇总 xlsx 的会话（按 sentAt 倒序），用于「推送壹匣」指令定位。
 */
function findLatestSentSession(groupId) {
  return getState().sessions
    .filter((item) => item.groupId === groupId && item.sentAt)
    .sort((a, b) => b.sentAt - a.sentAt)[0] || null;
}

function listSessions(filter = {}) {
  const list = getState().sessions
    .filter((item) => (!filter.groupId || item.groupId === filter.groupId)
      && (!filter.status || item.status === filter.status))
    .sort((a, b) => b.startedAt - a.startedAt);
  return list.map((item) => ({
    id: item.id,
    ruleId: item.ruleId,
    ruleName: item.ruleName,
    groupId: item.groupId,
    groupName: item.groupName,
    startedBy: item.startedBy,
    startedByName: item.startedByName,
    startedAt: item.startedAt,
    lastActivityAt: item.lastActivityAt,
    endedAt: item.endedAt,
    endReason: item.endReason,
    sentAt: item.sentAt || null,
    pushedAt: item.pushedAt || null,
    pushMode: item.pushMode || '',
    pushResult: item.pushResult || '',
    status: item.status,
    recordCount: item.records.length,
    pendingCount: item.records.filter((rec) => rec.matchStatus !== 'ok').length,
  }));
}

function getSession(sessionId) {
  return getState().sessions.find((item) => item.id === sessionId) || null;
}

function deleteSession(sessionId) {
  const current = getState();
  const before = current.sessions.length;
  current.sessions = current.sessions.filter((item) => item.id !== sessionId);
  if (current.sessions.length === before) return false;
  persist();
  return true;
}

function findRecord(recordId) {
  for (const session of getState().sessions) {
    const record = session.records.find((item) => item.id === recordId);
    if (record) return { session, record };
  }
  return null;
}

/**
 * 撤回消息定位记录：推送的撤回事件不含被撤消息 ID，只能启发式匹配——
 * 优先撤回人在时间窗内最近的一条记录；群主撤回他人消息等场景兜底为该群时间窗内最近一条。
 */
function findRecallTarget(groupId, senderId, windowSec = 600) {
  const now = Math.floor(Date.now() / 1000);
  const sessions = getState().sessions
    .filter((item) => item.groupId === groupId)
    .sort((a, b) => (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) || b.lastActivityAt - a.lastActivityAt);
  let fallback = null;
  for (const session of sessions) {
    const candidates = session.records
      .filter((item) => now - item.capturedAt <= windowSec)
      .sort((a, b) => b.capturedAt - a.capturedAt);
    if (senderId) {
      const own = candidates.find((item) => item.senderId === senderId);
      if (own) return { session, record: own, matchedBy: 'sender' };
    }
    if (!fallback && candidates.length) fallback = { session, record: candidates[0], matchedBy: 'latest' };
  }
  return fallback;
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
  getActiveSession,
  startSession,
  endSession,
  sweepStaleSessions,
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
  findLatestSentSession,
  listSessions,
  getSession,
  deleteSession,
  findRecord,
  findRecallTarget,
  assignRecordLine,
};
