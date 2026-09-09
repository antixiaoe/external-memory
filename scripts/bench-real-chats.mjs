// scripts/bench-real-chats.mjs — 真实沟通记录基准测试
// 从 VOE 中心 raw CSV 取客户发言最多的 10 个客户,走生产路径灌入记忆库:
//   会话原文 → source 落库 → LLM 抽取事实 → MCP record(语义去重) → MCP consolidate(聚合 Story)
//   → MCP wake / recall 验证 → 输出报告
// 用法: node scripts/bench-real-chats.mjs [--days 5] [--top 10]
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { loadEnv } from './lib/env.mjs';

loadEnv(new URL('../.env', import.meta.url).pathname);
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SILICONFLOW_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SILICONFLOW_API_KEY) {
  console.error('缺 .env 配置(SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SILICONFLOW_API_KEY)');
  process.exit(1);
}

const RAW_DIR = '/Users/liuxiaoyi/VOE中心/data/raw';
const TOP_N = Number(process.argv[process.argv.indexOf('--top') + 1]) || 10;
const DAYS = Number(process.argv[process.argv.indexOf('--days') + 1]) || 5;
const MAX_FACTS = 15;
const MAX_TRANSCRIPT = 24000; // 字符,超出截断(Qwen3-8B 上下文保护)

// ---------- 1. 读 CSV,按客户聚合 ----------
function parseCsv(file) {
  const text = readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows = [];
  let cur = null, inQ = false, field = '', row = [];
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { if (row.length > 1) rows.push(row); row = []; };
  for (const ch of text) {
    if (inQ) {
      if (ch === '"') inQ = false;
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') { pushField(); pushRow(); }
    else if (ch !== '\r') field += ch;
  }
  pushField(); pushRow();
  const header = rows.shift();
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const byUser = new Map(); // uid -> [{time, role, content, conv}]
const files = readdirSync(RAW_DIR).filter((f) => f.endsWith('.csv')).sort().slice(-DAYS);
for (const f of files) {
  for (const r of parseCsv(`${RAW_DIR}/${f}`)) {
    if (!r.gz_user_id || !r.content?.trim()) continue;
    if (!byUser.has(r.gz_user_id)) byUser.set(r.gz_user_id, []);
    byUser.get(r.gz_user_id).push({
      time: r.msg_time,
      role: r.sender === '2' ? '客户' : r.sender === '1' ? `销售${r.operator_name ?? ''}` : '系统',
      content: r.content.trim(),
      conv: r.conversation_id,
    });
  }
}
const top = [...byUser.entries()]
  .map(([uid, msgs]) => [uid, msgs, msgs.filter((m) => m.role === '客户').length])
  .filter(([, , c]) => c >= 10)
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, TOP_N);
console.log(`读取 ${files.length} 天 CSV,共 ${byUser.size} 个客户,取前 ${top.length} 个`);

// ---------- 2. MCP stdio 客户端 ----------
function startMcp() {
  const child = spawn('node', [new URL('../stdio/external-memory-mcp.mjs', import.meta.url).pathname], {
    env: {
      ...process.env,
      SUPABASE_SECRET_KEY: SUPABASE_SERVICE_ROLE_KEY,
      EM_OPERATOR: 'agent:bench:*',
    },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const pending = new Map();
  let nextId = 1;
  child.stdout.on('data', (d) => {
    buf += d;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  });
  return {
    call(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, (msg) => (msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)));
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
        setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('MCP 调用超时')); } }, 120_000);
      });
    },
    async tool(name, args) {
      const r = await this.call('tools/call', { name, arguments: args });
      const text = r?.content?.[0]?.text ?? '';
      try { return JSON.parse(text); } catch { return text; }
    },
    kill() { child.kill(); },
  };
}

// ---------- 3. LLM 抽取事实(模拟 agent 在对话中识别可记内容) ----------
async function extractFacts(transcript) {
  const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SILICONFLOW_API_KEY}` },
    body: JSON.stringify({
      model: 'Qwen/Qwen3-8B',
      enable_thinking: false,
      temperature: 0.2,
      messages: [{
        role: 'user',
        content: `你是二手车网销 agent 的记忆模块。以下是销售与一位客户的真实沟通记录。请抽取值得长期记住的客户事实,用于后续跟进。
