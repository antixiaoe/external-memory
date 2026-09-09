// tools/consolidate.ts — 整理：backfill 补 embedding / merge 去重 / archive 归档
// cluster（Story 聚合）本期占位返回 0（技术设计 §5.2）
import { resolveScope } from '../auth.ts';
import { insert, remove, rpc, select, toVectorLiteral, update, updateReturning } from '../lib/db.ts';
import { embed } from '../lib/embedding.ts';

const MERGE_THRESHOLD = 0.9;
const ARCHIVE_DAYS = 90;
const BATCH = 50; // 单次 consolidate 处理上限，防止超时

export const consolidateSpec = {
  name: 'consolidate',
  description:
    '【整理记忆库】维护性操作：补齐缺失的向量(backfill)、合并重复记忆(merge)、归档低价值旧记忆(archive)。agent 不传 subject_id 时整理其授权范围内全部主体。',
  inputSchema: {
    type: 'object',
    properties: {
      subject_id: { type: 'string', description: '记忆主体 id。人类用户省略=整理自己；agent 省略=整理授权范围全部' },
      mode: { type: 'string', enum: ['backfill', 'merge', 'archive', 'cluster', 'all'], description: '默认 all' },
    },
    required: [],
  },
};

interface MemoryRow {
  id: string;
  content: string;
  importance: number;
  embedding: string | null;
}

/** 根据 scope 取待处理主体集合（'*' = 全部有活跃记忆的主体） */
async function subjectsInScope(scope: string | '*'): Promise<string[]> {
  if (scope !== '*') return [scope];
  const rows = await select<{ subject_id: string }>('memory', 'status=eq.active&select=subject_id');
  return [...new Set(rows.map((r) => r.subject_id))];
}

/** backfill：embedding 为空的记忆批量补向量 */
async function backfill(subject: string): Promise<number> {
  const rows = await select<Pick<MemoryRow, 'id' | 'content'>>(
    'memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=is.null&select=id,content&limit=${BATCH}`,
  );
  if (!rows.length) return 0;
  const embs = await embed(rows.map((r) => r.content));
  for (let i = 0; i < rows.length; i++) {
    await update('memory', `id=eq.${rows[i].id}`, { embedding: toVectorLiteral(embs[i]) });
  }
  return rows.length;
}

/** merge：逐条找最近邻，cosine > 阈值则合并进已存在那条（保留下者，merge_memory 取最大 importance） */
async function merge(subject: string): Promise<number> {
  const rows = await select<MemoryRow>(
    'memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&embedding=not.is.null&select=id,content,importance,embedding&order=created_at.asc&limit=${BATCH}`,
  );
  let merged = 0;
  for (const r of rows) {
    const nearest = await rpc<Array<{ id: string; content: string; cos_sim: number }>>(
      'nearest_memory',
      { p_subject_id: subject, p_emb: r.embedding, p_exclude_id: r.id },
    );
    const hit = nearest[0];
    if (hit && hit.cos_sim > MERGE_THRESHOLD) {
      await rpc('merge_memory', { p_id: hit.id, p_importance: r.importance, p_source_id: null });
      await remove('memory', `id=eq.${r.id}`);
      merged++;
    }
  }
  return merged;
}

/** archive：importance≤2 且 reinforce=0 且 90 天未命中（从未命中按创建时间计） */
async function archive(subject: string): Promise<number> {
  const cutoff = new Date(Date.now() - ARCHIVE_DAYS * 86400_000).toISOString();
  const rows = await updateReturning<{ id: string }>(
    'memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&importance=lte.2&reinforce=eq.0` +
      `&or=(last_hit_at.lt.${cutoff},and(last_hit_at.is.null,created_at.lt.${cutoff}))&select=id`,
    { status: 'archived' },
  );
  return rows.length;
}

// ---------- Story 聚合（cluster） ----------
// bge-m3 实测分布：同一事件 0.53~0.61，无关 0.39~0.45 → 默认 0.5 落在间隙（数据量大后按分布上调）
const CLUSTER_THRESHOLD = Number(Deno.env.get('EM_CLUSTER_THRESHOLD')) || 0.5;
const MIN_CLUSTER_SIZE = 3;
const SUMMARY_MODEL = Deno.env.get('SUMMARY_MODEL') || 'Qwen/Qwen3-8B';

