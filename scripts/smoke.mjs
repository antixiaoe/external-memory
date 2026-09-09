// scripts/smoke.mjs — 端到端冒烟：record / recall / wake / consolidate + 客户间隔离验证
// 用法: node scripts/smoke.mjs   （需要 .env: MCP_URL, TOKEN_HUMAN, TOKEN_AGENT）
import { loadEnv } from './lib/env.mjs';

loadEnv();
const { MCP_URL, TOKEN_HUMAN, TOKEN_AGENT } = process.env;
if (!MCP_URL || !TOKEN_HUMAN || !TOKEN_AGENT) {
  console.error('缺少 MCP_URL / TOKEN_HUMAN / TOKEN_AGENT（见 .env.example）');
  process.exit(1);
}

let rpcId = 0;
async function call(token, tool, args) {
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: tool, arguments: args } }),
  });
  const body = await resp.json();
  if (body.error) throw new Error(`${tool} RPC 错误: ${JSON.stringify(body.error)}`);
  const r = body.result;
  if (r?.isError) throw new Error(`${tool} 执行失败: ${r.content?.[0]?.text}`);
  return r?.structuredContent ?? JSON.parse(r.content[0].text);
}

const check = (name, cond) => console.log(`${cond ? '✔' : '✘'} ${name}`);

// --- 1. tools/list ---
{
  const resp = await fetch(MCP_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN_HUMAN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }),
  });
  const body = await resp.json();
  const names = body.result.tools.map((t) => t.name).sort().join(',');
  check(`tools/list = [${names}]`, names === 'consolidate,recall,record,wake');
}

// --- 2. 场景一：human 记录并召回自己的记忆 ---
await call(TOKEN_HUMAN, 'record', { content: '我喜欢简洁直接的沟通风格', type: 'preference', importance: 8 });
await call(TOKEN_HUMAN, 'record', { content: '永远不要在没有确认的情况下删除我的数据', type: 'constraint', importance: 10 });
const mine = await call(TOKEN_HUMAN, 'recall', { query: '我的沟通风格偏好' });
check(`human recall 返回 ${mine.length} 条且命中偏好`, mine.length > 0 && JSON.stringify(mine).includes('沟通风格'));

// 去重验证：同义重复记录应 merged
const dup = await call(TOKEN_HUMAN, 'record', { content: '我偏好简洁直接的交流方式', type: 'preference', importance: 8 });
console.log(`  (去重结果: ${dup.dedup}${dup.dedup === 'merged' ? '，合并到: ' + dup.merged_into : ''})`);

// wake
const w = await call(TOKEN_HUMAN, 'wake', {});
check(`wake 返回 ${w._meta.memory_count} 条记忆且含 constraint`, JSON.stringify(w.top_memories).includes('永远不要'));

// --- 3. 场景二：agent 给客户 A 记 3 条，客户 B 不得串数据 ---
const CUST_A = 'customer_demo_a';
const CUST_B = 'customer_demo_b';
await call(TOKEN_AGENT, 'record', { subject_id: CUST_A, content: '客户A上周决定采购20台新能源物流车', type: 'event', importance: 9 });
await call(TOKEN_AGENT, 'record', { subject_id: CUST_A, content: '客户A预算上限50万', type: 'preference', importance: 8 });
await call(TOKEN_AGENT, 'record', { subject_id: CUST_A, content: '客户A要求所有报价必须含三年质保条款', type: 'constraint', importance: 10 });

const aRecall = await call(TOKEN_AGENT, 'recall', { subject_id: CUST_A, query: '客户采购预算' });
check(`agent recall 客户A 命中预算`, JSON.stringify(aRecall).includes('预算'));

const bRecall = await call(TOKEN_AGENT, 'recall', { subject_id: CUST_B, query: '客户采购预算' });
check(`客户B 召回为空（隔离零串扰）`, bRecall.length === 0);

const bWake = await call(TOKEN_AGENT, 'wake', { subject_id: CUST_B });
check(`客户B wake 无记忆`, bWake._meta.memory_count === 0);

// --- 4. 越权与鉴权负例 ---
let blocked = false;
try { await call(TOKEN_HUMAN, 'recall', { subject_id: CUST_A, query: 'x' }); blocked = 'ignored'; }
catch { blocked = false; }
// human 的 subject_id 被忽略（只能查自己），不应报错也不应返回客户A数据
const hijack = await call(TOKEN_HUMAN, 'recall', { subject_id: CUST_A, query: '客户采购预算' });
check(`human 伪造 subject_id 无效（查到的仍是自己的空间）`, !JSON.stringify(hijack).includes('客户A'));
void blocked;

const badTokenResp = await fetch(MCP_URL, {
  method: 'POST',
  headers: { Authorization: 'Bearer wrong_token', 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'recall', arguments: { query: 'x' } } }),
});
const badBody = await badTokenResp.json();
check('错误 token 被拒绝', badBody.result?.isError === true || badBody.error);

// --- 5. consolidate ---
const c = await call(TOKEN_AGENT, 'consolidate', { mode: 'all' });
console.log(`  (consolidate: ${JSON.stringify(c)})`);
check('consolidate 正常返回', typeof c.archived === 'number');

console.log('\n冒烟测试完成。✘ 项需要排查；全部 ✔ 则端到端链路通过。');
