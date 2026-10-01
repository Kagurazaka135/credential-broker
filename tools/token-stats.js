#!/usr/bin/env node
'use strict';
/**
 * token-stats.js — 汇总 broker 的 token 用量
 *
 * 读 broker 落下的 usage-<port>.jsonl（含轮转的 .1），按 天 × 模型 聚合：
 *   用了哪些模型、每个模型/整体的输入/输出/缓存读/缓存写 token、请求数。
 *
 * 用法:
 *   node tools/token-stats.js                 # 默认读当前目录 ./usage-*.jsonl
 *   node tools/token-stats.js --dir <目录>     # 指定目录（找 usage-*.jsonl）
 *   node tools/token-stats.js --days 14        # 只看最近 14 天（按记录日期）
 *   node tools/token-stats.js --since 2026-10-01
 *   node tools/token-stats.js --json           # 输出 JSON，给别的工具/面板读
 *
 * 只读，不写任何东西。数据来自 broker 的 usage 记录（见 broker.cjs 的 recordUsage）。
 */

const fs = require('fs');
const path = require('path');

function argValue(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DIR = argValue('--dir', process.cwd());
const DAYS = parseInt(argValue('--days', '0'), 10) || 0;
const SINCE = argValue('--since', null);
const AS_JSON = process.argv.includes('--json');

// ---------- 收集 usage 文件 ----------
function listUsageFiles(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch (_) { return []; }
  return names
    .filter(n => /^usage-.*\.jsonl(\.\d+)?$/.test(n))
    .map(n => path.join(dir, n));
}

// ---------- 解析 ----------
const files = listUsageFiles(DIR);
const zero = () => ({ reqs: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
const add = (a, b) => {
  a.reqs += 1; a.input += b.input || 0; a.output += b.output || 0;
  a.cacheRead += b.cacheRead || 0; a.cacheWrite += b.cacheWrite || 0;
  return a;
};

const byDayModel = new Map();   // day -> Map(model -> stat)
const byModel = new Map();      // model -> stat
const byRoute = new Map();      // route -> stat
const total = zero();
let lines = 0, bad = 0, minTs = null, maxTs = null;
const ports = new Set();

for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
  for (const ln of text.split('\n')) {
    const s = ln.trim();
    if (!s) continue;
    let r;
    try { r = JSON.parse(s); } catch (_) { bad++; continue; }
    if (!r || typeof r !== 'object' || !r.ts) { bad++; continue; }
    lines++;
    const day = String(r.ts).slice(0, 10);
    if (SINCE && day < SINCE) continue;
    if (DAYS > 0) {
      const cut = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
      if (day < cut) continue;
    }
    const model = r.served || r.upModel || r.reqModel || '(unknown)';
    if (!minTs || r.ts < minTs) minTs = r.ts;
    if (!maxTs || r.ts > maxTs) maxTs = r.ts;
    if (r.port) ports.add(r.port);

    add(total, r);
    if (!byModel.has(model)) byModel.set(model, zero());
    add(byModel.get(model), r);
    const route = r.route || '(unknown)';
    if (!byRoute.has(route)) byRoute.set(route, zero());
    add(byRoute.get(route), r);
    if (!byDayModel.has(day)) byDayModel.set(day, new Map());
    const dm = byDayModel.get(day);
    if (!dm.has(model)) dm.set(model, zero());
    add(dm.get(model), r);
  }
}

// ---------- 格式化 ----------
function fmt(n) { return Number(n || 0).toLocaleString('en-US'); }
function sortBy(map, key) {
  return Array.from(map.entries()).sort((a, b) => b[1][key] - a[1][key]);
}

if (AS_JSON) {
  const out = {
    generatedAt: new Date().toISOString(),
    dir: DIR,
    files: files.length,
    lines, badLines: bad,
    ports: Array.from(ports),
    range: { minTs, maxTs },
    total,
    byModel: Object.fromEntries(Array.from(byModel.entries()).sort((a, b) => (b[1].input + b[1].output) - (a[1].input + a[1].output))),
    byRoute: Object.fromEntries(byRoute.entries()),
    byDay: Object.fromEntries(
      Array.from(byDayModel.entries()).sort((a, b) => b[0].localeCompare(a[0]))
        .map(([d, m]) => [d, Object.fromEntries(m.entries())])
    ),
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  return;
}

console.log('usage 文件 ' + files.length + ' 个 | 记录 ' + fmt(lines) + ' 条 | 坏行 ' + fmt(bad));
console.log('端口 ' + (Array.from(ports).join(',') || '-') + ' | 区间 ' + (minTs || '-').slice(0, 16) + ' ~ ' + (maxTs || '-').slice(0, 16));
console.log('');
console.log('=== 总览 ===');
console.log('请求 ' + fmt(total.reqs) + ' | 输入 ' + fmt(total.input) + ' | 输出 ' + fmt(total.output) + ' | 缓存读 ' + fmt(total.cacheRead) + ' | 缓存写 ' + fmt(total.cacheWrite));
console.log('');
console.log('=== 按模型 ===');
const w = Math.max(6, ...Array.from(byModel.keys()).map(k => k.length));
console.log('model'.padEnd(w) + '  reqs      input       output      cacheRead     cacheWrite');
for (const [m, v] of sortBy(byModel, 'input')) {
  console.log(
    m.padEnd(w) + '  ' +
    fmt(v.reqs).padStart(7) + '  ' +
    fmt(v.input).padStart(11) + '  ' +
    fmt(v.output).padStart(11) + '  ' +
    fmt(v.cacheRead).padStart(13) + '  ' +
    fmt(v.cacheWrite).padStart(12)
  );
}
console.log('');
console.log('=== 按上游 ===');
for (const [r, v] of sortBy(byRoute, 'reqs')) {
  console.log(r.padEnd(12) + ' reqs=' + fmt(v.reqs) + ' in=' + fmt(v.input) + ' out=' + fmt(v.output));
}
console.log('');
console.log('=== 按天（最近 14 天）× 模型 ===');
const daysSorted = Array.from(byDayModel.keys()).sort((a, b) => b.localeCompare(a)).slice(0, 14);
for (const d of daysSorted) {
  const dm = byDayModel.get(d);
  let dt = zero();
  for (const v of dm.values()) { dt.reqs += v.reqs; dt.input += v.input; dt.output += v.output; dt.cacheRead += v.cacheRead; dt.cacheWrite += v.cacheWrite; }
  console.log(d + '  合计 reqs=' + fmt(dt.reqs) + ' in=' + fmt(dt.input) + ' out=' + fmt(dt.output) + ' cacheR=' + fmt(dt.cacheRead));
  for (const [m, v] of sortBy(dm, 'input')) {
    console.log('    ' + m.padEnd(w) + ' reqs=' + fmt(v.reqs).padStart(6) + ' in=' + fmt(v.input).padStart(11) + ' out=' + fmt(v.output).padStart(10) + ' cacheR=' + fmt(v.cacheRead).padStart(13));
  }
}
