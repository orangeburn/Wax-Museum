import { ARCHETYPES, CUSTOM_TAG_WHITELIST } from '@wax-museum/shared';
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
        <p className="eyebrow">单人叙事生存 MVP</p>
        <h1>
          蜡像馆
          <span>Prompt 驱动故事</span>
        </h1>
        <p className="lede">
          这里不再只是一艘固定潜艇。输入一句 Prompt，系统会为你生成一个新的危机场景，再把你的每一句自然语言转成代价与推进。
        </p>
        <div className="hero-actions">
          <button className="primary-button" onClick={() => navigate('/create')}>
            创建新局
          </button>
          <div className="hero-note">
            <strong>白名单自定义 Tag</strong>
            <span>{CUSTOM_TAG_WHITELIST.join(' / ')}</span>
          </div>
        </div>
      </section>

      <section className="start-grid">
        <article className="scenario-column">
          <p className="panel-kicker">动态故事</p>
          <h2>每一局都先生成世界</h2>
          <p>你可以输入雪山科考站、废弃医院、失控列车、坍塌剧院，或者任何带危机与秘密的封闭场景。</p>
          <div className="scenario-strip">
            <span>当前目标链</span>
            <p>找到关键工具，稳定核心装置，拿到通行物，穿过封锁，启动最终撤离。</p>
          </div>
          <div className="archetype-inline-list">
            {ARCHETYPES.map((entry) => (
              <div key={entry.id} className="archetype-chip">
                <strong>{entry.label}</strong>
                <span>{entry.summary}</span>
              </div>
            ))}
          </div>
        </article>

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
                    <dt>氧气</dt>
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
