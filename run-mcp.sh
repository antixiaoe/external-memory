#!/bin/bash
# external-memory MCP 启动包装：从 ~/external-memory/.env 加载凭据，映射 SUPABASE_SECRET_KEY
set -a
source "$HOME/external-memory/.env"
set +a
export SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY:-$SUPABASE_SERVICE_ROLE_KEY}"
export EM_OPERATOR="${EM_OPERATOR:-liuxiaoyi}"
exec node "$HOME/Downloads/C2网销产品文档仓库/.claude/skills/external-memory-skill/stdio/external-memory-mcp.mjs"
