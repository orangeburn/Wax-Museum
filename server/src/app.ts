import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from './config/env.js';
import { LocalAiService } from './services/ai.js';
import { createSessionRouter } from './routes/sessions.js';
import { SaveStore, SessionNotFoundError } from './services/save-store.js';
import { SessionService } from './services/session-service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface AppOptions {
  saveDir?: string;
  randomSource?: () => number;
}

export function createApp(options: AppOptions = {}) {
  loadEnvFile();
  const saveDir = options.saveDir ?? path.resolve(__dirname, '../data/saves');
  const sessionService = new SessionService(new SaveStore(saveDir), new LocalAiService(), options.randomSource);
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.get('/health', (_request, response) => {
    response.json({ ok: true });
  });
  app.use('/api', createSessionRouter(sessionService));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof SessionNotFoundError) {
      response.status(404).json({ message: error.message });
      return;
    }

    if (error instanceof Error) {
      response.status(400).json({ message: error.message });
      return;
    }

    response.status(500).json({ message: '未知错误' });
  });

  return { app, sessionService };
}
