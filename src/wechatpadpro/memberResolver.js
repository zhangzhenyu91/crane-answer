const { getSettings } = require('../settings');

const CACHE_TTL_MS = 10 * 60 * 1000;
const groupCache = new Map();

async function fetchGroupMembers(groupId) {
  const { wechat } = getSettings();
  const url = `${wechat.apiBase}/v1/Group/GetChatRoomMemberDetail`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Cloud-Access-Token': wechat.token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ QID: groupId }),
  });
  const body = await res.json().catch(() => null);
  const members = body && body.Success
    && body.Data && body.Data.NewChatroomData
    && body.Data.NewChatroomData.ChatRoomMember;

  if (!res.ok || !Array.isArray(members)) {
    throw new Error(`获取群成员失败（HTTP ${res.status}）：${JSON.stringify(body).slice(0, 200)}`);
  }

  const map = new Map();
  for (const m of members) {
    if (m.UserName) map.set(m.UserName, m.DisplayName || m.NickName || '');
  }
  return map;
}

async function getGroupMembers(groupId) {
  const cached = groupCache.get(groupId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.members;
  }
  const members = await fetchGroupMembers(groupId);
  groupCache.set(groupId, { fetchedAt: Date.now(), members });
  return members;
}

/**
 * 解析发送者显示名：手动别名 > 群成员接口（群昵称>微信昵称）> wxid 兜底。
 */
async function resolveDisplayName(groupId, wxid) {
  if (!wxid) return '';
  const { aliases } = getSettings();
  const override = aliases.find((item) => item.wxid === wxid);
  if (override) return override.name;
  try {
    const members = await getGroupMembers(groupId);
    return members.get(wxid) || wxid;
  } catch (err) {
    console.warn(`[成员解析] ${err.message}，使用 wxid 兜底`);
    return wxid;
  }
}

/**
 * 反解析：显示名 → wxid（手动别名 > 群成员接口）。用于撤回事件解析撤回人。
 */
async function resolveWxidByName(groupId, name) {
  if (!name) return '';
  const { aliases } = getSettings();
  const alias = aliases.find((item) => item.name === name);
  if (alias) return alias.wxid;
  try {
    const members = await getGroupMembers(groupId);
    for (const [wxid, display] of members) {
      if (display === name) return wxid;
    }
  } catch (err) {
    console.warn(`[成员解析] 反查失败：${err.message}`);
  }
  return '';
}

module.exports = { resolveDisplayName, resolveWxidByName };
