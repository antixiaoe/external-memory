// scripts/eval-trgm.mjs — pg_trgm 中文关键词增益实测
// 方法：造一个评测主体（12 条中文记忆），对 6 条 query 分别用 κ=0（纯向量）和 κ=0.2（混合）
// 跑 hybrid_recall，对比目标记忆在 top5 中的名次。跑完自动清理评测数据。
// 用法: node scripts/eval-trgm.mjs
import { loadEnv } from './lib/env.mjs';

loadEnv();
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: KEY, SILICONFLOW_API_KEY } = process.env;
const SUBJECT = 'eval_trgm_temp';
const TOP_K = 5;

const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const MEMORIES = [
  ['我喜欢简洁直接的沟通风格', 'preference', 8],
  ['项目 CSS-44225 格子引擎的排期定在 Q3', 'event', 7],
  ['客户张伟上周三确认了报价单', 'event', 7],
  ['永远不要在工作群发未脱敏的客户手机号', 'constraint', 10],
  ['团队复盘会改到每周四下午三点', 'event', 6],
  ['我认为网销1号的转化率口径需要重新定义', 'preference', 7],
  ['Q2 销售额达成率 87%', 'event', 6],
  ['我对花生过敏，聚餐不要点带花生的菜', 'constraint', 9],
  ['新分配的实习生叫李婷，负责数据标注', 'event', 5],
  ['OKR 里 KR3 是完成私有化部署', 'event', 6],
  ['我希望早上九点前不要安排会议', 'preference', 7],
  ['上次团建去了密云水库', 'event', 4],
];

// [query, 目标记忆应包含的子串, 考察点]
const QUERIES = [
  ['格子引擎的项目编号是什么', 'CSS-44225', '精确编号'],
  ['张伟确认了什么', '张伟', '人名'],
  ['我的饮食禁忌', '花生', '纯语义'],
  ['我的沟通风格偏好', '简洁直接', '纯语义'],
  ['转化率口径怎么看', '网销1号', '混合'],
  ['销售额达成情况如何', '87%', '语义+数字'],
];

async function embedBatch(texts) {
  const resp = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${SILICONFLOW_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'BAAI/bge-m3', input: texts }),
  });
  if (!resp.ok) throw new Error(`embed: ${resp.status} ${await resp.text()}`);
  const data = await resp.json();
  return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function rest(path, init = {}) {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  if (!resp.ok) throw new Error(`${path}: ${resp.status} ${await resp.text()}`);
  const t = await resp.text();
  return t ? JSON.parse(t) : null;
}

async function recall(query, qEmb, kappa) {
  return rest('rpc/hybrid_recall', {
    method: 'POST',
    body: JSON.stringify({
      p_subject_id: SUBJECT, p_query: query,
      p_query_emb: `[${qEmb.join(',')}]`,
      p_top_k: TOP_K, p_kappa: kappa,
    }),
  });
}

// --- 准备：清旧数据 → 插入带向量的记忆 ---
await rest(`memory?subject_id=eq.${SUBJECT}`, { method: 'DELETE' });
const embs = await embedBatch(MEMORIES.map((m) => m[0]));
await rest('memory', {
  method: 'POST',
  body: JSON.stringify(MEMORIES.map(([content, type, importance], i) => ({
    subject_id: SUBJECT, content, type, importance, embedding: `[${embs[i].join(',')}]`,
  }))),
});
console.log(`已注入 ${MEMORIES.length} 条评测记忆\n`);

// --- 评测 ---
const qEmbs = await embedBatch(QUERIES.map((q) => q[0]));
console.log('| query | 考察点 | κ=0 纯向量名次 | κ=0.2 混合名次 |');
console.log('|---|---|---|---|');
let win = 0, tie = 0, lose = 0;
for (let i = 0; i < QUERIES.length; i++) {
  const [query, target, aspect] = QUERIES[i];
  const rankOf = (rows) => {
    const idx = rows.findIndex((r) => r.content.includes(target));
    return idx === -1 ? '未命中' : `#${idx + 1}`;
  };
  const [pure, hybrid] = [await recall(query, qEmbs[i], 0), await recall(query, qEmbs[i], 0.2)];
  const rPure = rankOf(pure), rHybrid = rankOf(hybrid);
  const toN = (r) => (r === '未命中' ? 99 : Number(r.slice(1)));
  if (toN(rHybrid) < toN(rPure)) win++;
  else if (toN(rHybrid) > toN(rPure)) lose++;
  else tie++;
  console.log(`| ${query} | ${aspect} | ${rPure} | ${rHybrid} |`);
}
console.log(`\n混合检索相对纯向量：胜 ${win} / 平 ${tie} / 负 ${lose}`);

// --- 清理 ---
await rest(`memory?subject_id=eq.${SUBJECT}`, { method: 'DELETE' });
console.log('评测数据已清理');
