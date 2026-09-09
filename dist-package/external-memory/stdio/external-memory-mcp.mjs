#!/usr/bin/env node
// external-memory-mcp.mjs — 自托管版「外部记忆库」MCP server（stdio 传输）
//
// 单文件、零依赖、Node ≥ 18。与 Supabase Edge Function 版共享同一套表结构与 RPC，
// 差异：stdio 走本地进程，鉴权简化为本机环境变量（EM_OPERATOR），数据直连本人 Supabase 项目。
//
// 四个凭据（详见 docs/自托管教程.md）：
//   SUPABASE_URL            Supabase Project URL（https://<ref>.supabase.co）
//   SUPABASE_SECRET_KEY     Supabase secret key（sb_secret_...，Settings → API Keys）
//   SILICONFLOW_API_KEY     硅基流动 API Key（sk-...，embedding 用）
//   DB 初始化时另需数据库密码或 dashboard SQL Editor（一次性，不留在配置里）
//
// 可选：EM_OPERATOR=human:<名字>（默认 human:me）或 agent:<名字>:* / agent:<名字>:a|b
//   human 模式：记忆主体固定为本人，工具入参 subject_id 被忽略
//   agent 模式：工具入参必传 subject_id（如 customer_id），按白名单校验

import { createInterface } from 'node:readline';

// ---------- 配置 ----------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY;
const SILICONFLOW_KEY = process.env.SILICONFLOW_API_KEY;
const EMBED_MODEL = 'BAAI/bge-m3';
const EMBED_DIM = 1024;
const DEDUP_THRESHOLD = 0.9;
const MERGE_THRESHOLD = 0.9;
const ARCHIVE_DAYS = 90;
const BATCH = 50;
const PROTOCOL_VERSION = '2025-06-18';

const log = (...a) => console.error('[external-memory]', ...a); // stdout 只走协议

function parseOperator() {
  const raw = process.env.EM_OPERATOR || 'human:me';
  const [kind, name, scopeRaw] = raw.split(':');
  if (kind === 'agent') {
    const scope = (scopeRaw ?? '').split('|').filter(Boolean);
    return { kind, name, scope: scope.length ? scope : ['*'] };
  }
  return { kind: 'human', name: name || 'me', subject: name || 'me' };
}
const OPERATOR = parseOperator();

/** 身份解析：human 固定本人；agent 必传 subject_id 且校验白名单 */
function resolveSubject(paramSubject) {
  if (OPERATOR.kind === 'human') return OPERATOR.subject;
  const s = typeof paramSubject === 'string' ? paramSubject.trim() : '';
  if (!s) throw new Error('agent 模式调用必须携带 subject_id（如 customer_id）');
  if (!OPERATOR.scope.includes('*') && !OPERATOR.scope.includes(s)) {
    throw new Error(`operator ${OPERATOR.name} 无权访问 subject ${s}`);
  }
  return s;
}

/** consolidate 用：agent 不传 subject 时取授权范围 */
function resolveScope(paramSubject) {
  if (OPERATOR.kind === 'human') return OPERATOR.subject;
  const s = typeof paramSubject === 'string' ? paramSubject.trim() : '';
  if (s) return resolveSubject(s);
  return OPERATOR.scope.includes('*') ? '*' : OPERATOR.scope[0];
}

// ---------- Supabase PostgREST ----------
function headers(extra = {}) {
  return {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
    'Content-Type': 'application/json',
    ...extra,
  };
}

async function rpc(fn, args) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: headers(), body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`rpc ${fn}: ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function selectRows(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: headers() });
  if (!resp.ok) throw new Error(`select ${table}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function insertRows(table, rows) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST', headers: headers({ Prefer: 'return=representation' }), body: JSON.stringify(rows),
  });
  if (!resp.ok) throw new Error(`insert ${table}: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

async function updateRows(table, query, patch, returning = false) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers(returning ? { Prefer: 'return=representation' } : {}),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`update ${table}: ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return text ? JSON.parse(text) : null;
}

