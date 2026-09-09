// protocol.ts — MCP Streamable HTTP 最小实现（无状态单 endpoint，技术设计 §5.1）
// 支持：initialize / notifications/initialized / ping / tools/list / tools/call
import { AuthError } from './auth.ts';
import { wakeSpec, wake } from './tools/wake.ts';
import { recallSpec, recall } from './tools/recall.ts';
import { recordSpec, record } from './tools/record.ts';
import { consolidateSpec, consolidate } from './tools/consolidate.ts';

const PROTOCOL_VERSION = '2025-06-18';

const TOOLS = [
  { spec: wakeSpec, handler: wake },
  { spec: recallSpec, handler: recall },
  { spec: recordSpec, handler: record },
  { spec: consolidateSpec, handler: consolidate },
];

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function ok(id: string | number | undefined, result: unknown) {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function err(id: string | number | undefined | null, code: number, message: string) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** 返回 null 表示这是 notification，HTTP 层应回 202 */
export async function handleRpc(body: JsonRpcRequest, req: Request): Promise<unknown | null> {
  const { id, method, params } = body;

  // notification（无 id 的 initialized 等）→ 不回 body
  if (method?.startsWith('notifications/')) return null;

  switch (method) {
    case 'initialize':
      return ok(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'external-memory', version: '0.1.0' },
      });

    case 'ping':
      return ok(id, {});

    case 'tools/list':
      return ok(id, {
        tools: TOOLS.map((t) => ({
          name: t.spec.name,
          description: t.spec.description,
          inputSchema: t.spec.inputSchema,
        })),
      });

    case 'tools/call': {
      const name = String(params?.name ?? '');
      const args = (params?.arguments ?? {}) as Record<string, unknown>;
      const tool = TOOLS.find((t) => t.spec.name === name);
      if (!tool) return err(id, -32602, `unknown tool: ${name}`);
      try {
        const result = await tool.handler(req, args);
        return ok(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result,
        });
      } catch (e) {
        if (e instanceof AuthError) {
          return ok(id, { content: [{ type: 'text', text: `鉴权失败: ${e.message}` }], isError: true });
        }
        return ok(id, {
          content: [{ type: 'text', text: `工具执行失败: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        });
      }
    }

    default:
      return err(id, -32601, `method not found: ${method}`);
  }
}
