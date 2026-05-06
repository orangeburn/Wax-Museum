export interface ClientLlmSettings {
  apiKey: string;
  model: string;
  baseUrl: string;
}

const STORAGE_KEY = 'wax-museum.llm-settings';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

export function getDefaultLlmSettings(): ClientLlmSettings {
  return {
    apiKey: '',
    model: DEFAULT_MODEL,
    baseUrl: DEFAULT_BASE_URL
  };
}

export function readLlmSettings(): ClientLlmSettings {
  if (typeof window === 'undefined') {
    return getDefaultLlmSettings();
  }

  const defaults = getDefaultLlmSettings();
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ClientLlmSettings>;
    return {
      apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : defaults.model,
      baseUrl: typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : defaults.baseUrl
    };
  } catch {
    return defaults;
  }
}

export function saveLlmSettings(settings: ClientLlmSettings) {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeLlmSettings(settings)));
  window.dispatchEvent(new Event('wax-museum:llm-settings'));
}

export function clearLlmSettings() {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event('wax-museum:llm-settings'));
}

export function normalizeLlmSettings(settings: ClientLlmSettings): ClientLlmSettings {
  const defaults = getDefaultLlmSettings();
  return {
    apiKey: settings.apiKey.trim(),
    model: settings.model.trim() || defaults.model,
    baseUrl: settings.baseUrl.trim().replace(/\/+$/, '') || defaults.baseUrl
  };
}

export function hasClientLlmApiKey() {
  return Boolean(readLlmSettings().apiKey);
}
