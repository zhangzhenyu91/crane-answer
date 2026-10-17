const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const config = require('./config');
const {
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
} = require('./settings');
const { fetchTicket } = require('./wechatpadpro/client');

const SESSION_COOKIE = 'crane_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();
const publicDir = path.resolve(__dirname, '../public');

function parseCookies(req) {
  const cookies = {};
  for (const item of String(req.headers.cookie || '').split(';')) {
    const idx = item.indexOf('=');
    if (idx <= 0) continue;
    cookies[item.slice(0, idx).trim()] = decodeURIComponent(item.slice(idx + 1).trim());
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function cookieValue(req, value, maxAgeSeconds) {
  const secure = req.secure ? '; Secure' : '';
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function apiAuth(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ ok: false, error: { message: '登录已失效，请重新登录' } });
  req.session = session;
  next();
}

function pageAuth(req, res, next) {
  if (!getSession(req)) return res.redirect('/login.html');
  next();
}

function ok(res, data, status = 200) {
  return res.status(status).json({ ok: true, data });
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function createApp({ client }) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/api/health', (req, res) => ok(res, { status: 'up', time: new Date().toISOString() }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ ok: false, error: { message: '写接口仅支持 application/json' } });
    }
    next();
  });

  app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!safeEqual(username, config.adminUsername) || !safeEqual(password, config.adminPassword)) {
      return res.status(401).json({ ok: false, error: { message: '账号或密码不正确' } });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { username: config.adminUsername, expiresAt: Date.now() + SESSION_TTL_MS });
    res.set('Set-Cookie', cookieValue(req, token, SESSION_TTL_MS / 1000));
    return ok(res, { username: config.adminUsername });
  });

  app.get(['/', '/index.html'], pageAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDir, 'index.html'));
  });
  app.get('/login.html', (req, res, next) => {
    if (getSession(req)) return res.redirect('/');
    res.set('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', apiAuth);
  app.get('/api/auth/me', (req, res) => ok(res, { username: req.session.username }));
  app.post('/api/auth/logout', (req, res) => {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) sessions.delete(token);
    res.set('Set-Cookie', cookieValue(req, '', 0));
    return ok(res, { loggedOut: true });
  });
  app.get('/api/bootstrap', (req, res) => ok(res, {
    ...getPublicState(),
    user: { username: req.session.username },
  }));
  app.get('/api/status', (req, res) => ok(res, client.getStatus()));

  app.put('/api/settings', asyncRoute(async (req, res) => {
    const result = updateSettings(req.body || {});
    if (result.connectionChanged) await client.restart();
    return ok(res, result.state);
  }));
  app.post('/api/settings/test', asyncRoute(async (req, res) => {
    const current = getSettings();
    const wechat = buildWechat((req.body && req.body.wechat) || {}, current.wechat);
    const result = await fetchTicket(wechat);
    return ok(res, { connected: true, expiresIn: result.expiresIn || null });
  }));

  app.post('/api/rules', (req, res) => {
    createRule(req.body || {});
    return ok(res, getPublicState(), 201);
  });
  app.put('/api/rules/:id', (req, res) => {
    updateRule(req.params.id, req.body || {});
    return ok(res, getPublicState());
  });
  app.post('/api/rules/:id/copy', (req, res) => {
    copyRule(req.params.id);
    return ok(res, getPublicState(), 201);
  });
  app.post('/api/rules/:id/toggle', (req, res) => {
    toggleRule(req.params.id);
    return ok(res, getPublicState());
  });
  app.delete('/api/rules/:id', (req, res) => {
    deleteRule(req.params.id);
    return ok(res, getPublicState());
  });

  app.post('/api/aliases', (req, res) => {
    createAlias(req.body || {});
    return ok(res, getPublicState(), 201);
  });
  app.put('/api/aliases/:id', (req, res) => {
    updateAlias(req.params.id, req.body || {});
    return ok(res, getPublicState());
  });
  app.delete('/api/aliases/:id', (req, res) => {
    deleteAlias(req.params.id);
    return ok(res, getPublicState());
  });

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: { message: '接口不存在' } }));
  app.use(express.static(publicDir, { index: false, maxAge: 0 }));
  app.use((req, res) => res.status(404).send('Not Found'));
  app.use((err, req, res, next) => {
    const status = err.status || (err instanceof SyntaxError ? 400 : 500);
    if (status >= 500) console.error(`[server] ${err.stack || err}`);
    if (res.headersSent) return next(err);
    return res.status(status).json({ ok: false, error: { message: status >= 500 ? '服务端处理失败' : err.message } });
  });
  return app;
}

function createServer(options) {
  return http.createServer(createApp(options));
}

module.exports = { createServer };
