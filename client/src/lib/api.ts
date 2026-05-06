import type {
  ActionResponse,
  CreateSessionRequest,
  SaveMeta,
  SessionSnapshot,
  StoryOutlineRequest,
  StoryOutlineResponse,
  WriterDraftRequest,
  WriterDraftResponse
} from '@wax-museum/shared';
import { readLlmSettings } from './llm-settings';

const DEV_API_FALLBACKS = ['http://127.0.0.1:8787', 'http://localhost:8787'];
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') ?? '';

export class ApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

function buildRequestInit(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Content-Type', headers.get('Content-Type') ?? 'application/json');

  const llmSettings = readLlmSettings();
  if (llmSettings.apiKey) {
    headers.set('X-LLM-API-Key', llmSettings.apiKey);
    headers.set('X-LLM-Model', llmSettings.model);
    headers.set('X-LLM-Base-URL', llmSettings.baseUrl);
  }

  return {
    ...init,
    headers
  };
}

function withBaseUrl(path: string, baseUrl: string) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchWithFallback(input: string, init?: RequestInit) {
  const requestInit = buildRequestInit(init);
  const resolvedInput = API_BASE_URL && input.startsWith('/api') ? withBaseUrl(input, API_BASE_URL) : input;

  if (import.meta.env.DEV && !API_BASE_URL && input.startsWith('/api')) {
    let lastError: unknown;

    for (const baseUrl of DEV_API_FALLBACKS) {
      try {
        const response = await fetch(withBaseUrl(input, baseUrl), requestInit);
        if (response.ok) {
          return response;
        }

        lastError = new Error(`DEV backend request failed with status ${response.status}`);
      } catch (error) {
        lastError = error;
      }
    }

    try {
      return await fetch(input, requestInit);
    } catch (error) {
      throw lastError ?? error;
    }
  }

  try {
    return await fetch(resolvedInput, requestInit);
  } catch (error) {
    if (!import.meta.env.DEV || API_BASE_URL || !input.startsWith('/api')) {
      throw error;
    }

    for (const baseUrl of DEV_API_FALLBACKS) {
      try {
        return await fetch(withBaseUrl(input, baseUrl), requestInit);
      } catch {
        continue;
      }
    }

    throw new Error('无法连接到本地接口服务，请确认 http://127.0.0.1:8787 已启动。');
  }
}

async function readJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetchWithFallback(input, init);

  if (!response.ok) {
    const error = (await response.json().catch(() => ({ message: '请求失败' }))) as { message?: string };
    throw new ApiResponseError(error.message ?? '请求失败');
  }

  return response.json() as Promise<T>;
}

export function listSaves() {
  return readJson<SaveMeta[]>('/api/saves');
}

export function createSession(payload: CreateSessionRequest) {
  return readJson<SessionSnapshot>('/api/session', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function generateStoryOutline(payload: StoryOutlineRequest) {
  return readJson<StoryOutlineResponse>('/api/story-outline', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function generateWriterDraft(payload: WriterDraftRequest) {
  return readJson<WriterDraftResponse>('/api/writer/draft', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export function getSession(sessionId: string) {
  return readJson<SessionSnapshot>(`/api/session/${sessionId}`);
}

export function postAction(sessionId: string, intent: string) {
  return readJson<ActionResponse>(`/api/session/${sessionId}/action`, {
    method: 'POST',
    body: JSON.stringify({ intent })
  });
}
