# 外部记忆库 MCP（external-memory）

给你的 Agent 装上跨会话长期记忆：唤醒(wake)、回忆(recall)、记录(record)、整理(consolidate)。

## 何时使用

- 会话开始、或开始处理某个用户/客户的事务时 → 先调 `wake` 恢复该主体的记忆脉络
- 问题涉及主体的历史偏好、过往事件、之前说过的内容 → 先调 `recall` 再回答
- 对话中出现值得长期记住的事实/偏好/约束 → 调 `record`
- 定期维护（每天或每周）→ 调 `consolidate`

## 四个工具

| 工具 | 作用 | 关键入参 |
|---|---|---|
| `wake` | 加载核心画像 + 高显著记忆 + 进行中 Story（≤1500 token） | 无（agent 模式必传 `subject_id`） |
| `recall` | 混合检索：向量语义 + 关键词 + 显著性加权 | `query` 必填；`top_k` 默认 5 |
| `record` | 写入记忆，语义重复自动合并 | `content`/`type`/`importance` 必填 |
| `consolidate` | 补向量、去重、归档、Story 聚合 | `mode` 默认 all |

## 使用约束（必须遵守）

1. `record` 的 content 写成**一句话、可脱离上下文独立理解**的事实。
2. `type`：`preference`=偏好/事实，`event`=情景/事件，`constraint`=长期约束（会常驻每次 wake）。
3. `importance`：10=长期约束，7-9=重要事实/重大决定，4-6=一般事件，1-3=琐碎。不要记录寒暄、一次性信息、可随时重新查询的内容。
4. `record` 返回 `dedup=merged` 是正常合并，**不要重试**。
5. 不要跨主体引用记忆；agent 模式下 `subject_id` 必须是当前正在服务的主体（如 customer_id）。
6. 不确定该不该召回时，宁可调一次 `recall`。

## 运行前提

- 本服务为 stdio 模式本地进程，需要环境变量：`SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`SILICONFLOW_API_KEY`，可选 `EM_OPERATOR`。
- 后端初始化（建表 SQL）与凭据获取见随包 `docs/自托管教程.md`。
