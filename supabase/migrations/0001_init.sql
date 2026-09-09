-- 0001_init.sql — MCP 外挂记忆：初始化 DDL
-- 对应技术设计文档 §3。在 Supabase SQL Editor 或 scripts/apply-ddl.mjs 执行。

-- 0. 扩展
create extension if not exists vector;
create extension if not exists pg_trgm;

-- 1. 核心画像（wake 常驻内容；一个 subject 一行）
create table if not exists profile (
  subject_id  text primary key,       -- 人 id 或客户 id
  persona     text,
  updated_at  timestamptz default now()
);

-- 2. Source：原始素材（对话/日记，不直接喂模型）
create table if not exists source (
  id          uuid primary key default gen_random_uuid(),
  subject_id  text not null,
  source_type text not null check (source_type in ('conversation','diary')),
  raw_text    text not null,
  session_ref text,
  created_at  timestamptz default now()
);
create index if not exists source_subject_created on source (subject_id, created_at desc);

-- 3. Memory：可检索事实单元
create table if not exists memory (
  id          uuid primary key default gen_random_uuid(),
  subject_id  text not null,
  content     text not null,
  type        text not null check (type in ('preference','event','constraint')),
  embedding   vector(1024),               -- bge-m3，允许暂空(异步补)
  importance  smallint not null check (importance between 1 and 10),
  reinforce   real not null default 0,
  source_id   uuid references source(id),
  story_id    uuid,                        -- 本期恒为 null
  status      text not null default 'active' check (status in ('active','archived')),
  created_at  timestamptz default now(),
  last_hit_at timestamptz
);
-- HNSW 需要先有数据或用合理参数；空表上建也可，后续随数据量调 lists/m
create index if not exists memory_emb_hnsw on memory using hnsw (embedding vector_cosine_ops);
create index if not exists memory_content_trgm on memory using gin (content gin_trgm_ops);
create index if not exists memory_subject_status on memory (subject_id, status, importance desc);

-- 4. Story：长时序脉络（本期建表，聚合算法下期）
create table if not exists story (
  id          uuid primary key default gen_random_uuid(),
  subject_id  text not null,
  title       text not null,
  summary     text not null,
  embedding   vector(1024),
  salience    real default 0,
  time_span   tstzrange,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
create index if not exists story_emb_hnsw on story using hnsw (embedding vector_cosine_ops);

-- 5. 混合检索 RPC：recall 的核心
--    score = α·sem + κ·kw + β·importance/10·e^(-Δt/τ) + γ·reinforce，三量纲均归一到 [0,1]
create or replace function hybrid_recall(
  p_subject_id text,
  p_query text,
  p_query_emb vector(1024),
  p_top_k int default 5,
  p_alpha real default 0.4,
  p_kappa real default 0.2,
  p_beta  real default 0.3,
  p_gamma real default 0.1,
  p_tau_days real default 30
) returns table(id uuid, content text, type text, score real, source_quote text)
language sql stable as $$
  select m.id, m.content, m.type,
    p_alpha * ((1 + (1 - (m.embedding <=> p_query_emb))) / 2)
    + p_kappa * similarity(m.content, p_query)
    + p_beta  * (m.importance / 10.0)
        * exp(-extract(epoch from (now() - m.created_at)) / 86400.0 / p_tau_days)
    + p_gamma * m.reinforce                                           as score,
    (select left(s.raw_text, 200) from source s where s.id = m.source_id) as source_quote
  from memory m
  where m.subject_id = p_subject_id
    and m.status = 'active'
    and m.embedding is not null
  order by score desc
  limit p_top_k;
$$;

-- 6. 最近邻记忆（record 语义去重用）：返回与给定向量 cosine 最相似的一条
create or replace function nearest_memory(
  p_subject_id text,
  p_emb vector(1024),
  p_exclude_id uuid default null
) returns table(id uuid, content text, cos_sim real)
language sql stable as $$
  select m.id, m.content, 1 - (m.embedding <=> p_emb) as cos_sim
  from memory m
  where m.subject_id = p_subject_id
    and m.status = 'active'
    and m.embedding is not null
    and (p_exclude_id is null or m.id <> p_exclude_id)
  order by m.embedding <=> p_emb asc
  limit 1;
$$;

-- 8. 命中巩固：recall 返回后 reinforce = min(reinforce + delta, 1)，刷新 last_hit_at
create or replace function reinforce_hit(p_id uuid, p_delta real default 0.05)
returns void
language sql volatile as $$
  update memory
  set reinforce = least(reinforce + p_delta, 1),
      last_hit_at = now()
  where id = p_id;
$$;

-- 9. 语义去重合并（record 用）：取更高 importance、reinforce +0.1（封顶1）、刷新 source_id
create or replace function merge_memory(p_id uuid, p_importance smallint, p_source_id uuid default null)
returns void
language sql volatile as $$
  update memory
  set importance = greatest(importance, p_importance),
      reinforce = least(reinforce + 0.1, 1),
      source_id = coalesce(p_source_id, source_id),
      last_hit_at = now()
  where id = p_id;
$$;

-- 10. wake 用：按 importance·decay + reinforce 排序取 top（constraint 由调用方单独全量取）
create or replace function wake_memories(
  p_subject_id text,
  p_limit int default 10,
  p_tau_days real default 30
) returns table(id uuid, content text, type text, importance smallint, reinforce real)
language sql stable as $$
  select m.id, m.content, m.type, m.importance, m.reinforce
  from memory m
  where m.subject_id = p_subject_id
    and m.status = 'active'
    and m.type <> 'constraint'
  order by (m.importance / 10.0)
      * exp(-extract(epoch from (now() - m.created_at)) / 86400.0 / p_tau_days)
      + m.reinforce desc
  limit p_limit;
$$;
