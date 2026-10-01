#!/usr/bin/env node
'use strict';
/**
 * broker.cjs — 本地凭证代理（Credential Broker）
 *
 * 客户端只拿: baseUrl = http://127.0.0.1:<port>   apiKey = local-broker
 * 真钥匙只读于: secrets.json（默认 ~/.claude/secrets.json，可用
 *              BROKER_SECRETS_PATH 覆盖）—— 唯一王冠珠
 *
 * 用法:
 *   node broker.cjs --port 9999     # 主实例（Claude Code 走这条）
 *   node broker.cjs --port 9997     # 副实例（滚动升级 / 项目测试）
 *
 * 路由（零协议转换，按 路径格式 × 模型名 选上游）:
 *   POST /v1/messages          Anthropic 格式
 *   POST /v1/chat/completions  OpenAI   格式
 *   model 以 or/ 开头   -> openrouter（经 v2ray 隧道），模型名剥去 or/
 *                          可加 @tag 钉供给方：@zai|@zhipu -> Z.AI，@ali|@alibaba -> Alibaba
 *   model 以 mimo 开头  -> xiaomi（小米直连，不经隧道）
 *   model 以 glm 开头   -> 400 拒绝（旧阿里百炼路已移除，请改用 or/z-ai/glm-* 全名）
 *   其他               -> deepseek
 *
 * 客户端 key 双认:
 *   local-broker          -> 换成 secrets.json 里的真 key
 *   其他（含真 key）      -> 透传（保持切换前行为）
 *   secrets.json 读不到   -> 降级透传 + WARN，绝不 crash
 *
 * 用量记录:
 *   每个已完成的转发追加一行 JSON 到 usage-<port>.jsonl（可用 BROKER_USAGE 覆盖）：
 *   时间/上游/模型/输入输出/缓存 token/状态。只记数字与模型名，不记 body/header/key。
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------- 参数 ----------
function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}
const PORT = parseInt(argValue('--port') || process.env.BROKER_PORT || '9999', 10);
const HOST = argValue('--host') || process.env.BROKER_HOST || '127.0.0.1';
const SECRETS_PATH = process.env.BROKER_SECRETS_PATH || path.join(os.homedir(), '.claude', 'secrets.json');
const LOG_PATH = process.env.BROKER_LOG || path.join(__dirname, 'broker-' + PORT + '.log');
const USAGE_PATH = process.env.BROKER_USAGE || path.join(__dirname, 'usage-' + PORT + '.jsonl');
const DEFAULT_ACCEPT_TOKEN = 'local-broker';

const UPSTREAMS = {
  deepseek:   { host: 'api.deepseek.com',   aPrefix: '/anthropic', oPrefix: '' },
  xiaomi:     { host: 'api.xiaomimimo.com', aPrefix: '/anthropic', oPrefix: '' },
  openrouter: { host: 'openrouter.ai',      aPrefix: '/api',       oPrefix: '/api', tunnel: true },
};

// 模型名 @tag 后缀 -> OpenRouter 供给方名（provider.order 用）
const PROVIDER_PINS = {
  zai: 'Z.AI', zhipu: 'Z.AI',
  ali: 'Alibaba', alibaba: 'Alibaba',
};

// ---------- 日志（只记时间/方法/路径/模型/状态码/耗时/上游名；不记 body、不记 header、不记 key） ----------
function log(msg) {
  try { fs.appendFileSync(LOG_PATH, new Date().toISOString() + ' ' + msg + '\n'); } catch (_) { /* 日志失败不影响转发 */ }
}
try { // 简易轮转：超过 5MB 时重命名为 .1
  const st = fs.statSync(LOG_PATH);
  if (st.size > 5 * 1024 * 1024) fs.renameSync(LOG_PATH, LOG_PATH + '.1');
} catch (_) {}

// ---------- 用量记录（只记数字，不记内容） ----------
let usageWrites = 0;
function recordUsage(rec) {
  try {
    fs.appendFileSync(USAGE_PATH, JSON.stringify(rec) + '\n');
    if ((++usageWrites & 0x7f) === 0) {   // 每 ~128 次检查一次体积
      try {
        const st = fs.statSync(USAGE_PATH);
        if (st.size > 32 * 1024 * 1024) fs.renameSync(USAGE_PATH, USAGE_PATH + '.1');
      } catch (_) {}
    }
  } catch (_) { /* 统计失败绝不影响转发 */ }
}

