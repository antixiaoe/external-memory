import { useCallback, useEffect, useState } from 'react';
import { createStory, deleteStory, listStories, type Story } from '../api';

export default function Stories({ subject }: { subject: string }) {
  const [stories, setStories] = useState<Story[]>([]);
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');

  const reload = useCallback(async () => setStories(await listStories(subject)), [subject]);
  useEffect(() => { reload().catch((e) => alert(e.message)); }, [reload]);

  return (
    <section>
      <div className="toolbar">
        <input placeholder="Story 标题（一整件完整事件）" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input placeholder="摘要" value={summary} onChange={(e) => setSummary(e.target.value)} style={{ flex: 2 }} />
        <button className="primary" onClick={async () => {
          if (!title.trim() || !summary.trim()) return alert('标题和摘要都要填');
          await createStory(subject, title.trim(), summary.trim());
          setTitle(''); setSummary('');
          await reload();
        }}>新建 Story</button>
      </div>
      <p className="count">{stories.length} 条 Story · 也可由「立即整理」的 cluster 自动聚合生成</p>
      {stories.map((s) => (
        <div key={s.id} className="srow">
          <div className="s-title">{s.title}</div>
          <div className="s-body">{s.summary}</div>
          <div className="s-meta">
            <span>显著性 {s.salience.toFixed(2)}</span>
            <span>创建于 {s.created_at.slice(0, 10)}</span>
            <span className="spacer" />
            <button className="danger" onClick={async () => {
              if (confirm(`删除 Story「${s.title}」？（成员记忆不受影响）`)) { await deleteStory(s.id); await reload(); }
            }}>删除</button>
          </div>
        </div>
      ))}
      {!stories.length && <p className="empty">暂无 Story。Story 是多条记忆聚合的长时序脉络。</p>}
    </section>
  );
}
