// tools/record.ts — 记录：写入新记忆（语义去重 + embedding 惰性兜底）
// 去重：与该 subject 已有记忆最近邻 cosine > 0.9 → 合并而非新增（技术设计 §5.2）
import { resolveSubject } from '../auth.ts';
import { insert, rpc, toVectorLiteral } from '../lib/db.ts';
import { embed } from '../lib/embedding.ts';

const DEDUP_THRESHOLD = 0.9; // cosine 相似度阈值

export const recordSpec = {
  name: 'record',
  description:
    '【写入长期记忆】当对话中出现值得长期记住的事实、偏好或约束时调用。不要记录寒暄、一次性信息、可轻易重新查询的内容。' +
    'importance 打分规则：10=长期约束（如"永远不要做X"），7-9=重要事实/重大决定，4-6=一般事件，1-3=琐碎可丢弃。',
  inputSchema: {
    type: 'object',
    properties: {
      subject_id: { type: 'string', description: '记忆主体 id。人类用户调用时省略；agent 调用时必传（如 customer_id）' },
      content: { type: 'string', description: '一句话事实，应可脱离上下文独立理解' },
      type: { type: 'string', enum: ['preference', 'event', 'constraint'], description: 'preference=偏好/事实；event=情景/事件；constraint=长期约束（将常驻每次唤醒）' },
      importance: { type: 'number', description: '重要性 1-10，见打分规则' },
      source_id: { type: 'string', description: '可选，原始素材 id，用于溯源' },
    },
    required: ['content', 'type', 'importance'],
  },
};

export async function record(req: Request, args: Record<string, unknown>) {
  const subject = resolveSubject(req, args.subject_id);
  const content = String(args.content ?? '').trim();
  if (!content) throw new Error('content 不能为空');
  const type = String(args.type);
  if (!['preference', 'event', 'constraint'].includes(type)) throw new Error('type 非法');
  const importance = Math.min(Math.max(Math.round(Number(args.importance) || 5), 1), 10);
  const sourceId = typeof args.source_id === 'string' && args.source_id ? args.source_id : null;

  // embedding 失败不阻塞写入：落库 embedding=null，由 consolidate backfill 惰性补齐
  let emb: number[] | null = null;
  try {
    [emb] = await embed([content]);
  } catch { /* 惰性兜底 */ }

  // 语义去重
  if (emb) {
    const nearest = await rpc<Array<{ id: string; content: string; cos_sim: number }>>(
      'nearest_memory',
      { p_subject_id: subject, p_emb: toVectorLiteral(emb) },
    );
    const hit = nearest[0];
    if (hit && hit.cos_sim > DEDUP_THRESHOLD) {
      await rpc('merge_memory', {
        p_id: hit.id,
        p_importance: importance,
        p_source_id: sourceId,
      });
      return { id: hit.id, dedup: 'merged', merged_into: hit.content };
    }
  }

  const rows = await insert('memory', {
    subject_id: subject,
    content,
    type,
    importance,
    embedding: emb ? toVectorLiteral(emb) : null,
    source_id: sourceId,
  });
  const id = (rows[0] as { id: string }).id;

  return { id, dedup: 'created', embedded: emb !== null };
}
