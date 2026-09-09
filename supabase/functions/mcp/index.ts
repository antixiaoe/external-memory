// index.ts — MCP 外挂记忆 Edge Function 入口（Streamable HTTP，无状态）
import { handleRpc } from './protocol.ts';
import { AuthError } from './auth.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'POST, GET, DELETE, OPTIONS',
};

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  if (req.method === 'GET') {
    // 健康检查 + 协议探测（部分 client 会先 GET 试探 SSE）
    return Response.json(
      { name: 'external-memory', version: '0.1.0', transport: 'streamable-http', usage: 'POST JSON-RPC to this endpoint' },
      { headers: CORS },
    );
  }

  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: CORS });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error: body must be JSON-RPC' } },
      { status: 400, headers: CORS },
    );
  }

  try {
    const resp = await handleRpc(body as never, req);
    if (resp === null) return new Response(null, { status: 202, headers: CORS }); // notification
    return Response.json(resp, { headers: CORS });
  } catch (e) {
    const status = e instanceof AuthError ? 401 : 500;
    return Response.json(
      { jsonrpc: '2.0', id: null, error: { code: status === 401 ? -32001 : -32603, message: String(e instanceof Error ? e.message : e) } },
      { status, headers: CORS },
    );
  }
});
