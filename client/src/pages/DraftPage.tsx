import { CUSTOM_TAG_WHITELIST, type StoryGameMode, type StoryOutlineResponse, type WriterDraftResponse, type WriterRole } from '@wax-museum/shared';
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, Chip, Input, Skeleton, TextArea } from '@heroui/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiResponseError, createSession, generateStoryOutline, generateWriterDraft } from '../lib/api';

type RevealStage = 'loading-outline' | 'loading-roles' | 'roles';
const MODE_LABELS: Record<StoryGameMode, string> = {
  survival: '生存',
  puzzle: '解谜',
  versus: '对抗'
};

export function DraftPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const promptFromState = (location.state as { prompt?: string } | null)?.prompt?.trim() ?? '';
  const storyGameModeFromState = (location.state as { storyGameMode?: StoryGameMode } | null)?.storyGameMode;
  const playerCountFromState = (location.state as { playerCount?: number } | null)?.playerCount;
  const roundCountFromState = (location.state as { roundCount?: number } | null)?.roundCount;
  const [prompt] = useState(promptFromState);
  const [storyGameMode, setStoryGameMode] = useState<StoryGameMode>(storyGameModeFromState ?? 'survival');
  const [playerCount, setPlayerCount] = useState(() =>
    typeof playerCountFromState === 'number' && Number.isFinite(playerCountFromState)
      ? Math.max(1, Math.min(6, Math.round(playerCountFromState)))
      : 1
  );
  const [roundCount, setRoundCount] = useState(() =>
    typeof roundCountFromState === 'number' && Number.isFinite(roundCountFromState)
      ? Math.max(4, Math.min(20, Math.round(roundCountFromState)))
      : 8
  );
  const [customBackground, setCustomBackground] = useState('');
  const [customTag, setCustomTag] = useState('');
  const [draft, setDraft] = useState<WriterDraftResponse | null>(null);
  const [outline, setOutline] = useState<StoryOutlineResponse | null>(null);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealStage, setRevealStage] = useState<RevealStage>('loading-outline');

  const selectedRole = useMemo(
    () => draft?.bible.roles.find((entry) => entry.id === selectedRoleId) ?? draft?.bible.roles[0] ?? null,
    [draft, selectedRoleId]
  );

  useEffect(() => {
    if (!prompt) {
      navigate('/create');
      return;
    }
    let cancelled = false;
    async function run() {
      setGenerating(true);
      setError(null);
      setRevealStage('loading-outline');
      try {
        const nextOutline = await generateStoryOutline({
          templateId: 'generated-story',
          archetypeId: 'generated-role',
          prompt,
          storyGameMode,
          playerCount,
          roundCount
        });
        if (cancelled) return;
        setOutline(nextOutline);
        setRevealStage('loading-roles');

        const nextDraft = await generateWriterDraft({ prompt, storyGameMode, playerCount, roundCount, outline: nextOutline });
        if (cancelled) return;
        setDraft(nextDraft);
        const firstRole = nextDraft.bible.roles[0] ?? null;
        setSelectedRoleId(firstRole?.id ?? null);
        setCustomBackground(firstRole?.suggestedBackground ?? '');
        setCustomTag(firstRole?.suggestedTag ?? '');
        setRevealStage('roles');
      } catch (reason) {
        if (cancelled) return;
        setDraft(null);
        setSelectedRoleId(null);
        setError(reason instanceof ApiResponseError ? reason.message : '生成失败');
      } finally {
        if (!cancelled) setGenerating(false);
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [navigate, playerCount, prompt, roundCount, storyGameMode]);

  function applyRole(role: WriterRole) {
    setSelectedRoleId(role.id);
    setCustomBackground(role.suggestedBackground);
    setCustomTag(role.suggestedTag);
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !selectedRole) return;
    setLoading(true);
    setError(null);
    try {
      const snapshot = await createSession({
        templateId: 'generated-story',
        archetypeId: selectedRole.archetypeId,
        storyPrompt: prompt,
        storyGameMode,
        playerCount,
        roundCount: storyGameMode === 'versus' ? undefined : roundCount,
        selectedRole: {
          id: selectedRole.id,
          archetypeId: selectedRole.archetypeId,
          label: selectedRole.label,
          publicIdentity: selectedRole.publicIdentity,
          hiddenDrive: selectedRole.hiddenDrive,
          relationshipHook: selectedRole.relationshipHook,
          specialty: selectedRole.specialty,
          suggestedTag: selectedRole.suggestedTag,
          suggestedBackground: selectedRole.suggestedBackground,
          stats: selectedRole.stats,
          startingItems: selectedRole.startingItems,
          coreTag: selectedRole.coreTag,
          secretAgenda: selectedRole.secretAgenda,
          settingPack: selectedRole.settingPack
        },
        generatedRoles: draft.bible.roles.map((role) => ({
          id: role.id,
          archetypeId: role.archetypeId,
          label: role.label,
          publicIdentity: role.publicIdentity,
          hiddenDrive: role.hiddenDrive,
          relationshipHook: role.relationshipHook,
          specialty: role.specialty,
          suggestedTag: role.suggestedTag,
          suggestedBackground: role.suggestedBackground,
          stats: role.stats,
          startingItems: role.startingItems,
          coreTag: role.coreTag,
          secretAgenda: role.secretAgenda,
          settingPack: role.settingPack
        })),
        customBackground,
        customTag
      });
      navigate(`/session/${snapshot.sessionId}`);
    } catch (reason) {
      setError(reason instanceof ApiResponseError ? reason.message : null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="shell shell-create">
      <section className="create-hero">
        <p className="eyebrow">剧本生成</p>
        <h1>构建故事与角色。</h1>
        <p className="lede">Prompt：{prompt}</p>
        <p className="muted-copy">{MODE_LABELS[storyGameMode]} · {playerCount} 人 · {storyGameMode === 'versus' ? '不限回合' : `${roundCount} 回合`}</p>
      </section>

      <form className="create-layout" onSubmit={handleSubmit}>
        <section className="writer-stage">
          {generating || revealStage === 'loading-outline' ? (
            <Card className="story-outline-card story-bible-card is-empty section-surface">
              <CardContent className="writer-stage">
                <p className="panel-kicker">生成中</p>
                <Skeleton className="h-5 w-40 rounded-none" />
                <Skeleton className="h-16 w-full rounded-none" />
              </CardContent>
            </Card>
          ) : null}

          {outline ? (
            <Card className="story-outline-card section-surface">
              <CardHeader className="panel-header">
                <p className="panel-kicker">故事大纲</p>
                <h2>{outline.title}</h2>
              </CardHeader>
              <CardContent className="writer-stage">
                <p><strong>前提：</strong>{outline.premise}</p>
                {outline.modeGoal ? <p className="muted-copy"><strong>玩法目标：</strong>{outline.modeGoal}</p> : null}
                <p className="muted-copy"><strong>反转：</strong>{outline.twist}</p>
                <p className="muted-copy"><strong>开场：</strong>{outline.openingHook}</p>
              </CardContent>
            </Card>
          ) : null}

          {revealStage === 'loading-roles' ? <p className="muted-copy">正在生成角色卡…</p> : null}

          <div className="select-row">
            <label className="field-stack">
              <span className="field-label">游戏模式</span>
              <select className="field-select" value={storyGameMode} onChange={(event) => setStoryGameMode(event.target.value as StoryGameMode)} disabled={generating}>
                <option value="survival">生存</option>
                <option value="puzzle">解谜</option>
                <option value="versus">对抗</option>
              </select>
            </label>
            <label className="field-stack">
              <span className="field-label">角色数量</span>
              <select className="field-select" value={playerCount} onChange={(event) => setPlayerCount(Number(event.target.value))} disabled={generating}>
                <option value={1}>1 人</option>
                <option value={2}>2 人</option>
                <option value={3}>3 人</option>
                <option value={4}>4 人</option>
                <option value={5}>5 人</option>
                <option value={6}>6 人</option>
              </select>
            </label>
            <label className="field-stack">
              <span className="field-label">回合数</span>
              <select className="field-select" value={roundCount} onChange={(event) => setRoundCount(Number(event.target.value))} disabled={generating || storyGameMode === 'versus'}>
                <option value={6}>6 回合 · 短局</option>
                <option value={8}>8 回合 · 标准</option>
                <option value={10}>10 回合 · 长局</option>
                <option value={12}>12 回合 · 复杂</option>
                <option value={16}>16 回合 · 超长局</option>
              </select>
            </label>
          </div>

          {draft && revealStage === 'roles' ? (
            <section className="role-grid" aria-label="编剧生成角色">
              {draft.bible.roles.map((role) => {
                const active = role.id === selectedRole?.id;
                return (
                  <Button
                    type="button"
                    key={role.id}
                    className={`role-card ${active ? 'active-role-card' : ''}`}
                    variant={active ? 'primary' : 'secondary'}
                    onClick={() => applyRole(role)}
                  >
                    <div className="role-card-copy">
                      <p className="panel-kicker">{role.suggestedTag}</p>
                      <h2>{role.label}</h2>
                      <p>{role.publicIdentity}</p>
                    </div>
                  </Button>
                );
              })}
            </section>
          ) : null}
          {error ? <p className="error-copy inline-error">{error}</p> : null}
        </section>

        <aside className="briefing-panel">
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">选中角色</p>
              <h2>{selectedRole?.label ?? '等待角色'}</h2>
            </CardHeader>
            <CardContent className="writer-stage">
              <p className="muted-copy">{selectedRole?.publicIdentity ?? '等待角色生成完成。'}</p>
              {selectedRole ? <Chip size="sm" variant="soft">{`建议 Tag：${selectedRole.suggestedTag}`}</Chip> : null}
              <div className="field-stack">
                <span className="field-label">角色背景</span>
                <TextArea
                  aria-label="角色背景"
                  rows={4}
                  value={customBackground}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setCustomBackground(event.target.value)}
                  variant="secondary"
                />
              </div>
              <div className="field-stack">
                <span className="field-label">自定义 Tag</span>
                <Input
                  aria-label="自定义 Tag"
                  value={customTag}
                  onChange={(event) => setCustomTag(event.target.value)}
                  list="tag-whitelist"
                  variant="secondary"
                />
              </div>
              <datalist id="tag-whitelist">
                {CUSTOM_TAG_WHITELIST.map((tag) => <option key={tag} value={tag} />)}
              </datalist>
              <div className="hero-actions">
                <Button type="submit" variant="primary" isDisabled={loading || !draft || !selectedRole || revealStage !== 'roles'}>
                  {loading ? '写入故事中…' : '进入故事'}
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/create')}>
                  返回
                </Button>
              </div>
            </CardContent>
          </Card>
        </aside>
      </form>
    </main>
  );
}
