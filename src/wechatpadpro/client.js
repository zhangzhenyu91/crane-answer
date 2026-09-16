const WebSocket = require('ws');
const config = require('../config');

const PING_INTERVAL_MS = 25 * 1000; // 客户端心跳
const STALE_CHECK_INTERVAL_MS = 30 * 1000; // 活性检查周期
const STALE_TIMEOUT_MS = 90 * 1000; // 超过该时长无任何数据则判定连接已死
const MAX_RECONNECT_DELAY_MS = 30 * 1000;

class WeChatPadProClient {
  /**
   * @param {(msg: object, raw: object) => void} onMessage 收到单条消息
   * @param {() => void} onReady 实时通道就绪（收到 connection_ready）
   */
  constructor({ onMessage, onReady } = {}) {
    this.onMessage = onMessage || (() => {});
    this.onReady = onReady || (() => {});
    this.ws = null;
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.lastSeenAt = 0;
    this.pingTimer = null;
    this.staleTimer = null;
    this.reconnectTimer = null;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      try {
        this.ws.close(1000, 'client shutdown');
      } catch {
        // 忽略关闭异常
      }
    }
  }

  async fetchTicket() {
    const url = `${config.apiBase}${config.ticketPath}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Cloud-Access-Token': config.token,
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

  async connect() {
    this.clearTimers();
    let ticket;
    try {
      ({ ticket } = await this.fetchTicket());
    } catch (err) {
      console.error(`[wechatpadpro] 获取票据失败：${err.message}`);
      this.scheduleReconnect();
      return;
    }

    const url = `${config.wsUrl}?ticket=${encodeURIComponent(ticket)}`;
    console.log('[wechatpadpro] 正在建立 WebSocket 连接…');
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      console.log('[wechatpadpro] WebSocket 已连接，等待实时通道就绪…');
      this.lastSeenAt = Date.now();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.ping();
      }, PING_INTERVAL_MS);
      this.staleTimer = setInterval(() => this.checkStale(), STALE_CHECK_INTERVAL_MS);
    });

    ws.on('message', (data) => this.handleRaw(data));
    ws.on('pong', () => {
      this.lastSeenAt = Date.now();
    });

    ws.on('close', (code, reason) => {
      console.log(`[wechatpadpro] 连接关闭 code=${code} reason=${reason || '(无)'}`);
      if (!this.stopped) this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      // error 之后必跟随 close，重连逻辑放在 close 里统一处理
      console.error(`[wechatpadpro] 连接错误：${err.message}`);
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

    if (config.logRawMessage) {
      console.log('[wechatpadpro] RAW:', text);
    }

    const payload = raw.Data;
    if (payload && payload.type === 'connection_ready') {
      console.log(`[wechatpadpro] ${raw.Message || '实时消息通道已就绪'}`);
      this.reconnectAttempts = 0;
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

    // 其他类型的推送（状态同步等），仅在调试模式下可见
    if (!config.logRawMessage) {
      console.log('[wechatpadpro] 收到非消息类推送（设 LOG_RAW_MESSAGE=1 可查看原文）');
    }
  }

  checkStale() {
    if (this.stopped || !this.ws) return;
    if (Date.now() - this.lastSeenAt > STALE_TIMEOUT_MS) {
      console.warn('[wechatpadpro] 连接长时间无数据，主动断开并重建…');
      this.ws.terminate();
    }
  }

  scheduleReconnect() {
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    if (this.stopped) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(MAX_RECONNECT_DELAY_MS, 1000 * 2 ** (this.reconnectAttempts - 1));
    console.log(`[wechatpadpro] ${delay / 1000}s 后进行第 ${this.reconnectAttempts} 次重连…`);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
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
