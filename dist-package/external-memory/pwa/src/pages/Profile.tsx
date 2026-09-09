import { useCallback, useEffect, useState } from 'react';
import { getProfile, saveProfile } from '../api';

/** profile 画像页：每个主体的核心画像，wake 每次必带的常驻内容（不走检索、不会漏） */
export default function Profile({ subject }: { subject: string }) {
  const [persona, setPersona] = useState('');
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(async () => {
    const p = await getProfile(subject);
    setPersona(p.persona);
    setUpdatedAt(p.updated_at);
    setDirty(false);
  }, [subject]);
  useEffect(() => { reload().catch((e) => alert(e.message)); }, [reload]);

  return (
    <section>
      <p className="count">
        主体 {subject} 的核心画像 · 每次 wake 常驻加载，不走检索
        {updatedAt && ` · 更新于 ${updatedAt.slice(0, 16).replace('T', ' ')}`}
      </p>
      <div className="table" style={{ padding: 14 }}>
        <textarea
          rows={12}
          placeholder={`写下这个主体永远该被记住的核心信息，例如：\n\n- 身份与角色（谁是这个人/这个客户）\n- 人格基调与沟通偏好总纲\n- 长期约束的汇总（单条具体约束仍用 record 记成 constraint）\n\n注意：这里的内容每次会话都会被完整加载，保持精炼。`}
          value={persona}
          onChange={(e) => { setPersona(e.target.value); setDirty(true); }}
        />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button
            className="primary"
            disabled={!dirty || saving}
            onClick={async () => {
              setSaving(true);
              try {
                await saveProfile(subject, persona);
                await reload();
                alert('画像已保存，下次 wake 生效');
              } finally { setSaving(false); }
            }}
          >
            {saving ? '保存中…' : '保存画像'}
          </button>
          {dirty && <span className="count" style={{ alignSelf: 'center' }}>有未保存修改</span>}
        </div>
      </div>
    </section>
  );
}