async function removeRows(table, query) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { method: 'DELETE', headers: headers() });
  if (!resp.ok) throw new Error(`delete ${table}: ${resp.status} ${await resp.text()}`);
}

const toVectorLiteral = (emb) => `[${emb.join(',')}]`;

// PostgREST 返回的 vector 是字符串 "[0.1,...]"，解析为数组
const parseVec = (v) => (Array.isArray(v) ? v : JSON.parse(v));

function cosineSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------- Embedding（硅基流动 bge-m3） ----------
async function embed(texts) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch('https://api.siliconflow.cn/v1/embeddings', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SILICONFLOW_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      });
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`embed retryable: ${resp.status}`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
        continue;
      }
      if (!resp.ok) throw new Error(`embed: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const out = data.data
        .sort((a, b) => a.index - b.index)
        .map((d) => d.embedding);
      if (out.length !== texts.length || out[0]?.length !== EMBED_DIM) {
        throw new Error(`embed shape mismatch: ${out.length}x${out[0]?.length}`);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    }
  }
  throw lastErr;
}

// ---------- 工具实现 ----------

async function toolWake(args) {
  const subject = resolveSubject(args.subject_id);
  const [profiles, constraints, tops, stories] = await Promise.all([
    selectRows('profile', `subject_id=eq.${encodeURIComponent(subject)}&select=persona`),
    selectRows('memory', `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&type=eq.constraint&select=id,content,type,importance&order=importance.desc`),
    rpc('wake_memories', { p_subject_id: subject, p_limit: 10, p_tau_days: 30 }),
    selectRows('story', `subject_id=eq.${encodeURIComponent(subject)}&select=title,summary&order=salience.desc&limit=3`),
  ]);
  return {
    profile: profiles[0]?.persona ?? null,
    top_memories: [
      ...constraints.map((m) => ({ content: m.content, type: m.type, importance: m.importance })),
      ...(tops ?? []).map((m) => ({ content: m.content, type: m.type, importance: m.importance })),
    ],
    active_stories: stories.map((s) => ({ title: s.title, summary: s.summary })),
    _meta: { subject, memory_count: constraints.length + (tops?.length ?? 0) },
  };
}

async function toolRecall(args) {
  const subject = resolveSubject(args.subject_id);
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query 不能为空');
  const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 20);
  const keywordBoost = args.keyword_boost !== false;

  const [qEmb] = await embed([query]);
  const rows = await rpc('hybrid_recall', {
    p_subject_id: subject,
    p_query: query,
    p_query_emb: toVectorLiteral(qEmb),
    p_top_k: topK,
    p_kappa: keywordBoost ? 0.2 : 0,
  }) ?? [];

  // 命中巩固：浮空异步，不阻塞返回
  void (async () => {
    for (const r of rows) {
      try { await rpc('reinforce_hit', { p_id: r.id, p_delta: 0.05 }); } catch { /* 不影响主链路 */ }
    }
  })();

  return rows.map((r) => ({
    id: r.id, content: r.content, type: r.type,
    score: Math.round(r.score * 1000) / 1000, source_quote: r.source_quote,
  }));
}

async function toolRecord(args) {
  const subject = resolveSubject(args.subject_id);
  const content = String(args.content ?? '').trim();
  if (!content) throw new Error('content 不能为空');
  const type = String(args.type);
  if (!['preference', 'event', 'constraint'].includes(type)) throw new Error('type 非法');
  const importance = Math.min(Math.max(Math.round(Number(args.importance) || 5), 1), 10);
  const sourceId = typeof args.source_id === 'string' && args.source_id ? args.source_id : null;

  let emb = null;
  try { [emb] = await embed([content]); } catch { /* 惰性兜底：consolidate backfill 补齐 */ }

  if (emb) {
    const nearest = await rpc('nearest_memory', { p_subject_id: subject, p_emb: toVectorLiteral(emb) }) ?? [];
    const hit = nearest[0];
    if (hit && hit.cos_sim > DEDUP_THRESHOLD) {
      await rpc('merge_memory', { p_id: hit.id, p_importance: importance, p_source_id: sourceId });
      return { id: hit.id, dedup: 'merged', merged_into: hit.content };
    }
  }

  const rows = await insertRows('memory', {
    subject_id: subject, content, type, importance,
    embedding: emb ? toVectorLiteral(emb) : null,
    source_id: sourceId,
  });
  return { id: rows[0].id, dedup: 'created', embedded: emb !== null };
}

async function subjectsInScope(scope) {
  if (scope !== '*') return [scope];
  const rows = await selectRows('memory', 'status=eq.active&select=subject_id');
  return [...new Set(rows.map((r) => r.subject_id))];
}

async function backfill(subject) {
  const rows = await selectRows('memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=is.null&select=id,content&limit=${BATCH}`);
  if (!rows.length) return 0;
  const embs = await embed(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++) {
    await updateRows('memory', `id=eq.${rows[i].id}`, { embedding: toVectorLiteral(embs[i]) });
  }
  return rows.length;
}

