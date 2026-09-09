// lib/embedding.ts — 硅基流动 bge-m3（OpenAI 兼容，1024 维）
// 规则（技术设计 §4）：模型与维度锁定；失败重试 3 次；调用方决定失败时是否兜底。
export const EMBED_MODEL = 'BAAI/bge-m3';
export const EMBED_DIM = 1024;

const API_URL = 'https://api.siliconflow.cn/v1/embeddings';

export async function embed(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get('SILICONFLOW_API_KEY');
  if (!key) throw new Error('SILICONFLOW_API_KEY not set');

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      });
      if (resp.status === 429 || resp.status >= 500) {
        lastErr = new Error(`embed retryable: ${resp.status}`);
        await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
        continue;
      }
      if (!resp.ok) throw new Error(`embed failed: ${resp.status} ${await resp.text()}`);
      const data = await resp.json();
      const out = (data.data as { embedding: number[] }[])
        .sort((a, b) => (a as never as { index: number }).index - (b as never as { index: number }).index)
        .map((d) => d.embedding);
      if (out.length !== texts.length || out[0]?.length !== EMBED_DIM) {
        throw new Error(`embed shape mismatch: got ${out.length}x${out[0]?.length}`);
      }
      return out;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2 ** attempt * 500));
    }
  }
  throw lastErr;
}
