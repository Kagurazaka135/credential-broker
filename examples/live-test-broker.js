const http = require('http');

function post(port, p, headers, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const h = { ...headers, 'content-type': 'application/json', 'content-length': data.length };
    const r = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: h }, x => {
      let b = ''; x.on('data', c => b += c);
      x.on('end', () => resolve({ status: x.statusCode, body: b.slice(0, 160) }));
    });
    r.on('error', reject); r.write(data); r.end();
  });
}

(async () => {
  const P = '说一个字';
  const tests = [
    ['9999 A格式 DS  local-broker', 9999, '/v1/messages', { 'x-api-key': 'local-broker' }, { model: 'deepseek-flash', max_tokens: 60, messages: [{ role: 'user', content: P }] }],
    ['9999 O格式 DS  local-broker', 9999, '/v1/chat/completions', { 'authorization': 'Bearer local-broker' }, { model: 'deepseek-flash', max_tokens: 60, messages: [{ role: 'user', content: P }] }],
    ['9997 A格式 GLM(OR) local-broker', 9997, '/v1/messages', { 'x-api-key': 'local-broker' }, { model: 'or/z-ai/glm-5.3@zai', max_tokens: 60, messages: [{ role: 'user', content: P }] }],
    ['9997 A格式 glm裸名 期望400', 9997, '/v1/messages', { 'x-api-key': 'local-broker' }, { model: 'glm-5.3', max_tokens: 60, messages: [{ role: 'user', content: P }] }],
    ['9997 O格式 OR  local-broker', 9997, '/v1/chat/completions', { 'authorization': 'Bearer local-broker' }, { model: 'or/openai/gpt-4o-mini', max_tokens: 60, messages: [{ role: 'user', content: P }] }],
  ];
  for (const [name, port, p, h, b] of tests) {
    try {
      const r = await post(port, p, h, b);
      console.log(name.padEnd(30), '->', r.status, '|', r.body.replace(/\s+/g, ' ').slice(0, 90));
    } catch (e) { console.log(name.padEnd(30), '-> ERR', e.message); }
  }
  for (const port of [9999, 9997]) {
    try {
      const r = await new Promise((res, rej) => {
        http.get({ host: '127.0.0.1', port, path: '/healthz' }, x => { let b = ''; x.on('data', c => b += c); x.on('end', () => res(b)); }).on('error', rej);
      });
      console.log('healthz'.padEnd(30), '->', port, r);
    } catch (e) { console.log('healthz', port, 'ERR', e.message); }
  }
})();
