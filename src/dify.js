const config = require('./config');

/**
 * 调用 Dify workflow（blocking 模式）。
 * @param {string} apiKey 该群对应的 Dify API Key
 * @param {{ lng: number|string, lat: number|string, nickname: string, wxid: string }} inputs
 * @returns {Promise<object>} Dify 响应体
 */
async function runWorkflow(apiKey, inputs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.difyTimeoutMs);
  try {
    const res = await fetch(`${config.difyApiBase}/workflows/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: {
          lng: String(inputs.lng ?? ''),
          lat: String(inputs.lat ?? ''),
          nickname: inputs.nickname || '',
          wxid: inputs.wxid || '',
        },
        response_mode: 'blocking',
        user: config.difyUser,
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`Dify 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(`Dify 调用失败（HTTP ${res.status}）：${text.slice(0, 300)}`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runWorkflow };
