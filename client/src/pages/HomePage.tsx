import { useEffect, useState } from 'react';
import { Button, Card, CardContent, CardHeader, Chip, Skeleton } from '@heroui/react';
import { useNavigate } from 'react-router-dom';
import { listSaves } from '../lib/api';

export function HomePage() {
  const [saves, setSaves] = useState<Array<Awaited<ReturnType<typeof listSaves>>[number]>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    listSaves()
      .then((result) => {
        setSaves(result);
        setError(null);
      })
      .catch((reason: Error) => setError(reason.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="shell shell-home">
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">叙事沙盒</p>
          <h1>蜡像馆</h1>
          <p className="hero-subtitle">这里的每个人都有秘密，每一步都有代价。你写下设定，系统补完剧本与角色，再把你扔进现场。</p>
          <div className="hero-actions">
            <Button size="lg" variant="primary" onClick={() => navigate('/create')}>
              开始新局
            </Button>
          </div>
        </div>
      </section>

      <section className="start-grid">
        <Card className="save-column section-surface">
          <CardHeader className="panel-header">
            <p className="panel-kicker">本地存档</p>
            <h2>继续旧局</h2>
          </CardHeader>
          {loading ? (
            <CardContent className="save-list">
              <Skeleton className="h-20 w-full rounded-none" />
              <Skeleton className="h-20 w-full rounded-none" />
            </CardContent>
          ) : null}
          {error ? <p className="error-copy">{error}</p> : null}
          {!loading && saves.length === 0 ? (
            <div className="empty-state">
              <p>还没有存档。创建第一局后会出现在这里。</p>
            </div>
          ) : null}
          <CardContent className="save-list">
            {saves.map((save) => (
              <Button
                key={save.sessionId}
                className="save-item"
                fullWidth
                variant="secondary"
                onClick={() => navigate(`/session/${save.sessionId}`)}
              >
                <div className="save-item-copy">
                  <strong>{save.title}</strong>
                  <p>{save.dynamicGuide}</p>
                </div>
                <div className="save-item-meta">
                  <Chip size="sm" variant="soft">{`${save.countdownName || '氧气'} ${save.oxygen}`}</Chip>
                  <Chip className={save.danger > 2 ? 'danger-chip' : ''} size="sm" variant="soft">{`危险 ${save.danger}`}</Chip>
                </div>
              </Button>
            ))}
          </CardContent>
        </Card>
      </section>
    </main>
  );
}
