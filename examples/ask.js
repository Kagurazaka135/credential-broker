/**
 * ask.js — 走本地 broker 问任意模型（**换模型只改 MODEL**）
 *
 * 用法：改下面「改这里」两块 → node ask.js
 *   node ask.js          # 默认 9999
 *   node ask.js 9997     # 指定端口
 *
 * 走本地凭证代理，key 是假 key `local-broker` —— **本文件里没有任何真 key**。
 * 换模型只改 MODEL：
 *   deepseek-flash / deepseek-v4-pro        → DeepSeek
 *   glm-5.3                                 → 阿里百炼
 *   or/openai/gpt-4o-mini                   → OpenRouter（测各家走 or/ 前缀）
 *   or/google/gemini-2.5-pro
 *   or/anthropic/claude-opus-4.7
 */
const http = require('http');

// ==================== 改这里 ====================
const MODEL = 'deepseek-flash';
const QUESTIONS = [
  '用一句话介绍你自己',
];
// ===============================================

const PORT = process.argv[2] || '9999';
const FAKE_KEY = 'local-broker';

function ask(question) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({
      model: MODEL,
      max_tokens: 2000,
      messages: [{ role: 'user', content: question }],
    }));
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      path: '/v1/chat/completions',      // OpenAI 格式，各上游都认
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + FAKE_KEY,
        'content-length': body.length,
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        let answer = buf;
        try {
          const j = JSON.parse(buf);
          answer = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content)
            || (j.error && ('错误: ' + JSON.stringify(j.error)))
            || buf;
        } catch (_) { /* 非 JSON 原样返回 */ }
        resolve({ status: res.statusCode, answer });
      });
    });
    req.on('error', (e) => resolve({ status: 0, answer: '请求失败: ' + e.message }));
    req.write(body);
    req.end();
  });
}

(async () => {
  for (const q of QUESTIONS) {
    console.log('================================================');
    console.log('模型: ' + MODEL + '   端口: ' + PORT);
    console.log('问: ' + q);
    console.log('------------------------------------------------');
    const r = await ask(q);
    console.log('[' + r.status + '] ' + String(r.answer).trim());
    console.log('');
  }
})();