要求:
- 只抽取客户相关的稳定事实:预算、意向车型/配置、购车用途、时间节点、异议顾虑、个人情况(城市/职业/家庭)、明确表态
- 每条一句话,可脱离上下文独立理解,数字和人名必须与原文一致,不得编造
- 不记录寒暄、销售的推销话术、一次性流程信息
- 输出严格 JSON 数组,最多 ${MAX_FACTS} 条:[{"content":"...","type":"preference|event|constraint","importance":1-10}]
- type: preference=偏好/事实, event=发生的事件, constraint=长期硬性约束(如"绝不考虑X")
- 没有可记的则输出 []

沟通记录:
${transcript}`,
      }],
    }),
  });
  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const data = await resp.json();
  const text = data.choices[0].message.content.replace(/```(?:json)?/g, '');
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]);
    return arr.filter((f) => f?.content && f?.type && f?.importance).slice(0, MAX_FACTS);
  } catch { return []; }
}

// ---------- 4. source 落库(PostgREST 直连) ----------
async function insertSource(subject, rawText) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/source`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ subject_id: subject, raw_text: rawText, source_type: 'conversation' }),
  });
  if (!resp.ok) throw new Error(`source ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return (await resp.json())[0].id;
}

// ---------- 主流程 ----------
const mcp = startMcp();
await mcp.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bench', version: '0.1' } });

const report = [];
for (const [uid, msgs, custMsgs] of top) {
  const subject = `cust_${uid}`;
  msgs.sort((a, b) => a.time.localeCompare(b.time));
  let transcript = msgs.map((m) => `[${m.time}] ${m.role}: ${m.content}`).join('\n');
  if (transcript.length > MAX_TRANSCRIPT) transcript = transcript.slice(0, MAX_TRANSCRIPT) + '\n...(截断)';

  const t0 = Date.now();
  const sourceId = await insertSource(subject, transcript);
  const facts = await extractFacts(transcript);

  let created = 0, merged = 0, failed = 0;
  for (const f of facts) {
    try {
      const r = await mcp.tool('record', {
        subject_id: subject, content: f.content, type: f.type,
        importance: Math.min(10, Math.max(1, Number(f.importance) || 5)),
        source_id: sourceId,
      });
      if (r?.dedup === 'merged') merged++; else created++;
    } catch (e) { failed++; console.error(`  record 失败: ${e.message.slice(0, 100)}`); }
  }

  const cons = await mcp.tool('consolidate', { subject_id: subject, mode: 'all' });
  const wake = await mcp.tool('wake', { subject_id: subject });

  // 3 个固定探针查询
  const probes = ['客户的预算和意向车型是什么', '客户有什么顾虑或异议', '客户什么时候打算买/下一步是什么'];
  const recalls = [];
  for (const q of probes) {
    const r = await mcp.tool('recall', { subject_id: subject, query: q, top_k: 3 });
    recalls.push({ q, hits: (r?.results ?? []).map((h) => ({ score: h.score, content: h.content })) });
  }

  report.push({
    subject, msgs: msgs.length, custMsgs, facts: facts.length, created, merged, failed,
    consolidated: cons, wake_size: JSON.stringify(wake).length, recalls,
    sample_facts: facts.slice(0, 5).map((f) => `[${f.type}/${f.importance}] ${f.content}`),
    elapsed_s: ((Date.now() - t0) / 1000).toFixed(1),
  });
  console.log(`✅ ${subject}  msgs=${msgs.length} facts=${facts.length} (新${created}/并${merged}/败${failed}) stories=${cons?.stories_created ?? '?'}  耗时${report.at(-1).elapsed_s}s`);
}

mcp.kill();
const out = new URL('../reports/bench-real-chats.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), days: files, report }, null, 2));
console.log(`\n报告已写入 ${out}`);
