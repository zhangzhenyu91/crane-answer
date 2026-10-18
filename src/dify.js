const { getSettings } = require('./settings');

/**
 * 调用 Dify workflow（blocking 模式）。
 * @param {string} apiKey 该群对应的 Dify API Key
 * @param {object} inputs 工作流输入变量，键名需与 Dify 侧定义一致，原样透传
 * @returns {Promise<object>} Dify 响应体
 */
async function runWorkflow(apiKey, inputs) {
  const { dify } = getSettings();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), dify.timeoutMs);
  try {
    const res = await fetch(`${dify.apiBase}/workflows/run`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        inputs: inputs || {},
        response_mode: 'blocking',
        user: dify.user,
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
