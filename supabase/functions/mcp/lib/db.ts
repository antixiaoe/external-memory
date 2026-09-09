// lib/db.ts — PostgREST 直连封装（不依赖 supabase-js，Edge Function 里零 npm 依赖）
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

function headers() {
  return {
    apikey: SERVICE_KEY,
    Authorization: `Bearer ${SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
}

/** 调用 RPC（数据库函数）。void 返回的函数 body 为空，需容错 */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args),
  });
  if (!resp.ok) throw new Error(`rpc ${fn} failed: ${resp.status} ${await resp.text()}`);
  const text = await resp.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** 表查询 */
export async function select<T = Record<string, unknown>>(
  table: string,
  query: string, // e.g. "subject_id=eq.x&status=eq.active&select=*"
): Promise<T[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: headers() });
  if (!resp.ok) throw new Error(`select ${table} failed: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T[]>;
}

/** 插入，返回插入行 */
export async function insert<T = Record<string, unknown>>(
  table: string,
  rows: Record<string, unknown> | Record<string, unknown>[],
): Promise<T[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  if (!resp.ok) throw new Error(`insert ${table} failed: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T[]>;
}

/** 更新 */
export async function update(
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: headers(),
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`update ${table} failed: ${resp.status} ${await resp.text()}`);
}

/** 更新并返回受影响行（用于 consolidate 计数） */
export async function updateReturning<T = Record<string, unknown>>(
  table: string,
  query: string,
  patch: Record<string, unknown>,
): Promise<T[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'PATCH',
    headers: { ...headers(), Prefer: 'return=representation' },
    body: JSON.stringify(patch),
  });
  if (!resp.ok) throw new Error(`update ${table} failed: ${resp.status} ${await resp.text()}`);
  return resp.json() as Promise<T[]>;
}

/** 删除 */
export async function remove(table: string, query: string): Promise<void> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${query}`, {
    method: 'DELETE',
    headers: headers(),
  });
  if (!resp.ok) throw new Error(`delete ${table} failed: ${resp.status} ${await resp.text()}`);
}

/** 向量数组 → pgvector 文本格式 */
export function toVectorLiteral(emb: number[]): string {
  return `[${emb.join(',')}]`;
}
