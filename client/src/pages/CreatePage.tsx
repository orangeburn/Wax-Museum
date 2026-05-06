import { ChangeEvent, FormEvent, useState } from 'react';
import { Button, Card, CardContent, CardHeader, TextArea } from '@heroui/react';
import { useNavigate } from 'react-router-dom';
import type { StoryGameMode } from '@wax-museum/shared';

const MODE_OPTIONS: Array<{ value: StoryGameMode; label: string; hint: string }> = [
  { value: 'survival', label: '生存', hint: '在限定回合内尽可能活下来，活着撑到终点的玩家都算胜利。' },
  { value: 'puzzle', label: '解谜', hint: '玩家合作破局，在限定回合内找出答案并逃出生天。' },
  { value: 'versus', label: '对抗', hint: '不设回合上限，彼此博弈，最后留下来的玩家获胜。' }
];

export function CreatePage() {
  const navigate = useNavigate();
  const [backgroundPrompt, setBackgroundPrompt] = useState('');
  const [storyGameMode, setStoryGameMode] = useState<StoryGameMode>('survival');
  const [playerCount, setPlayerCount] = useState(1);
  const [roundCount, setRoundCount] = useState(8);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const prompt = backgroundPrompt.trim();
    if (!prompt) {
      return;
    }
    navigate('/create/draft', { state: { prompt, storyGameMode, playerCount, roundCount: storyGameMode === 'versus' ? undefined : roundCount } });
  }

  return (
    <main className="shell shell-create">
      <section className="create-hero">
        <p className="eyebrow">新故事</p>
        <h1>设定你的故事。</h1>
        <p className="lede">描述一个场景，选择玩法模式、参与人数和回合数。系统会生成完整的剧本、角色和相应玩法。</p>
      </section>

      <form className="create-layout" onSubmit={handleSubmit}>
        <Card className="writer-stage section-surface">
          <CardContent className="writer-prompt-panel">
            <div className="field-stack">
              <span className="field-label">故事 Prompt</span>
              <TextArea
                aria-label="故事 Prompt"
                rows={4}
                value={backgroundPrompt}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setBackgroundPrompt(event.target.value)}
                placeholder="例如：风雪山庄，4人，逃生/破案，关系复杂，最后要有一次反转。"
                variant="secondary"
              />
            </div>
            <div className="field-stack">
              <span className="field-label">游戏模式</span>
              <div className="mode-select-grid" role="radiogroup" aria-label="游戏模式">
                {MODE_OPTIONS.map((option) => {
                  const active = option.value === storyGameMode;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`mode-option ${active ? 'mode-option-active' : ''}`}
                      onClick={() => setStoryGameMode(option.value)}
                      aria-pressed={active}
                    >
                      <strong>{option.label}</strong>
                      <span>{option.hint}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="select-row">
              <label className="field-stack">
                <span className="field-label">角色数量</span>
                <select className="field-select" value={playerCount} onChange={(event) => setPlayerCount(Number(event.target.value))}>
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
                <select
                  className="field-select"
                  value={roundCount}
                  onChange={(event) => setRoundCount(Number(event.target.value))}
                  disabled={storyGameMode === 'versus'}
                >
                  <option value={6}>6 回合 · 短局</option>
                  <option value={8}>8 回合 · 标准</option>
                  <option value={10}>10 回合 · 长局</option>
                  <option value={12}>12 回合 · 复杂</option>
                  <option value={16}>16 回合 · 超长局</option>
                </select>
              </label>
            </div>
            <p className="select-hint">
              {storyGameMode === 'versus' ? '对抗模式不限制回合数，重点是角色博弈、资源消耗和淘汰压力。' : '回合越多，剧本越复杂，故事节点越丰富。'}
            </p>
          </CardContent>
        </Card>

        <aside className="briefing-panel">
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">下一步</p>
              <h2>生成剧本与角色</h2>
            </CardHeader>
            <CardContent className="writer-stage">
              <p className="muted-copy">提交后系统会分阶段生成故事大纲、角色卡，你选角后即可进入游戏。</p>
              <div className="hero-actions">
                <Button type="submit" variant="primary" isDisabled={!backgroundPrompt.trim()}>
              生成剧本
                </Button>
                <Button type="button" variant="outline" onClick={() => navigate('/')}>
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
