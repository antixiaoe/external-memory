// src/api.ts — 数据访问层（浏览器不持有任何密钥，全部走本机 Vite 代理：/sbapi → Supabase，/sfapi → 硅基流动）

export interface Memory {
  id: string;
  subject_id: string;
  content: string;
  type: 'preference' | 'event' | 'constraint';
  importance: number;
  reinforce: number;
  status: 'active' | 'archived';
  source_id: string | null;
  story_id: string | null;
  created_at: string;
  last_hit_at: string | null;
}

export interface Story {
  id: string;
  subject_id: string;
  title: string;
  summary: string;
  salience: number;
  time_span: [string, string] | null;
  created_at: string;
}

export interface SourceRow {
  id: string;
  subject_id: string;
  source_type: 'conversation' | 'diary';
  raw_text: string;
  session_ref: string | null;
  created_at: string;
}

const DEDUP_THRESHOLD = 0.9;
const MERGE_THRESHOLD = 0.9;
const ARCHIVE_DAYS = 90;
const BATCH = 50;
const CLUSTER_THRESHOLD = 0.5;
const MIN_CLUSTER_SIZE = 3;
const SUMMARY_MODEL = 'Qwen/Qwen3-8B';
const EMBED_MODEL = 'BAAI/bge-m3';

// ---------- 基础 ----------

function headers(extra: Record<string, string> = {}) {
  // 密钥由 Vite 代理注入（见 vite.config.ts），浏览器侧只带内容类型
  return { 'Content-Type': 'application/json', ...extra };
}

async function rest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const resp = await fetch(`/sbapi/rest/v1/${path}`, { ...init, headers: headers(init.headers as never) });
  if (!resp.ok) throw new Error(`${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

const rpc = <T>(fn: string, args: Record<string, unknown>) => rest<T>(`rpc/${fn}`, { method: 'POST', body: JSON.stringify(args) });
const toVectorLiteral = (emb: number[]) => `[${emb.join(',')}]`;
const parseVec = (v: string | number[]): number[] => (Array.isArray(v) ? v : JSON.parse(v));

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

async function embed(texts: string[]): Promise<number[][]> {
  const resp = await fetch('/sfapi/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
  });
  if (!resp.ok) throw new Error(`embedding: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.data.sort((a: { index: number }, b: { index: number }) => a.index - b.index).map((d: { embedding: number[] }) => d.embedding);
}

// ---- subjects ----
export async function listSubjects(): Promise<string[]> {
  const rows = await rest<Array<{ subject_id: string }>>('memory?select=subject_id');
  return [...new Set(rows.map((r) => r.subject_id))].sort();
}

// ---- memory ----
export async function listMemories(subject: string, type = '', status = ''): Promise<Memory[]> {
  let q = `memory?subject_id=eq.${encodeURIComponent(subject)}&order=importance.desc,created_at.desc&limit=500`;
  if (type) q += `&type=eq.${type}`;
  if (status) q += `&status=eq.${status}`;
  return rest<Memory[]>(q);
}

/** 语义搜索：浏览器内 embed → hybrid_recall RPC（与 MCP recall 同一打分公式） */
export async function searchMemories(subject: string, query: string) {
  const [qEmb] = await embed([query]);
  return rpc<Array<{ id: string; content: string; type: string; score: number; source_quote: string | null }>>(
    'hybrid_recall',
    { p_subject_id: subject, p_query: query, p_query_emb: toVectorLiteral(qEmb), p_top_k: 20 },
  );
}

export async function updateMemory(id: string, patch: Partial<Pick<Memory, 'content' | 'importance' | 'status' | 'type'>>) {
  await rest(`memory?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

export async function deleteMemory(id: string) {
  await rest(`memory?id=eq.${id}`, { method: 'DELETE' });
}

/** 重新生成 embedding：置空后走 backfill */
export async function reembedMemory(subject: string, id: string) {
  await rest(`memory?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ embedding: null }) });
  return backfill(subject);
}

// ---- record（提炼为记忆用，与 MCP record 同逻辑：去重合并） ----
export async function recordMemory(
  subject: string, content: string, type: string, importance: number, sourceId: string | null,
): Promise<{ dedup: string; merged_into?: string }> {
  let emb: number[] | null = null;
  try { [emb] = await embed([content]); } catch { /* 惰性兜底 */ }
  if (emb) {
    const nearest = await rpc<Array<{ id: string; content: string; cos_sim: number }>>(
      'nearest_memory', { p_subject_id: subject, p_emb: toVectorLiteral(emb) });
    const hit = nearest?.[0];
    if (hit && hit.cos_sim > DEDUP_THRESHOLD) {
      await rpc('merge_memory', { p_id: hit.id, p_importance: importance, p_source_id: sourceId });
      return { dedup: 'merged', merged_into: hit.content };
    }
  }
  await rest('memory', {
    method: 'POST',
    body: JSON.stringify({
      subject_id: subject, content, type, importance,
      embedding: emb ? toVectorLiteral(emb) : null, source_id: sourceId,
    }),
  });
  return { dedup: 'created' };
}

