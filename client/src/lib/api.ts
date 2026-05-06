import {
  ARCHETYPES,
  ITEM_LIBRARY,
  SUBMARINE_TEMPLATE,
  type ActionResponse,
  type ActionType,
  type CreateSessionRequest,
  type GameSession,
  type ItemId,
  type LocationId,
  type ParsedAction,
  type SaveMeta,
  type SceneObjectDefinition,
  type SessionSnapshot,
  type StoryGameMode,
  type StoryOutlineRequest,
  type StoryOutlineResponse,
  type StoryScenario,
  type WriterDraftRequest,
  type WriterDraftResponse,
  type WriterRole
} from '@wax-museum/shared';
import {
  applyParsedActionWithNpcAi,
  buildActorObservation,
  buildSnapshot,
  createNewSession
} from '../../../server/src/engine/session-engine';
import { readLlmSettings } from './llm-settings';

const STORAGE_PREFIX = 'wax-museum.session.';
const INDEX_KEY = 'wax-museum.session-index';
const FREE_ACTIONS = new Set<ActionType>(['inspect', 'inventory', 'help']);

export class ApiResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiResponseError';
  }
}

export async function listSaves() {
  return readSaveIndex()
    .map((sessionId) => readSession(sessionId)?.saveMeta)
    .filter((entry): entry is SaveMeta => Boolean(entry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function createSession(payload: CreateSessionRequest) {
  const storyPrompt = payload.storyPrompt?.trim();
  const scenario = storyPrompt
    ? (payload.selectedRole || payload.generatedRoles
        ? buildScenarioFromDraft(storyPrompt, payload.storyGameMode, payload.roundCount)
        : undefined)
    : undefined;
  const session = createNewSession(
    {
      ...payload,
      storyGameMode: normalizeStoryGameMode(payload.storyGameMode),
      customBackground: payload.customBackground.trim(),
      customTag: payload.customTag.trim()
    },
    scenario
  );
  writeSession(session);
  return buildSnapshot(session);
}

export async function generateStoryOutline(payload: StoryOutlineRequest) {
  const prompt = payload.prompt.trim();
  if (!prompt) {
    throw new ApiResponseError('请先输入一句故事 Prompt。');
  }

  return requestLlmObject<StoryOutlineResponse>(
    '你是中文互动悬疑游戏策划。请基于用户 prompt 输出 JSON，不要 markdown。字段：title,premise,twist,secret,openingHook,modeGoal,suggestedBackground,suggestedTags(string[])。文案中文，信息密度高。',
    {
      prompt,
      storyGameMode: normalizeStoryGameMode(payload.storyGameMode),
      playerCount: payload.playerCount ?? 1,
      roundCount: payload.roundCount ?? 8
    }
  ).then(normalizeOutline).catch(() => buildFallbackOutline(prompt, payload.storyGameMode, payload.roundCount));
}

export async function generateWriterDraft(payload: WriterDraftRequest) {
  const prompt = payload.prompt.trim();
  if (!prompt) {
    throw new ApiResponseError('请先输入一句故事 Prompt。');
  }

  const outline = payload.outline ?? buildFallbackOutline(prompt, payload.storyGameMode, payload.roundCount);
  const playerCount = clamp(payload.playerCount ?? 1, 1, 6);
  const storyGameMode = normalizeStoryGameMode(payload.storyGameMode);
  const roundCount = storyGameMode === 'versus' ? 20 : clamp(payload.roundCount ?? 8, 4, 20);

  const generated = await requestLlmObject<Partial<WriterDraftResponse>>(
    `你是中文互动悬疑游戏编剧。请只输出 JSON，不要 markdown。JSON 包含 bible 和 scenario。bible 必含 title,genre,playerCountLabel,premise,background,currentCrisis,coreSecret,outline,endings,roles。roles 数量为 ${playerCount}，每个 role 必含 id,archetypeId,label,publicIdentity,hiddenDrive,relationshipHook,specialty,suggestedTag,suggestedBackground,stats,startingItems,coreTag,secretAgenda。scenario 必含 title,premise,openingLine,macroObjective。`,
    { prompt, outline, storyGameMode, playerCount, roundCount }
  ).catch(() => null);

  if (generated?.bible?.roles?.length) {
    return normalizeDraft(generated, prompt, outline, storyGameMode, playerCount, roundCount);
  }

  return buildFallbackDraft(prompt, outline, storyGameMode, playerCount, roundCount);
}

export async function getSession(sessionId: string) {
  return buildSnapshot(requireSession(sessionId));
}

export async function postAction(sessionId: string, intent: string): Promise<ActionResponse> {
  const session = requireSession(sessionId);
  const parsed = parseIntent(session, intent);
  const executed = await applyParsedActionWithNpcAi(
    session,
    parsed,
    Math.random,
    ({ session: currentSession, npc }) => decideNpcIntent(currentSession, npc.id)
  );
  const sessionSnapshot = buildSnapshot(executed.session);
  const narration = {
    scene: `${executed.presentation.publicText}`,
    systems: [
      executed.presentation.systemText,
      ...(executed.filteredAction.storyFilterNote ? [executed.filteredAction.storyFilterNote] : []),
      ...executed.resolution.stateChanges
    ],
    dynamicGuide: executed.session.objectives.dynamicGuide
  };
  writeSession(executed.session);
  return {
    filteredAction: executed.filteredAction,
    resolution: executed.resolution,
    sessionSnapshot,
    narration
  };
}

function readSaveIndex() {
  return readJson<string[]>(INDEX_KEY, []);
}

function writeSaveIndex(sessionIds: string[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify([...new Set(sessionIds)]));
}

function writeSession(session: GameSession) {
  localStorage.setItem(`${STORAGE_PREFIX}${session.sessionId}`, JSON.stringify(session));
  writeSaveIndex([session.sessionId, ...readSaveIndex()]);
}

function readSession(sessionId: string) {
  return readJson<GameSession | null>(`${STORAGE_PREFIX}${sessionId}`, null);
}

function requireSession(sessionId: string) {
  const session = readSession(sessionId);
  if (!session) {
    throw new ApiResponseError(`未找到本地存档 ${sessionId}`);
  }
  return session;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

async function requestLlmObject<T>(systemPrompt: string, payload: unknown): Promise<T> {
  const settings = readLlmSettings();
  if (!settings.apiKey) {
    throw new ApiResponseError('请先在右上角填写 API Key。');
  }

  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${settings.apiKey}`
    },
    body: JSON.stringify({
      model: settings.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(payload) }
      ]
    })
  });

  if (!response.ok) {
    throw new ApiResponseError(`上游接口返回 ${response.status}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new ApiResponseError('上游接口没有返回内容。');
  }
  return parseJsonContent(content) as T;
}

function parseJsonContent(content: string) {
  const trimmed = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  return JSON.parse(start >= 0 && end >= start ? trimmed.slice(start, end + 1) : trimmed);
}

function normalizeOutline(input: Partial<StoryOutlineResponse>): StoryOutlineResponse {
  return {
    title: clean(input.title, '临时故事'),
    premise: clean(input.premise, '一场封闭危机正在升级。'),
    twist: clean(input.twist, '最可信的人隐瞒了关键事实。'),
    secret: clean(input.secret, '真相被刻意掩埋。'),
    openingHook: clean(input.openingHook, '灯光骤暗，第一声警报响起。'),
    modeGoal: clean(input.modeGoal, '在倒计时结束前做出选择。'),
    suggestedBackground: clean(input.suggestedBackground, '你带着旧事留下的问题进入现场。'),
    suggestedTags: Array.isArray(input.suggestedTags) ? input.suggestedTags.map(String).slice(0, 3) : ['冷静']
  };
}

function buildFallbackOutline(prompt: string, storyGameMode?: StoryGameMode, roundCount = 8): StoryOutlineResponse {
  return {
    title: `${prompt.slice(0, 12) || '无名'} / 临时剧本`,
    premise: `${prompt} 引发了一场封闭现场里的连锁危机。`,
    twist: '最早报警的人并不只是目击者。',
    secret: '旧关系、利益和一次被掩盖的事故同时压在现场。',
    openingHook: '所有出口同时失效，现场只剩不断逼近的倒计时。',
    modeGoal: storyGameMode === 'versus' ? '在对抗中活到最后。' : `约 ${roundCount} 回合内查清真相并脱身。`,
    suggestedBackground: `你因为 ${prompt} 被卷入这场故事。`,
    suggestedTags: ['冷静', '说客']
  };
}

function normalizeDraft(
  input: Partial<WriterDraftResponse>,
  prompt: string,
  outline: StoryOutlineResponse,
  storyGameMode: StoryGameMode,
  playerCount: number,
  roundCount: number
): WriterDraftResponse {
  const fallback = buildFallbackDraft(prompt, outline, storyGameMode, playerCount, roundCount);
  const roles = Array.isArray(input.bible?.roles) && input.bible.roles.length
    ? input.bible.roles.map((role, index) => normalizeRole(role as Partial<WriterRole>, index))
    : fallback.bible.roles;

  return {
    bible: {
      ...fallback.bible,
      ...input.bible,
      roles
    },
    scenario: buildScenarioFromDraft(prompt, storyGameMode, roundCount, input.scenario)
  };
}

function buildFallbackDraft(prompt: string, outline: StoryOutlineResponse, storyGameMode: StoryGameMode, playerCount: number, roundCount: number): WriterDraftResponse {
  const roles = Array.from({ length: playerCount }, (_, index) => normalizeRole({}, index));
  return {
    bible: {
      title: outline.title,
      genre: '互动悬疑',
      storyGameMode,
      playerCountLabel: `${playerCount} 人`,
      premise: outline.premise,
      background: prompt,
      currentCrisis: outline.openingHook,
      coreSecret: outline.secret,
      outline: [outline.premise, outline.twist, outline.secret],
      endings: ['揭开真相后脱身', '带着代价保住关键人物', '真相被重新掩埋'],
      roles
    },
    scenario: buildScenarioFromDraft(prompt, storyGameMode, roundCount)
  };
}

function normalizeRole(input: Partial<WriterRole>, index: number): WriterRole {
  const archetype = ARCHETYPES[index % ARCHETYPES.length] ?? {
    id: 'engineer',
    label: '调查者',
    summary: '临时卷入现场的人',
    prompt: '擅长在压力下处理问题。',
    defaultTag: '冷静' as const,
    stats: { physique: 2, mind: 3, empathy: 2 },
    startingItems: ['sealant-foam' as const]
  };
  const tag = normalizeTag(input.suggestedTag ?? input.coreTag ?? archetype.defaultTag);
  return {
    id: clean(input.id, `role-${index + 1}`),
    archetypeId: clean(input.archetypeId, archetype.id),
    label: clean(input.label, archetype.label),
    publicIdentity: clean(input.publicIdentity, archetype.summary),
    hiddenDrive: clean(input.hiddenDrive, '你必须在脱身前确认一件被隐瞒的旧事。'),
    relationshipHook: clean(input.relationshipHook, '你和现场至少一人有未说出口的旧关系。'),
    specialty: clean(input.specialty, archetype.prompt),
    suggestedTag: tag,
    suggestedBackground: clean(input.suggestedBackground, '你在旧事里留下过一个没有收尾的决定。'),
    stats: input.stats ?? archetype.stats,
    startingItems: input.startingItems?.length ? input.startingItems : archetype.startingItems,
    coreTag: tag,
    secretAgenda: input.secretAgenda ?? {
      title: '找出被隐瞒的关键事实',
      description: '你要在脱身前确认谁改写了现场叙事。',
      successHint: '多调查记录、痕迹和人物矛盾。',
      triggerKeywords: ['记录', '真相', '痕迹'],
      requiredProgress: 2
    },
    settingPack: input.settingPack
  };
}

function buildScenarioFromDraft(prompt: string, storyGameMode: StoryGameMode = 'survival', roundCount = 8, partial?: Partial<StoryScenario>): StoryScenario {
  const glossary = {
    toolLabel: ITEM_LIBRARY['insulated-wrench'].label,
    keyItemLabel: ITEM_LIBRARY['captain-keycard'].label,
    repairMaterialLabel: ITEM_LIBRARY['sealant-foam'].label,
    powerNodeLabel: '主继电器',
    cabinetLabel: '急救柜',
    survivorLabel: '关键证人',
    gateLabel: '封锁闸门',
    exitVehicleLabel: '逃生艇',
    itemLabels: {
      'insulated-wrench': ITEM_LIBRARY['insulated-wrench'].label,
      'captain-keycard': ITEM_LIBRARY['captain-keycard'].label,
      medkit: ITEM_LIBRARY.medkit.label,
      'oxygen-canister': ITEM_LIBRARY['oxygen-canister'].label,
      'sealant-foam': ITEM_LIBRARY['sealant-foam'].label
    }
  };
  return {
    id: 'generated-story',
    title: clean(partial?.title, prompt.slice(0, 16) || '临时故事'),
    premise: clean(partial?.premise, `${prompt} 正在把所有人困进同一个现场。`),
    openingLine: clean(partial?.openingLine, '警报响起时，每个人都意识到自己已经错过了最安全的撤离窗口。'),
    macroObjective: clean(partial?.macroObjective, storyGameMode === 'versus' ? '在对抗中保住自己并揭开真相。' : '在倒计时结束前查清关键事实并脱身。'),
    storyGameMode,
    countdown: partial?.countdown ?? {
      label: storyGameMode === 'versus' ? '局势压力' : '剩余行动步数',
      shortLabel: storyGameMode === 'versus' ? '压力' : '步数',
      max: storyGameMode === 'versus' ? 20 : clamp(roundCount, 4, 20),
      recoverLabel: storyGameMode === 'versus' ? '压力' : '步数'
    },
    gameplayMode: 'llm',
    beats: buildBeats(roundCount),
    npcs: partial?.npcs ?? [{
      id: 'witness',
      name: '关键证人',
      publicIdentity: '最早发现异常的人',
      hiddenDrive: '害怕自己被牵连进旧案',
      attitude: 'neutral',
      locationId: 'med-bay',
      clue: '启动前必须先补齐最后的资源。',
      status: '惊魂未定'
    }],
    locations: SUBMARINE_TEMPLATE.locations,
    glossary
  };
}

function buildBeats(roundCount: number) {
  const labels = [
    ['查看现场异常', '先在当前位置找出最反常的痕迹。', 'crew-quarters', 'inspect', '储物柜'],
    ['恢复核心供能', '找到工具后处理核心装置。', 'engine-room', 'repair', '主继电器'],
    ['解读权限记录', '前往控制室查看被删改的记录。', 'control-room', 'inspect', '主控终端'],
    ['找到关键权限', '去医务舱或补给点寻找关键物资。', 'med-bay', 'inspect', '急救柜'],
    ['稳住关键证人', '说服现场证人交出最后线索。', 'med-bay', 'persuade', '关键证人'],
    ['打开封锁路线', '用钥匙卡打开最后通道。', 'control-room', 'use_item', '封锁闸门'],
    ['完成撤离准备', '检查撤离装置并补齐启动资源。', 'escape-bay', 'inspect', '逃生艇'],
    ['启动终局', '在代价落下前启动撤离装置。', 'escape-bay', 'use_item', '逃生艇']
  ] as const;
  return labels.slice(0, Math.min(labels.length, Math.max(4, Math.round(roundCount / 2)))).map(([title, summary, locationId, actionType, targetLabel], index) => ({
    id: `beat-${index + 1}`,
    title,
    summary,
    guidance: summary,
    locationId: locationId as LocationId,
    actionType: actionType as ActionType,
    targetLabel,
    successText: `${title}取得进展。`,
    failText: `${title}暂时受阻。`,
    suggestions: [summary]
  }));
}

function parseIntent(session: GameSession, intent: string): ParsedAction {
  const normalizedIntent = intent.trim().toLowerCase();
  const type = inferActionType(normalizedIntent);
  const locationId = findLocation(normalizedIntent, session);
  const object = findSceneObject(normalizedIntent, session, locationId);
  const toolId = findItem(normalizedIntent, session);
  const targetLabel = object?.label ?? (locationId ? session.world.locations[locationId]?.label : undefined) ?? getTargetLabel(session, inferTarget(normalizedIntent)) ?? '当前区域';
  return {
    type,
    rawIntent: intent,
    normalizedIntent,
    targetId: object?.id ?? inferTarget(normalizedIntent),
    targetLabel,
    locationId,
    objectId: object?.id,
    toolId,
    consumesTurn: !FREE_ACTIONS.has(type)
  };
}

function inferActionType(input: string): ActionType {
  if (/(背包|物品|inventory)/.test(input)) return 'inventory';
  if (/(帮助|提示|怎么办|help)/.test(input)) return 'help';
  if (/(使用|刷卡|启动|吃|喝|用|use|launch)/.test(input)) return 'use_item';
  if (/(修|维修|重启|repair|fix|稳定)/.test(input)) return 'repair';
  if (/(砸|撬|撞开|强行|force|break)/.test(input)) return 'force';
  if (/(说服|安抚|交谈|聊天|persuade|talk)/.test(input)) return 'persuade';
  if (/(去|前往|移动|进入|赶往|move|go)/.test(input)) return 'move';
  return 'inspect';
}

function findLocation(input: string, session: GameSession): LocationId | undefined {
  return Object.values(session.world.locations).find((location) =>
    [location.label, ...location.pointsOfInterest].some((entry) => input.includes(entry.toLowerCase()))
  )?.id;
}

function findSceneObject(input: string, session: GameSession, locationId?: LocationId): SceneObjectDefinition | undefined {
  const locations = locationId ? [session.world.locations[locationId]] : Object.values(session.world.locations);
  return locations.flatMap((location) => location?.sceneObjects ?? []).find((object) => input.includes(object.label.toLowerCase()));
}

function findItem(input: string, session: GameSession): ItemId | undefined {
  return session.player.inventory.find((itemId) => input.includes(getItemLabel(session, itemId).toLowerCase()) || input.includes(ITEM_LIBRARY[itemId].label.toLowerCase()));
}

function inferTarget(input: string) {
  if (/(储物|柜|locker)/.test(input)) return 'locker';
  if (/(继电|电力|供能|relay)/.test(input)) return 'relay';
  if (/(终端|控制|console)/.test(input)) return 'console';
  if (/(急救|医疗|cabinet)/.test(input)) return 'cabinet';
  if (/(幸存|证人|survivor)/.test(input)) return 'survivor';
  if (/(闸门|封锁|bulkhead)/.test(input)) return 'bulkhead';
  if (/(逃生|撤离|艇|pod)/.test(input)) return 'escape-pod';
  return 'location';
}

async function decideNpcIntent(session: GameSession, actorId: string) {
  const observation = buildActorObservation(session, actorId);
  return {
    intent: observation.availableActionsHint[0] ?? '观察附近最异常的线索',
    actionType: 'inspect' as ActionType,
    reason: '纯前端演示的本地 NPC 决策'
  };
}

function getItemLabel(session: GameSession, itemId: ItemId) {
  return session.scenario.glossary.itemLabels[itemId] ?? ITEM_LIBRARY[itemId].label;
}

function getTargetLabel(session: GameSession, targetId: string) {
  switch (targetId) {
    case 'locker': return session.world.locations['crew-quarters']?.pointsOfInterest[0] ?? '储物点';
    case 'relay': return session.scenario.glossary.powerNodeLabel;
    case 'console': return session.world.locations['control-room']?.pointsOfInterest[0] ?? '主控终端';
    case 'cabinet': return session.scenario.glossary.cabinetLabel;
    case 'survivor': return session.scenario.glossary.survivorLabel;
    case 'bulkhead': return session.scenario.glossary.gateLabel;
    case 'escape-pod': return session.scenario.glossary.exitVehicleLabel;
    default: return '当前区域';
  }
}

function normalizeStoryGameMode(input: StoryGameMode | undefined): StoryGameMode {
  return input === 'puzzle' || input === 'versus' ? input : 'survival';
}

function normalizeTag(input: string) {
  return ['机械直觉', '战地急救', '危机嗅觉', '幸运星', '冷静', '钢铁意志', '说客', '潜行训练'].includes(input) ? input as WriterRole['coreTag'] : '冷静';
}

function clean(value: unknown, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
