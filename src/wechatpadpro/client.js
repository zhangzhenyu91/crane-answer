const WebSocket = require('ws');
const { getSettings } = require('../settings');

const PING_INTERVAL_MS = 25 * 1000;
const STALE_CHECK_INTERVAL_MS = 30 * 1000;
const STALE_TIMEOUT_MS = 90 * 1000;
const MAX_RECONNECT_DELAY_MS = 30 * 1000;

async function fetchTicket(wechat) {
  if (!wechat.token) throw new Error('未配置 WeChatPadPro Cloud Access Token');
  const url = `${wechat.apiBase}${wechat.ticketPath}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Cloud-Access-Token': wechat.token,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });

  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`换票接口返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
  }

  if (!res.ok || !body.Success || !body.Data || !body.Data.ticket) {
    throw new Error(`换票失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }
  return { ticket: body.Data.ticket, expiresIn: body.Data.expires_in };
}

class WeChatPadProClient {
  constructor({ onMessage, onReady } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onReady = onReady || (() => {});
    this.ws = null;
    this.stopped = true;
    this.state = 'stopped';
    this.generation = 0;
    this.reconnectAttempts = 0;
    this.lastSeenAt = 0;
    this.lastReadyAt = 0;
    this.pingTimer = null;
    this.staleTimer = null;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    const { wechat } = getSettings();
    if (!wechat.token) {
      this.state = 'not_configured';
      console.warn('[wechatpadpro] 未配置 Access Token，请在 Web 管理页完成接入设置');
      return;
    }
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.state = 'stopped';
    this.generation += 1;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, 'client shutdown');
      } catch {
        // 忽略关闭异常
      }
    }
  }

  async restart() {
    this.stop();
    this.reconnectAttempts = 0;
    await this.start();
  }

  getStatus() {
    return {
      state: this.state,
      reconnectAttempts: this.reconnectAttempts,
      lastSeenAt: this.lastSeenAt || null,
      lastReadyAt: this.lastReadyAt || null,
    };
  }

  async connect() {
    const generation = ++this.generation;
    this.clearTimers();
    const { wechat } = getSettings();
    if (!wechat.token) {
      this.state = 'not_configured';
      return;
    }
    this.state = this.reconnectAttempts ? 'reconnecting' : 'connecting';
    let ticket;
    try {
      ({ ticket } = await fetchTicket(wechat));
    } catch (err) {
      if (generation !== this.generation || this.stopped) return;
      console.error(`[wechatpadpro] 获取票据失败：${err.message}`);
      this.scheduleReconnect();
      return;
    }
    if (generation !== this.generation || this.stopped) return;

    const url = `${wechat.wsUrl}?ticket=${encodeURIComponent(ticket)}`;
    console.log('[wechatpadpro] 正在建立 WebSocket 连接…');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      if (generation !== this.generation) return;
      console.log('[wechatpadpro] WebSocket 已连接，等待实时通道就绪…');
      this.state = 'connected';
      this.lastSeenAt = Date.now();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
      this.staleTimer = setInterval(() => this.checkStale(generation), STALE_CHECK_INTERVAL_MS);
    });

    ws.on('message', (data) => {
      if (generation === this.generation) this.handleRaw(data);
    });
    ws.on('pong', () => {
      if (generation === this.generation) this.lastSeenAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      if (generation !== this.generation) return;
      console.log(`[wechatpadpro] 连接关闭 code=${code} reason=${reason || '(无)'}`);
      this.ws = null;
      this.state = 'offline';
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (generation === this.generation) console.error(`[wechatpadpro] 连接错误：${err.message}`);
    });
  }

  handleRaw(data) {
    this.lastSeenAt = Date.now();
    const text = data.toString();
    let raw;
    try {
      raw = JSON.parse(text);
    } catch {
      console.warn(`[wechatpadpro] 收到非 JSON 数据：${text.slice(0, 200)}`);
      return;
    }

    const { wechat } = getSettings();
    if (wechat.logRawMessage) console.log('[wechatpadpro] RAW:', text);

    const payload = raw.Data;
    if (payload && payload.type === 'connection_ready') {
      console.log(`[wechatpadpro] ${raw.Message || '实时消息通道已就绪'}`);
      this.reconnectAttempts = 0;
      this.state = 'online';
      this.lastReadyAt = Date.now();
      this.onReady();
      return;
    }

    const messages = payload && payload.data && Array.isArray(payload.data.messages)
      ? payload.data.messages
      : null;
    if (messages) {
      for (const msg of messages) {
        try {
          this.onMessage(msg, raw);
        } catch (err) {
          console.error(`[wechatpadpro] 消息处理异常：${err.stack || err}`);
        }
      }
      return;
    }

    if (!wechat.logRawMessage) {
      console.log('[wechatpadpro] 收到非消息类推送（可在接入设置中开启原始报文日志）');
    }
  }

  checkStale(generation) {
    if (generation !== this.generation || this.stopped || !this.ws) return;
    if (Date.now() - this.lastSeenAt > STALE_TIMEOUT_MS) {
      console.warn('[wechatpadpro] 连接长时间无数据，主动断开并重建…');
      this.ws.terminate();
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    this.clearTimers();
    const generation = ++this.generation;
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    this.reconnectAttempts += 1;
    this.state = 'reconnecting';
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** (this.reconnectAttempts - 1));
    console.log(`[wechatpadpro] ${delay / 1000}s 后进行第 ${this.reconnectAttempts} 次重连…`);
    this.reconnectTimer = setTimeout(() => {
      if (generation === this.generation) this.connect();
    }, delay);
  }

  clearTimers() {
    for (const key of ['pingTimer', 'staleTimer', 'reconnectTimer']) {
      if (this[key]) {
        clearInterval(this[key]);
        clearTimeout(this[key]);
        this[key] = null;
      }
    }
  }
}

module.exports = WeChatPadProClient;
module.exports.fetchTicket = fetchTicket;
