import type {
  ActionResponse,
  CreateSessionRequest,
  SessionSnapshot,
  StoryOutlineRequest,
  StoryOutlineResponse,
  WriterDraftRequest,
  WriterDraftResponse
} from '@wax-museum/shared';
import { buildSnapshot, createNewSession, applyParsedAction } from '../engine/session-engine.js';
import type { AiService } from './ai.js';
import { SaveStore } from './save-store.js';

export class SessionService {
  constructor(
    private readonly saveStore: SaveStore,
    private readonly aiService: AiService,
    private readonly randomSource: () => number = Math.random
  ) {}

  async createSession(request: CreateSessionRequest): Promise<SessionSnapshot> {
    const storyPrompt = request.storyPrompt?.trim();
    const scenario = storyPrompt
      ? await this.aiService.generateScenario({
          templateId: request.templateId,
          archetypeId: request.archetypeId,
          prompt: storyPrompt
        })
      : undefined;

    const session = createNewSession({
      ...request,
      customBackground: request.customBackground.trim(),
      customTag: request.customTag.trim()
    }, scenario);
    await this.saveStore.write(session);
    return buildSnapshot(session);
  }

  async listSaves() {
    return this.saveStore.list();
  }

  async generateStoryOutline(request: StoryOutlineRequest): Promise<StoryOutlineResponse> {
    return this.aiService.generateStoryOutline({
      ...request,
      prompt: request.prompt.trim()
    });
  }

  async generateWriterDraft(request: WriterDraftRequest): Promise<WriterDraftResponse> {
    return this.aiService.generateWriterDraft({
      prompt: request.prompt.trim()
    });
  }

  async getSession(sessionId: string) {
    const session = await this.saveStore.read(sessionId);
    return buildSnapshot(session);
  }

  async applyIntent(sessionId: string, intent: string): Promise<ActionResponse> {
    const session = await this.saveStore.read(sessionId);
    const parsed = await this.aiService.intentToAction(session, intent);
    const executed = applyParsedAction(session, parsed, this.randomSource);
    const sessionSnapshot = buildSnapshot(executed.session);
    const narration = await this.aiService.composeNarration({
      session: executed.session,
      filteredAction: executed.filteredAction,
      resolution: executed.resolution,
      presentation: executed.presentation
    });

    await this.saveStore.write(executed.session);

    return {
      filteredAction: executed.filteredAction,
      resolution: executed.resolution,
      sessionSnapshot,
      narration
    };
  }
}
