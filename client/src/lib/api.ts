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

const DEV_API_FALLBACKS = ['http://127.0.0.1:8787', 'http://localhost:8787'];

function buildRequestInit(init?: RequestInit): RequestInit {
  return {
    headers: {
      'Content-Type': 'application/json'
    },
    ...init
  };
}

function withBaseUrl(path: string, baseUrl: string) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchWithFallback(input: string, init?: RequestInit) {
  const requestInit = buildRequestInit(init);

  try {
    return await fetch(input, requestInit);
  } catch (error) {
    if (!import.meta.env.DEV || !input.startsWith('/api')) {
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
    throw new Error(error.message ?? '请求失败');
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
