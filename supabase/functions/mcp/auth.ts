// auth.ts — operator / subject 身份解析（技术设计 §2.1）
//
// operator token 映射通过 env OP_TOKENS 配置，格式：
//   OP_TOKENS="tok_aaa=human:liuxiaoyi,tok_bbb=agent:sales-agent:*,tok_ccc=agent:other:cust_001|cust_002"
//   - human:<subject>            人只能访问自己的记忆空间，忽略工具入参里的 subject_id
//   - agent:<name>:*             agent 可访问任意 subject（调用时必须传 subject_id）
//   - agent:<name>:a|b|c         agent 仅可访问白名单内的 subject

export interface Operator {
  kind: 'human' | 'agent';
  name: string;
  subject?: string;   // human 时 = 本人 subject
  scope: string[];    // agent 时允许的 subject 白名单，['*'] 表示不限
}

export class AuthError extends Error {}

function parseOpTokens(): Map<string, Operator> {
  const raw = Deno.env.get('OP_TOKENS') ?? '';
  const map = new Map<string, Operator>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const token = trimmed.slice(0, eq).trim();
    const parts = trimmed.slice(eq + 1).split(':');
    if (parts[0] === 'human' && parts[1]) {
      map.set(token, { kind: 'human', name: parts[1], subject: parts[1], scope: [parts[1]] });
    } else if (parts[0] === 'agent' && parts[1]) {
      const scope = (parts[2] ?? '').split('|').filter(Boolean);
      map.set(token, { kind: 'agent', name: parts[1], scope: scope.length ? scope : ['*'] });
    }
  }
  return map;
}

export function authenticate(req: Request): Operator {
  const auth = req.headers.get('Authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new AuthError('missing bearer token');
  const op = parseOpTokens().get(token);
  if (!op) throw new AuthError('invalid token');
  return op;
}

/** 每个工具入口第一行调用：解析本次请求的记忆主体 */
export function resolveSubject(req: Request, paramSubject?: unknown): string {
  const op = authenticate(req);
  if (op.kind === 'human') return op.subject!; // 人：忽略入参，只能是自己
  // agent：必须显式指定 subject（如 customer_id），且在授权范围内
  const subject = typeof paramSubject === 'string' ? paramSubject.trim() : '';
  if (!subject) throw new AuthError('agent 调用必须携带 subject_id（customer_id）');
  if (!op.scope.includes('*') && !op.scope.includes(subject)) {
    throw new AuthError(`operator ${op.name} 无权访问 subject ${subject}`);
  }
  return subject;
}

/** consolidate 用：agent 不传 subject 时，返回其全部授权范围（'*' 表示不过滤） */
export function resolveScope(req: Request, paramSubject?: unknown): string | '*' {
  const op = authenticate(req);
  if (op.kind === 'human') return op.subject!;
  const subject = typeof paramSubject === 'string' ? paramSubject.trim() : '';
  if (subject) {
    if (!op.scope.includes('*') && !op.scope.includes(subject)) {
      throw new AuthError(`operator ${op.name} 无权访问 subject ${subject}`);
    }
    return subject;
  }
  return op.scope.includes('*') ? '*' : op.scope[0]; // 白名单多个时默认取第一个，批量整理靠 cron 逐个调
}
