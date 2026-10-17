(function () {
  'use strict';

  var icons = {
    add: '<path d="M12 5v14M5 12h14"/>',
    refresh: '<path d="M20 6v5h-5"/><path d="M18.2 16.5a8 8 0 1 1 1.1-7.8L20 11"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.2v.2"/>',
    search: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="m16 16 4.2 4.2"/>',
    message: '<path d="M20 11.5a8 8 0 0 1-11.7 7.1L3.5 20l1.5-4.3A8 8 0 1 1 20 11.5z"/><path d="M8 10h8M8 13.5h5"/>',
    workflow: '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><path d="M9 6h4a4 4 0 0 1 4 4v5M15 18h-4a4 4 0 0 1-4-4V9"/>',
    link: '<path d="m10 14 4-4"/><path d="M7.5 16.5 6 18a3.5 3.5 0 0 1-5-5l3-3a3.5 3.5 0 0 1 5 0" transform="translate(3 0)"/><path d="m16.5 7.5 1.5-1.5a3.5 3.5 0 0 1 5 5l-3 3a3.5 3.5 0 0 1-5 0" transform="translate(-3 0)"/>',
    debug: '<path d="M8 9H4v6h4M16 9h4v6h-4M9 4h6l2 5v6l-2 5H9l-2-5V9z"/><path d="M9 12h6M12 4V2M8 5 6 3M16 5l2-2"/>',
    save: '<path d="M5 3h12l3 3v15H4V3z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    warning: '<path d="M10.2 4.1 2.7 17.2A2 2 0 0 0 4.4 20h15.2a2 2 0 0 0 1.7-2.8L13.8 4.1a2 2 0 0 0-3.6 0z"/><path d="M12 9v4M12 17h.01"/>',
    trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
    rules: '<path d="M9 5h11M9 12h11M9 19h11"/><path d="m3 5 1 1 2-2M3 12l1 1 2-2M3 19l1 1 2-2"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/>',
    error: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>'
  };

  var state = {
    user: null,
    wechat: null,
    dify: null,
    rules: [],
    aliases: [],
    editingRuleId: null,
    editingAliasId: null,
    editingGroups: [],
    deleteTarget: null,
    statusLoading: false,
  };

  function icon(name, size) {
    return '<svg width="' + (size || 16) + '" height="' + (size || 16) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (icons[name] || icons.info) + '</svg>';
  }

  function hydrateIcons(root) {
    (root || document).querySelectorAll('[data-icon]').forEach(function (el) {
      el.innerHTML = icon(el.getAttribute('data-icon'), el.getAttribute('data-icon-size') || 16);
    });
  }

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function $(id) { return document.getElementById(id); }

  async function api(path, options) {
    var opts = options || {};
    var method = (opts.method || 'GET').toUpperCase();
    var init = { method: method, credentials: 'same-origin', headers: {} };
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body || {});
    }
    var res = await fetch(path, init);
    var body = await res.json().catch(function () { return null; });
    if (res.status === 401) {
      window.location.replace('/login.html');
      throw new Error('登录已失效，请重新登录');
    }
    if (!res.ok || !body || !body.ok) {
      throw new Error(body && body.error ? body.error.message : '请求失败，请稍后重试');
    }
    return body.data;
  }

  function toast(message, type) {
    var el = document.createElement('div');
    el.className = 'toast ' + (type || 'success');
    el.innerHTML = icon(type === 'error' ? 'error' : type === 'info' ? 'info' : 'check', 16) + '<span>' + esc(message) + '</span>';
    $('toastWrap').appendChild(el);
    setTimeout(function () { el.remove(); }, 3500);
  }

  window.addEventListener('error', function (event) {
    toast('页面脚本异常：' + (event.error && event.error.message ? event.error.message : event.message), 'error');
  });
  window.addEventListener('unhandledrejection', function (event) {
    toast('页面请求异常：' + (event.reason && event.reason.message ? event.reason.message : String(event.reason)), 'error');
  });

  async function busy(btn, task) {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await task(); } catch (err) { toast(err.message, 'error'); } finally { btn.disabled = false; }
  }

  function openMask(id) {
    $(id).hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeMask(id) {
    $(id).hidden = true;
    if (!document.querySelector('.mask:not([hidden])')) document.body.classList.remove('modal-open');
  }

  document.querySelectorAll('[data-close]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeMask(btn.getAttribute('data-close')); });
  });
  document.querySelectorAll('.mask').forEach(function (mask) {
    mask.addEventListener('mousedown', function (event) {
      if (event.target === mask) closeMask(mask.id);
    });
  });
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    var open = document.querySelector('.mask:not([hidden])');
    if (open) closeMask(open.id);
  });

  document.querySelectorAll('.nav-item').forEach(function (btn) {
    btn.addEventListener('click', function () {
      document.querySelectorAll('.nav-item').forEach(function (item) {
        item.classList.toggle('on', item === btn);
        if (item === btn) item.setAttribute('aria-current', 'page');
        else item.removeAttribute('aria-current');
      });
      document.querySelectorAll('.page-panel').forEach(function (panel) {
        panel.hidden = panel.id !== 'page-' + btn.getAttribute('data-page');
      });
    });
  });

  function applyState(data) {
    if (data.user) state.user = data.user;
    state.wechat = data.wechat;
    state.dify = data.dify;
    state.rules = data.rules || [];
    state.aliases = data.aliases || [];
    if (state.user) $('adminName').textContent = state.user.username;
    renderRules();
    renderAliases();
  }

  function fillSettings() {
    if (!state.wechat || !state.dify) return;
    $('wppToken').value = '';
    $('tokenConfigured').hidden = !state.wechat.hasToken;
    $('wppToken').placeholder = state.wechat.hasToken ? '留空则保持已保存的 Token' : '请输入 Cloud Access Token';
    $('wppApiBase').value = state.wechat.apiBase;
    $('wppTicketPath').value = state.wechat.ticketPath;
    $('wppWsUrl').value = state.wechat.wsUrl;
    $('difyApiBase').value = state.dify.apiBase;
    $('difyUser').value = state.dify.user;
    $('difyTimeout').value = state.dify.timeoutMs;
    $('rawLogSwitch').classList.toggle('on', Boolean(state.wechat.logRawMessage));
    $('rawLogSwitch').setAttribute('aria-checked', String(Boolean(state.wechat.logRawMessage)));
  }

  async function loadBootstrap(showFeedback) {
    var data = await api('/api/bootstrap');
    applyState(data);
    fillSettings();
    if (showFeedback) toast('配置已刷新', 'info');
  }

  function renderRules() {
    var groupTotal = state.rules.reduce(function (sum, rule) { return sum + rule.groups.length; }, 0);
    $('ruleCount').textContent = '共 ' + state.rules.length + ' 条规则 · ' + groupTotal + ' 个监听群';
    if (!state.rules.length) {
      $('ruleTableBody').innerHTML = '<tr><td colspan="6"><div class="empty"><div class="empty-icon">' + icon('rules', 24) + '</div><p>暂无监听规则，点击右上角“新建规则”创建</p></div></td></tr>';
      return;
    }
    $('ruleTableBody').innerHTML = state.rules.map(function (rule) {
      var chips = rule.groups.slice(0, 2).map(function (group) { return '<span class="group-chip">' + esc(group.name || '未命名群') + '</span>'; }).join('');
      if (rule.groups.length > 2) chips += '<span class="group-chip">+' + (rule.groups.length - 2) + '</span>';
      return '<tr>' +
        '<td><div class="rule-name">' + esc(rule.name) + (rule.isDefault ? '<span class="tag tag-blue">默认规则</span>' : '') + '</div><div class="cell-sub" title="' + esc(rule.id) + '">规则编号 ' + esc(rule.id.slice(-8)) + '</div></td>' +
        '<td><div class="group-chips">' + (chips || '<span class="cell-sub">未配置监听群</span>') + '</div><div class="cell-sub">共 ' + rule.groups.length + ' 个群</div></td>' +
        '<td><span class="tag tag-blue">位置消息</span><div class="cell-sub mono">kind=location</div></td>' +
        '<td><span class="cell-main">Dify 工作流</span><div class="cell-sub">blocking 模式</div></td>' +
        '<td><div class="switch-line"><button class="switch' + (rule.enabled ? ' on' : '') + '" type="button" role="switch" aria-checked="' + rule.enabled + '" aria-label="切换规则状态" data-rule-action="toggle" data-id="' + esc(rule.id) + '"></button><span class="switch-label">' + (rule.enabled ? '启用' : '停用') + '</span></div></td>' +
        '<td><div class="actions"><button class="text-btn primary" data-rule-action="edit" data-id="' + esc(rule.id) + '" type="button">编辑</button><button class="text-btn" data-rule-action="copy" data-id="' + esc(rule.id) + '" type="button">复制</button><button class="text-btn" data-rule-action="toggle" data-id="' + esc(rule.id) + '" type="button">' + (rule.enabled ? '停用' : '启用') + '</button><button class="text-btn danger" data-rule-action="delete" data-id="' + esc(rule.id) + '" type="button">删除</button></div></td>' +
      '</tr>';
    }).join('');
  }

  function renderGroupEditor() {
    if (!state.editingGroups.length) {
      $('groupList').innerHTML = '<div class="empty" style="padding:24px"><p>尚未添加监听群，请点击右上角“添加监听群”</p></div>';
      return;
    }
    $('groupList').innerHTML = state.editingGroups.map(function (group, index) {
      return '<div class="group-item" data-group-index="' + index + '">' +
        '<div class="group-item-head"><strong>监听群 ' + (index + 1) + '</strong>' + (group.hasKey ? '<span class="tag tag-green status-dot">Key 已配置</span>': '<span class="tag tag-orange">待配置 Key</span>') + '<button class="icon-btn" type="button" data-remove-group="' + index + '" aria-label="删除监听群">' + icon('trash', 14) + '</button></div>' +
        '<div class="group-fields">' +
          '<div class="form-field"><label>群备注 <span class="required">*</span></label><input class="input" data-group-field="name" value="' + esc(group.name) + '" placeholder="如：东区吊车协调群" autocomplete="off"></div>' +
          '<div class="form-field"><label>群 ID <span class="required">*</span></label><input class="input mono" data-group-field="groupId" value="' + esc(group.groupId) + '" placeholder="如：100860001@chatroom" autocomplete="off"></div>' +
          '<div class="form-field"><label>Dify API Key <span class="required">*</span></label><input class="input" type="password" data-group-field="key" value="' + esc(group.key || '') + '" placeholder="' + (group.hasKey ? '留空则保持已保存 Key' : '请输入 app-xxxxxxxx') + '" autocomplete="new-password"></div>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  function openRuleEditor(rule) {
    state.editingRuleId = rule ? rule.id : null;
    state.editingGroups = rule ? clone(rule.groups) : [{ name: '', groupId: '', hasKey: false, key: '' }];
    $('ruleModalTitle').textContent = rule ? '编辑监听规则' : '新建监听规则';
    $('ruleName').value = rule ? rule.name : '';
    var enabled = rule ? rule.enabled : true;
    $('ruleEnabledSwitch').classList.toggle('on', enabled);
    $('ruleEnabledSwitch').setAttribute('aria-checked', String(enabled));
    $('ruleEnabledText').textContent = enabled ? '启用' : '停用';
    renderGroupEditor();
    openMask('ruleMask');
    setTimeout(function () { $('ruleName').focus(); }, 50);
  }

  $('addRuleBtn').addEventListener('click', function () { openRuleEditor(null); });
  $('refreshRulesBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, function () { return loadBootstrap(true); });
  });
  $('ruleEnabledSwitch').addEventListener('click', function () {
    var on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    this.setAttribute('aria-checked', String(on));
    $('ruleEnabledText').textContent = on ? '启用' : '停用';
  });
  $('addGroupBtn').addEventListener('click', function () {
    state.editingGroups.push({ name: '', groupId: '', hasKey: false, key: '' });
    renderGroupEditor();
    var items = $('groupList').querySelectorAll('.group-item');
    var last = items[items.length - 1];
    if (last) last.querySelector('input').focus();
  });
  $('groupList').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-remove-group]');
    if (!btn) return;
    state.editingGroups.splice(Number(btn.getAttribute('data-remove-group')), 1);
    renderGroupEditor();
  });
  $('groupList').addEventListener('input', function (event) {
    var input = event.target.closest('[data-group-field]');
    if (!input) return;
    var item = input.closest('[data-group-index]');
    var group = state.editingGroups[Number(item.getAttribute('data-group-index'))];
    group[input.getAttribute('data-group-field')] = input.value;
  });

  $('ruleTableBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-rule-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var rule = state.rules.find(function (item) { return item.id === id; });
    if (!rule) {
      toast('未找到对应规则，请刷新后重试', 'error');
      return;
    }
    var action = btn.getAttribute('data-rule-action');
    if (action === 'edit') openRuleEditor(rule);
    if (action === 'toggle') {
      busy(btn, async function () {
        applyState(await api('/api/rules/' + encodeURIComponent(id) + '/toggle', { method: 'POST' }));
        toast('规则已' + (rule.enabled ? '停用' : '启用'));
      });
    }
    if (action === 'copy') {
      busy(btn, async function () {
        applyState(await api('/api/rules/' + encodeURIComponent(id) + '/copy', { method: 'POST' }));
        toast('已复制规则，副本默认停用');
      });
    }
    if (action === 'delete') {
      state.deleteTarget = { type: 'rule', id: id };
      $('confirmText').innerHTML = '确定删除规则 <strong>“' + esc(rule.name) + '”</strong> 吗？删除后该规则下的 ' + rule.groups.length + ' 个监听群将不再触发此工作流。此操作不可恢复。';
      openMask('confirmMask');
    }
  });

  $('saveRuleBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      var name = $('ruleName').value.trim();
      if (!name) throw new Error('请输入规则名称');
      if (!state.editingGroups.length) throw new Error('请至少添加一个监听群');
      var groups = state.editingGroups.map(function (group, index) {
        if (!group.name.trim() || !group.groupId.trim()) throw new Error('请完整填写监听群 ' + (index + 1) + ' 的备注和群 ID');
        if (!group.hasKey && !(group.key || '').trim()) throw new Error('请填写监听群 ' + (index + 1) + ' 的 Dify API Key');
        return { id: group.id, name: group.name.trim(), groupId: group.groupId.trim(), key: (group.key || '').trim() };
      });
      var payload = {
        name: name,
        enabled: $('ruleEnabledSwitch').classList.contains('on'),
        trigger: 'location',
        action: 'dify',
        groups: groups,
      };
      var editing = Boolean(state.editingRuleId);
      var data = await api(editing ? '/api/rules/' + encodeURIComponent(state.editingRuleId) : '/api/rules', {
        method: editing ? 'PUT' : 'POST',
        body: payload,
      });
      applyState(data);
      closeMask('ruleMask');
      toast(editing ? '规则已保存' : '规则已创建');
    });
  });

  function renderAliases() {
    var keyword = $('aliasSearch').value.trim().toLowerCase();
    var list = state.aliases.filter(function (item) {
      return !keyword || item.wxid.toLowerCase().indexOf(keyword) >= 0 || item.name.toLowerCase().indexOf(keyword) >= 0;
    });
    $('aliasCount').textContent = keyword ? '找到 ' + list.length + ' 条匹配记录' : '共 ' + state.aliases.length + ' 条别名';
    if (!list.length) {
      $('aliasTableBody').innerHTML = '<tr><td colspan="3"><div class="empty"><div class="empty-icon">' + icon('search', 24) + '</div><p>' + (keyword ? '没有匹配的发送者别名' : '暂无发送者别名') + '</p></div></td></tr>';
      return;
    }
    $('aliasTableBody').innerHTML = list.map(function (item) {
      return '<tr><td class="mono">' + esc(item.wxid) + '</td><td><span class="cell-main">' + esc(item.name) + '</span></td><td><div class="actions"><button class="text-btn primary" data-alias-action="edit" data-id="' + esc(item.id) + '" type="button">编辑</button><button class="text-btn danger" data-alias-action="delete" data-id="' + esc(item.id) + '" type="button">删除</button></div></td></tr>';
    }).join('');
  }

  function openAliasEditor(item) {
    state.editingAliasId = item ? item.id : null;
    $('aliasModalTitle').textContent = item ? '编辑发送者别名' : '新增发送者别名';
    $('aliasWxid').value = item ? item.wxid : '';
    $('aliasName').value = item ? item.name : '';
    openMask('aliasMask');
    setTimeout(function () { (item ? $('aliasName') : $('aliasWxid')).focus(); }, 50);
  }

  $('addAliasBtn').addEventListener('click', function () { openAliasEditor(null); });
  $('aliasSearch').addEventListener('input', renderAliases);
  $('aliasTableBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-alias-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var item = state.aliases.find(function (alias) { return alias.id === id; });
    if (!item) return;
    if (btn.getAttribute('data-alias-action') === 'edit') openAliasEditor(item);
    else {
      state.deleteTarget = { type: 'alias', id: id };
      $('confirmText').innerHTML = '确定删除 <strong>“' + esc(item.name) + '”</strong> 的手动别名吗？删除后将恢复为群成员接口自动解析显示名。';
      openMask('confirmMask');
    }
  });
  $('saveAliasBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      var wxid = $('aliasWxid').value.trim();
      var name = $('aliasName').value.trim();
      if (!wxid || !name) throw new Error('请完整填写 wxid 和显示名');
      var editing = Boolean(state.editingAliasId);
      var data = await api(editing ? '/api/aliases/' + encodeURIComponent(state.editingAliasId) : '/api/aliases', {
        method: editing ? 'PUT' : 'POST',
        body: { wxid: wxid, name: name },
      });
      applyState(data);
      closeMask('aliasMask');
      toast(editing ? '别名已更新' : '别名已新增');
    });
  });

  $('confirmDeleteBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      if (!state.deleteTarget) return;
      var target = state.deleteTarget;
      var data = await api('/api/' + (target.type === 'rule' ? 'rules/' : 'aliases/') + encodeURIComponent(target.id), { method: 'DELETE' });
      state.deleteTarget = null;
      applyState(data);
      closeMask('confirmMask');
      toast('已删除');
    });
  });

  $('rawLogSwitch').addEventListener('click', function () {
    var on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    this.setAttribute('aria-checked', String(on));
  });

  function wechatPayload() {
    return {
      token: $('wppToken').value,
      apiBase: $('wppApiBase').value.trim(),
      ticketPath: $('wppTicketPath').value.trim(),
      wsUrl: $('wppWsUrl').value.trim(),
      logRawMessage: $('rawLogSwitch').classList.contains('on'),
    };
  }

  $('testConnectionBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      var result = await api('/api/settings/test', { method: 'POST', body: { wechat: wechatPayload() } });
      toast('连接测试成功' + (result.expiresIn ? '，票据有效期 ' + result.expiresIn + ' 秒' : ''));
    });
  });

  $('saveSettingsBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      var timeout = Number($('difyTimeout').value);
      if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 300000) throw new Error('Dify 调用超时应在 1000–300000 毫秒之间');
      var data = await api('/api/settings', {
        method: 'PUT',
        body: {
          wechat: wechatPayload(),
          dify: { apiBase: $('difyApiBase').value.trim(), user: $('difyUser').value.trim(), timeoutMs: timeout },
        },
      });
      applyState(data);
      fillSettings();
      refreshStatus();
      toast('接入设置已保存');
    });
  });

  async function refreshStatus() {
    if (state.statusLoading) return;
    state.statusLoading = true;
    try {
      var status = await api('/api/status');
      var text = '通道未连接';
      var cls = 'off';
      if (status.state === 'online') { text = '实时通道正常'; cls = ''; }
      else if (['connecting', 'connected', 'reconnecting'].includes(status.state)) { text = '通道连接中'; cls = 'pending'; }
      else if (status.state === 'not_configured') { text = '等待接入配置'; cls = 'pending'; }
      $('channelStatusText').textContent = text;
      $('channelStatus').className = 'channel-status' + (cls ? ' ' + cls : '');
    } catch (err) {
      $('channelStatusText').textContent = '状态获取失败';
      $('channelStatus').className = 'channel-status off';
    } finally {
      state.statusLoading = false;
    }
  }

  $('logoutBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      await api('/api/auth/logout', { method: 'POST' });
      window.location.replace('/login.html');
    });
  });

  hydrateIcons();
  document.querySelectorAll('.confirm-icon').forEach(function (el) { el.innerHTML = icon('warning', 24); });
  (async function () {
    try {
      await loadBootstrap(false);
      refreshStatus();
      setInterval(refreshStatus, 15000);
    } catch (err) {
      toast(err.message, 'error');
    }
  })();
})();
