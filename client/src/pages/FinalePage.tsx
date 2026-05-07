import type { FinaleReport, SessionSnapshot } from '@wax-museum/shared';
import { Button, Card, CardContent, Chip } from '@heroui/react';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { generateFinaleReport, getSession } from '../lib/api';

export function FinalePage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<SessionSnapshot | null>(null);
  const [finale, setFinale] = useState<FinaleReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    setLoading(true);
    getSession(sessionId)
      .then((snapshot) => {
        setSession(snapshot);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId || !session || (session.phase !== 'escaped' && session.phase !== 'failed')) return;
    setGenerating(true);
    generateFinaleReport(sessionId)
      .then((report) => {
        setFinale(report);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setGenerating(false));
  }, [sessionId, session]);

  async function handleRegenerate() {
    if (!sessionId) return;
    setGenerating(true);
    setError(null);
    try {
      const report = await generateFinaleReport(sessionId, true);
      setFinale(report);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成结算失败');
    } finally {
      setGenerating(false);
    }
  }

  if (loading) {
    return <main className="shell game-loading">读取结算档案...</main>;
  }

  if (!session) {
    return (
      <main className="shell game-loading">
        <div>
          <p className="error-copy">{error ?? '未找到该存档。'}</p>
          <Link to="/" className="muted-copy">返回首页</Link>
        </div>
      </main>
    );
  }

  if (session.phase !== 'escaped' && session.phase !== 'failed') {
    return (
      <main className="shell game-loading">
        <div>
          <p className="error-copy">本局还没有结束。</p>
          <Link to={`/session/${session.sessionId}`} className="muted-copy">回到游戏</Link>
        </div>
      </main>
    );
  }

  return (
    <main className="shell shell-finale">
      <header className="finale-page-header">
        <div>
          <p className="panel-kicker">{finale?.title ?? '结算生成中'}</p>
          <h1>{finale?.novelTitle ?? session.scenario.title}</h1>
          <p className="muted-copy">{finale?.verdict ?? '正在根据本局记录生成角色高光与中短篇故事。'}</p>
        </div>
        <div className="hero-actions">
          <Button type="button" variant="secondary" onClick={handleRegenerate} isDisabled={generating}>
            {generating ? '生成中...' : '重新生成'}
          </Button>
          <Link to={`/session/${session.sessionId}`} className="muted-copy">回看本局</Link>
        </div>
      </header>

      {error ? (
        <Card className="section-surface">
          <CardContent className="writer-stage">
            <p className="error-copy">{error}</p>
            <p className="muted-copy">请先在右上角填写 API Key 和模型设置，然后重新生成。</p>
          </CardContent>
        </Card>
      ) : null}

      {finale ? (
        <section className="finale-board" aria-label="结算画面">
          <div className="finale-layout">
            <section className="finale-main">
              <div className="finale-section">
                <p className="panel-kicker">角色高光</p>
                <div className="highlight-grid">
                  {finale.characterHighlights.map((entry) => (
                    <article key={entry.actorId} className={`highlight-card highlight-${entry.actorType}`}>
                      <div className="highlight-title">
                        <h3>{entry.actorLabel}</h3>
                        <Chip size="sm" variant="soft">{entry.outcome}</Chip>
                      </div>
                      <ul>
                        {entry.highlights.map((highlight) => (
                          <li key={highlight}>{highlight}</li>
                        ))}
                      </ul>
                      <p>{entry.closingLine}</p>
                    </article>
                  ))}
                </div>
              </div>

              <div className="finale-section">
                <p className="panel-kicker">中短篇故事</p>
                <article className="novel-paper">
                  {finale.novelStory.split('\n\n').map((paragraph) => (
                    <p key={paragraph}>{paragraph}</p>
                  ))}
                </article>
              </div>
            </section>

            <aside className="finale-timeline">
              <div className="panel-header">
                <p className="panel-kicker">本局记录</p>
                <h2>{finale.subtitle}</h2>
              </div>
              <ol>
                {finale.timeline.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ol>
            </aside>
          </div>
        </section>
      ) : (
        <section className="finale-board">
          <p className="muted-copy">{generating ? 'LLM 正在整理本局高光与小说...' : '等待生成。'}</p>
        </section>
      )}
    </main>
  );
}
