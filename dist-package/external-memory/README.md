# 外部记忆库 MCP

给 Agent 装上长期记忆：不把所有历史塞进上下文，按需召回——会话开始「唤醒」、聊天中「回忆」、值得记的「记录」、定期「整理」。

- **数据归你**：后端是你自己的免费 Supabase 项目，记忆不出你的账号
- **零服务成本**：embedding 用硅基流动免费模型 bge-m3，MCP 是本机单文件进程（Node ≥18，零依赖）
- **多主体隔离**：每个用户/客户独立记忆空间，互不可见
- **混合检索**：向量语义 + 中文关键词 + 显著性打分（重要性 × 时间衰减 × 越用越强）
- **三层记忆**：Source 原始素材 / Memory 事实单元 / Story 事件脉络（自动聚合）
- **附管理面板**：本地 PWA 查看、编辑、删除、导出记忆

## 快速开始

详见 **[docs/自托管教程.md](docs/自托管教程.md)**，15 分钟四步：

1. 建免费 Supabase 项目 → 拿到 URL 和 Secret Key
2. SQL Editor 粘贴 `supabase/migrations/` 里两个 .sql 建表
3. 注册硅基流动 → 拿 API Key
4. MCP client 配置本包 `stdio/external-memory-mcp.mjs` + 三个环境变量

可选第 5 步：`pwa/` 本地起管理面板。

## 包内容

```
stdio/external-memory-mcp.mjs    MCP server（单文件，零依赖）
supabase/migrations/             建表与函数 SQL（两个都要执行）
pwa/                             本地记忆管理面板（可选）
scripts/apply-ddl-api.mjs        初始化建表的命令行替代方案
docs/自托管教程.md                完整教程（四个凭据获取 + 配置 + 验证）
SKILL.md                         给 Agent 的工具使用说明
```

## 安全说明

- 本包不含任何密钥；你的三个凭据只写在你本机的 MCP client 配置和 `pwa/.env.local` 里
- 迁移 SQL 中的 `0002_enable_rls.sql` 会开启行级安全，请务必执行（否则你的 secret key 一旦泄露等于数据库裸奔）
- 怀疑凭据泄露：Supabase 控制台 Rotate + 硅基流动吊销重建
