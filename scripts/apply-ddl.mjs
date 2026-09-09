// scripts/apply-ddl.mjs — 把 supabase/migrations/*.sql 按序应用到云端数据库
// 用法: node scripts/apply-ddl.mjs   （读取 .env 的 DATABASE_URL）
import { readFileSync, readdirSync } from 'node:fs';
import { loadEnv } from './lib/env.mjs';
import pg from 'pg';

loadEnv();
const { DATABASE_URL } = process.env;
if (!DATABASE_URL) {
  console.error('缺少 DATABASE_URL（Supabase Dashboard → Project Settings → Database → Connection string）');
  process.exit(1);
}

const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort();
const client = new pg.Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
for (const f of files) {
  const sql = readFileSync(`supabase/migrations/${f}`, 'utf8');
  console.log(`▶ applying ${f} ...`);
  await client.query(sql);
  console.log(`✔ ${f}`);
}
await client.end();
console.log('全部 migration 应用完成');