// ---- profile（核心画像，wake 常驻内容） ----
export async function getProfile(subject: string): Promise<{ persona: string; updated_at: string | null }> {
  const rows = await rest<Array<{ persona: string; updated_at: string }>>(
    `profile?subject_id=eq.${encodeURIComponent(subject)}&select=persona,updated_at`);
  return rows[0] ?? { persona: '', updated_at: null };
}

export async function saveProfile(subject: string, persona: string): Promise<void> {
  await rest('profile', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates' }, // subject_id 是主键 → upsert
    body: JSON.stringify({ subject_id: subject, persona, updated_at: new Date().toISOString() }),
  });
}

// ---- story ----
export async function listStories(subject: string): Promise<Story[]> {
  return rest(`story?subject_id=eq.${encodeURIComponent(subject)}&order=salience.desc,updated_at.desc`);
}

export async function createStory(subject: string, title: string, summary: string) {
  await rest('story', { method: 'POST', body: JSON.stringify({ subject_id: subject, title, summary }) });
}

export async function deleteStory(id: string) {
  await rest(`story?id=eq.${id}`, { method: 'DELETE' });
}

// ---- source ----
export async function listSources(subject: string): Promise<SourceRow[]> {
  return rest(`source?subject_id=eq.${encodeURIComponent(subject)}&order=created_at.desc&limit=200`);
}

export async function createSource(subject: string, rawText: string, sourceType: 'conversation' | 'diary') {
  await rest('source', { method: 'POST', body: JSON.stringify({ subject_id: subject, raw_text: rawText, source_type: sourceType }) });
}

// ---- 溯源 ----
export async function getSourceQuote(sourceId: string): Promise<string> {
  const rows = await rest<Array<{ raw_text: string }>>(`source?id=eq.${sourceId}&select=raw_text`);
  return rows[0]?.raw_text?.slice(0, 300) ?? '(source 已删除)';
}

// ---- 整理（consolidate 的浏览器移植版，逻辑与 MCP 版一致） ----
async function backfill(subject: string): Promise<number> {
  const rows = await rest<Array<{ id: string; content: string }>>(
    `memory?subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=is.null&select=id,content&limit=${BATCH}`);
  if (!rows.length) return 0;
  const embs = await embed(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++) {
    await rest(`memory?id=eq.${rows[i].id}`, { method: 'PATCH', body: JSON.stringify({ embedding: toVectorLiteral(embs[i]) }) });
  }
  return rows.length;
}

async function mergeDup(subject: string): Promise<number> {
  const rows = await rest<Array<{ id: string; importance: number; embedding: string }>>(
    `memory?subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=not.is.null&select=id,importance,embedding&order=created_at.asc&limit=${BATCH}`);
  let merged = 0;
  for (const r of rows) {
    const nearest = await rpc<Array<{ id: string; cos_sim: number }>>(
      'nearest_memory', { p_subject_id: subject, p_emb: r.embedding, p_exclude_id: r.id });
    const hit = nearest?.[0];
    if (hit && hit.cos_sim > MERGE_THRESHOLD) {
      await rpc('merge_memory', { p_id: hit.id, p_importance: r.importance, p_source_id: null });
      await rest(`memory?id=eq.${r.id}`, { method: 'DELETE' });
      merged++;
    }
  }
  return merged;
}

async function archiveOld(subject: string): Promise<number> {
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString();
  const rows = await rest<Array<{ id: string }>>(
    `memory?subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&importance=lte.2&reinforce=eq.0` +
    `&or=(last_hit_at.lt.${cutoff},and(last_hit_at.is.null,created_at.lt.${cutoff}))&select=id`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ status: 'archived' }) });
  return rows?.length ?? 0;
}

