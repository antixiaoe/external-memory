# external-memory — MCP 外挂记忆

长期记忆外置服务：模型通过 MCP 工具（wake / recall / record / consolidate）读写记忆库，人在本地 PWA 查看与编辑。
设计文档：`C2网销产品文档仓库/pmac-product-asset-center/products/_草稿/刘晓燚/外部记忆库/`

## 两种形态

| | 托管 HTTP 版（团队共享） | 自托管 stdio 版（个人/推广） |
|---|---|---|
| 服务进程 | Supabase Edge Function（云端） | 本机单文件 `stdio/external-memory-mcp.mjs`（Node ≥18，零依赖） |
| 后端数据库 | 共享 Supabase 项目 | **每人自己建**免费 Supabase 项目 |
| 鉴权 | Bearer token → operator（auth.ts） | 本机 env `EM_OPERATOR`（无需 token） |
| 适合 | toC agent（一个 agent 服务多个客户，按客户建记忆）等团队级场景 | 同事各自安装、数据互不接触 |
| 文档 | [docs/使用说明.md](docs/使用说明.md) | [docs/自托管教程.md](docs/自托管教程.md) |

两版**共用同一套表结构与 RPC**（`supabase/migrations/`），数据可互通迁移。

## 架构（托管版）

```
大模型 / Agent ──MCP(Streamable HTTP)──▶ Supabase Edge Function (Deno)
                                            │  身份解析 operator→subject
                                            ▼
                                      Supabase PG (pgvector + pg_trgm)
本地 PWA ──supabase-js──────────────────▶ （同一套表）
Embedding: 硅基流动 BAAI/bge-m3（1024 维，OpenAI 兼容）
```

## 目录

```
supabase/migrations/0001_init.sql   -- 全部 DDL + RPC（hybrid_recall / nearest_memory / wake_memories / reinforce_hit / merge_memory）
supabase/functions/mcp/             -- MCP Edge Function（协议 + auth + 4 工具）
scripts/apply-ddl.mjs               -- 应用 migration 到云端库
scripts/test-embed.mjs              -- 单独验证 bge-m3 链路（无需 Supabase）
scripts/smoke.mjs                   -- 端到端冒烟（含双场景隔离验证）
pwa/                                -- 本地记忆面板（待建）
```

## 首次搭建（约 15 分钟）

### 1. 创建 Supabase 云端项目（人工，2 分钟）

1. https://supabase.com/dashboard → New project（免费档即可），记住数据库密码
2. 拿到四样东西填进 `.env`（照 `.env.example` 复制）：
   - Project URL：`https://<ref>.supabase.co`
   - Database connection string（Settings → Database → URI 格式）
   - service_role key（Settings → API）
   - project ref

### 2. 应用 DDL

```bash
npm install
npm run apply-ddl        # 直连库（需要本机 IPv6）
# 若报 ENOTFOUND（免费档直连是 IPv6-only，本机仅 IPv4 时用这条）：
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/apply-ddl-api.mjs
```

### 3. 配置密钥并部署 Edge Function

```bash
# 先在硅基流动控制台吊销暴露过的旧 key，新建一把填入 .env / .env.functions
cp .env.example .env && cp .env.example .env.functions  # 然后填值

npm run test:embed          # 验证 bge-m3 链路（无需 Supabase）

npx supabase login          # 需要 dashboard 的 access token
npx supabase link --project-ref <ref>
npm run secrets             # 上传 SILICONFLOW_API_KEY + OP_TOKENS 到 Edge Function
npm run deploy              # 部署 mcp 函数（不需要 Docker）
```

### 4. 端到端冒烟

```bash
npm run smoke
```

覆盖：tools/list、human 记录/召回/去重/唤醒、agent 按客户记录、**客户间隔离零串扰**、伪造 subject 无效、错 token 拒绝、consolidate。

### 5. 接入 MCP client（如 Claude Code）

```json
{
  "mcpServers": {
    "external-memory": {
      "type": "http",
      "url": "https://<ref>.supabase.co/functions/v1/mcp",
      "headers": { "Authorization": "Bearer tok_dev_human" }
    }
  }
}
```

配套 system prompt 规约（漏召回对策）：涉及该主体的历史偏好/过往事件时必须先 recall；处理某主体事务前必须先 wake。

## 身份模型（重要）

- **operator**（调用者）由 token 决定，服务端解析，模型不可伪造。
- **subject**（记忆主体）：human 调用 = 本人（入参忽略）；agent 调用 = 必传 `subject_id`（如 customer_id），服务端按白名单校验。
- 两种场景（多人使用 / toC agent 按客户建记忆）共用同一套表与检索，隔离键都是 `subject_id`。

## 红线

- `.env` / `.env.functions` / token / service_role key 永不进 git。
- embedding 模型与维度锁定为 bge-m3 / 1024；更换 = 全量重索引。
- 客户记忆数据离开本机前必须补 RLS + 授权 + 审计（见技术设计 §7）。
