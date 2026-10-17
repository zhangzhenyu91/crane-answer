const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

let settings = null;

function createError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function id(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function parsePairs(raw) {
  const pairs = [];
  for (const item of String(raw || '').split(',')) {
    const idx = item.indexOf(':');
    if (idx <= 0) continue;
    const key = item.slice(0, idx).trim();
    const value = item.slice(idx + 1).trim();
    if (key && value) pairs.push([key, value]);
  }
  return pairs;
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function defaultSettings() {
  const env = config.legacy;
  const groups = parsePairs(env.DIFY_GROUP_KEYS).map(([groupId, apiKey], index) => ({
    id: id('grp'),
    name: `吊车群 ${index + 1}`,
    groupId,
    apiKey,
  }));
  return {
    version: 1,
    wechat: {
      token: env.WECHATPADPRO_TOKEN || '',
      apiBase: trimTrailingSlash(env.WECHATPADPRO_API_BASE || 'https://api.wechatpadpro.com'),
      ticketPath: env.WECHATPADPRO_TICKET_PATH || '/cloud/v1/Runtime/WebSocketTicket',
      wsUrl: env.WECHATPADPRO_WS_URL || 'wss://api.wechatpadpro.com/ws/sync',
      logRawMessage: env.LOG_RAW_MESSAGE === '1',
    },
    dify: {
      apiBase: trimTrailingSlash(env.DIFY_API_BASE || 'https://ai.j1net.com/v1'),
      user: env.DIFY_USER || 'zhangzhenyu91',
      timeoutMs: Number(env.DIFY_TIMEOUT_MS) || 60000,
    },
    rules: [{
      id: id('rule'),
      name: '吊车群监听',
      isDefault: true,
      enabled: true,
      trigger: 'location',
      action: 'dify',
      groups,
    }],
    aliases: parsePairs(env.SENDER_NAME_MAP).map(([wxid, name]) => ({ id: id('alias'), wxid, name })),
  };
}

function settingsFile() {
  return path.join(config.dataDir, 'settings.json');
}

function persist() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = settingsFile();
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function initSettings() {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = settingsFile();
  if (!fs.existsSync(file)) {
    settings = defaultSettings();
    persist();
    return;
  }
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  const defaults = defaultSettings();
  settings = {
    ...defaults,
    ...loaded,
    wechat: { ...defaults.wechat, ...(loaded.wechat || {}) },
    dify: { ...defaults.dify, ...(loaded.dify || {}) },
    rules: Array.isArray(loaded.rules) ? loaded.rules : defaults.rules,
    aliases: Array.isArray(loaded.aliases) ? loaded.aliases : defaults.aliases,
  };
}

function getSettings() {
  if (!settings) throw new Error('配置尚未初始化');
  return settings;
}

function getPublicState() {
  const current = getSettings();
  return {
    wechat: {
      apiBase: current.wechat.apiBase,
      ticketPath: current.wechat.ticketPath,
      wsUrl: current.wechat.wsUrl,
      logRawMessage: Boolean(current.wechat.logRawMessage),
      hasToken: Boolean(current.wechat.token),
    },
    dify: { ...current.dify },
    rules: current.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      isDefault: Boolean(rule.isDefault),
      enabled: Boolean(rule.enabled),
      trigger: rule.trigger,
      action: rule.action,
      groups: (rule.groups || []).map((group) => ({
        id: group.id,
        name: group.name,
        groupId: group.groupId,
        hasKey: Boolean(group.apiKey),
      })),
    })),
    aliases: clone(current.aliases),
  };
}

function requiredText(value, label, maxLength = 128) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw createError(`请填写${label}`);
  if (text.length > maxLength) throw createError(`${label}不能超过 ${maxLength} 个字符`);
  return text;
}

function normalizeUrl(value, label, protocols, stripSlash = false) {
  const text = requiredText(value, label, 500);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw createError(`${label}格式不正确`);
  }
  if (!protocols.includes(parsed.protocol)) {
    throw createError(`${label}仅支持 ${protocols.join(' / ')} 协议`);
  }
  return stripSlash ? trimTrailingSlash(text) : text;
}

function buildWechat(input, current) {
  const data = input || {};
  const token = Object.prototype.hasOwnProperty.call(data, 'token')
    ? String(data.token || '').trim() || current.token
    : current.token;
  const ticketPath = requiredText(
    Object.prototype.hasOwnProperty.call(data, 'ticketPath') ? data.ticketPath : current.ticketPath,
    '换票接口路径',
    300
  );
  if (!ticketPath.startsWith('/')) throw createError('换票接口路径必须以 / 开头');
  return {
    token,
    apiBase: normalizeUrl(
      Object.prototype.hasOwnProperty.call(data, 'apiBase') ? data.apiBase : current.apiBase,
      'WeChatPadPro API Base',
      ['http:', 'https:'],
      true
    ),
    ticketPath,
    wsUrl: normalizeUrl(
      Object.prototype.hasOwnProperty.call(data, 'wsUrl') ? data.wsUrl : current.wsUrl,
      'WebSocket 地址',
      ['ws:', 'wss:']
    ),
    logRawMessage: Object.prototype.hasOwnProperty.call(data, 'logRawMessage')
      ? Boolean(data.logRawMessage)
      : Boolean(current.logRawMessage),
  };
}

