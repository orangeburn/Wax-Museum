import { CUSTOM_TAG_WHITELIST, type WriterDraftResponse, type WriterRole } from '@wax-museum/shared';
import { FormEvent, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { createSession, generateWriterDraft } from '../lib/api';

export function CreatePage() {
  const navigate = useNavigate();
  const [backgroundPrompt, setBackgroundPrompt] = useState('');
  const [customBackground, setCustomBackground] = useState('');
  const [customTag, setCustomTag] = useState('');
  const [draft, setDraft] = useState<WriterDraftResponse | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedRole = useMemo(
    () => draft?.bible.roles.find((entry) => entry.id === selectedRoleId) ?? draft?.bible.roles[0] ?? null,
    [draft, selectedRoleId]
  );

  async function handleGenerateDraft() {
    setGenerating(true);
    setError(null);

    try {
      const nextDraft = await generateWriterDraft({
        prompt: backgroundPrompt
      });
      const firstRole = nextDraft.bible.roles[0] ?? null;
      setDraft(nextDraft);
      setSelectedRoleId(firstRole?.id ?? null);
      setCustomBackground(firstRole?.suggestedBackground ?? '');
      setCustomTag(firstRole?.suggestedTag ?? '');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成剧本失败');
    } finally {
      setGenerating(false);
    }
  }

  function applyRole(role: WriterRole) {
    setSelectedRoleId(role.id);
    setCustomBackground(role.suggestedBackground);
    setCustomTag(role.suggestedTag);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !selectedRole) {
      setError('请先生成剧本草案并选择角色。');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const snapshot = await createSession({
        templateId: 'generated-story',
        archetypeId: selectedRole.archetypeId,
        storyPrompt: backgroundPrompt,
        selectedRole: {
          label: selectedRole.label,
          publicIdentity: selectedRole.publicIdentity,
          hiddenDrive: selectedRole.hiddenDrive,
          relationshipHook: selectedRole.relationshipHook,
          specialty: selectedRole.specialty,
          suggestedTag: selectedRole.suggestedTag
        },
        customBackground,
        customTag
      });
      navigate(`/session/${snapshot.sessionId}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell shell-create">
      <section className="create-hero">
        <p className="eyebrow">编剧 Agent</p>
        <h1>先给一句设定，让系统替你写出这局戏。</h1>
        <p className="lede">输入像“风雪山庄，4人，逃生 / 破案”这样的说明。系统会先生成故事背景、剧情骨架和可选角色，再让你选一个身份进入现场。</p>
      </section>

      <form className="create-layout" onSubmit={handleSubmit}>
        <section className="writer-stage">
          <div className="writer-prompt-panel">
            <p className="panel-kicker">创作输入</p>
            <label>
              <span>故事 Prompt</span>
              <textarea
                rows={3}
                value={backgroundPrompt}
                onChange={(event) => setBackgroundPrompt(event.target.value)}
                placeholder="例如：风雪山庄，4人，逃生/破案，关系复杂，最后要有一次反转。"
              />
            </label>
            <div className="hero-actions compact-actions">
              <button type="button" className="primary-button" onClick={handleGenerateDraft} disabled={generating}>
                {generating ? '编剧生成中…' : '生成剧本草案'}
              </button>
            </div>
          </div>

          {draft ? (
            <>
              <section className="story-outline-card story-bible-card">
                <p className="panel-kicker">故事圣经</p>
                <h2>{draft.bible.title}</h2>
                <p className="muted-copy">{draft.bible.genre} / {draft.bible.playerCountLabel}</p>
                <p><strong>故事背景：</strong>{draft.bible.background}</p>
                <p><strong>当前危机：</strong>{draft.bible.currentCrisis}</p>
                <p><strong>核心秘密：</strong>{draft.bible.coreSecret}</p>
                <div className="story-list-block">
                  <strong>剧情大纲</strong>
                  <ol className="story-list">
                    {draft.bible.outline.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ol>
                </div>
                <div className="story-list-block">
                  <strong>结局方向</strong>
                  <ul className="story-list">
                    {draft.bible.endings.map((entry) => (
                      <li key={entry}>{entry}</li>
                    ))}
                  </ul>
                </div>
              </section>

              <section className="role-grid" aria-label="编剧生成角色">
                {draft.bible.roles.map((role) => {
                  const active = role.id === selectedRole?.id;
                  return (
                    <button
                      type="button"
                      key={role.id}
                      className={`role-card ${active ? 'is-active' : ''}`}
                      onClick={() => applyRole(role)}
                    >
                      <p className="panel-kicker">{role.suggestedTag}</p>
                      <h2>{role.label}</h2>
                      <p>{role.publicIdentity}</p>
                      <p><strong>隐藏动机：</strong>{role.hiddenDrive}</p>
                      <p><strong>关系钩子：</strong>{role.relationshipHook}</p>
                      <span className="prompt-text">{role.specialty}</span>
                    </button>
                  );
                })}
              </section>
            </>
          ) : (
            <section className="story-outline-card story-bible-card is-empty">
              <p className="panel-kicker">等待剧本</p>
              <h2>先生成一份故事圣经</h2>
              <p>生成后这里会出现背景、危机、核心秘密、剧情大纲，以及 4 个可选角色卡。</p>
            </section>
          )}
        </section>

        <aside className="briefing-panel">
          <p className="panel-kicker">开局简报</p>
          <h2>{selectedRole?.label ?? '等待角色'}</h2>
          <p>{selectedRole?.publicIdentity ?? '先生成剧本草案，再从角色卡里选一个身份进入故事。'}</p>
          {draft ? (
            <div className="story-outline-card">
              <p className="panel-kicker">当前场景</p>
              <h3>{draft.scenario.title}</h3>
              <p><strong>前提：</strong>{draft.scenario.premise}</p>
              <p><strong>开场：</strong>{draft.scenario.openingLine}</p>
            </div>
          ) : null}
          {selectedRole ? (
            <div className="story-outline-card">
              <p className="panel-kicker">角色摘要</p>
              <p><strong>隐藏动机：</strong>{selectedRole.hiddenDrive}</p>
              <p><strong>关系钩子：</strong>{selectedRole.relationshipHook}</p>
              <p><strong>角色专长：</strong>{selectedRole.specialty}</p>
            </div>
          ) : null}
          <label>
            <span>角色背景</span>
            <textarea
              rows={5}
              value={customBackground}
              onChange={(event) => setCustomBackground(event.target.value)}
              placeholder="生成角色后，这里会自动带入一版角色背景，你也可以手动改写。"
            />
          </label>
          <label>
            <span>自定义 Tag</span>
            <input value={customTag} onChange={(event) => setCustomTag(event.target.value)} list="tag-whitelist" />
            <datalist id="tag-whitelist">
              {CUSTOM_TAG_WHITELIST.map((tag) => (
                <option key={tag} value={tag} />
              ))}
            </datalist>
          </label>
          {selectedRole ? <p className="muted-copy">编剧建议 Tag：{selectedRole.suggestedTag}</p> : null}
          <p className="muted-copy">规则白名单：{CUSTOM_TAG_WHITELIST.join('、')}</p>
          {error ? <p className="error-copy">{error}</p> : null}
          <div className="hero-actions">
            <button type="button" className="ghost-button" onClick={() => navigate('/')}>
              返回起始页
            </button>
            <button type="submit" className="primary-button" disabled={loading || !draft || !selectedRole}>
              {loading ? '正在写入故事并开局…' : '进入故事'}
            </button>
          </div>
        </aside>
      </form>
    </main>
  );
}
