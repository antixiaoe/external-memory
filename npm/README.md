# external-memory-mcp

「外部记忆库」MCP server(stdio 传输,单文件零依赖,Node ≥ 18)。

给 Agent 长期记忆:会话开始 `wake` 唤醒脉络,对话中 `recall` 向量+关键词混合召回,
重要事实 `record` 落库(自动语义去重),定期 `consolidate` 整理归档、聚合 Story。
自托管模式:记忆存在**你自己的** Supabase 项目里,embedding 走**你自己的**硅基流动免费额度。

## 使用

```json
{
  "mcpServers": {
    "external-memory": {
      "command": "npx",
      "args": ["-y", "external-memory-mcp"],
      "env": {
        "npm_config_registry": "http://npm.guazi-corp.com",
        "SUPABASE_URL": "https://<你的ref>.supabase.co",
        "SUPABASE_SECRET_KEY": "sb_secret_...",
        "SILICONFLOW_API_KEY": "sk-...",
        "EM_OPERATOR": "human:<你的名字>"
      }
    }
  }
}
```

## 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `SUPABASE_URL` | ✅ | 你的 Supabase Project URL |
| `SUPABASE_SECRET_KEY` | ✅ | 你的 `sb_secret_...`(仅本机持有) |
| `SILICONFLOW_API_KEY` | ✅ | 硅基流动 `sk-...`(bge-m3 免费) |
| `EM_OPERATOR` | 可选 | `human:<名字>`(默认 `human:me`)或 `agent:<名>:*` / `agent:<名>:a\|b` |
| `EM_CLUSTER_THRESHOLD` | 可选 | Story 聚类阈值,默认 0.5 |
| `SUMMARY_MODEL` | 可选 | 聚合摘要模型,默认 `Qwen/Qwen3-8B` |

完整建库教程(Supabase 初始化、PWA 管理面板)见 SkillsHub 技能包内 `docs/自托管教程.md`。
