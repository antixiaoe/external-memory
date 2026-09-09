// src/version.ts — 版本与更新检测
// 本地版本来自 package.json（vite define 注入 __APP_VERSION__）；
// 远程版本由 Vite 中间件 /__version_check 服务端拉取 VERSION_CHECK_URL（可选配置，不配置则静默跳过）
declare const __APP_VERSION__: string;
export const APP_VERSION: string = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0';

export interface UpdateInfo {
  update: boolean;
  version?: string;
  url?: string;
  canUpdate?: boolean; // 本机是否配了 VERSION_UPDATE_CMD（可一键更新）
}

/** 三段数字版本比较：a > b 返回正数 */
export function compareVersion(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function checkUpdate(): Promise<UpdateInfo> {
  try {
    const resp = await fetch('/__version_check');
    const data = await resp.json();
    if (!data.version) return { update: false };
    if (compareVersion(data.version, APP_VERSION) > 0) {
      return { update: true, version: data.version, url: data.url, canUpdate: Boolean(data.can_update) };
    }
  } catch { /* 无远程版本源时静默跳过 */ }
  return { update: false };
}

/** 一键更新：POST 到本机 Vite 中间件，执行 .env.local 里配置的 VERSION_UPDATE_CMD */
export async function runUpdate(info: UpdateInfo): Promise<{ ok: boolean; log?: string; error?: string }> {
  const resp = await fetch('/__version_update', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: info.version, url: info.url }),
  });
  return resp.json();
}
