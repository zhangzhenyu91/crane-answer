const config = require('../config');

const CACHE_TTL_MS = 10 * 60 * 1000; // 群成员缓存 10 分钟
const groupCache = new Map(); // groupId -> { fetchedAt, members: Map<wxid, displayName> }

async function fetchGroupMembers(groupId) {
  const url = `${config.apiBase}/v1/Group/GetChatRoomMemberDetail`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Cloud-Access-Token': config.token,
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

  // 显示名优先级：群昵称 DisplayName > 微信昵称 NickName
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
 * 解析发送者显示名：env 映射（SENDER_NAME_MAP）> 群成员接口 > wxid 兜底。
 */
async function resolveDisplayName(groupId, wxid) {
  if (!wxid) return '';
  const override = config.senderNameMap.get(wxid);
  if (override) return override;
  try {
    const members = await getGroupMembers(groupId);
    return members.get(wxid) || wxid;
  } catch (err) {
    console.warn(`[成员解析] ${err.message}，使用 wxid 兜底`);
    return wxid;
  }
}

module.exports = { resolveDisplayName };