async function summarizeCluster(contents: string[]): Promise<{ title: string; summary: string }> {
  const fallback = () => ({ title: contents[0].slice(0, 20), summary: contents.join('；') });
  try {
    const resp = await fetch('/sfapi/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        enable_thinking: false,
        messages: [{
          role: 'user',
          content: `以下是与同一主体相关的若干条记忆，属于同一件完整事件。请输出 JSON：{"title": "≤15字的事件名", "summary": "≤80字的脉络摘要"}。\n要求：必须严格使用原文中的事实，数字、人名、金额、条款不得改动或编造。只输出 JSON，不要多余内容。\n\n${contents.map((c, i) => `${i + 1}. ${c}`).join('\n')}`,
        }],
        temperature: 0.3,
      }),
    });
    if (!resp.ok) throw new Error(`${resp.status}`);
    const data = await resp.json();
    const text: string = data.choices[0].message.content.replace(/```(?:json)?/g, '');
    let parsed: { title?: string; summary?: string } | null = null;
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { /* 走正则 */ } }
    if (!parsed?.title || !parsed?.summary) {
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

async function clusterStories(subject: string): Promise<number> {
  const memories = await rest<Array<{ id: string; content: string; importance: number; embedding: string; created_at: string }>>(
    `memory?subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&story_id=is.null&embedding=not.is.null` +
    `&select=id,content,importance,embedding,created_at&order=created_at.asc&limit=200`);
  if (!memories.length) return 0;

  const stories = await rest<Array<{ id: string; embedding: string }>>(
    `story?subject_id=eq.${encodeURIComponent(subject)}&embedding=not.is.null&select=id,embedding`);
  const remaining: typeof memories = [];
  for (const m of memories) {
    const vec = parseVec(m.embedding);
    let best: { id: string; sim: number } | null = null;
    for (const s of stories) {
      const sim = cosineSim(vec, parseVec(s.embedding));
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { id: s.id, sim };
    }
    if (best) {
      await rest(`memory?id=eq.${m.id}`, { method: 'PATCH', body: JSON.stringify({ story_id: best.id }) });
    } else {
      remaining.push(m);
    }
  }

  const clusters: Array<{ centroid: number[]; members: typeof memories }> = [];
  for (const m of remaining) {
    const vec = parseVec(m.embedding);
    let best: { c: (typeof clusters)[0]; sim: number } | null = null;
    for (const c of clusters) {
      const sim = cosineSim(vec, c.centroid);
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { c, sim };
    }
    if (best) {
      best.c.members.push(m);
      const n = best.c.members.length;
      best.c.centroid = best.c.centroid.map((v, i) => (v * (n - 1) + vec[i]) / n);
    } else {
      clusters.push({ centroid: [...vec], members: [m] });
    }
  }

  let created = 0;
  for (const c of clusters) {
    if (c.members.length < MIN_CLUSTER_SIZE) continue;
    const contents = c.members.map((m) => m.content);
    const { title, summary } = await summarizeCluster(contents);
    const [sumEmb] = await embed([summary]);
    const maxImportance = Math.max(...c.members.map((m) => m.importance));
    const times = c.members.map((m) => m.created_at).sort();
    const inserted = await rest<Array<{ id: string }>>('story', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({
        subject_id: subject, title, summary,
        embedding: toVectorLiteral(sumEmb),
        salience: Math.min(1, maxImportance / 10 + 0.05 * c.members.length),
        time_span: `[${times[0]},${times[times.length - 1]}]`,
      }),
    });
    for (const m of c.members) {
      await rest(`memory?id=eq.${m.id}`, { method: 'PATCH', body: JSON.stringify({ story_id: inserted[0].id }) });
    }
    created++;
  }
  return created;
}

export async function consolidate(subject: string) {
  const backfilled = await backfill(subject);
  const merged = await mergeDup(subject);
  const archived = await archiveOld(subject);
  const stories_created = await clusterStories(subject);
  return { backfilled, merged, archived, stories_created };
}

// ---- 导出（合规底线）----
export async function exportJson(subject: string) {
  const [memories, stories, sources, profiles] = await Promise.all([
    rest<Memory[]>(`memory?subject_id=eq.${encodeURIComponent(subject)}`),
    rest<Story[]>(`story?subject_id=eq.${encodeURIComponent(subject)}`),
    rest<SourceRow[]>(`source?subject_id=eq.${encodeURIComponent(subject)}`),
    rest<Array<Record<string, unknown>>>(`profile?subject_id=eq.${encodeURIComponent(subject)}`),
  ]);
  const strip = memories.map((m) => ({ ...m, embedding: undefined }));
  const payload = { exported_at: new Date().toISOString(), subject, profile: profiles[0] ?? null, memories: strip, stories, sources };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `memory-export-${subject}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