async function mergeDup(subject) {
  const rows = await selectRows('memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=not.is.null&select=id,content,importance,embedding&order=created_at.asc&limit=${BATCH}`);
  let merged = 0;
  for (const r of rows) {
    const nearest = await rpc('nearest_memory', { p_subject_id: subject, p_emb: r.embedding, p_exclude_id: r.id }) ?? [];
    const hit = nearest[0];
    if (hit && hit.cos_sim > MERGE_THRESHOLD) {
      await rpc('merge_memory', { p_id: hit.id, p_importance: r.importance, p_source_id: null });
      await removeRows('memory', `id=eq.${r.id}`);
      merged++;
    }
  }
  return merged;
}

async function archiveOld(subject) {
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString();
  const rows = await updateRows('memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&importance=lte.2&reinforce=eq.0` +
    `&or=(last_hit_at.lt.${cutoff},and(last_hit_at.is.null,created_at.lt.${cutoff}))&select=id`,
    { status: 'archived' }, true);
  return rows?.length ?? 0;
}

// ---------- Story 聚合（cluster） ----------
// bge-m3 实测分布：同一事件的记忆 0.53~0.61，无关记忆 0.39~0.45 → 默认 0.5 落在间隙，
// 可用 EM_CLUSTER_THRESHOLD 覆盖（数据量大了之后按实际分布上调）
const CLUSTER_THRESHOLD = Number(process.env.EM_CLUSTER_THRESHOLD) || 0.5;
const MIN_CLUSTER_SIZE = 3;      // 少于 3 条不成故事
// 实测：Qwen2.5-7B 输出截断且编造数字，不可用；Qwen3-8B（关思考）事实准确，作为默认
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || 'Qwen/Qwen3-8B';

/** 用 LLM 为一簇记忆生成标题+摘要；解析鲁棒（剥围栏+字段正则兜底）；完全失败回退启发式 */
async function summarizeCluster(contents) {
  const fallback = () => ({
    title: contents[0].slice(0, 20),
    summary: contents.join('；'),
  });
  try {
    const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SILICONFLOW_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        enable_thinking: false, // Qwen3 系关闭思考，省 token 且输出稳定
        messages: [{
          role: 'user',
          content: `以下是与同一主体相关的若干条记忆，属于同一件完整事件。请输出 JSON：{"title": "≤15字的事件名", "summary": "≤80字的脉络摘要"}。
要求：必须严格使用原文中的事实，数字、人名、金额、条款不得改动或编造。只输出 JSON，不要多余内容。

${contents.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
        }],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    let text = data.choices[0].message.content.replace(/```(?:json)?/g, '');
    // 小模型可能输出非法 JSON（多余逗号等），先整体 parse，失败再字段级正则打捞
    let parsed = null;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 走正则 */ } }
    if (!parsed) {
      const title = text.match(/"title"\s*:\s*"([^"]+)"/)?.[1];
      const summary = text.match(/"summary"\s*:\s*"([^"]+)"/)?.[1];
      if (title && summary) parsed = { title, summary };
    }
    if (!parsed?.title || !parsed?.summary) return fallback();
    return { title: String(parsed.title).slice(0, 50), summary: String(parsed.summary).slice(0, 300) };
  } catch {
    return fallback();
  }
}

