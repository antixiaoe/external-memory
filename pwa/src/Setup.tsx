/** 未配置后端时的指引页（凭据在本机 .env.local，由 Vite 代理持有，浏览器无法也无需填写） */
export default function Setup({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="setup">
      <h1>🧠 外部记忆库 · 需要本机配置</h1>
      <p className="hint">
        面板通过本机 Vite 代理连接你自己的 Supabase，密钥不经过浏览器。
        请在 <code>pwa/</code> 目录下创建 <code>.env.local</code>（三个值）：
      </p>
      <pre className="hint" style={{ background: '#f3f4f6', padding: 12, borderRadius: 8, whiteSpace: 'pre-wrap' }}>
{`SUPABASE_URL=https://<你的ref>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
SILICONFLOW_API_KEY=sk-...`}
      </pre>
      <p className="hint">
        三个值的获取方式见技能包内 <code>docs/自托管教程.md</code>（凭据 1 / 2 / 4）。
        保存后<strong>重启 <code>npm run dev</code></strong>，再点下方按钮。
      </p>
      <button onClick={onRetry}>我已配置，重新检测</button>
    </div>
  );
}