// 从上游响应里抠出 token 用量。Anthropic 与 OpenAI 字段名不同，分别解析。
// SSE 用逐行 data: 解析（末尾 message_delta / 末块 usage 才带 output）；非流式整体 JSON.parse。
function createUsageSniffer(isAnthropic, isSSE) {
  const acc = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, served: null, seen: false };

  function absorbAnthropic(obj) {
    if (obj && typeof obj.model === 'string') acc.served = obj.model;
    const u = (obj && obj.type === 'message_start' && obj.message && obj.message.usage)
      ? obj.message.usage
      : (obj && obj.usage);
    if (u && typeof u === 'object') {
      if (typeof u.input_tokens === 'number') acc.input = u.input_tokens;
      if (typeof u.output_tokens === 'number') acc.output = Math.max(acc.output, u.output_tokens);
      if (typeof u.cache_read_input_tokens === 'number') acc.cacheRead = u.cache_read_input_tokens;
      if (typeof u.cache_creation_input_tokens === 'number') acc.cacheWrite = u.cache_creation_input_tokens;
      acc.seen = true;
    }
  }
  function absorbOpenAI(obj) {
    if (obj && typeof obj.model === 'string') acc.served = obj.model;
    const u = obj && obj.usage;
    if (u && typeof u === 'object') {
      if (typeof u.prompt_tokens === 'number') acc.input = u.prompt_tokens;
      if (typeof u.completion_tokens === 'number') acc.output = u.completion_tokens;
      const cached = u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens;
      if (typeof cached === 'number') acc.cacheRead = cached;
      acc.seen = true;
    }
  }
  const absorb = isAnthropic ? absorbAnthropic : absorbOpenAI;

  let sseBuf = '';
  let parts = null;
  let bytes = 0;

  function feed(chunk) {
    if (isSSE) {
      sseBuf += chunk.toString('utf8');
      if (sseBuf.length > 2 * 1024 * 1024) sseBuf = sseBuf.slice(-1024 * 1024);  // 上限保护
      let nl;
      while ((nl = sseBuf.indexOf('\n')) !== -1) {
        let line = sseBuf.slice(0, nl).trim();
        sseBuf = sseBuf.slice(nl + 1);
        if (!line || line[0] === ':') continue;                 // 注释/心跳行
        if (line.startsWith('data:')) line = line.slice(5).trim();
        if (!line || line === '[DONE]') continue;
        let obj; try { obj = JSON.parse(line); } catch (_) { continue; }
        try { absorb(obj); } catch (_) {}
      }
    } else {
      bytes += chunk.length;
      if (bytes > 8 * 1024 * 1024) { parts = null; return; }    // 超大整包放弃统计
      (parts || (parts = [])).push(chunk);
    }
  }
  function finish() {
    if (!isSSE && parts) {
      try { absorb(JSON.parse(Buffer.concat(parts).toString('utf8'))); } catch (_) {}
    }
    return acc;
  }
  return { feed, finish, acc };
}

// ---------- secrets.json（唯一读者） ----------
let secrets = null;          // 最近一次成功解析的内容
let lastAttempt = 0;         // 上次尝试读取时间（ms）
let warnedDegraded = false;
let warnedReloadFail = false;

function getSecrets() {
  const now = Date.now();
  if (now - lastAttempt < 10000) return secrets;   // 10s 内不重复读盘
  lastAttempt = now;
  let ok = false;
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') { secrets = parsed; ok = true; warnedReloadFail = false; }
  } catch (_) { /* 读不到 / 解析不了 */ }
  if (ok) {
    if (warnedDegraded) { log('SECRETS: recovered (' + SECRETS_PATH + ')'); warnedDegraded = false; }
  } else if (!secrets) {
    if (!warnedDegraded) { log('SECRETS: WARN unavailable (' + SECRETS_PATH + ') -> degraded passthrough mode'); warnedDegraded = true; }
  } else if (!warnedReloadFail) {
    log('SECRETS: WARN reload failed, keep last good copy'); warnedReloadFail = true;
  }
  return secrets;
}

