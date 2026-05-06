import { AsyncLocalStorage } from 'node:async_hooks';
import type express from 'express';

export interface LlmRequestConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

const llmRequestContext = new AsyncLocalStorage<LlmRequestConfig>();

export function withLlmRequestConfig(request: express.Request, next: () => void) {
  llmRequestContext.run(readLlmRequestConfig(request), next);
}

export function getLlmApiKey() {
  return llmRequestContext.getStore()?.apiKey ?? process.env.LLM_API_KEY;
}

export function getLlmModel() {
  return llmRequestContext.getStore()?.model ?? process.env.LLM_MODEL;
}

export function getLlmBaseUrlOverride() {
  return llmRequestContext.getStore()?.baseUrl ?? process.env.LLM_BASE_URL;
}

function readLlmRequestConfig(request: express.Request): LlmRequestConfig {
  return {
    apiKey: readHeader(request, 'x-llm-api-key'),
    model: readHeader(request, 'x-llm-model'),
    baseUrl: readHeader(request, 'x-llm-base-url')
  };
}

function readHeader(request: express.Request, name: string) {
  const raw = request.header(name)?.trim();
  return raw || undefined;
}
