// tools/recall.ts — 回忆：混合检索（向量语义 + pg_trgm 关键词 + 显著性加权）
// 命中后对返回记忆异步 reinforce+=0.05（封顶1）、刷新 last_hit_at（技术设计 §5.2）
import { resolveSubject } from '../auth.ts';
import { rpc, toVectorLiteral } from '../lib/db.ts';
import { embed } from '../lib/embedding.ts';

export const recallSpec = {
  name: 'recall',
  description:
    '【按需召回长期记忆】当问题涉及该主体的历史偏好、过往事件、之前说过的内容时，必须先调用本工具再回答；不确定时宁可调用一次。返回按相关度+显著性加权排序的记忆片段及原文溯源。',
  inputSchema: {
    type: 'object',
    properties: {
      subject_id: { type: 'string', description: '记忆主体 id。人类用户调用时省略；agent 调用时必传（如 customer_id）' },
      query: { type: 'string', description: '检索查询，用自然语言描述要找的记忆' },
      top_k: { type: 'number', description: '返回条数，默认 5，最大 20' },
      keyword_boost: { type: 'boolean', description: '是否启用关键词混合检索（默认 true）。查询含人名/编号等精确词时保持开启' },
    },
    required: ['query'],
  },
};

interface RecallRow {
  id: string;
  content: string;
  type: string;
  score: number;
  source_quote: string | null;
}

/** 命中巩固：reinforce = min(reinforce + 0.05, 1)，刷新 last_hit_at；失败不影响主链路 */
async function reinforceHits(rows: RecallRow[]): Promise<void> {
  for (const r of rows) {
    try {
      await rpc('reinforce_hit', { p_id: r.id, p_delta: 0.05 });
    } catch { /* 巩固失败不影响主链路 */ }
  }
}

export async function recall(req: Request, args: Record<string, unknown>) {
  const subject = resolveSubject(req, args.subject_id);
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query 不能为空');
  const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 20);
  const keywordBoost = args.keyword_boost !== false;

  const [qEmb] = await embed([query]);
  const rows = await rpc<RecallRow[]>('hybrid_recall', {
    p_subject_id: subject,
    p_query: query,
    p_query_emb: toVectorLiteral(qEmb),
    p_top_k: topK,
    p_kappa: keywordBoost ? 0.2 : 0,
  });

  // 异步巩固，不阻塞返回；本地 Deno 无 EdgeRuntime 时退化为浮空 promise
  const bg = reinforceHits(rows);
  try {
    (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<void>) => void } })
      .EdgeRuntime?.waitUntil(bg);
  } catch { void bg; }

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    type: r.type,
    score: Math.round(r.score * 1000) / 1000,
    source_quote: r.source_quote,
  }));
}
