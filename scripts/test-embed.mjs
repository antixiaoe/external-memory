// scripts/test-embed.mjs — 验证硅基流动 bge-m3 链路（无需 Supabase）
// 用法: node scripts/test-embed.mjs
import { loadEnv } from './lib/env.mjs';

loadEnv();
const key = process.env.SILICONFLOW_API_KEY;
if (!key) { console.error('缺少 SILICONFLOW_API_KEY（见 .env.example）'); process.exit(1); }

const resp = await fetch('https://api.siliconflow.cn/v1/embeddings', {
  method: 'POST',
  headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ model: 'BAAI/bge-m3', input: ['外部记忆库的第一条测试记忆', '客户上周决定采购 20 台车'] }),
});
if (!resp.ok) { console.error('失败:', resp.status, await resp.text()); process.exit(1); }
const data = await resp.json();
for (const d of data.data) {
  console.log(`dim=${d.embedding.length} first3=[${d.embedding.slice(0, 3).map((x) => x.toFixed(4)).join(', ')}]`);
}
console.log('usage:', data.usage);
console.log('✔ bge-m3 embedding 链路正常');
