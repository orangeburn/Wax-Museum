import express from 'express';
import type { SessionService } from '../services/session-service.js';

export function createSessionRouter(sessionService: SessionService) {
  const router = express.Router();

  router.get('/saves', async (_request, response) => {
    response.json(await sessionService.listSaves());
  });

  router.post('/session', async (request, response) => {
    response.status(201).json(await sessionService.createSession(request.body));
  });

  router.post('/story-outline', async (request, response) => {
    response.json(await sessionService.generateStoryOutline(request.body));
  });

  router.post('/writer/draft', async (request, response) => {
    response.json(await sessionService.generateWriterDraft(request.body));
  });

  router.get('/session/:id', async (request, response) => {
    response.json(await sessionService.getSession(request.params.id));
  });

  router.post('/session/:id/action', async (request, response) => {
    response.json(await sessionService.applyIntent(request.params.id, request.body.intent ?? ''));
  });

  return router;
}
