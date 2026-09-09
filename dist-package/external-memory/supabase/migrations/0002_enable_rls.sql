-- 0002_enable_rls.sql — 开启 RLS（不建任何 policy）
-- 效果：anon/authenticated（publishable key）对四表全部拒绝；
--       service_role（Edge Function 与本地 PWA 使用）绕过 RLS，不受影响。
-- 公网多人化时再按 subject 建细粒度 policy（见技术设计 §2.1 演进路径）。

alter table profile enable row level security;
alter table source  enable row level security;
alter table memory  enable row level security;
alter table story   enable row level security;
