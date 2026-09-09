// src/config.ts — 后端可用性探测（凭据在本机 Vite 代理侧，浏览器不持有）
export async function checkBackend(): Promise<boolean> {
  try {
    const resp = await fetch('/__pwa_config');
    const data = await resp.json();
    return data.ok === true;
  } catch {
    return false;
  }
}
