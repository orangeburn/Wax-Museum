import { useEffect, useState } from 'react';
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
        <h1>蜡像馆</h1>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => navigate('/create')}>
            创建新局
          </button>
        </div>
      </section>

      <section className="start-grid">
        <article className="save-column">
          <div className="panel-header">
            <p className="panel-kicker">本地存档</p>
            <h2>继续旧局</h2>
          </div>
          {loading ? <p className="muted-copy">正在读取存档…</p> : null}
          {error ? <p className="error-copy">{error}</p> : null}
          {!loading && saves.length === 0 ? (
            <div className="empty-state">
              <strong>还没有存档</strong>
              <p>第一局会先让你写一句故事 Prompt。你只需要选一个身份，然后决定第一句要怎么活下去。</p>
            </div>
          ) : null}
          <div className="save-list">
            {saves.map((save) => (
              <button key={save.sessionId} className="save-item" onClick={() => navigate(`/session/${save.sessionId}`)}>
                <div>
                  <strong>{save.title}</strong>
                  <p>{save.dynamicGuide}</p>
                </div>
                <dl>
                  <div>
                    <dt>{save.countdownName || '氧气'}</dt>
                    <dd>{save.oxygen}</dd>
                  </div>
                  <div>
                    <dt>危险</dt>
                    <dd>{save.danger}</dd>
                  </div>
                </dl>
              </button>
            ))}
          </div>
        </article>
      </section>
    </main>
  );
}
