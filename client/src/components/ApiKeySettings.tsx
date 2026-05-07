import { FormEvent, useEffect, useState } from 'react';
import { Button, Input } from '@heroui/react';
import { useLocation } from 'react-router-dom';
import {
  clearLlmSettings,
  getDefaultLlmSettings,
  normalizeLlmSettings,
  readLlmSettings,
  saveLlmSettings,
  type ClientLlmSettings
} from '../lib/llm-settings';

export function ApiKeySettings() {
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [settings, setSettings] = useState<ClientLlmSettings>(() => readLlmSettings());
  const [draft, setDraft] = useState<ClientLlmSettings>(() => readLlmSettings());
  const hasKey = Boolean(settings.apiKey);
  const showGmButton = /^\/session\/[^/]+$/.test(location.pathname);

  useEffect(() => {
    function syncSettings() {
      const next = readLlmSettings();
      setSettings(next);
      setDraft(next);
    }

    window.addEventListener('storage', syncSettings);
    window.addEventListener('wax-museum:llm-settings', syncSettings);
    return () => {
      window.removeEventListener('storage', syncSettings);
      window.removeEventListener('wax-museum:llm-settings', syncSettings);
    };
  }, []);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizeLlmSettings(draft);
    saveLlmSettings(normalized);
    setSettings(normalized);
    setDraft(normalized);
    setOpen(false);
  }

  function handleClear() {
    clearLlmSettings();
    const defaults = getDefaultLlmSettings();
    setSettings(defaults);
    setDraft(defaults);
  }

  function handleOpenGm() {
    window.dispatchEvent(new CustomEvent('wax-museum:open-gm'));
  }

  return (
    <div className="api-key-dock">
      <div className="top-link-row">
        <a
          className="github-link"
          href="https://github.com/orangeburn/Wax-Museum"
          target="_blank"
          rel="noreferrer"
        >
          GitHub
        </a>
        <Button
          type="button"
          size="sm"
          variant={hasKey ? 'primary' : 'secondary'}
          className="api-key-trigger"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          {hasKey ? 'API Key 已启用' : '填写 API Key'}
        </Button>
        {showGmButton ? (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="gm-top-trigger"
            onClick={handleOpenGm}
          >
            GM
          </Button>
        ) : null}
      </div>

      {open ? (
        <div className="api-key-popover" role="dialog" aria-label="LLM API 设置">
          <form className="api-key-form" onSubmit={handleSubmit}>
            <div className="panel-header">
              <p className="panel-kicker">LLM 测试配置</p>
              <h2>使用你自己的密钥</h2>
            </div>
            <label className="field-stack">
              <span className="field-label">API Key</span>
              <Input
                aria-label="API Key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder="sk-..."
                variant="secondary"
              />
            </label>
            <label className="field-stack">
              <span className="field-label">模型</span>
              <Input
                aria-label="模型"
                value={draft.model}
                onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))}
                placeholder="gpt-4o-mini"
                variant="secondary"
              />
            </label>
            <label className="field-stack">
              <span className="field-label">Base URL</span>
              <Input
                aria-label="Base URL"
                value={draft.baseUrl}
                onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://api.openai.com/v1"
                variant="secondary"
              />
            </label>
            <p className="select-hint">密钥只保存在当前浏览器。浏览器会直接调用你填写的模型服务；失败时使用本地兜底内容。</p>
            <div className="api-key-actions">
              <Button type="submit" variant="primary" isDisabled={!draft.apiKey.trim()}>
                保存
              </Button>
              <Button type="button" variant="outline" onClick={handleClear}>
                清除
              </Button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
