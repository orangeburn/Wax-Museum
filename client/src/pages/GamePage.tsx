import type { ActionResponse, ItemId, SessionSnapshot } from '@wax-museum/shared';
import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getSession, postAction } from '../lib/api';

export function GamePage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [intent, setIntent] = useState('');
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
  const isResolved = session?.phase === 'escaped' || session?.phase === 'failed';
  const resolutionTitle = session?.phase === 'escaped' ? `你活着离开了 ${session?.scenario.title ?? '现场'}。` : `${session?.scenario.title ?? '这个现场'} 吞掉了最后一口气。`;
  const resolutionSummary =
    actionFeedback?.narration.scene ??
    latestEntry?.publicText ??
    (session?.phase === 'escaped' ? `最终撤离已经完成，${session?.scenario.title ?? '现场'} 终于退成了身后的黑影。` : '秩序彻底崩塌，这一局停在了代价和黑暗之间。');
  const resolutionTone =
    session?.phase === 'escaped'
      ? '警报已经远去，剩下的是终于能慢慢呼吸的空气。'
      : '这次没能离开，但整段航程和每一步代价都还留在记录里。';

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

  if (loading) {
    return <main className="shell game-loading">正在同步故事现场…</main>;
  }

  if (!session) {
    return (
      <main className="shell game-loading">
        <p className="error-copy">{error ?? '未找到该存档。'}</p>
        <Link to="/" className="ghost-button inline-link">
          返回起始页
        </Link>
      </main>
    );
  }

  return (
    <main className="shell shell-game">
      <header className="status-ribbon">
        <div>
          <p className="panel-kicker">当前故事</p>
          <h1>{session.objectives.macroObjective}</h1>
          <p className="muted-copy">{session.scenario.premise}</p>
        </div>
        <div className="ribbon-stats">
          <span>{session.objectives.countdownLabel}</span>
          <span>危险 {session.world.danger}</span>
          <span>HP {session.player.hp}</span>
          <span>San {session.player.san}</span>
          <span className={`phase-chip phase-${session.phase}`}>{session.phase}</span>
        </div>
      </header>

      {isResolved ? (
        <section className={`resolution-banner resolution-${session.phase}`}>
          <div className="resolution-copy">
            <p className="panel-kicker">{session.phase === 'escaped' ? '任务完成' : '任务结束'}</p>
            <h2>{resolutionTitle}</h2>
            <p>{resolutionSummary}</p>
            <p className="muted-copy">{resolutionTone}</p>
          </div>
          <div className="resolution-stats" aria-label="结算摘要">
            <div>
              <span>剩余氧气</span>
              <strong>{session.world.oxygen}</strong>
            </div>
            <div>
              <span>危险等级</span>
              <strong>{session.world.danger}</strong>
            </div>
            <div>
              <span>总回合</span>
              <strong>{session.world.turn}</strong>
            </div>
          </div>
        </section>
      ) : null}

      <section className="game-grid">
        <aside className="sidebar player-rail">
          <div className="sidebar-block">
            <p className="panel-kicker">故事设定</p>
            <h2>{session.scenario.title}</h2>
            <p>{session.scenario.openingLine}</p>
          </div>
          <div className="sidebar-block">
            <p className="panel-kicker">角色</p>
            <h2>{session.player.archetypeLabel}</h2>
            <p>{session.player.customBackground || '没有额外背景备注。'}</p>
          </div>
          <div className="stat-stack">
            <div>
              <span>体魄</span>
              <strong>{session.player.stats.physique}</strong>
            </div>
            <div>
              <span>心智</span>
              <strong>{session.player.stats.mind}</strong>
            </div>
            <div>
              <span>感性</span>
              <strong>{session.player.stats.empathy}</strong>
            </div>
          </div>
          <div className="sidebar-block">
            <p className="panel-kicker">标签</p>
            <div className="tag-list">
              {session.player.tags.map((tag) => (
                <span key={tag}>{tag}</span>
              ))}
            </div>
          </div>
          <div className="sidebar-block">
            <p className="panel-kicker">携带物品</p>
            <ul className="item-list">
              {session.player.inventory.length ? session.player.inventory.map((item) => <li key={item}>{itemLabels[item] ?? item}</li>) : <li>无</li>}
            </ul>
          </div>
          <div className="sidebar-block notes-block">
            <p className="panel-kicker">规则备注</p>
            <ul className="item-list">
              {session.player.notes.length ? session.player.notes.map((note) => <li key={note}>{note}</li>) : <li>无额外备注</li>}
            </ul>
          </div>
        </aside>

        <section className="log-panel">
          <div className="log-header">
            <div>
              <p className="panel-kicker">动态目标</p>
              <h2>{session.objectives.dynamicGuide}</h2>
            </div>
            <span className="location-pill">当前位置：{session.world.locations[session.player.locationId].label}</span>
          </div>

          <div className="narration-preview">
            <p className="panel-kicker">最新广播</p>
            <p>{actionFeedback?.narration.scene ?? latestEntry?.publicText ?? '开局后你的第一条行动会出现在这里。'}</p>
            <div className="system-tags">
              {(actionFeedback?.narration.systems ?? []).map((entry) => (
                <span key={entry}>{entry}</span>
              ))}
            </div>
          </div>

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

          <form className="command-form" onSubmit={handleSubmit}>
            <label>
              <span>{session.phase === 'active' ? '自然语言行动' : '本局已结束'}</span>
              <textarea
                rows={3}
                value={intent}
                onChange={(event) => setIntent(event.target.value)}
                placeholder={session.phase === 'active' ? '例如：我查看工具柜；我前往动力区；我启动撤离装置' : '你已经抵达结局，可以返回首页再开一局。'}
                disabled={session.phase !== 'active'}
              />
            </label>
            <div className="hero-actions">
              <button type="submit" className="primary-button" disabled={sending || session.phase !== 'active'}>
                {sending ? '执行中…' : session.phase === 'active' ? '执行行动' : session.phase === 'escaped' ? '已成功逃离' : '本局已结束'}
              </button>
              <Link to="/" className="ghost-button inline-link">
                {session.phase === 'active' ? '返回首页' : '再开一局'}
              </Link>
            </div>
          </form>
          {error ? <p className="error-copy">{error}</p> : null}
        </section>

        <aside className="sidebar route-rail">
          <div className="sidebar-block">
            <p className="panel-kicker">当前舱室</p>
            <h2>{session.world.locations[session.player.locationId].label}</h2>
            <p>{session.world.locations[session.player.locationId].description}</p>
          </div>
          <div className="sidebar-block">
            <p className="panel-kicker">推荐动作</p>
            <div className="suggestion-list">
              {session.objectives.availableActionsHint.map((hint) => (
                <button key={hint} type="button" className="suggestion-chip" onClick={() => submitSuggestedCommand(hint)} disabled={sending || session.phase !== 'active'}>
                  {hint}
                </button>
              ))}
            </div>
          </div>
          <div className="sidebar-block">
            <p className="panel-kicker">已到过</p>
            <ul className="item-list">
              {session.world.visitedLocations.map((locationId) => (
                <li key={locationId}>{session.world.locations[locationId].label}</li>
              ))}
            </ul>
          </div>
        </aside>
      </section>
    </main>
  );
}