const parseVec = (v: string | number[]): number[] => (Array.isArray(v) ? v : JSON.parse(v));

function cosineSim(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** LLM 为一簇记忆生成标题+摘要；解析鲁棒；失败回退启发式（拼接，事实安全） */
async function summarizeCluster(contents: string[]): Promise<{ title: string; summary: string }> {
  const fallback = () => ({ title: contents[0].slice(0, 20), summary: contents.join('；') });
  try {
    const resp = await fetch('https://api.siliconflow.cn/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Deno.env.get('SILICONFLOW_API_KEY')}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: SUMMARY_MODEL,
        enable_thinking: false,
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

interface ClusterMemory {
  id: string;
  content: string;
  importance: number;
  embedding: string;
  created_at: string;
  _vec?: number[];
}

/** cluster：未归属 Story 的活跃记忆 → 挂已有 Story 或贪心聚类 → ≥3 条成 Story */
async function clusterStories(subject: string): Promise<{ created: number; attached: number }> {
  const memories = await select<ClusterMemory>(
    'memory',
    `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&story_id=is.null&embedding=not.is.null` +
      `&select=id,content,importance,embedding,created_at&order=created_at.asc&limit=200`,
  );
  if (!memories.length) return { created: 0, attached: 0 };
  for (const m of memories) m._vec = parseVec(m.embedding);

  // 1) 先挂已有 Story
  const stories = await select<{ id: string; embedding: string }>(
    'story',
    `subject_id=eq.${encodeURIComponent(subject)}&embedding=not.is.null&select=id,embedding`,
  );
  let attached = 0;
  const remaining: ClusterMemory[] = [];
  for (const m of memories) {
    let best: { id: string; sim: number } | null = null;
    for (const s of stories) {
      const sim = cosineSim(m._vec!, parseVec(s.embedding));
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { id: s.id, sim };
    }
    if (best) {
      await update('memory', `id=eq.${m.id}`, { story_id: best.id });
      attached++;
    } else {
      remaining.push(m);
    }
  }

  // 2) 贪心聚类（与簇质心比较）
  const clusters: Array<{ centroid: number[]; members: ClusterMemory[] }> = [];
  for (const m of remaining) {
    let best: { c: (typeof clusters)[0]; sim: number } | null = null;
    for (const c of clusters) {
      const sim = cosineSim(m._vec!, c.centroid);
      if (sim > CLUSTER_THRESHOLD && (!best || sim > best.sim)) best = { c, sim };
    }
    if (best) {
      best.c.members.push(m);
      const n = best.c.members.length;
      best.c.centroid = best.c.centroid.map((v, i) => (v * (n - 1) + m._vec![i]) / n);
    } else {
      clusters.push({ centroid: [...m._vec!], members: [m] });
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
    const rows = await insert('story', {
      subject_id: subject, title, summary,
      embedding: toVectorLiteral(sumEmb),
      salience,
      time_span: `[${times[0]},${times[times.length - 1]}]`,
    });
    const storyId = (rows[0] as { id: string }).id;
    for (const m of c.members) {
      await update('memory', `id=eq.${m.id}`, { story_id: storyId });
    }
    created++;
  }
  return { created, attached };
}

export async function consolidate(req: Request, args: Record<string, unknown>) {
  const scope = resolveScope(req, args.subject_id);
  const mode = String(args.mode ?? 'all');
  const subjects = await subjectsInScope(scope);

  let backfilled = 0, merged = 0, archived = 0, storiesCreated = 0, storiesAttached = 0;
  for (const subject of subjects) {
    if (mode === 'backfill' || mode === 'all') backfilled += await backfill(subject);
    if (mode === 'merge' || mode === 'all') merged += await merge(subject);
    if (mode === 'archive' || mode === 'all') archived += await archive(subject);
    if (mode === 'cluster' || mode === 'all') {
      const r = await clusterStories(subject);
      storiesCreated += r.created;
      storiesAttached += r.attached;
    }
  }

  return {
    subjects_processed: subjects.length,
    backfilled,
    merged,
    archived,
    stories_created: storiesCreated,
    memories_attached_to_stories: storiesAttached,
  };
}
