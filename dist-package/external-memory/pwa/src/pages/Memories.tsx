import { useCallback, useEffect, useState } from 'react';
import {
  consolidate, deleteMemory, exportJson, getSourceQuote, listMemories,
  reembedMemory, searchMemories, updateMemory, type Memory,
} from '../api';

const TYPE_LABEL: Record<string, string> = { preference: '偏好', event: '事件', constraint: '约束' };

export default function Memories({ subject }: { subject: string }) {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [scores, setScores] = useState<Record<string, number>>({});
  const [query, setQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editContent, setEditContent] = useState('');
  const [editImportance, setEditImportance] = useState(5);
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState<Record<string, string>>({});

  const reload = useCallback(async () => {
    setScores({});
    setMemories(await listMemories(subject, typeFilter, statusFilter));
  }, [subject, typeFilter, statusFilter]);

  useEffect(() => { reload().catch((e) => alert(e.message)); }, [reload]);

  const doSearch = async () => {
    if (!query.trim()) return reload();
    setBusy(true);
    try {
      const rows = await searchMemories(subject, query.trim());
      const order = new Map(rows.map((r, i) => [r.id, i]));
      setScores(Object.fromEntries(rows.map((r) => [r.id, r.score])));
      const all = await listMemories(subject, typeFilter, statusFilter);
      setMemories(all.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)));
    } finally { setBusy(false); }
  };

  const save = async (id: string) => {
    await updateMemory(id, { content: editContent, importance: editImportance });
    setEditingId(null);
    await reload();
  };

  return (
    <section>
      <div className="toolbar">
        <input
          className="search"
          placeholder="语义搜索（与 MCP recall 同一打分公式；空则按重要性列表）"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && doSearch()}
        />
        <button className="primary" disabled={busy} onClick={doSearch}>{busy ? '检索中…' : '搜索'}</button>
        <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}>
          <option value="">全部类型</option>
          <option value="preference">偏好</option>
          <option value="event">事件</option>
          <option value="constraint">约束</option>
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="">全部状态</option>
          <option value="active">active</option>
          <option value="archived">archived</option>
        </select>
        <span className="spacer" style={{ flex: 1 }} />
        <button onClick={async () => { const r = await consolidate(subject); alert(`整理完成: ${JSON.stringify(r)}`); await reload(); }}>
          立即整理
        </button>
        <button onClick={() => exportJson(subject)}>导出 JSON</button>
      </div>

      <p className="count">{memories.length} 条记忆 · 主体 {subject}</p>

      <div className="table">
        <div className="thead">
          <span>content</span><span>type</span><span>重要性</span><span>巩固</span><span>创建时间</span><span>score</span><span></span>
        </div>
        {memories.map((m) => (
          <div key={m.id}>
            {editingId === m.id ? (
              <div className="edit-area">
                <textarea value={editContent} onChange={(e) => setEditContent(e.target.value)} rows={3} />
                <label>
                  重要性
                  <input type="number" min={1} max={10} value={editImportance}
                    onChange={(e) => setEditImportance(Number(e.target.value))} />
                </label>
                <div className="edit-actions">
                  <button className="primary" onClick={() => save(m.id)}>保存</button>
                  <button onClick={() => setEditingId(null)}>取消</button>
                </div>
              </div>
            ) : (
              <div className={`trow ${m.status}`}>
                <span className="cell-content">{m.content}</span>
                <span><span className={`tag ${m.type}`}>{TYPE_LABEL[m.type]}</span></span>
                <span className="cell-num">{m.importance}</span>
                <span className="cell-num">{m.reinforce.toFixed(2)}</span>
                <span className="cell-date">{m.created_at.slice(0, 10)}</span>
                <span>
                  {scores[m.id] !== undefined && <span className="score-badge">{scores[m.id]}</span>}
                  {m.status === 'archived' && <span className="tag archived">已归档</span>}
                </span>
                <span className="cell-actions">
                  <button onClick={() => { setEditingId(m.id); setEditContent(m.content); setEditImportance(m.importance); }}>编辑</button>
                  {m.source_id && (
                    <button onClick={async () => setQuote({ ...quote, [m.id]: quote[m.id] ? '' : await getSourceQuote(m.source_id!) })}>溯源</button>
                  )}
                  <button onClick={async () => { await reembedMemory(subject, m.id); alert('已重新生成 embedding'); }}>重建向量</button>
                  {m.status === 'active' ? (
                    <button onClick={async () => { await updateMemory(m.id, { status: 'archived' }); await reload(); }}>归档</button>
                  ) : (
                    <button onClick={async () => { await updateMemory(m.id, { status: 'active' }); await reload(); }}>恢复</button>
                  )}
                  <button className="danger" onClick={async () => {
                    if (confirm(`硬删除这条记忆？\n\n${m.content}`)) { await deleteMemory(m.id); await reload(); }
                  }}>删除</button>
                </span>
              </div>
            )}
            {quote[m.id] && <blockquote className="quote">{quote[m.id]}</blockquote>}
          </div>
        ))}
      </div>
      {!memories.length && <p className="empty">暂无记忆。该主体的记忆会随 Agent 调用 record 工具逐渐积累。</p>}
    </section>
  );
}