function acceptToken() {
  const s = getSecrets();
  return (s && typeof s.accept_token === 'string' && s.accept_token) || DEFAULT_ACCEPT_TOKEN;
}
function isPlaceholder(value) {
  if (value === undefined || value === null) return false;
  const raw = String(value).replace(/^Bearer\s+/i, '').trim();
  return raw === acceptToken();
}
function keyFor(upstream, fmt) {
  const s = getSecrets();
  const u = s && s.upstreams && s.upstreams[upstream];
  if (!u) return null;
  if (fmt === 'openai') return u.openai_key || u.anthropic_key || null;
  return u.anthropic_key || u.openai_key || null;
}

// ---------- Anthropic 格式专属 hack（只作用于 /v1/messages 分支） ----------

function stripReasoningControls(obj) {
  if (!obj || typeof obj !== 'object') return;
  delete obj.reasoning_effort;
  delete obj.reasoningEffort;
  delete obj.reasoning;
  delete obj.reasoning_config;
  delete obj.reasoningConfig;
  for (const value of Object.values(obj)) stripReasoningControls(value);
}

function stripThinkingBlocks(value) {
  if (Array.isArray(value)) {
    return value
      .filter(item => !(item && typeof item === 'object' && (item.type === 'thinking' || item.type === 'redacted_thinking')))
      .map(stripThinkingBlocks);
  }
  if (!value || typeof value !== 'object') return value;
  for (const [key, child] of Object.entries(value)) {
    value[key] = stripThinkingBlocks(child);
  }
  return value;
}

function normalizeSystemText(text) {
  if (typeof text !== 'string') return text;
  text = text.replace(/\(cch=[a-f0-9]{5}\)\n?/g, '');                        // 剥归因头（保缓存前缀稳定）
  text = text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})/g, '__TIME__');
  text = text.replace(/C:\\Users\\[^\\\s]+/gi, '__HOME__');
  text = text.replace(/\/home\/[^\/\s]+/g, '__HOME__');
  return text;
}

function normalizeSystemContent(content) {
  if (typeof content === 'string') return normalizeSystemText(content);
  if (Array.isArray(content)) {
    return content.map(item => {
      if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
        return { ...item, text: normalizeSystemText(item.text) };
      }
      return item;
    });
  }
  return content;
}

function sortTools(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.slice().sort((a, b) => {
    const na = (a.function && a.function.name) || '';
    const nb = (b.function && b.function.name) || '';
    return na.localeCompare(nb);
  });
}

// ---------- 路由 ----------
function routeFor(model) {
  if (/^or\//i.test(model)) {
    const rest = model.slice(3);
    const at = rest.lastIndexOf('@');
    if (at > 0) {
      const tag = rest.slice(at + 1).toLowerCase();
      const provider = PROVIDER_PINS[tag] || null;
      return { upstream: 'openrouter', model: rest.slice(0, at), provider, badTag: provider ? null : tag };
    }
    return { upstream: 'openrouter', model: rest };
  }
  if (/^mimo/i.test(model)) return { upstream: 'xiaomi', model };
  if (/^glm/i.test(model))  return { upstream: 'reject', model };   // 旧百炼路已移除
  return { upstream: 'deepseek', model };
}

// ---------- v2ray 隧道（OR 出海；从 or-relay.cjs 吸收） ----------
function openTunnel(targetHost, cfg) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: cfg.host,
      port: cfg.port,
      method: 'CONNECT',
      path: targetHost + ':443',
      headers: { Host: targetHost + ':443' },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) { socket.destroy(); return reject(new Error('CONNECT ' + res.statusCode)); }
      resolve(socket);
    });
    req.on('error', reject);
    req.end();
  });
}

class TunnelAgent extends https.Agent {
  constructor(socket) {
    super({ keepAlive: false, maxSockets: 1 });
    this._socket = socket;
  }
  createConnection(options, callback) {
    if (typeof callback === 'function') { process.nextTick(callback, null, this._socket); return; }
    return this._socket;
  }
}

function tunnelConfig() {
  const s = getSecrets();
  const v = (s && s.v2ray) || {};
  return { host: v.host || '127.0.0.1', port: v.port || 10809 };
}

// ---------- 主处理 ----------
const srv = http.createServer((req, res) => {
  const started = Date.now();

  // 健康检查（无 key 信息）
  if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
    const body = JSON.stringify({ ok: true, service: 'credential-broker', port: PORT, listen: HOST, secrets: getSecrets() ? 'ok' : 'degraded' });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body);
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', async () => {
    try {
      await handle(req, res, Buffer.concat(chunks), started);
    } catch (error) {
      const msg = (error && error.message) || String(error);
      log('PARSE_ERR ' + req.method + ' ' + req.url + ' :: ' + msg);
      try {
        if (!res.headersSent) { res.writeHead(400); res.end('Bad Request: ' + msg); } else { res.destroy(); }
      } catch (_) {}
    }
  });
});

