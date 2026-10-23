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
    lines: [],
    linesUpdatedAt: null,
    editingLines: [],
    sessions: [],
    currentSession: null,
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
      var page = btn.getAttribute('data-page');
      if (page === 'lines') loadLines(false).catch(function (err) { toast(err.message, 'error'); });
      if (page === 'inspection') loadSessions(false).catch(function (err) { toast(err.message, 'error'); });
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
    $('wppBotWxid').value = state.wechat.botWxid || '';
    $('wppFileAppId').value = state.wechat.fileAppId || '';
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
      var triggerCell = rule.trigger === 'treeWatch'
        ? '<td><span class="tag tag-green">输电班组运维</span><div class="cell-sub mono">树木排查 + 交跨排查 + 群内提问</div></td>'
        : '<td><span class="tag tag-blue">位置消息</span><div class="cell-sub mono">kind=location</div></td>';
      return '<tr>' +
        '<td><div class="rule-name">' + esc(rule.name) + (rule.isDefault ? '<span class="tag tag-blue">默认规则</span>' : '') + '</div><div class="cell-sub" title="' + esc(rule.id) + '">规则编号 ' + esc(rule.id.slice(-8)) + '</div></td>' +
        '<td><div class="group-chips">' + (chips || '<span class="cell-sub">未配置监听群</span>') + '</div><div class="cell-sub">共 ' + rule.groups.length + ' 个群</div></td>' +
        triggerCell +
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
    var isTreeWatch = $('ruleTrigger').value === 'treeWatch';
    $('groupList').innerHTML = state.editingGroups.map(function (group, index) {
      return '<div class="group-item" data-group-index="' + index + '">' +
        '<div class="group-item-head"><strong>监听群 ' + (index + 1) + '</strong>' + (group.hasKey ? '<span class="tag tag-green status-dot">Key 已配置</span>': '<span class="tag tag-orange">待配置 Key</span>') + '<button class="icon-btn" type="button" data-remove-group="' + index + '" aria-label="删除监听群">' + icon('trash', 14) + '</button></div>' +
        '<div class="group-fields">' +
          '<div class="form-field"><label>群备注 <span class="required">*</span></label><input class="input" data-group-field="name" value="' + esc(group.name) + '" placeholder="如：东区吊车协调群" autocomplete="off"></div>' +
          '<div class="form-field"><label>群 ID <span class="required">*</span></label><input class="input mono" data-group-field="groupId" value="' + esc(group.groupId) + '" placeholder="如：100860001@chatroom" autocomplete="off"></div>' +
          '<div class="form-field"><label>' + (isTreeWatch ? '提取工作流 API Key' : 'Dify API Key') + ' <span class="required">*</span></label><input class="input" type="password" data-group-field="key" value="' + esc(group.key || '') + '" placeholder="' + (group.hasKey ? '留空则保持已保存 Key' : '请输入 app-xxxxxxxx') + '" autocomplete="new-password"></div>' +
          (isTreeWatch ? '<div class="form-field"><label>更正提取 API Key <span class="required">*</span></label><input class="input" type="password" data-group-field="correctKey" value="' + esc(group.correctKey || '') + '" placeholder="' + (group.hasCorrectKey ? '留空则保持已保存 Key' : '请输入更正工作流 app-xxxxxxxx') + '" autocomplete="new-password"></div>' : '') +
          (isTreeWatch ? '<div class="form-field"><label>交跨提取 API Key（可空）</label><input class="input" type="password" data-group-field="crossingKey" value="' + esc(group.crossingKey || '') + '" placeholder="' + (group.hasCrossingKey ? '留空则保持已保存 Key' : '留空则不捕获交跨报送') + '" autocomplete="new-password"></div>' : '') +
          (isTreeWatch ? '<div class="form-field"><label>交跨更正 API Key（可空）</label><input class="input" type="password" data-group-field="crossingCorrectKey" value="' + esc(group.crossingCorrectKey || '') + '" placeholder="' + (group.hasCrossingCorrectKey ? '留空则保持已保存 Key' : '留空则不启用交跨更正') + '" autocomplete="new-password"></div>' : '') +
        '</div>' +
      '</div>';
    }).join('');
  }

  function updateAskHint() {
    var team = $('ruleTeamName').value.trim();
    $('ruleAskHint').textContent = '会话以『' + (team ? team + '群内提问' : '群内提问') + '』命名；@我 + 文字/引用文字/图片/文件/视频/语音即提问；可指定模型如『请使用K3』。';
  }

  function syncTriggerFields() {
    var isTreeWatch = $('ruleTrigger').value === 'treeWatch';
    $('treeWatchFields').hidden = !isTreeWatch;
    $('askFields').hidden = !isTreeWatch;
    $('ruleTriggerHint').textContent = isTreeWatch
      ? '输电班组运维：全天候监听捕获，按消息内容分流——树木排查（杆号+特征词）与交跨排查（交叉/跨越/交跨+杆号，需配置交跨提取 Key）各归各的日桶，逐条调用提取工作流并实时推送壹匣，引用记录的消息按记录类型调用对应更正工作流；@监听账号 可发「汇总」（两类当天 xlsx 发群）、「报送」（两类当天全部记录重推）或直接提问（见「群内提问」）。'
      : '仅当群成员发送有效位置消息时触发，自动提取经纬度、位置名称和发送者信息。';
    updateAskHint();
  }

  function openRuleEditor(rule) {
    state.editingRuleId = rule ? rule.id : null;
    state.editingGroups = rule ? clone(rule.groups) : [{ name: '', groupId: '', hasKey: false, key: '', hasCorrectKey: false, correctKey: '', hasCrossingKey: false, crossingKey: '', hasCrossingCorrectKey: false, crossingCorrectKey: '' }];
    $('ruleModalTitle').textContent = rule ? '编辑监听规则' : '新建监听规则';
    $('ruleName').value = rule ? rule.name : '';
    $('ruleTrigger').value = rule && rule.trigger === 'treeWatch' ? 'treeWatch' : 'location';
    $('ruleSummaryKeywords').value = rule && rule.summaryKeywords && rule.summaryKeywords.length ? rule.summaryKeywords.join(', ') : '汇总';
    $('ruleTeamName').value = rule && rule.teamName ? rule.teamName : '';
    $('ruleDigestKey').value = '';
    $('ruleDigestKey').placeholder = rule && rule.hasDigestKey ? '留空则保持已保存 Key' : '留空不启用；请输入 app-xxxxxxxx';
    var ask = (rule && rule.ask) || {};
    var askOn = rule ? ask.enabled !== false : true;
    $('ruleAskEnabledSwitch').classList.toggle('on', askOn);
    $('ruleAskEnabledSwitch').setAttribute('aria-checked', String(askOn));
    $('ruleAskEnabledText').textContent = askOn ? '启用' : '停用';
    $('ruleAskNameKey').value = '';
    $('ruleAskNameKey').placeholder = ask.hasAskNameKey ? '留空则保持已保存 Key' : '请输入 app-xxxxxxxx';
    var enabled = rule ? rule.enabled : true;
    $('ruleEnabledSwitch').classList.toggle('on', enabled);
    $('ruleEnabledSwitch').setAttribute('aria-checked', String(enabled));
    $('ruleEnabledText').textContent = enabled ? '启用' : '停用';
    syncTriggerFields();
    renderGroupEditor();
    openMask('ruleMask');
    setTimeout(function () { $('ruleName').focus(); }, 50);
  }

  $('ruleTrigger').addEventListener('change', function () {
    syncTriggerFields();
    renderGroupEditor();
  });

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
  $('ruleAskEnabledSwitch').addEventListener('click', function () {
    var on = !this.classList.contains('on');
    this.classList.toggle('on', on);
    this.setAttribute('aria-checked', String(on));
    $('ruleAskEnabledText').textContent = on ? '启用' : '停用';
  });
  $('ruleTeamName').addEventListener('input', updateAskHint);
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
      var trigger = $('ruleTrigger').value === 'treeWatch' ? 'treeWatch' : 'location';
      var groups = state.editingGroups.map(function (group, index) {
        if (!group.name.trim() || !group.groupId.trim()) throw new Error('请完整填写监听群 ' + (index + 1) + ' 的备注和群 ID');
        if (!group.hasKey && !(group.key || '').trim()) throw new Error('请填写监听群 ' + (index + 1) + ' 的 Dify API Key');
        var item = { id: group.id, name: group.name.trim(), groupId: group.groupId.trim(), key: (group.key || '').trim() };
        if (trigger === 'treeWatch') {
          if (!group.hasCorrectKey && !(group.correctKey || '').trim()) throw new Error('请填写监听群 ' + (index + 1) + ' 的更正提取 API Key');
          item.correctKey = (group.correctKey || '').trim();
          // 交跨子能力 Key 可空：留空提交保持已保存值（后端同 apiKey 口径），从未配置则不启用交跨
          item.crossingKey = (group.crossingKey || '').trim();
          item.crossingCorrectKey = (group.crossingCorrectKey || '').trim();
        }
        return item;
      });
      var payload = {
        name: name,
        enabled: $('ruleEnabledSwitch').classList.contains('on'),
        trigger: trigger,
        action: 'dify',
        groups: groups,
      };
      if (trigger === 'treeWatch') {
        var splitKeywords = function (raw) {
          return raw.split(/[,，]/).map(function (item) { return item.trim(); }).filter(Boolean);
        };
        payload.summaryKeywords = splitKeywords($('ruleSummaryKeywords').value);
        if (!payload.summaryKeywords.length) throw new Error('请填写汇总关键词');
        payload.teamName = $('ruleTeamName').value.trim();
        if (payload.teamName.length > 32) throw new Error('归属班组不能超过 32 个字符');
        payload.digestKey = $('ruleDigestKey').value.trim();
        if (payload.digestKey.length > 200) throw new Error('聊天日志总结工作流 API Key 不能超过 200 个字符');
        var askNameKey = $('ruleAskNameKey').value.trim();
        if (askNameKey.length > 200) throw new Error('文件名生成工作流 API Key 不能超过 200 个字符');
        payload.ask = {
          enabled: $('ruleAskEnabledSwitch').classList.contains('on'),
          nameApiKey: askNameKey,
        };
      }
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
      if (target.type === 'session') {
        await api('/api/inspection/sessions/' + encodeURIComponent(target.id), { method: 'DELETE' });
        state.deleteTarget = null;
        closeMask('confirmMask');
        await loadSessions(false);
        toast('已删除');
        return;
      }
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
      botWxid: $('wppBotWxid').value.trim(),
      fileAppId: $('wppFileAppId').value.trim(),
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

  /* ------------------------- 线路表 ------------------------- */

  async function loadLines(showFeedback) {
    var data = await api('/api/lines');
    state.lines = data.lines || [];
    state.linesUpdatedAt = data.updatedAt || null;
    state.editingLines = clone(state.lines);
    renderLines();
    if (showFeedback) toast('线路表已刷新', 'info');
  }

  function renderLines() {
    $('lineCount').textContent = '共 ' + state.editingLines.length + ' 条线路' + (state.linesUpdatedAt ? ' · 更新于 ' + new Date(state.linesUpdatedAt).toLocaleString('zh-CN', { hour12: false }) : '');
    if (!state.editingLines.length) {
      $('lineTableBody').innerHTML = '<tr><td colspan="4"><div class="empty"><div class="empty-icon">' + icon('rules', 24) + '</div><p>暂无线路，点击右上角「上传 xlsx 更新」导入一览表</p></div></td></tr>';
      return;
    }
    $('lineTableBody').innerHTML = state.editingLines.map(function (line, index) {
      return '<tr data-line-index="' + index + '">' +
        '<td><input class="table-input" data-line-field="voltage" value="' + esc(line.voltage) + '" placeholder="如：220" autocomplete="off"></td>' +
        '<td><input class="table-input" data-line-field="name" value="' + esc(line.name) + '" placeholder="如：孝南线" autocomplete="off"></td>' +
        '<td><input class="table-input" data-line-field="team" value="' + esc(line.team) + '" placeholder="如：检修一班" autocomplete="off"></td>' +
        '<td><button class="text-btn danger" data-remove-line="' + index + '" type="button">删除</button></td>' +
      '</tr>';
    }).join('');
  }

  $('refreshLinesBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, function () { return loadLines(true); });
  });
  $('addLineBtn').addEventListener('click', function () {
    state.editingLines.push({ voltage: '', name: '', team: '' });
    renderLines();
  });
  $('lineTableBody').addEventListener('input', function (event) {
    var input = event.target.closest('[data-line-field]');
    if (!input) return;
    var row = input.closest('[data-line-index]');
    var line = state.editingLines[Number(row.getAttribute('data-line-index'))];
    line[input.getAttribute('data-line-field')] = input.value;
  });
  $('lineTableBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-remove-line]');
    if (!btn) return;
    state.editingLines.splice(Number(btn.getAttribute('data-remove-line')), 1);
    renderLines();
  });
  $('saveLinesBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, async function () {
      var list = state.editingLines.map(function (line, index) {
        var name = (line.name || '').trim();
        if (!name) throw new Error('第 ' + (index + 1) + ' 行线路名称为空');
        return { voltage: (line.voltage || '').trim(), name: name, team: (line.team || '').trim() };
      });
      if (!list.length) throw new Error('线路表不能为空');
      await api('/api/lines', { method: 'PUT', body: { lines: list } });
      await loadLines(false);
      toast('线路表已保存');
    });
  });
  $('uploadLinesBtn').addEventListener('click', function () { $('linesFileInput').click(); });
  $('linesFileInput').addEventListener('change', function () {
    var file = this.files && this.files[0];
    this.value = '';
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var base64 = String(reader.result || '').split(',')[1] || '';
      if (!base64) { toast('文件读取失败', 'error'); return; }
      busy($('uploadLinesBtn'), async function () {
        var data = await api('/api/lines/upload', { method: 'POST', body: { fileBase64: base64 } });
        state.lines = data.lines || [];
        state.linesUpdatedAt = data.updatedAt || null;
        state.editingLines = clone(state.lines);
        renderLines();
        toast('已导入 ' + state.lines.length + ' 条线路');
      });
    };
    reader.onerror = function () { toast('文件读取失败', 'error'); };
    reader.readAsDataURL(file);
  });

  /* ------------------------- 排查记录 ------------------------- */

  function fmtTime(unix) {
    return unix ? new Date(unix * 1000).toLocaleString('zh-CN', { hour12: false }) : '-';
  }

  function showVal(value) {
    return value == null || String(value).trim() === '' ? '' : esc(String(value).trim());
  }

  /* 记录明细两套列头：树障（含状态/辅证）与交跨排查（含跨越字段/备注），按桶 kind 切换 */
  var TREE_RECORD_HEADERS = ['时间', '发现人', '报送原文', '线路名称', '区段', '树种', '数量', '水平', '垂直', '状态', '推送', '辅证', '更正'];
  var CROSSING_RECORD_HEADERS = ['时间', '发现人', '报送原文', '线路名称', '跨越区段', '跨越类型', '距小号侧（m）', '距大号侧（m）', '水平距离（m）', '垂直距离（m）', '交叉角（°）', '隐患', '备注', '推送', '更正'];

  async function loadSessions(showFeedback) {
    var data = await api('/api/inspection/sessions');
    state.sessions = data.sessions || [];
    renderSessions();
    if (showFeedback) toast('排查记录已刷新', 'info');
  }

  function renderSessions() {
    $('sessionCount').textContent = '共 ' + state.sessions.length + ' 个日桶';
    if (!state.sessions.length) {
      $('sessionTableBody').innerHTML = '<tr><td colspan="5"><div class="empty"><div class="empty-icon">' + icon('message', 24) + '</div><p>暂无排查记录，群内报送后按北京时间自然天自动归入当日记录</p></div></td></tr>';
      return;
    }
    $('sessionTableBody').innerHTML = state.sessions.map(function (session) {
      var statusCell = '<span class="tag tag-green">记录中</span>';
      if (session.sentAt) statusCell += '<div class="cell-sub"><span class="tag tag-blue">已发群 ' + fmtTime(session.sentAt).slice(5) + '</span></div>';
      if (session.pushedAt) {
        var pushOk = String(session.pushResult || '').indexOf('ok') === 0;
        statusCell += '<div class="cell-sub"><span class="tag ' + (pushOk ? 'tag-green' : 'tag-orange') + '">' + (session.pushMode === 'staging' ? '已暂存' : '已入库') + ' ' + fmtTime(session.pushedAt).slice(5) + '</span></div>';
      }
      if (session.pushFailedCount) {
        statusCell += '<div class="cell-sub"><span class="tag tag-red" title="记录推送壹匣失败，可在详情中单条重推">推送失败 ' + session.pushFailedCount + '</span></div>';
      }
      var countCell = '<span class="cell-main">' + session.recordCount + '</span>'
        + (session.pendingCount ? '<div class="cell-sub"><span class="tag tag-orange">待确认 ' + session.pendingCount + '</span></div>' : '');
      var actions = '<button class="text-btn primary" data-session-action="detail" data-id="' + esc(session.id) + '" type="button">详情</button>'
        + '<button class="text-btn" data-session-action="export" data-id="' + esc(session.id) + '" type="button">导出</button>'
        + '<button class="text-btn" data-session-action="send" data-id="' + esc(session.id) + '" type="button">发至群聊</button>'
        + '<button class="text-btn danger" data-session-action="delete" data-id="' + esc(session.id) + '" type="button">删除</button>';
      var idParts = String(session.id).split('_');
      var bucketDate = session.kind === 'crossing' ? idParts.slice(-2, -1)[0] : idParts.pop();
      return '<tr>' +
        '<td><span class="cell-main">' + esc(session.groupName || '未命名群') + '</span><div class="cell-sub mono">' + esc(session.groupId) + '</div></td>' +
        '<td>' + (session.kind === 'crossing' ? '<span class="tag tag-blue">交跨</span> ' : '') + '<span class="cell-main mono">' + esc(bucketDate) + '</span><div class="cell-sub">创建于 ' + fmtTime(session.startedAt) + '</div></td>' +
        '<td>' + statusCell + '</td>' +
        '<td>' + countCell + '</td>' +
        '<td><div class="actions">' + actions + '</div></td>' +
      '</tr>';
    }).join('');
  }

  $('refreshSessionsBtn').addEventListener('click', function () {
    var btn = this;
    busy(btn, function () { return loadSessions(true); });
  });

  $('sessionTableBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-session-action]');
    if (!btn) return;
    var id = btn.getAttribute('data-id');
    var action = btn.getAttribute('data-session-action');
    var session = state.sessions.find(function (item) { return item.id === id; });
    if (action === 'detail') openSessionDetail(id, btn);
    if (action === 'export') window.open('/api/inspection/sessions/' + encodeURIComponent(id) + '/export.xlsx', '_blank');
    if (action === 'send') {
      busy(btn, async function () {
        var result = await api('/api/inspection/sessions/' + encodeURIComponent(id) + '/send', { method: 'POST' });
        await loadSessions(false);
        toast('已发送至群聊：' + result.fileName);
      });
    }
    if (action === 'delete') {
      state.deleteTarget = { type: 'session', id: id };
      $('confirmText').innerHTML = '确定删除该日桶及其全部 <strong>' + (session ? session.recordCount : 0) + '</strong> 条记录吗？仅删本地数据，不联动壹匣删除已上报记录。此操作不可恢复。';
      openMask('confirmMask');
    }
  });

  function openSessionDetail(id, btn) {
    busy(btn, async function () {
      state.currentSession = await api('/api/inspection/sessions/' + encodeURIComponent(id));
      renderRecords();
      openMask('sessionMask');
    });
  }

  function recSection(ex) {
    var from = Number(ex.pole_from);
    var to = Number(ex.pole_to);
    if (!Number.isFinite(from) || from <= 0) return '';
    var note = String(ex.position_note || '').trim();
    var suffix = note && note !== '塔底' ? note : '';
    if (!Number.isFinite(to) || to <= 0 || to === from) return from + '#' + suffix;
    return from + '#-' + to + '#' + suffix;
  }

  /* 交跨记录侧别距离展示：与 export.js formatSideDistance 同口径（small/both → 小号侧，big → 大号侧） */
  function recSideDistance(ex, side) {
    var value = ex.distance == null ? '' : String(ex.distance).trim();
    if (!value) return '';
    var recordSide = String(ex.side || '').trim();
    if (side === 'small') return recordSide === 'small' || recordSide === 'both' ? value : '';
    return recordSide === 'big' ? value : '';
  }

  function renderRecords() {
    var session = state.currentSession;
    if (!session) return;
    var isCrossing = session.kind === 'crossing';
    var headers = isCrossing ? CROSSING_RECORD_HEADERS : TREE_RECORD_HEADERS;
    $('recordTableHead').innerHTML = headers.map(function (header) { return '<th>' + header + '</th>'; }).join('');
    $('sessionModalTitle').textContent = (session.groupName || '日桶') + ' · 当日记录明细';
    $('sessionModalSub').textContent = '日桶 ' + session.id + ' · 共 ' + session.records.length + ' 条' + (isCrossing ? ' · 交跨排查' : '');
    $('sessionPushStatus').textContent = session.pushedAt
      ? (session.pushMode === 'staging' ? '报送暂存' : '报送入库') + ' ' + fmtTime(session.pushedAt) + (session.pushResult ? ' · ' + session.pushResult : '')
      : '';
    if (!session.records.length) {
      $('recordTableBody').innerHTML = '<tr><td colspan="' + headers.length + '"><div class="empty"><p>该日桶没有捕获到记录</p></div></td></tr>';
      return;
    }
    $('recordTableBody').innerHTML = session.records.map(function (rec) {
      var ex = rec.extracted || {};
      var lineCell;
      if (rec.matchStatus === 'ok' && rec.matchedLine) {
        lineCell = '<span class="cell-main">' + esc(rec.matchedLine.name) + '</span>' + (rec.matchedLine.voltage ? '<div class="cell-sub">' + esc(rec.matchedLine.voltage) + 'kV</div>' : '');
      } else {
        var options = ['<option value="">待确认' + (rec.lineNameRaw ? '（' + esc(rec.lineNameRaw) + '）' : '') + '</option>'];
        state.lines.forEach(function (line) { options.push('<option value="' + esc(line.name) + '">' + esc(line.name) + '</option>'); });
        lineCell = '<select class="cell-select" data-assign-line="' + esc(rec.id) + '">' + options.join('') + '</select>';
      }
      /* 推送状态：成功绿 / 失败红（tooltip 带失败原因，旁附单条重推）/ 待推送灰 */
      var pushCell;
      if (rec.pushStatus === 'ok') {
        pushCell = '<span class="tag tag-green">已推送</span>';
      } else if (rec.pushStatus === 'failed') {
        pushCell = '<span class="tag tag-red" title="' + esc(rec.pushError || '') + '">推送失败</span>'
          + '<div class="cell-sub"><button class="text-btn primary" data-record-push="' + esc(rec.id) + '" type="button">重推</button></div>';
      } else {
        pushCell = '<span class="tag tag-gray">待推送</span>';
      }
      var corrCount = (rec.correctionHistory || []).filter(function (item) { return item.patches; }).length;
      /* 树障/交跨共用的前四列：时间 / 发现人 / 报送原文 / 线路名称 */
      var baseCells = '<td class="cell-sub">' + fmtTime(rec.capturedAt) + '</td>'
        + '<td>' + esc((rec.senderName || rec.senderId || '-') + (rec.coSenderId ? ' ' + (rec.coSenderName || rec.coSenderId) : '')) + '</td>'
        + '<td><div class="cell-main" style="max-width:260px;white-space:normal">' + esc(rec.content) + '</div></td>'
        + '<td>' + lineCell + '</td>';
      if (isCrossing) {
        return '<tr>' + baseCells
          + '<td>' + esc(recSection(ex)) + '</td>'
          + '<td>' + showVal(ex.crossing_type) + '</td>'
          + '<td>' + showVal(recSideDistance(ex, 'small')) + '</td>'
          + '<td>' + showVal(recSideDistance(ex, 'big')) + '</td>'
          + '<td>' + showVal(ex.cross_horizontal) + '</td>'
          + '<td>' + showVal(ex.cross_vertical) + '</td>'
          + '<td>' + showVal(ex.cross_angle) + '</td>'
          + '<td>' + showVal(ex.has_hazard) + '</td>'
          + '<td>' + showVal(ex.remark) + '</td>'
          + '<td>' + pushCell + '</td>'
          + '<td>' + (corrCount ? '<span class="tag tag-orange">' + corrCount + ' 次</span>' : '-') + '</td>'
        + '</tr>';
      }
      var vertical = ex.over_height != null && String(ex.over_height).trim() !== '' ? '超高' + String(ex.over_height).trim() : showVal(ex.vertical);
      var statusCell = rec.status === 'pending'
        ? '<span class="tag tag-blue">解析中</span>'
        : rec.handledNote ? '<span class="tag tag-green">' + esc(rec.handledNote) + '</span>' : '<span class="tag tag-gray">待处理</span>';
      /* 辅证照片：缩略图点击新标签看原图（附件接口登录态 Cookie 同源自带） */
      var photoCell = (rec.photos && rec.photos.length)
        ? rec.photos.map(function (ph) {
            var name = String(ph.file || '').split('/').pop();
            return '<a href="/api/inspection/attachments/' + encodeURIComponent(name) + '" target="_blank" title="查看辅证照片">'
              + '<img class="ph-thumb" src="/api/inspection/attachments/' + encodeURIComponent(name) + '" alt="辅证照片" loading="lazy"></a>';
          }).join('')
        : '-';
      return '<tr>' + baseCells
        + '<td>' + esc(recSection(ex)) + '</td>'
        + '<td>' + showVal(ex.tree_species) + '</td>'
        + '<td>' + showVal(ex.tree_count) + '</td>'
        + '<td>' + showVal(ex.horizontal) + '</td>'
        + '<td>' + vertical + '</td>'
        + '<td>' + statusCell + '</td>'
        + '<td>' + pushCell + '</td>'
        + '<td>' + photoCell + '</td>'
        + '<td>' + (corrCount ? '<span class="tag tag-orange">' + corrCount + ' 次</span>' : '-') + '</td>'
      + '</tr>';
    }).join('');
  }

  $('recordTableBody').addEventListener('change', function (event) {
    var select = event.target.closest('[data-assign-line]');
    if (!select || !select.value) return;
    var recordId = select.getAttribute('data-assign-line');
    select.disabled = true;
    api('/api/inspection/records/' + encodeURIComponent(recordId), { method: 'PATCH', body: { lineName: select.value } })
      .then(function (record) {
        if (state.currentSession) {
          var index = state.currentSession.records.findIndex(function (item) { return item.id === record.id; });
          if (index >= 0) state.currentSession.records[index] = record;
          renderRecords();
        }
        toast('线路已指定为 ' + record.matchedLine.name);
      })
      .catch(function (err) { toast(err.message, 'error'); select.disabled = false; });
  });

  /* 单条记录重推：实时推送失败记录旁的「重推」按钮 */
  $('recordTableBody').addEventListener('click', function (event) {
    var btn = event.target.closest('[data-record-push]');
    if (!btn) return;
    if (!state.currentSession) return;
    var rid = btn.getAttribute('data-record-push');
    busy(btn, async function () {
      await api('/api/inspection/sessions/' + encodeURIComponent(state.currentSession.id) + '/records/' + encodeURIComponent(rid) + '/push', { method: 'POST', body: {} });
      state.currentSession = await api('/api/inspection/sessions/' + encodeURIComponent(state.currentSession.id));
      renderRecords();
      loadSessions(false);
      toast('该条记录已重新推送');
    });
  });

  $('exportSessionBtn').addEventListener('click', function () {
    if (!state.currentSession) return;
    window.open('/api/inspection/sessions/' + encodeURIComponent(state.currentSession.id) + '/export.xlsx', '_blank');
  });

  /* 桶级推送：重推该日桶全部记录（direct） */
  function pushCurrentSession(btn) {
    if (!state.currentSession) return;
    busy(btn, async function () {
      var id = state.currentSession.id;
      var result = await api('/api/inspection/sessions/' + encodeURIComponent(id) + '/push', { method: 'POST', body: {} });
      state.currentSession = await api('/api/inspection/sessions/' + encodeURIComponent(id));
      renderRecords();
      loadSessions(false);
      toast(result.message || '重推完成');
    });
  }
  $('pushDirectBtn').addEventListener('click', function () { pushCurrentSession(this); });

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
