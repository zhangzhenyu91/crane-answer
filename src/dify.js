const { getSettings } = require('./settings');

const DEFAULT_RETRY_DELAY_MS = 5000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 单次调用 Dify workflow（blocking 模式）。
 */
async function runWorkflowOnce(apiKey, inputs) {
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

/**
 * 调用 Dify workflow（blocking 模式），inputs 原样透传。
 * options.retries：失败后间隔重试次数（默认 0）；options.retryDelayMs：重试间隔（默认 5000）。
 */
async function runWorkflow(apiKey, inputs, options = {}) {
  const retries = Number.isInteger(options.retries) && options.retries > 0 ? options.retries : 0;
  const delayMs = Number.isInteger(options.retryDelayMs) && options.retryDelayMs > 0
    ? options.retryDelayMs
    : DEFAULT_RETRY_DELAY_MS;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runWorkflowOnce(apiKey, inputs);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        console.warn(`[dify] 调用失败，${delayMs / 1000}s 后重试（第 ${attempt + 2} 次尝试）：${err.message}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

module.exports = { runWorkflow };
