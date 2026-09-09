import { defineConfig, loadEnv, type Plugin, type ProxyOptions } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';
import { exec } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string };

/** 占位符注入防护：URL/版本号只允许安全字符，且单引号包裹 */
const safeUrl = (u: string) => (/^https:\/\/[\w./?&=%:+~-]+$/.test(u) ? `'${u}'` : null);
const safeVer = (v: string) => (/^[\d.]+$/.test(v) ? v : null);

// PWA 本身不持有任何密钥：
// 浏览器 → /sbapi/* → Vite 代理注入 Supabase secret key 转发（key 只存在本机 Node 侧）
// 浏览器 → /sfapi/* → Vite 代理注入硅基流动 key 转发
// 凭据从 pwa/.env.local 读取（三个：SUPABASE_URL / SUPABASE_SECRET_KEY / SILICONFLOW_API_KEY）

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const { SUPABASE_URL, SUPABASE_SECRET_KEY, SILICONFLOW_API_KEY } = env;
  const configured = Boolean(SUPABASE_URL && SUPABASE_SECRET_KEY && SILICONFLOW_API_KEY);

  if (!configured) {
    console.warn('[pwa] 缺少 .env.local 配置（SUPABASE_URL / SUPABASE_SECRET_KEY / SILICONFLOW_API_KEY），代理不可用');
  }

  const configApi: Plugin = {
    name: 'pwa-config',
    configureServer(server) {
      server.middlewares.use('/__pwa_config', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: configured }));
      });
      // 版本检测：可选配置 VERSION_CHECK_URL（返回 {"version":"0.2.0","url":"下载地址"}），
      // 未配置时返回 {version:null}，前端静默跳过。服务端拉取避免浏览器跨域。
      // can_update 表示是否配了一键更新命令（VERSION_UPDATE_CMD）
      const updateCmd = env.VERSION_UPDATE_CMD;
      server.middlewares.use('/__version_check', async (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        const checkUrl = env.VERSION_CHECK_URL;
        if (!checkUrl) { res.end(JSON.stringify({ version: null })); return; }
        try {
          const resp = await fetch(checkUrl, { signal: AbortSignal.timeout(5000) });
          const data = (await resp.json()) as { version?: string; url?: string };
          res.end(JSON.stringify({
            version: data.version ?? null,
            url: data.url ?? null,
            can_update: Boolean(updateCmd),
          }));
        } catch {
          res.end(JSON.stringify({ version: null }));
        }
      });

      // 一键更新：浏览器 POST {version, url} → 本机 Node 执行 .env.local 里的 VERSION_UPDATE_CMD。
      // 命令模板支持 {url} {version} 占位符（注入前做字符白名单校验 + 单引号包裹）。
      // 命令完全来自用户本机配置，远程 version.json 只提供版本号和下载地址。
      server.middlewares.use('/__version_update', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        if (req.method !== 'POST') { res.end(JSON.stringify({ ok: false, error: 'POST only' })); return; }
        if (!updateCmd) { res.end(JSON.stringify({ ok: false, error: 'not_configured' })); return; }
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
          try {
            const { version, url } = JSON.parse(body || '{}') as { version?: string; url?: string };
            const v = safeVer(String(version ?? ''));
            const u = url ? safeUrl(String(url)) : "''";
            if (!v || u === null) { res.end(JSON.stringify({ ok: false, error: '非法的版本号或下载地址' })); return; }
            const cmd = updateCmd.replaceAll('{url}', u).replaceAll('{version}', v);
            exec(cmd, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
              res.end(JSON.stringify(err
                ? { ok: false, error: `${err.message}\n${stderr}`.slice(0, 2000) }
                : { ok: true, log: (stdout + stderr).trim().slice(0, 2000) }));
            });
          } catch (e) {
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };

  // configured 为 true 时三个值必然存在（上面已判空）
  // 注意必须覆盖 User-Agent：Supabase 靠 UA 识别浏览器环境并拒绝 secret key，
  // 不覆盖的话浏览器的 UA 会被透传，触发 401 "Forbidden use of secret API key in browser"
  const proxy: Record<string, ProxyOptions> = configured
    ? {
        '/sbapi': {
          target: SUPABASE_URL!,
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/sbapi/, ''),
          headers: {
            apikey: SUPABASE_SECRET_KEY!,
            Authorization: `Bearer ${SUPABASE_SECRET_KEY!}`,
            'User-Agent': 'external-memory-pwa-local-proxy',
          },
        },
        '/sfapi': {
          target: 'https://api.siliconflow.cn',
          changeOrigin: true,
          rewrite: (p: string) => p.replace(/^\/sfapi/, ''),
          headers: {
            Authorization: `Bearer ${SILICONFLOW_API_KEY!}`,
            'User-Agent': 'external-memory-pwa-local-proxy',
          },
        },
      }
    : {};

  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
    plugins: [
      react(),
      configApi,
      VitePWA({
        registerType: 'autoUpdate',
        manifest: {
          name: '外部记忆库',
          short_name: '记忆库',
          description: 'MCP 外挂记忆 · 人工管理面板',
          theme_color: '#3ecf8e',
          background_color: '#f8f9fa',
          display: 'standalone',
          icons: [],
        },
      }),
    ],
    server: {
      port: 5173,
      proxy,
    },
  };
});