/** cluster：未归属 Story 的活跃记忆 → 贪心聚类 → ≥3 条成 Story；也尝试挂到已有 Story */
async function clusterStories(subject) {
  const memories = await selectRows('memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&story_id=is.null&embedding=not.is.null` +
    `&select=id,content,importance,embedding,created_at&order=created_at.asc&limit=200`);
  if (!memories.length) return { created: 0, attached: 0 };
  for (const m of memories) m._vec = parseVec(m.embedding);

  // 1) 先尝试挂到已有 Story
  const stories = await selectRows('story',
    `subject_id=eq.${encodeURIComponent(subject)}&embedding=not.is.null&select=id,embedding`);
  let attached = 0;
  const remaining = [];
  for (const m of memories) {
    let best = null;
    for (const s of stories) {
      const sim = cosineSim(m._vec, parseVec(s.embedding));
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { id: s.id, sim };
    }
    if (best) {
      await updateRows('memory', `id=eq.${m.id}`, { story_id: best.id });
      attached++;
    } else {
      remaining.push(m);
    }
  }

  // 2) 贪心聚类：按时间顺序，与簇质心 cosine > 阈值则入簇，否则开新簇
  const clusters = [];
  for (const m of remaining) {
    let best = null;
    for (const c of clusters) {
      const sim = cosineSim(m._vec, c.centroid);
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { c, sim };
    }
    if (best) {
      best.c.members.push(m);
      const n = best.c.members.length;
      best.c.centroid = best.c.centroid.map((v, i) => (v * (n - 1) + m._vec[i]) / n);
    } else {
      clusters.push({ centroid: [...m._vec], members: [m] });
    }
  }

  // 3) 达到规模的簇 → 建 Story
  let created = 0;
  for (const c of clusters) {
    if (c.members.length < MIN_CLUSTER_SIZE) continue;
    const contents = c.members.map((m) => m.content);
    const { title, summary } = await summarizeCluster(contents);
    const [sumEmb] = await embed([summary]);
    const maxImportance = Math.max(...c.members.map((m) => m.importance));
    const times = c.members.map((m) => m.created_at).sort();
    const salience = Math.min(1, maxImportance / 10 + 0.05 * c.members.length);
    const rows = await insertRows('story', {
      subject_id: subject, title, summary,
      embedding: toVectorLiteral(sumEmb),
      salience,
      time_span: `[${times[0]},${times[times.length - 1]}]`,
    });
    const storyId = rows[0].id;
    for (const m of c.members) {
      await updateRows('memory', `id=eq.${m.id}`, { story_id: storyId });
    }
    created++;
  }
  return { created, attached };
}

async function toolConsolidate(args) {
  const scope = resolveScope(args.subject_id);
  const mode = String(args.mode ?? 'all');
  const subjects = await subjectsInScope(scope);
  let backfilled = 0, merged = 0, archived = 0, storiesCreated = 0, storiesAttached = 0;
  for (const subject of subjects) {
    if (mode === 'backfill' || mode === 'all') backfilled += await backfill(subject);
    if (mode === 'merge' || mode === 'all') merged += await mergeDup(subject);
    if (mode === 'archive' || mode === 'all') archived += await archiveOld(subject);
    if (mode === 'cluster' || mode === 'all') {
      const r = await clusterStories(subject);
      storiesCreated += r.created;
      storiesAttached += r.attached;
    }
  }
  return {
    subjects_processed: subjects.length,
    backfilled, merged, archived,
    stories_created: storiesCreated,
    memories_attached_to_stories: storiesAttached,
  };
}

// ---------- MCP 协议 ----------

const SUBJECT_PARAM = {
  type: 'string',
  description: '记忆主体 id。human 模式省略；agent 模式必传（如 customer_id）',
};