async function handle(req, res, rawBody, started) {
  const isAnthropic = !req.url.startsWith('/v1/chat/completions');   // 其余路径沿用旧行为，按 Anthropic 分支
  let data = rawBody.length ? JSON.parse(rawBody.toString('utf-8')) : null;
  const model0 = data && typeof data.model === 'string' ? data.model : '';
  const route = routeFor(model0);

  // ---- 拒绝：glm*（旧百炼路已移除）/ 未知 @tag ----
  if (route.upstream === 'reject' || route.badTag) {
    const message = route.badTag
      ? '未知的供给方标记 @' + route.badTag + '（可用：@zai / @zhipu / @ali / @alibaba）'
      : 'glm* -> 阿里百炼 路由已移除。请改用 OpenRouter 全名：or/z-ai/glm-5.3（可选 @zai 钉智谱官方、@ali 钉阿里）。';
    log('REJECT model=' + (model0 || '-') + ' :: ' + message);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message } }));
    return;
  }

  // ---- Anthropic 分支：沿用 ds-proxy 的 CC 专属 hack（OpenAI 分支纯透传） ----
  if (isAnthropic && data) {
    stripReasoningControls(data);
    delete data.thinking;
    data.messages = stripThinkingBlocks(data.messages);
    if (data.system) data.system = normalizeSystemContent(data.system);
    if (data.messages) {
      for (const msg of data.messages) if (msg.role === 'system') msg.content = normalizeSystemContent(msg.content);
    }
    if (data.tools) data.tools = sortTools(data.tools);

    const sysMsgs = (data.messages || []).filter(m => m.role === 'system');
    if (sysMsgs.length > 0) {
      data.messages = data.messages.filter(m => m.role !== 'system');
      data.system = sysMsgs.flatMap(m => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
    }
  }

  // ---- 钉供给方（OR 原生字段，两种格式通用） ----
  if (data && route.provider) {
    data.provider = { order: [route.provider], allow_fallbacks: false };
  }

  // ---- OpenAI 流式：注入 include_usage，让末块带上 token 用量（标准字段，不改语义） ----
  let injectedUsage = false;
  if (!isAnthropic && data && data.stream === true && !(data.stream_options && data.stream_options.include_usage)) {
    data.stream_options = { ...(data.stream_options || {}), include_usage: true };
    injectedUsage = true;
  }

  // ---- 需要改 model 名的场景（or/ 前缀剥除） ----
  let outBody;
  if (isAnthropic) {
    if (data && route.model !== model0) data.model = route.model;
    outBody = data ? Buffer.from(JSON.stringify(data)) : rawBody;
  } else if (data && (route.model !== model0 || injectedUsage)) {
    if (route.model !== model0) data.model = route.model;
    outBody = Buffer.from(JSON.stringify(data));
  } else {
    outBody = rawBody;   // OpenAI 分支非 or/ ：逐字节透传
  }

  // ---- 鉴权：双认 ----
  const headers = { ...req.headers };
  delete headers['connection'];
  delete headers['proxy-connection'];
  delete headers['transfer-encoding'];

  const hadX = headers['x-api-key'] !== undefined;
  const hadAuth = headers['authorization'] !== undefined;
  const xPlaceholder = hadX && isPlaceholder(headers['x-api-key']);
  const aPlaceholder = hadAuth && isPlaceholder(headers['authorization']);
  if (xPlaceholder) delete headers['x-api-key'];
  if (aPlaceholder) delete headers['authorization'];

  const upstreamKey = keyFor(route.upstream, isAnthropic ? 'anthropic' : 'openai');
  let keySource = 'passthrough';
  if (route.upstream === 'openrouter') {
    if (upstreamKey && (!hadX || xPlaceholder) && (!hadAuth || aPlaceholder)) {
      headers['authorization'] = 'Bearer ' + upstreamKey;    // 客户端没带真凭证 -> 注入
      keySource = 'broker';
    } else if (aPlaceholder || xPlaceholder || (!hadX && !hadAuth && !upstreamKey)) {
      keySource = 'degraded';
    }
  } else { // deepseek / xiaomi：双认
    if (xPlaceholder || aPlaceholder || (!hadX && !hadAuth)) {
      if (upstreamKey) {
        if (aPlaceholder || (!hadX && !hadAuth && !isAnthropic)) headers['authorization'] = 'Bearer ' + upstreamKey;
        else headers['x-api-key'] = upstreamKey;
        keySource = 'broker';
      } else {
        keySource = 'degraded';
      }
    }
  }

  // ---- 上游请求 ----
  const tgt = UPSTREAMS[route.upstream];
  const targetPath = (isAnthropic ? tgt.aPrefix : tgt.oPrefix) + req.url;
  headers['host'] = tgt.host;
  if (outBody.length > 0) headers['content-length'] = String(outBody.length);
  else delete headers['content-length'];

  log('REQ ' + req.method + ' ' + req.url + ' model=' + (model0 || '-') + ' -> ' + route.upstream + (isAnthropic ? ' (A)' : ' (O)'));

  const onResponse = (proxyRes) => {
    const responseHeaders = { ...proxyRes.headers };
    delete responseHeaders['transfer-encoding'];
    log('RESP ' + proxyRes.statusCode + ' ' + (Date.now() - started) + 'ms route=' + route.upstream + ' key=' + keySource);

    // 用量嗅探：只旁听响应体（tee），不动转发
    const ct = String(proxyRes.headers['content-type'] || '');
    const isSSE = ct.includes('text/event-stream');
    const sniffer = createUsageSniffer(isAnthropic, isSSE);
    proxyRes.on('data', (c) => { try { sniffer.feed(c); } catch (_) {} });
    proxyRes.on('end', () => {
      let u = null; try { u = sniffer.finish(); } catch (_) {}
      if (u && u.seen) {
        recordUsage({
          ts: new Date().toISOString(),
          port: PORT,
          route: route.upstream,
          reqModel: model0 || null,
          upModel: (route.model && route.model !== model0) ? route.model : null,
          served: u.served || null,
          kind: isAnthropic ? 'A' : 'O',
          stream: isSSE,
          status: proxyRes.statusCode,
          ms: Date.now() - started,
          input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite,
        });
      }
    });

    try { if (!res.headersSent) res.writeHead(proxyRes.statusCode, responseHeaders); } catch (_) {}
    proxyRes.pipe(res);
  };
  const onError = (error) => {
    log('UPSTREAM_ERR route=' + route.upstream + ' :: ' + ((error && error.message) || error));
    try {
      if (!res.headersSent) { res.writeHead(502); res.end('broker upstream error'); } else { res.destroy(); }
    } catch (_) {}
  };

  let proxyReq = null;
  if (tgt.tunnel) {
    const socket = await openTunnel(tgt.host, tunnelConfig());
    const tlsSocket = tls.connect({ socket, servername: tgt.host });
    await new Promise((resolve, reject) => {
      tlsSocket.once('secureConnect', resolve);
      tlsSocket.once('error', reject);
    });
    proxyReq = https.request(
      { hostname: tgt.host, port: 443, path: targetPath, method: req.method, headers, agent: new TunnelAgent(tlsSocket) },
      onResponse
    );
    proxyReq.on('error', (e) => { tlsSocket.destroy(); onError(e); });
  } else {
    proxyReq = https.request({ hostname: tgt.host, port: 443, path: targetPath, method: req.method, headers }, onResponse);
    proxyReq.on('error', onError);
  }

  res.on('close', () => {
    if (!res.writableEnded && proxyReq) { try { proxyReq.destroy(); } catch (_) {} }
  });

  proxyReq.end(outBody.length ? outBody : undefined);
}

// ---------- 自保：绝不 crash ----------
process.on('uncaughtException', error => {
  log('UNCAUGHT: ' + (error && error.stack ? error.stack : error));
});
process.on('unhandledRejection', reason => {
  log('UNHANDLED_REJECTION: ' + (reason && reason.stack ? reason.stack : reason));
});

srv.requestTimeout = 0;   // 长思考/长流式响应不能被默认 5 分钟掐断
srv.listen(PORT, HOST, () => {
  const s = getSecrets();
  log('STARTED on ' + HOST + ':' + PORT + ' secrets=' + (s ? 'ok' : 'DEGRADED-passthrough') + ' usage=' + USAGE_PATH);
  console.log('credential broker on http://' + HOST + ':' + PORT + (s ? '' : '  [DEGRADED: secrets.json unavailable]'));
});
