import type { ActionResponse, ItemId, SessionSnapshot } from '@wax-museum/shared';
import { ChangeEvent, FormEvent, useEffect, useMemo, useState } from 'react';
import { Button, Card, CardContent, CardHeader, Chip, TextArea } from '@heroui/react';
import { Link, useParams } from 'react-router-dom';
import { getSession, postAction, postPublicMessage } from '../lib/api';

/** Estimate AP cost for a suggestion label based on keyword heuristics. */
function estimateApCost(hint: string): number {
  if (/查看|背包|提示/.test(hint)) return 0;
  if (/前往|移动/.test(hint)) return 2;
  if (/修理|强行/.test(hint)) return 3;
  if (/使用|说服/.test(hint)) return 2;
  return 1;
}

function getLocationLabel(snapshot: SessionSnapshot, locationId: string) {
  return snapshot.world.locations[locationId]?.label ?? locationId;
}

function getLocationDescription(snapshot: SessionSnapshot, locationId: string) {
  return snapshot.world.locations[locationId]?.description ?? '这个区域的信息暂时缺失。';
}

export function GamePage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [intent, setIntent] = useState('');
  const [publicMessage, setPublicMessage] = useState('');
  const [actionFeedback, setActionFeedback] = useState<ActionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    setLoading(true);
    getSession(sessionId)
      .then((snapshot) => {
        setSession(snapshot);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const latestEntry = useMemo(() => session?.logTail.at(-1) ?? null, [session]);
  const itemLabels: Partial<Record<ItemId, string>> = session?.scenario?.glossary?.itemLabels ?? {};
  const secretAgenda = session?.player.secretAgenda ?? null;
  const isResolved = session?.phase === 'escaped' || session?.phase === 'failed';
  const resolutionTitle = session?.phase === 'escaped' ? `你活着离开了 ${session?.scenario.title ?? '现场'}。` : `${session?.scenario.title ?? '这个现场'} 吞掉了最后一口气。`;
  const resolutionSummary =
    actionFeedback?.narration.scene ??
    latestEntry?.publicText ??
    (session?.phase === 'escaped' ? `撤离完成。` : '秩序彻底崩塌。');
  const playerAp = session?.world.playerActionPoints ?? 0;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !intent.trim() || sending) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const response = await postAction(sessionId, intent);
      setSession(response.sessionSnapshot);
      setActionFeedback(response);
      setIntent('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '行动失败');
    } finally {
      setSending(false);
    }
  }

  async function submitSuggestedCommand(command: string) {
    setIntent(command);
    if (!sessionId || sending) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const response = await postAction(sessionId, command);
      setSession(response.sessionSnapshot);
      setActionFeedback(response);
      setIntent('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '行动失败');
    } finally {
      setSending(false);
    }
  }

  async function handleEndRound() {
    if (!sessionId || sending || !session || session.phase !== 'active') {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const response = await postAction(sessionId, '结束回合');
      setSession(response.sessionSnapshot);
      setActionFeedback(response);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '结束回合失败');
    } finally {
      setSending(false);
    }
  }

  async function handlePublicMessageSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!sessionId || !publicMessage.trim() || sending || session?.phase !== 'active') {
      return;
    }

    setSending(true);
    setError(null);
    try {
      const snapshot = await postPublicMessage(sessionId, publicMessage);
      setSession(snapshot);
      setPublicMessage('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '公屏发送失败');
    } finally {
      setSending(false);
    }
  }

  if (loading) {
    return <main className="shell game-loading">同步故事现场…</main>;
  }

  if (!session) {
    return (
      <main className="shell game-loading">
        <div>
          <p className="error-copy">{error ?? '未找到该存档。'}</p>
          <div className="hero-actions" style={{ justifyContent: 'center' }}>
            <Link to="/" className="muted-copy">返回</Link>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell-game">
      {/* ── Status Ribbon ── */}
      <header className="status-ribbon">
        <div className="ribbon-heading">
          <p className="panel-kicker">主线目标</p>
          <h1>{session.objectives.macroObjective}</h1>
        </div>
        <div className="ribbon-stats">
          <Chip size="sm" variant="soft">{`回合 ${session.world.currentRound ?? 1}/${session.world.maxRounds ?? 8}`}</Chip>
          <Chip size="sm" variant="soft">{`AP ${playerAp}`}</Chip>
          <Chip size="sm" variant="soft">{session.objectives.countdownLabel}</Chip>
          <Chip className={session.world.danger > 2 ? 'danger-chip' : ''} size="sm" variant="soft">{`危险 ${session.world.danger}`}</Chip>
          <Chip size="sm" variant="soft">{`HP ${session.player.hp}`}</Chip>
          <Chip size="sm" variant="soft">{`San ${session.player.san}`}</Chip>
          <Chip className={`phase-chip phase-${session.phase}`} size="sm" variant="soft">{session.phase}</Chip>
        </div>
      </header>

      {/* ── Resolution Banner ── */}
      {isResolved ? (
        <section className={`resolution-banner resolution-${session.phase}`}>
          <div className="resolution-copy">
            <p className="panel-kicker">{session.phase === 'escaped' ? '任务完成' : '任务结束'}</p>
            <h2>{resolutionTitle}</h2>
            <p className="muted-copy">{resolutionSummary}</p>
          </div>
          <div className="resolution-stats" aria-label="结算摘要">
            <div>
              <span>{session.scenario.countdown.label}</span>
              <strong>{session.world.oxygen}</strong>
            </div>
            <div>
              <span>危险等级</span>
              <strong>{session.world.danger}</strong>
            </div>
            <div>
              <span>总行动</span>
              <strong>{session.world.turn}</strong>
            </div>
          </div>
        </section>
      ) : null}

      {/* ── Main Grid ── */}
      <section className="game-grid">
        {/* ── Left: Player Info ── */}
        <aside className="sidebar player-rail">
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">角色</p>
              <h2>{session.player.archetypeLabel}</h2>
            </CardHeader>
            <CardContent className="writer-stage">
              <div className="stat-stack">
                <div><span>体魄</span><strong>{session.player.stats.physique}</strong></div>
                <div><span>心智</span><strong>{session.player.stats.mind}</strong></div>
                <div><span>感性</span><strong>{session.player.stats.empathy}</strong></div>
              </div>
              <div className="sidebar-block">
                <p className="panel-kicker">标签</p>
                <div className="tag-list">
                  {session.player.tags.map((tag) => (
                    <Chip key={tag} size="sm" variant="soft">{tag}</Chip>
                  ))}
                </div>
              </div>
              <div className="sidebar-block">
                <p className="panel-kicker">物品</p>
                <ul className="item-list">
                  {session.player.inventory.length ? session.player.inventory.map((item) => <li key={item}>{itemLabels[item] ?? item}</li>) : <li className="muted-copy">无</li>}
                </ul>
              </div>
            </CardContent>
          </Card>
          {secretAgenda ? (
            <Card className="section-surface">
              <CardHeader className="panel-header">
                <p className="panel-kicker">秘密目标</p>
                <h2>{secretAgenda.title}</h2>
              </CardHeader>
              <CardContent className="writer-stage">
                <p>{secretAgenda.description}</p>
                <Chip className={secretAgenda.status === 'completed' ? 'success-chip' : ''} size="sm" variant="soft">
                  {session.objectives.secretAgendaStatus ?? `${secretAgenda.progress}/${secretAgenda.requiredProgress}`}
                </Chip>
              </CardContent>
            </Card>
          ) : null}
          {session.scenario.npcs?.length ? (
            <Card className="section-surface">
              <CardHeader className="panel-header">
                <p className="panel-kicker">NPC</p>
              </CardHeader>
              <CardContent>
                <ul className="item-list">
                  {session.scenario.npcs.map((npc) => (
                    <li key={npc.id}>
                      <strong>{npc.name}</strong>（{npc.attitude}）
                      <div>@{getLocationLabel(session, npc.locationId)}</div>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ) : null}
        </aside>

        {/* ── Center: Story Flow ── */}
        <section className="log-panel">
          <Card className="section-surface">
            <CardHeader className="log-header">
              <div>
                <p className="panel-kicker">行动指引</p>
                <h2>{session.objectives.dynamicGuide}</h2>
              </div>
              <Chip className="location-pill" size="sm" variant="soft">{getLocationLabel(session, session.player.locationId)}</Chip>
            </CardHeader>
            <CardContent className="narration-preview">
              <p className="panel-kicker">最新事件</p>
              <p>{actionFeedback?.narration.scene ?? latestEntry?.publicText ?? '你的第一条行动会出现在这里。'}</p>
              {(actionFeedback?.narration.systems ?? []).length > 0 ? (
                <div className="system-tags">
                  {(actionFeedback?.narration.systems ?? []).map((entry) => (
                    <Chip key={entry} size="sm" variant="soft">{entry}</Chip>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <ol className="log-stream">
            {session.logTail.map((entry) => (
              <li key={`${entry.step}-${entry.timestamp}`} className={`log-entry tier-${entry.tier}`}>
                <div className="log-meta">
                  <span>#{entry.step}</span>
                  <strong>{entry.filteredAction}</strong>
                </div>
                <p>{entry.publicText}</p>
                <small>{entry.systemText}</small>
              </li>
            ))}
          </ol>

          <Card className="section-surface public-chat-panel">
            <CardHeader className="panel-header">
              <p className="panel-kicker">公屏</p>
              <h2>所有角色可见</h2>
            </CardHeader>
            <CardContent className="public-chat-content">
              <ol className="public-chat-stream">
                {(session.publicMessages ?? []).length ? (session.publicMessages ?? []).map((message) => (
                  <li key={message.id} className={`public-message public-message-${message.speakerType}`}>
                    <div className="public-message-meta">
                      <strong>{message.speakerLabel}</strong>
                      <span>#{message.step}</span>
                    </div>
                    <p>{message.content}</p>
                  </li>
                )) : (
                  <li className="muted-copy">还没有人开口。</li>
                )}
              </ol>
              <form className="public-chat-form" onSubmit={handlePublicMessageSubmit}>
                <TextArea
                  aria-label="公屏发言"
                  rows={2}
                  value={publicMessage}
                  maxLength={180}
                  onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setPublicMessage(event.target.value)}
                  placeholder={session.phase === 'active' ? '向所有角色发一条公开信息…' : '本局已结束。'}
                  disabled={session.phase !== 'active'}
                  variant="secondary"
                />
                <Button type="submit" variant="secondary" isDisabled={sending || session.phase !== 'active' || !publicMessage.trim()}>
                  发送
                </Button>
              </form>
            </CardContent>
          </Card>

          <form className="command-form" onSubmit={handleSubmit}>
            <span className="field-label">{session.phase === 'active' ? '行动输入' : '本局已结束'}</span>
            <div className="command-row">
              <TextArea
                aria-label="自然语言行动"
                rows={2}
                value={intent}
                onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setIntent(event.target.value)}
                placeholder={session.phase === 'active' ? '描述你想做的事…' : '返回首页再开一局。'}
                disabled={session.phase !== 'active'}
                variant="secondary"
              />
              <Button type="submit" variant="primary" isDisabled={sending || session.phase !== 'active'}>
                {sending ? '…' : '执行行动'}
              </Button>
            </div>
            {error ? <p className="error-copy">{error}</p> : null}
            {!isResolved ? (
              <Link to="/" className="muted-copy" style={{ fontSize: '0.75rem' }}>返回首页</Link>
            ) : (
              <Link to="/" className="muted-copy">再开一局</Link>
            )}
          </form>
        </section>

        {/* ── Right: Actions & Location ── */}
        <aside className="sidebar route-rail">
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">当前位置</p>
              <h2>{getLocationLabel(session, session.player.locationId)}</h2>
            </CardHeader>
            <CardContent>
              <p>{getLocationDescription(session, session.player.locationId)}</p>
            </CardContent>
          </Card>
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">可用行动</p>
            </CardHeader>
            <CardContent className="writer-stage">
              <div className="suggestion-list">
                {session.objectives.availableActionsHint.map((hint) => {
                  const cost = estimateApCost(hint);
                  return (
                    <Button key={hint} type="button" className="save-item" variant="secondary" onClick={() => submitSuggestedCommand(hint)} isDisabled={sending || session.phase !== 'active'}>
                      <span>{hint}</span>
                      <span className="ap-cost">{cost > 0 ? `${cost} AP` : '免费'}</span>
                    </Button>
                  );
                })}
              </div>
              {session.phase === 'active' && playerAp > 0 ? (
                <Button type="button" variant="outline" onClick={handleEndRound} isDisabled={sending}>
                  结束当前回合
                </Button>
              ) : null}
            </CardContent>
          </Card>
          <Card className="section-surface">
            <CardHeader className="panel-header">
              <p className="panel-kicker">已探索</p>
            </CardHeader>
            <CardContent>
              <ul className="item-list">
                {session.world.visitedLocations.map((locationId) => (
                  <li key={locationId}>{getLocationLabel(session, locationId)}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </aside>
      </section>
    </main>
  );
}