const TOOLS = [
  {
    spec: {
      name: 'wake',
      description: '【会话启动时必须先调用一次】唤醒长期记忆：返回该主体的核心画像、最重要的记忆（含全部长期约束）和进行中的事件脉络，用于恢复人格/客户关系连续性。处理某主体的事务前必须先 wake。',
      inputSchema: { type: 'object', properties: { subject_id: SUBJECT_PARAM }, required: [] },
    },
    handler: toolWake,
  },
  {
    spec: {
      name: 'recall',
      description: '【按需召回长期记忆】当问题涉及该主体的历史偏好、过往事件、之前说过的内容时，必须先调用本工具再回答；不确定时宁可调用一次。返回按相关度+显著性加权排序的记忆片段及原文溯源。',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: SUBJECT_PARAM,
          query: { type: 'string', description: '检索查询，用自然语言描述要找的记忆' },
          top_k: { type: 'number', description: '返回条数，默认 5，最大 20' },
          keyword_boost: { type: 'boolean', description: '是否启用关键词混合检索（默认 true）。查询含人名/编号等精确词时保持开启' },
        },
        required: ['query'],
      },
    },
    handler: toolRecall,
  },
  {
    spec: {
      name: 'record',
      description: '【写入长期记忆】当对话中出现值得长期记住的事实、偏好或约束时调用。不要记录寒暄、一次性信息、可轻易重新查询的内容。importance 打分规则：10=长期约束（如"永远不要做X"），7-9=重要事实/重大决定，4-6=一般事件，1-3=琐碎可丢弃。',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: SUBJECT_PARAM,
          content: { type: 'string', description: '一句话事实，应可脱离上下文独立理解' },
          type: { type: 'string', enum: ['preference', 'event', 'constraint'], description: 'preference=偏好/事实；event=情景/事件；constraint=长期约束（将常驻每次唤醒）' },
          importance: { type: 'number', description: '重要性 1-10，见打分规则' },
          source_id: { type: 'string', description: '可选，原始素材 id，用于溯源' },
        },
        required: ['content', 'type', 'importance'],
      },
    },
    handler: toolRecord,
  },
  {
    spec: {
      name: 'consolidate',
      description: '【整理记忆库】维护性操作：补齐缺失的向量(backfill)、合并重复记忆(merge)、归档低价值旧记忆(archive)。agent 模式不传 subject_id 时整理授权范围内全部主体。',
      inputSchema: {
        type: 'object',
        properties: {
          subject_id: SUBJECT_PARAM,
          mode: { type: 'string', enum: ['backfill', 'merge', 'archive', 'cluster', 'all'], description: '默认 all' },
        },
        required: [],
      },
    },
    handler: toolConsolidate,
  },
];

function ok(id, result) { return { jsonrpc: '2.0', id: id ?? null, result }; }
function err(id, code, message) { return { jsonrpc: '2.0', id: id ?? null, error: { code, message } }; }

async function handleRpc(body) {
  const { id, method, params } = body;
  if (method?.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'external-memory', version: '0.1.0' },
      });
    case 'ping':
      return ok(id, {});
    case 'tools/list':
      return ok(id, { tools: TOOLS.map((t) => t.spec) });
    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = params?.arguments ?? {};
      const tool = TOOLS.find((t) => t.spec.name === name);
      if (!tool) return err(id, -32602, `unknown tool: ${name}`);
      try {
        const result = await tool.handler(args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        return ok(id, {
          content: [{ type: 'text', text: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }
    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}

// ---------- stdio 主循环 ----------

if (!SUPABASE_URL || !SUPABASE_KEY || !SILICONFLOW_KEY) {
  log('缺少必需环境变量：SUPABASE_URL / SUPABASE_SECRET_KEY / SILICONFLOW_API_KEY');
  log('配置教程见 docs/自托管教程.md');
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  void (async () => {
    let body;
    try {
      body = JSON.parse(trimmed);
    } catch {
      process.stdout.write(JSON.stringify(err(null, -32700, 'parse error')) + '\n');
      return;
    }
    const resp = await handleRpc(body);
    if (resp !== null) process.stdout.write(JSON.stringify(resp) + '\n');
  })();
});

log(`已启动（operator=${OPERATOR.kind}:${OPERATOR.name}，backend=${SUPABASE_URL}）`);
