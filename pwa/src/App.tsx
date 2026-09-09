import { useEffect, useState } from 'react';
import { listSubjects } from './api';
import { checkBackend } from './config';
import { checkUpdate, runUpdate, APP_VERSION, type UpdateInfo } from './version';
import Setup from './Setup';
import Memories from './pages/Memories';
import Stories from './pages/Stories';
import Sources from './pages/Sources';
import Profile from './pages/Profile';

type Tab = 'memories' | 'stories' | 'sources' | 'profile';

const NAV: [Tab, string][] = [
  ['memories', 'memory 记忆'],
  ['stories', 'story 脉络'],
  ['sources', 'source 素材'],
  ['profile', 'profile 画像'],
];

export default function App() {
  const [ready, setReady] = useState<boolean | null>(null); // null=检测中
  const [tab, setTab] = useState<Tab>('memories');
  const [subjects, setSubjects] = useState<string[]>([]);
  const [subject, setSubject] = useState<string>(() => localStorage.getItem('em_subject') ?? '');
  const [newSubject, setNewSubject] = useState('');
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo>({ update: false });
  const [updating, setUpdating] = useState(false);

  /** 点更新角标：配了 VERSION_UPDATE_CMD 走本机命令行一键更新，否则打开下载页 */
  const onUpdateClick = async () => {
    if (!updateInfo.update) return;
    if (!updateInfo.canUpdate) {
      if (updateInfo.url) window.open(updateInfo.url, '_blank');
      return;
    }
    if (!confirm(`在本机执行升级命令，更新到 v${updateInfo.version}？\n更新完成后需要重启 npm run dev 生效。`)) return;
    setUpdating(true);
    try {
      const r = await runUpdate(updateInfo);
      if (r.ok) {
        alert(`更新完成${r.log ? `\n\n${r.log}` : ''}\n\n请重启 npm run dev 并强刷页面（Cmd+Shift+R）`);
      } else if (r.error === 'not_configured') {
        if (updateInfo.url) window.open(updateInfo.url, '_blank');
        else alert('未配置 VERSION_UPDATE_CMD，请手动下载新版');
      } else {
        alert(`更新失败：${r.error}`);
      }
    } finally { setUpdating(false); }
  };

  const detect = () => checkBackend().then(setReady);
  useEffect(() => { detect(); }, []);

  useEffect(() => {
    if (ready === true) checkUpdate().then(setUpdateInfo);
  }, [ready]);

  useEffect(() => {
    if (ready !== true) return;
    listSubjects().then((s) => {
      setSubjects(s);
      if (!subject && s.length) setSubject(s[0]);
    }).catch((e) => alert(`加载主体列表失败: ${e.message}`));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  useEffect(() => {
    if (subject) localStorage.setItem('em_subject', subject);
  }, [subject]);

  if (ready === null) return <p className="empty">检测本机配置…</p>;
  if (ready === false) return <Setup onRetry={detect} />;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">🧠 外部记忆库</div>

        <div className="side-section">
          <div className="side-title">记忆主体</div>
          {subjects.map((s) => (
            <button key={s} className={`side-item ${subject === s ? 'active' : ''}`} onClick={() => setSubject(s)}>
              {s}
            </button>
          ))}
          <div className="side-add">
            <input
              placeholder="新主体 id…"
              value={newSubject}
              onChange={(e) => setNewSubject(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                const v = newSubject.trim();
                if (!v) return;
                setSubject(v);
                if (!subjects.includes(v)) setSubjects([...subjects, v].sort());
                setNewSubject('');
              }}
            />
          </div>
        </div>

        <div className="side-section">
          <div className="side-title">schema public</div>
          {NAV.map(([t, label]) => (
            <button key={t} className={`side-item ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {label}
            </button>
          ))}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <span className="crumb">
            Table Editor / <strong>{tab === 'memories' ? 'memory' : tab === 'stories' ? 'story' : tab === 'sources' ? 'source' : 'profile'}</strong>
            {subject && <> · 主体 <strong>{subject}</strong></>}
          </span>
          <span className="topbar-right">
            <span className="version-badge">v{APP_VERSION}</span>
            {updateInfo.update && (
              <button
                className="update-badge"
                onClick={onUpdateClick}
                disabled={updating}
                title={updateInfo.canUpdate ? '点击在本机执行升级命令' : '点击查看新版'}
              >
                {updating ? '更新中…' : `⬆ ${updateInfo.canUpdate ? '一键更新到' : '有新版'} v${updateInfo.version}`}
              </button>
            )}
          </span>
        </header>

        <div className="content">
          {!subject ? (
            <p className="empty">请先在左侧选择或创建一个记忆主体</p>
          ) : tab === 'memories' ? (
            <Memories subject={subject} />
          ) : tab === 'stories' ? (
            <Stories subject={subject} />
          ) : tab === 'sources' ? (
            <Sources subject={subject} />
          ) : (
            <Profile subject={subject} />
          )}
        </div>
      </div>
    </div>
  );
}
