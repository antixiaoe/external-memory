// tools/wake.ts — 唤醒：会话启动一次，加载核心画像 + 高显著性记忆 + 进行中 Story
// 预算硬约束：profile 全量 + ≤10 条记忆 + ≤3 条 story（技术设计 §5.2）
import { resolveSubject } from '../auth.ts';
import { rpc, select } from '../lib/db.ts';

export const wakeSpec = {
  name: 'wake',
  description:
    '【会话启动时必须先调用一次】唤醒长期记忆：返回该主体的核心画像、最重要的记忆（含全部长期约束）和进行中的事件脉络，用于恢复人格/客户关系连续性。处理某主体的事务前必须先 wake。',
  inputSchema: {
    type: 'object',
    properties: {
      subject_id: { type: 'string', description: '记忆主体 id。人类用户调用时省略；agent 调用时必传（如 customer_id）' },
    },
    required: [],
  },
};

export async function wake(req: Request, args: Record<string, unknown>) {
  const subject = resolveSubject(req, args.subject_id);

  const [profiles, constraints, tops, stories] = await Promise.all([
    select('profile', `subject_id=eq.${encodeURIComponent(subject)}&select=persona`),
    select(
      'memory',
      `subject_id=eq.${encodeURIComponent(subject)}&status=eq.active&type=eq.constraint&select=id,content,type,importance&order=importance.desc`,
    ),
    rpc<Array<{ id: string; content: string; type: string; importance: number; reinforce: number }>>(
      'wake_memories',
      { p_subject_id: subject, p_limit: 10, p_tau_days: 30 },
    ),
    select(
      'story',
      `subject_id=eq.${encodeURIComponent(subject)}&select=title,summary&order=salience.desc&limit=3`,
    ),
  ]);

  return {
    profile: profiles[0]?.persona ?? null,
    top_memories: [
      ...constraints.map((m) => ({ content: m.content, type: m.type, importance: m.importance })),
      ...tops.map((m) => ({ content: m.content, type: m.type, importance: m.importance })),
    ],
    active_stories: stories.map((s) => ({ title: s.title, summary: s.summary })),
    _meta: { subject, memory_count: constraints.length + tops.length },
  };
}