function buildDify(input, current) {
  const data = input || {};
  const timeoutMs = Number(Object.prototype.hasOwnProperty.call(data, 'timeoutMs') ? data.timeoutMs : current.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000) {
    throw createError('Dify 调用超时必须是 1000-300000 的整数毫秒');
  }
  return {
    apiBase: normalizeUrl(
      Object.prototype.hasOwnProperty.call(data, 'apiBase') ? data.apiBase : current.apiBase,
      'Dify API Base',
      ['http:', 'https:'],
      true
    ),
    user: requiredText(Object.prototype.hasOwnProperty.call(data, 'user') ? data.user : current.user, 'Workflow User 标识'),
    timeoutMs,
  };
}

function updateSettings(input) {
  const current = getSettings();
  const nextWechat = buildWechat(input.wechat, current.wechat);
  const nextDify = buildDify(input.dify, current.dify);
  const connectionChanged = ['token', 'apiBase', 'ticketPath', 'wsUrl']
    .some((key) => nextWechat[key] !== current.wechat[key]);
  current.wechat = nextWechat;
  current.dify = nextDify;
  persist();
  return { connectionChanged, state: getPublicState() };
}

function buildRule(input, existing) {
  const data = input || {};
  const name = requiredText(data.name, '规则名称', 40);
  const trigger = data.trigger || 'location';
  const action = data.action || 'dify';
  if (trigger !== 'location') throw createError('当前仅支持位置消息触发');
  if (action !== 'dify') throw createError('当前仅支持 Dify Workflow 动作');
  if (!Array.isArray(data.groups) || !data.groups.length) throw createError('请至少配置一个监听群');
  if (data.groups.length > 100) throw createError('单条规则最多配置 100 个监听群');
  const seen = new Set();
  const groups = data.groups.map((item, index) => {
    const group = item || {};
    const groupName = requiredText(group.name, `监听群 ${index + 1} 的群备注`, 64);
    const groupId = requiredText(group.groupId, `监听群 ${index + 1} 的群 ID`);
    if (!/^\S+@chatroom$/.test(groupId)) throw createError(`监听群 ${index + 1} 的群 ID 应以 @chatroom 结尾`);
    if (seen.has(groupId)) throw createError(`群 ID ${groupId} 在当前规则中重复`);
    seen.add(groupId);
    const previous = existing && (existing.groups || []).find((entry) => entry.id === group.id);
    const apiKey = String(group.key || '').trim() || (previous && previous.apiKey) || '';
    if (!apiKey) throw createError(`请填写监听群 ${index + 1} 的 Dify API Key`);
    return {
      id: previous ? previous.id : id('grp'),
      name: groupName,
      groupId,
      apiKey,
    };
  });
  return {
    id: existing ? existing.id : id('rule'),
    name,
    isDefault: existing ? Boolean(existing.isDefault) : false,
    enabled: Object.prototype.hasOwnProperty.call(data, 'enabled') ? Boolean(data.enabled) : existing ? Boolean(existing.enabled) : true,
    trigger,
    action,
    groups,
  };
}

function createRule(input) {
  const rule = buildRule(input, null);
  getSettings().rules.push(rule);
  persist();
  return rule;
}

function requireRule(ruleId) {
  const rule = getSettings().rules.find((item) => item.id === ruleId);
  if (!rule) throw createError('监听规则不存在', 404);
  return rule;
}

function updateRule(ruleId, input) {
  const existing = requireRule(ruleId);
  const next = buildRule(input, existing);
  const index = getSettings().rules.findIndex((item) => item.id === ruleId);
  getSettings().rules[index] = next;
  persist();
  return next;
}

function copyRule(ruleId) {
  const source = requireRule(ruleId);
  const copy = clone(source);
  copy.id = id('rule');
  copy.name = `${source.name}（副本）`.slice(0, 40);
  copy.isDefault = false;
  copy.enabled = false;
  copy.groups = copy.groups.map((group) => ({ ...group, id: id('grp') }));
  getSettings().rules.push(copy);
  persist();
  return copy;
}

function toggleRule(ruleId) {
  const rule = requireRule(ruleId);
  rule.enabled = !rule.enabled;
  persist();
  return rule;
}

function deleteRule(ruleId) {
  requireRule(ruleId);
  const current = getSettings();
  current.rules = current.rules.filter((item) => item.id !== ruleId);
  persist();
}

function normalizeAlias(input, existing) {
  const data = input || {};
  const wxid = requiredText(data.wxid, '发送者 wxid');
  const name = requiredText(data.name, '显示名', 30);
  if (/\s/.test(wxid)) throw createError('发送者 wxid 不能包含空白字符');
  const duplicate = getSettings().aliases.find((item) => item.wxid === wxid && (!existing || item.id !== existing.id));
  if (duplicate) throw createError('该 wxid 已设置别名，请直接编辑原记录', 409);
  return { id: existing ? existing.id : id('alias'), wxid, name };
}

function createAlias(input) {
  const alias = normalizeAlias(input, null);
  getSettings().aliases.push(alias);
  persist();
  return alias;
}

function requireAlias(aliasId) {
  const alias = getSettings().aliases.find((item) => item.id === aliasId);
  if (!alias) throw createError('发送者别名不存在', 404);
  return alias;
}

function updateAlias(aliasId, input) {
  const existing = requireAlias(aliasId);
  const next = normalizeAlias(input, existing);
  const index = getSettings().aliases.findIndex((item) => item.id === aliasId);
  getSettings().aliases[index] = next;
  persist();
  return next;
}

function deleteAlias(aliasId) {
  requireAlias(aliasId);
  const current = getSettings();
  current.aliases = current.aliases.filter((item) => item.id !== aliasId);
  persist();
}

module.exports = {
  initSettings,
  getSettings,
  getPublicState,
  buildWechat,
  updateSettings,
  createRule,
  updateRule,
  copyRule,
  toggleRule,
  deleteRule,
  createAlias,
  updateAlias,
  deleteAlias,
};
