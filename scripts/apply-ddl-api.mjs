// scripts/apply-ddl-api.mjs — 通过 Supabase Management API 执行 migration
// 适用场景：免费档直连库是 IPv6-only，本机只有 IPv4 时用它替代 apply-ddl.mjs
// 用法: SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-ddl-api.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { loadEnv } from './lib/env.mjs';

loadEnv();
const token = process.env.SUPABASE_ACCESS_TOKEN;
const ref = process.env.PROJECT_REF ?? 'bnxgezelwdztzhzrkugv';
if (!token) { console.error('缺少 SUPABASE_ACCESS_TOKEN'); process.exit(1); }

const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
for (const f of files) {
  const sql = readFileSync(`supabase/migrations/${f}`, 'utf8');
  console.log(`▶ applying ${f} via Management API ...`);
  const resp = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  if (!resp.ok) {
    console.error(`✘ ${f}: ${resp.status} ${await resp.text()}`);
    process.exit(1);
  }
  console.log(`✔ ${f}`);
}
console.log('全部 migration 应用完成');
