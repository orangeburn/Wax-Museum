import type {
  ActionResponse,
  CreateSessionRequest,
  SessionSnapshot,
  StoryGameMode,
  StoryOutlineRequest,
  StoryOutlineResponse,
  WriterDraftRequest,
  WriterDraftResponse
} from '@wax-museum/shared';
import { buildActorObservation, buildSnapshot, createNewSession, applyParsedActionWithNpcAi } from '../engine/session-engine.js';
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
    const playerCount = clampPlayerCount(request.playerCount);
    const roundCount = clampRoundCount(request.roundCount);
    const scenario = storyPrompt
      ? await this.aiService.generateScenario({
          templateId: request.templateId,
          archetypeId: request.archetypeId,
          prompt: storyPrompt,
          storyGameMode: normalizeStoryGameMode(request.storyGameMode),
          playerCount,
          roundCount: normalizeStoryGameMode(request.storyGameMode) === 'versus' ? undefined : roundCount
        })
      : undefined;

    const session = createNewSession({
      ...request,
      storyGameMode: normalizeStoryGameMode(request.storyGameMode),
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
      prompt: request.prompt.trim(),
      storyGameMode: normalizeStoryGameMode(request.storyGameMode),
      playerCount: clampPlayerCount(request.playerCount),
      roundCount: normalizeStoryGameMode(request.storyGameMode) === 'versus' ? undefined : clampRoundCount(request.roundCount)
    });
  }

  async generateWriterDraft(request: WriterDraftRequest): Promise<WriterDraftResponse> {
    return this.aiService.generateWriterDraft({
      prompt: request.prompt.trim(),
      storyGameMode: normalizeStoryGameMode(request.storyGameMode),
      playerCount: clampPlayerCount(request.playerCount),
      roundCount: normalizeStoryGameMode(request.storyGameMode) === 'versus' ? undefined : clampRoundCount(request.roundCount),
      outline: request.outline
    });
  }

  async getSession(sessionId: string) {
    const session = await this.saveStore.read(sessionId);
    return buildSnapshot(session);
  }

  async applyIntent(sessionId: string, intent: string): Promise<ActionResponse> {
    const session = await this.saveStore.read(sessionId);
    const parsed = await this.aiService.intentToAction(session, intent);
    const executed = await applyParsedActionWithNpcAi(
      session,
      parsed,
      this.randomSource,
      ({ session: currentSession, npc }) => this.aiService.decideNpcIntent(buildActorObservation(currentSession, npc.id))
    );
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

function clampPlayerCount(input: number | undefined) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 1;
  }
  return Math.max(1, Math.min(6, Math.round(input)));
}

function clampRoundCount(input: number | undefined) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 8;
  }
  return Math.max(4, Math.min(20, Math.round(input)));
}

function normalizeStoryGameMode(input: StoryGameMode | undefined): StoryGameMode {
  if (input === 'puzzle' || input === 'versus') {
    return input;
  }
  return 'survival';
}
