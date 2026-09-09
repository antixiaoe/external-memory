import { useCallback, useEffect, useState } from 'react';
import { createSource, listSources, recordMemory, type SourceRow } from '../api';

export default function Sources({ subject }: { subject: string }) {
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [rawText, setRawText] = useState('');
  const [srcType, setSrcType] = useState<'conversation' | 'diary'>('conversation');
  const [distilling, setDistilling] = useState<string | null>(null);
  const [fact, setFact] = useState('');
  const [factType, setFactType] = useState('event');
  const [factImportance, setFactImportance] = useState(6);

  const reload = useCallback(async () => setSources(await listSources(subject)), [subject]);
  useEffect(() => { reload().catch((e) => alert(e.message)); }, [reload]);

  return (
    <section>
      <div className="toolbar">
        <select value={srcType} onChange={(e) => setSrcType(e.target.value as 'conversation' | 'diary')}>
          <option value="conversation">对话</option>
          <option value="diary">日记</option>
        </select>
        <input placeholder="粘贴原始素材（对话记录/日记），作为提炼记忆的原料"
          value={rawText} onChange={(e) => setRawText(e.target.value)} style={{ flex: 3 }} />
        <button className="primary" onClick={async () => {
          if (!rawText.trim()) return;
          await createSource(subject, rawText.trim(), srcType);
          setRawText('');
          await reload();
        }}>存入 Source</button>
      </div>
      <p className="count">{sources.length} 条原始素材 · Source 不直接喂模型，仅作提炼与溯源</p>
      {sources.map((s) => (
        <div key={s.id} className="srow">
          <div className="s-body">{s.raw_text}</div>
          <div className="s-meta">
            <span className="tag plain">{s.source_type === 'conversation' ? '对话' : '日记'}</span>
            <span>{s.created_at.slice(0, 16).replace('T', ' ')}</span>
            {s.session_ref && <span>session: {s.session_ref}</span>}
            <span className="spacer" />
            <button onClick={() => { setDistilling(distilling === s.id ? null : s.id); setFact(''); }}>
              {distilling === s.id ? '收起' : '提炼为记忆'}
            </button>
          </div>
          {distilling === s.id && (
            <div className="edit-area">
              <textarea placeholder="提炼成一句话事实（可独立理解）" value={fact}
                onChange={(e) => setFact(e.target.value)} rows={2} />
              <label>
                类型
                <select value={factType} onChange={(e) => setFactType(e.target.value)}>
                  <option value="preference">偏好</option>
                  <option value="event">事件</option>
                  <option value="constraint">约束</option>
                </select>
                重要性
                <input type="number" min={1} max={10} value={factImportance}
                  onChange={(e) => setFactImportance(Number(e.target.value))} />
              </label>
              <div className="edit-actions">
                <button className="primary" onClick={async () => {
                  const r = await recordMemory(subject, fact.trim(), factType, factImportance, s.id);
                  alert(r.dedup === 'merged' ? '已与已有记忆合并' : '已创建记忆');
                  setDistilling(null); setFact('');
                }}>确认提炼</button>
                <button onClick={() => setDistilling(null)}>取消</button>
              </div>
            </div>
          )}
        </div>
      ))}
      {!sources.length && <p className="empty">暂无原始素材。粘贴一段对话或日记开始。</p>}
    </section>
  );
}
