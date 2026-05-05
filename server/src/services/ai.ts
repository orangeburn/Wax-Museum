import {
  ARCHETYPES,
  ITEM_LIBRARY,
  type ActionType,
  type ActorObservation,
  type CountdownPresentation,
  type FilteredAction,
  type GameSession,
  type ItemId,
  type LocationDefinition,
  type LocationId,
  type NarrationPayload,
  type NpcIntentDecision,
  type ParsedAction,
  type Resolution,
  type RoleSettingPack,
  type ScenarioGlossary,
  type SkillKey,
  type StoryBeat,
  type StoryGameMode,
  type StoryNpc,
  type Stats,
  type StoryBible,
  type StoryOutlineRequest,
  type StoryOutlineResponse,
  type StoryScenario,
  type StoryScenarioRequest,
  type WriterDraftRequest,
  type WriterDraftResponse,
  type WriterRole
} from '@wax-museum/shared';
import type { EnginePresentation } from '../engine/session-engine.js';

const FREE_ACTIONS = new Set<ActionType>(['inspect', 'inventory', 'help']);
const DEFAULT_LLM_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_LLM_REQUEST_TIMEOUT_MS = 60_000;
const DEFAULT_LLM_RETRY_COUNT = 3;
const RETRIABLE_HTTP_STATUS = new Set([429, 500, 502, 503, 504]);
export interface AiService {
  intentToAction(session: GameSession, intent: string): Promise<ParsedAction>;
  decideNpcIntent(observation: ActorObservation): Promise<NpcIntentDecision | null>;
  generateStoryOutline(input: StoryOutlineRequest): Promise<StoryOutlineResponse>;
  generateScenario(input: StoryScenarioRequest): Promise<StoryScenario>;
  generateWriterDraft(input: WriterDraftRequest): Promise<WriterDraftResponse>;
  composeNarration(input: {
    session: GameSession;
    filteredAction: FilteredAction;
    resolution: Resolution;
    presentation: EnginePresentation;
  }): Promise<NarrationPayload>;
}

export class LocalAiService implements AiService {
  async intentToAction(session: GameSession, intent: string): Promise<ParsedAction> {
    if (session.scenario.gameplayMode === 'llm' && session.scenario.beats?.length) {
      const beatAware = await parseDynamicIntentWithLlm(session, intent);
      if (beatAware) {
        return beatAware;
      }
    }

    const normalizedIntent = normalizeIntent(intent);
    const type = inferActionType(normalizedIntent);
    const locationId = findLocation(normalizedIntent, session);
    const toolId = findItem(normalizedIntent, session);
    const targetId = findTarget(normalizedIntent, session);

    return {
      type,
      rawIntent: intent,
      normalizedIntent,
      targetId,
      targetLabel: locationId
        ? requireAiLocation(session, locationId).label
        : toolId
          ? getItemLabel(session, toolId)
          : targetId
            ? getTargetLabel(session, targetId)
            : requireAiLocation(session, session.player.locationId).label,
      locationId,
      toolId,
      consumesTurn: !FREE_ACTIONS.has(type)
    };
  }

  async decideNpcIntent(observation: ActorObservation): Promise<NpcIntentDecision | null> {
    if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      return null;
    }

    try {
      const response = await fetchLlmChatCompletions({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${process.env.LLM_API_KEY}`
        },
        body: JSON.stringify({
          model: process.env.LLM_MODEL,
          messages: [
            {
              role: 'system',
              content:
                '你是一个互动悬疑游戏里的 NPC 玩家。你只能根据 observation 里提供的信息行动，不能假设自己知道隐藏剧本、其他人的秘密目标或不可见地点。请输出 JSON 对象，不要 markdown。字段：intent(string), actionType(one of inspect,move,persuade,force,use_item,repair), reason(string)。intent 要像玩家自然语言行动，简短具体。'
            },
            {
              role: 'user',
              content: JSON.stringify({ observation })
            }
          ]
        })
      });

      if (!response.ok) {
        return null;
      }

      const payload = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = payload.choices?.[0]?.message?.content;
      if (!content) {
        return null;
      }

      const parsed = parseWriterDraftContent(content) as Partial<NpcIntentDecision>;
      const intent = typeof parsed.intent === 'string' ? parsed.intent.trim() : '';
      if (!intent) {
        return null;
      }

      return {
        intent,
        actionType: normalizeParsedActionType(parsed.actionType),
        reason: typeof parsed.reason === 'string' ? parsed.reason.trim() : undefined
      };
    } catch {
      return null;
    }
  }

  async generateStoryOutline(input: StoryOutlineRequest): Promise<StoryOutlineResponse> {
    if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('未配置自定义故事生成模型，请检查 .env 中的 LLM_API_KEY 和 LLM_MODEL。');
    }
    return requestStoryOutlineFromLlm(input);
  }

  async generateScenario(input: StoryScenarioRequest): Promise<StoryScenario> {
    const roundCount = normalizeRoundCount(input.roundCount);
    const outline = await this.generateStoryOutline({
      templateId: input.templateId,
      archetypeId: input.archetypeId,
      prompt: input.prompt,
      storyGameMode: input.storyGameMode,
      playerCount: input.playerCount,
      roundCount
    });
    const draft = await this.generateWriterDraft({
      prompt: input.prompt,
      storyGameMode: input.storyGameMode,
      playerCount: input.playerCount,
      roundCount,
      outline
    });
    return draft.scenario;
  }

  async generateWriterDraft(input: WriterDraftRequest): Promise<WriterDraftResponse> {
    const prompt = input.prompt.trim();
    const playerCount = normalizePlayerCount(input.playerCount);
    const roundCount = normalizeRoundCount(input.roundCount);
    const storyGameMode = normalizeStoryGameMode(input.storyGameMode);
    if (!prompt) {
      throw new Error('请先输入一句故事 Prompt。');
    }

    if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('未配置自定义故事生成模型，请检查 .env 中的 LLM_API_KEY 和 LLM_MODEL。');
    }

    const startedAt = Date.now();
    try {
      const outline = input.outline ?? await requestStoryOutlineFromLlm({
        templateId: 'generated-story',
        archetypeId: 'engineer',
        prompt,
        storyGameMode,
        playerCount,
        roundCount
      });
      const generated = await requestWriterDraftFast(prompt, storyGameMode, playerCount, roundCount, outline);
      if (!generated) {
        throw new Error('模型没有返回可用的故事草案。');
      }

      return generated;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const elapsedMs = Date.now() - startedAt;
      console.warn(`[AI] generateWriterDraft fallback after ${elapsedMs}ms: ${message}`);
      return buildFallbackWriterDraft(prompt, storyGameMode, playerCount, roundCount);
    }
  }

  async composeNarration(input: {
    session: GameSession;
    filteredAction: FilteredAction;
    resolution: Resolution;
    presentation: EnginePresentation;
  }): Promise<NarrationPayload> {
    const location = requireAiLocation(input.session, input.session.player.locationId);
    const tone =
      input.resolution.tier === 'success'
        ? '局面终于被你扳回了一寸。'
        : input.resolution.tier === 'cost'
          ? '你硬是把事情往前推了半步，但代价也跟着落下。'
          : '这个故事没有轻易放过你。';

      const systems = [
        input.presentation.systemText,
        ...(input.filteredAction.storyFilterNote ? [input.filteredAction.storyFilterNote] : []),
        ...input.resolution.stateChanges
      ];
    if (input.resolution.roll !== undefined && input.resolution.score !== undefined && input.resolution.difficulty !== undefined) {
      systems.push(
        `判定 ${input.resolution.skill}: ${input.resolution.score} / 难度 ${input.resolution.difficulty} (掷骰 ${input.resolution.roll})`
      );
    }

    return {
      scene: `${tone} ${location.label}里，${input.presentation.publicText}`,
      systems,
      dynamicGuide: input.session.objectives.dynamicGuide
    };
  }
}

async function requestWriterDraftFast(prompt: string, storyGameMode: StoryGameMode, playerCount: number, roundCount: number, outline: StoryOutlineResponse): Promise<WriterDraftResponse> {
  const beatCountHint = inferBeatCountByRoundCount(roundCount);
  const enrichedPrompt = buildCinematicStoryBrief(prompt, storyGameMode, playerCount, roundCount);
  const modeGuide = getStoryGameModeGuide(storyGameMode, roundCount);
  const parsed = await requestLlmObject(
    `你是中文互动悬疑游戏的编剧 agent。你必须严格基于已提供的 storyOutline 生成，不得偏离其核心设定。若用户原始 prompt 很短，你也要主动补出完整戏剧结构：明确人物关系、隐藏秘密、逐步升级的危机、至少一次误导反转，以及带代价的终局选择。请只输出 JSON 对象，不要 markdown，不要解释。JSON 必须包含 bible 和 scenario。bible 必含：title,genre,storyGameMode,playerCountLabel,premise,background,currentCrisis,coreSecret,outline,endings,roles。roles 必须 ${playerCount} 个，每个 role 必含：id,archetypeId,label,publicIdentity,hiddenDrive,relationshipHook,specialty,suggestedTag,suggestedBackground,secretAgenda,settingPack。settingPack 必含：coreBelief,immediateNeed,longTermNeed,stressBehaviors,behaviorPrinciples,actionTendencies,environmentPlaybook(confined/social/highPressure),interactionGuide(trustGain/trustBreak/bargainingChip/tabooTopics)。scenario 必含：title,premise,openingLine,macroObjective,storyGameMode,countdown,glossary,locations,gameplayMode,beats,npcs。gameplayMode 固定 llm。beats 数量要和回合数匹配，目标 beats 数量约为 ${beatCountHint}（允许上下浮动 1），回合少时节奏要更狠更集中，回合多时要允许中段拉出更多试探、误导和角色碰撞。beats 要形成“钩子 -> 试探 -> 升级 -> 误导/反转 -> 对峙/抉择 -> 余波”的节奏。尤其要遵守本局玩法：${modeGuide}。文案全部中文。`,
    { prompt: enrichedPrompt, rawPrompt: prompt, storyGameMode, playerCount, roundCount, beatCountHint, storyOutline: outline }
  ) as { bible?: Partial<StoryBible>; scenario?: Omit<StoryScenario, 'id'> };

  if (!parsed.bible || !parsed.scenario) {
    throw new Error('快速生成未返回完整的 bible + scenario。');
  }

  return normalizeWriterDraft(parsed.bible, parsed.scenario, prompt, storyGameMode, playerCount, roundCount);
}

async function requestStoryOutlineFromLlm(input: StoryOutlineRequest): Promise<StoryOutlineResponse> {
  const archetype = ARCHETYPES.find((entry) => entry.id === input.archetypeId);
  const playerCount = normalizePlayerCount(input.playerCount);
  const roundCount = normalizeRoundCount(input.roundCount);
  const storyGameMode = normalizeStoryGameMode(input.storyGameMode);
  const enrichedPrompt = buildCinematicStoryBrief(input.prompt, storyGameMode, playerCount, roundCount);
  const parsed = await requestLlmObject(
    `你是中文互动悬疑游戏策划。用户可能只给你一句很短的提示词，你必须把它扩写成戏剧性足够强的故事种子。请主动补足：封闭环境或强限制环境、主要矛盾、人物之间的旧关系、隐藏秘密、一次误导性判断、一次强反转，以及带时间压力的开场钩子。还要让故事天然适配本局玩法：${getStoryGameModeGuide(storyGameMode, roundCount)}。只输出 JSON，不要 markdown，不要解释。输出字段：title,premise,twist,secret,openingHook,modeGoal,suggestedBackground,suggestedTags。suggestedTags 返回 1-3 个中文标签。文案中文，篇幅精炼，但信息密度要高。`,
    {
      prompt: enrichedPrompt,
      rawPrompt: input.prompt,
      storyGameMode,
      archetypeId: input.archetypeId,
      playerCount,
      roundCount,
      complexityHint: `总回合 ${roundCount}`
    }
  ) as Partial<StoryOutlineResponse>;

  const fallbackTags = buildSuggestedTags(input.archetypeId, input.prompt);
  const title = typeof parsed.title === 'string' && parsed.title.trim()
    ? parsed.title.trim()
    : `${archetype?.label ?? '角色'} / 临时故事`;

  return {
    title,
    premise: typeof parsed.premise === 'string' && parsed.premise.trim() ? parsed.premise.trim() : '一场封闭危机正在升级。',
    twist: typeof parsed.twist === 'string' && parsed.twist.trim() ? parsed.twist.trim() : '你最信任的人可能在隐瞒关键事实。',
    secret: typeof parsed.secret === 'string' && parsed.secret.trim() ? parsed.secret.trim() : '真相被刻意掩埋。',
    openingHook: typeof parsed.openingHook === 'string' && parsed.openingHook.trim() ? parsed.openingHook.trim() : '灯光骤暗，第一声警报响起。',
    modeGoal: typeof parsed.modeGoal === 'string' && parsed.modeGoal.trim() ? parsed.modeGoal.trim() : getModeGoalText(storyGameMode, roundCount),
    suggestedBackground:
      typeof parsed.suggestedBackground === 'string' && parsed.suggestedBackground.trim()
        ? parsed.suggestedBackground.trim()
        : `你曾因为 ${input.prompt.trim()} 被卷入这场故事。`,
    suggestedTags:
      Array.isArray(parsed.suggestedTags) && parsed.suggestedTags.length
        ? parsed.suggestedTags.map((entry) => String(entry).trim()).filter(Boolean).slice(0, 3)
        : fallbackTags
  };
}

async function parseDynamicIntentWithLlm(session: GameSession, intent: string): Promise<ParsedAction | null> {
  if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    return null;
  }

  const currentBeat = session.scenario.beats?.[session.world.storyBeatIndex ?? 0];
  if (!currentBeat) {
    return null;
  }

  try {
    const response = await fetchLlmChatCompletions({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        messages: [
          {
            role: 'system',
            content:
              '你是互动剧情里的行动解析器。请把玩家的自然语言意图转换成 JSON，不要解释，不要 markdown。只输出一个对象。字段必须包含：matchesCurrentBeat(boolean), actionType, locationId, targetLabel, toolId, targetId, dynamicBeatId, reason。目标是判断玩家这句话是否在推进当前关键节点。如果玩家只是换一种自然表达，但本质上在执行当前节点，也要判定为 matchesCurrentBeat=true，并把 actionType/locationId/targetLabel/dynamicBeatId 对齐到当前节点。若只是移动，actionType 可为 move。若看不出来，matchesCurrentBeat=false，并尽量给出最可能的 actionType/locationId/targetLabel。'
          },
          {
            role: 'user',
            content: JSON.stringify({
              currentLocationId: session.player.locationId,
              currentLocationLabel: requireAiLocation(session, session.player.locationId).label,
              inventory: session.player.inventory.map((itemId) => ({
                itemId,
                label: getItemLabel(session, itemId)
              })),
              currentBeat,
              locations: Object.values(session.world.locations).map((location) => ({
                id: location.id,
                label: location.label,
                pointsOfInterest: location.pointsOfInterest,
                connected: location.connected
              })),
              playerIntent: intent,
              playerSettingPack: session.player.settingPack ?? null,
              npcInteractionBriefs: (session.scenario.npcs ?? []).map((npc) => ({
                name: npc.name,
                attitude: npc.attitude,
                motiveAnchor: npc.motiveAnchor ?? npc.hiddenDrive,
                interactionTips: npc.interactionTips ?? []
              }))
            })
          }
        ]
      })
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content;
    if (!content) {
      return null;
    }

    const parsed = parseWriterDraftContent(content) as {
      matchesCurrentBeat?: boolean;
      actionType?: ActionType;
      locationId?: string;
      targetLabel?: string;
      toolId?: string | null;
      targetId?: string | null;
      dynamicBeatId?: string | null;
    };

    const normalizedIntent = normalizeIntent(intent);
    const locationId =
      parsed.matchesCurrentBeat && currentBeat.locationId
        ? currentBeat.locationId
        : typeof parsed.locationId === 'string' && session.world.locations[parsed.locationId]
          ? parsed.locationId
          : findLocation(normalizedIntent, session);
    const toolId = normalizeParsedItemId(parsed.toolId) ?? findItem(normalizedIntent, session);
    const actionType = parsed.matchesCurrentBeat && currentBeat.actionType ? currentBeat.actionType : normalizeParsedActionType(parsed.actionType) ?? inferActionType(normalizedIntent);
    const targetLabel =
      parsed.matchesCurrentBeat && currentBeat.targetLabel
        ? currentBeat.targetLabel
        : typeof parsed.targetLabel === 'string' && parsed.targetLabel.trim()
          ? parsed.targetLabel.trim()
          : locationId
            ? requireAiLocation(session, locationId).label
            : requireAiLocation(session, session.player.locationId).label;

    return {
      type: actionType,
      rawIntent: intent,
      normalizedIntent,
      dynamicBeatId: parsed.matchesCurrentBeat ? currentBeat.id : typeof parsed.dynamicBeatId === 'string' ? parsed.dynamicBeatId : undefined,
      targetId: typeof parsed.targetId === 'string' ? parsed.targetId : undefined,
      targetLabel,
      locationId,
      toolId,
      consumesTurn: !FREE_ACTIONS.has(actionType)
    };
  } catch {
    return null;
  }
}

function inferActionType(normalizedIntent: string): ActionType {
  if (!normalizedIntent) return 'help';
  if (/(背包|物品|inventory)/.test(normalizedIntent)) return 'inventory';
  if (/(帮助|提示|怎么办|help)/.test(normalizedIntent)) return 'help';
  if (/(使用|刷卡|启动|发射|吃|喝|掏出|拿出|亮出|举起|用|use|launch)/.test(normalizedIntent)) return 'use_item';
  if (/(修|维修|重启|接线|fix|repair|校准|稳定)/.test(normalizedIntent)) return 'repair';
  if (/(砸|撬|撞开|强行|force|break|突入)/.test(normalizedIntent)) return 'force';
  if (/(说服|安抚|交谈|聊天|persuade|talk)/.test(normalizedIntent)) return 'persuade';
  if (/(去|前往|移动|进入|赶往|move|go)/.test(normalizedIntent)) return 'move';
  return 'inspect';
}

function findLocation(normalizedIntent: string, session: GameSession): LocationId | undefined {
  for (const locationId of Object.keys(session.world.locations) as LocationId[]) {
    const location = session.world.locations[locationId];
    if (!location) {
      continue;
    }
    if ([location.label, ...location.pointsOfInterest].some((entry) => normalizedIntent.includes(entry.toLowerCase()))) {
      return locationId;
    }
  }

  const fallbackKeywords = buildLocationKeywordMap(session);

  for (const [id, keywords] of fallbackKeywords) {
    if (keywords.some((keyword) => normalizedIntent.includes(keyword))) {
      return id;
    }
  }

  return undefined;
}

function findItem(normalizedIntent: string, session: GameSession): ItemId | undefined {
  for (const [itemId, label] of Object.entries(session.scenario.glossary.itemLabels) as Array<[ItemId, string]>) {
    if (normalizedIntent.includes(label.toLowerCase())) {
      return itemId;
    }
  }

  const fallbackKeywords: Array<[ItemId, string[]]> = [
    ['insulated-wrench', ['工具', '扳手', '维修器具', '钥匙']],
    ['captain-keycard', ['钥匙卡', '通行物', '凭证', '徽章']],
    ['medkit', ['急救包', '药包', '医疗箱']],
    ['oxygen-canister', ['氧气', '呼吸', '补给', '提神']],
    ['sealant-foam', ['泡沫', '密封', '封堵材料', '稳定剂']]
  ];

  for (const [id, keywords] of fallbackKeywords) {
    if (keywords.some((keyword) => normalizedIntent.includes(keyword))) {
      return id;
    }
  }

  return undefined;
}

function findTarget(normalizedIntent: string, session: GameSession): string | undefined {
  const dynamicBeatTarget = session.scenario.beats?.[session.world.storyBeatIndex ?? 0]?.targetLabel;
  const targets: Array<[string, string[]]> = [
    ['cabinet', [session.scenario.glossary.cabinetLabel, '急救柜', '补给柜', '药柜', '档案柜']],
    ['locker', [getFirstPoi(session, 'crew-quarters', '储物柜'), '储物柜', '工具柜', '行李柜']],
    ['relay', [session.scenario.glossary.powerNodeLabel, '主继电器', '动力节点', '核心装置', '锅炉', '主机']],
    ['console', [getFirstPoi(session, 'control-room', '主控终端'), '主控终端', '终端', '控制台', '书桌']],
    ['survivor', [session.scenario.glossary.survivorLabel, '幸存者', '目击者', '管家', '证人']],
    ['bulkhead', [session.scenario.glossary.gateLabel, '封闭闸门', '闸门', '封锁门', '铁门']],
    ['escape-pod', [session.scenario.glossary.exitVehicleLabel, '逃生艇', '出口', '撤离装置', '雪地车']],
    ['self', ['自己', '我自己']]
  ];

  if (dynamicBeatTarget) {
    targets.unshift(['location', [dynamicBeatTarget]]);
  }

  for (const [id, entries] of targets) {
    if (entries.filter((entry): entry is string => Boolean(entry)).some((entry) => normalizedIntent.includes(entry.toLowerCase()))) {
      return id;
    }
  }

  return session.world.locations[session.player.locationId]?.pointsOfInterest[0] ?? undefined;
}

function normalizeIntent(intent: string) {
  return intent.trim().toLowerCase();
}

function normalizeParsedActionType(value: unknown): ActionType | undefined {
  return ['inspect', 'inventory', 'help', 'move', 'repair', 'force', 'use_item', 'persuade'].includes(String(value))
    ? (value as ActionType)
    : undefined;
}

function normalizeParsedItemId(value: unknown): ItemId | undefined {
  return ['insulated-wrench', 'captain-keycard', 'medkit', 'oxygen-canister', 'sealant-foam'].includes(String(value))
    ? (value as ItemId)
    : undefined;
}

function buildSuggestedTags(archetypeId: string, prompt: string) {
  const suggestions = new Set<string>();
  if (/(调查|冷静|分析|真相|记录|线索|破案)/.test(prompt)) suggestions.add('冷静');
  if (/(安抚|沟通|救援|照料|医护|审问)/.test(prompt)) suggestions.add('说客');
  if (/(突入|冲撞|护送|安保|硬闯|追捕)/.test(prompt)) suggestions.add('钢铁意志');
  if (/(躲避|潜入|逃跑|绕路|幸存|藏匿)/.test(prompt)) suggestions.add('潜行训练');
  if (suggestions.size === 0) {
    if (archetypeId === 'engineer') suggestions.add('冷静');
    if (archetypeId === 'medic') suggestions.add('说客');
    if (archetypeId === 'security') suggestions.add('钢铁意志');
    if (archetypeId === 'passenger') suggestions.add('潜行训练');
  }
  return Array.from(suggestions).slice(0, 2);
}

function inferStoryGenre(prompt: string) {
  if (/(校园|学生|社团|宿舍|毕业)/.test(prompt)) return '校园悬疑';
  if (/(医院|诊所|手术|病房|急救)/.test(prompt)) return '医疗危机悬疑';
  if (/(邮轮|列车|航班|潜艇|游轮|客轮)/.test(prompt)) return '交通工具封闭空间悬疑';
  if (/(豪宅|山庄|别墅|古堡|宅邸)/.test(prompt)) return '密室群像悬疑';
  if (/(实验|研究所|实验室|项目|样本)/.test(prompt)) return '科技阴谋悬疑';
  return '封闭空间悬疑';
}

function normalizeStoryGameMode(input: unknown): StoryGameMode {
  if (input === 'puzzle' || input === 'versus') {
    return input;
  }
  return 'survival';
}

function getStoryGameModeGuide(storyGameMode: StoryGameMode, roundCount: number) {
  if (storyGameMode === 'puzzle') {
    return `解谜模式：玩家需要合作，在约 ${roundCount} 回合内拼出真相、破解结构性谜题并逃出生天。`;
  }
  if (storyGameMode === 'versus') {
    return '对抗模式：不限制回合数，角色之间要有强烈利益冲突、欺骗、抢资源和淘汰压力，最后只应有一名胜者或一个胜利阵营。';
  }
  return `生存模式：玩家需要在约 ${roundCount} 回合内熬过环境、资源和人际压力，能活到最后的玩家都算胜利。`;
}

function getModeGoalText(storyGameMode: StoryGameMode, roundCount: number) {
  if (storyGameMode === 'puzzle') {
    return `在 ${roundCount} 回合内合作解开核心谜题并找到逃生路径。`;
  }
  if (storyGameMode === 'versus') {
    return '想办法把别人逼到绝境，成为最后留下的人。';
  }
  return `在 ${roundCount} 回合内撑过危机并尽可能活下来。`;
}

function getModeMacroObjective(storyGameMode: StoryGameMode) {
  if (storyGameMode === 'puzzle') {
    return '合作拼出真相，解开关键谜题，并在局势崩溃前找到逃生方式。';
  }
  if (storyGameMode === 'versus') {
    return '利用资源、谎言和时机压倒其他竞争者，成为最后留下的人。';
  }
  return '在资源耗尽与危机升级前保住性命，撑到结局。';
}

function getModeEndings(storyGameMode: StoryGameMode) {
  if (storyGameMode === 'puzzle') {
    return ['所有人合作破局并逃出生天', '带着不完整的真相侥幸脱身', '谜题被解开时，逃生窗口已经关闭'];
  }
  if (storyGameMode === 'versus') {
    return ['你踩着所有对手留下来', '你和另一名对手勉强形成脆弱同盟', '所有人都把局面拖进同归于尽'];
  }
  return ['带着真相活下来', '活着撑到终点但代价惨重', '有人存活，但这个故事已经吞掉了太多东西'];
}

function inferStorySpace(prompt: string) {
  if (/(暴风雪|雪山|山庄)/.test(prompt)) return '与外界隔绝的风雪据点';
  if (/(海|潜艇|邮轮|游轮|客轮)/.test(prompt)) return '无法立刻撤离的水上或水下空间';
  if (/(医院|病房|诊所)/.test(prompt)) return '秩序严密却信息失真的医疗空间';
  if (/(学校|校园|宿舍)/.test(prompt)) return '熟人社会里的半封闭场域';
  return '出口受限、通信不稳、人人被迫留在现场的封闭区域';
}

function inferCoreConflict(prompt: string) {
  if (/(失踪|消失|下落不明)/.test(prompt)) return '有人失踪，但每个人都声称自己在保护真相';
  if (/(事故|爆炸|坠落|沉没|火灾)/.test(prompt)) return '一场事故究竟是意外还是人为安排';
  if (/(遗产|继承|股份|合同)/.test(prompt)) return '利益分配引爆旧关系，真话反而最危险';
  if (/(复仇|报复|旧案|真相)/.test(prompt)) return '旧案受害者与既得利益者终于在同一空间正面碰撞';
  return '表面目标是求生或破案，真实冲突却是彼此都在掩护不同秘密';
}

function inferTwistDirection(prompt: string) {
  if (/(家人|恋人|朋友|搭档|同伴)/.test(prompt)) return '最值得信任的人其实提前知道关键真相，但隐瞒动机并不单纯邪恶';
  if (/(调查|记者|记录|证据)/.test(prompt)) return '最有说服力的证据是被人刻意摆出来误导你的';
  if (/(救援|医生|保安|警卫|安保)/.test(prompt)) return '名义上维持秩序的人，恰恰在决定谁有资格接近真相';
  return '真正的幕后推手未必亲自作恶，但一直在操控叙事和时间差';
}

function inferCountdownPressure(prompt: string, roundCount: number) {
  if (/(毒|病|感染|手术|失血)/.test(prompt)) return `有人状态正在恶化，约 ${roundCount} 轮内必须做出错误也得承担的决定`;
  if (/(海|潜艇|邮轮|游轮|列车|航班)/.test(prompt)) return `交通工具或环境正在失控，约 ${roundCount} 轮内窗口就会彻底关闭`;
  if (/(停电|风暴|暴风雪|封锁|警报)/.test(prompt)) return `外部环境持续恶化，约 ${roundCount} 轮内资源与退路都会被压缩`;
  return `时间站在真相的对立面，约 ${roundCount} 轮内必须在揭露、保命、牺牲之间做选择`;
}

async function requestLlmObject(systemPrompt: string, userPayload: unknown): Promise<unknown> {
  const response = await fetchLlmChatCompletions({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`上游接口返回 ${response.status}${text ? `: ${text}` : ''}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('上游接口没有返回 message.content。');
  }

  return parseLlmJsonWithRepair(content);
}

async function parseLlmJsonWithRepair(content: string): Promise<unknown> {
  try {
    return parseWriterDraftContent(content);
  } catch (firstError) {
    const repaired = await requestJsonRepairFromLlm(content);
    try {
      return parseWriterDraftContent(repaired);
    } catch (secondError) {
      const firstMessage = firstError instanceof Error ? firstError.message : String(firstError);
      const secondMessage = secondError instanceof Error ? secondError.message : String(secondError);
      throw new Error(`模型输出 JSON 修复失败：初次错误：${firstMessage}；修复后错误：${secondMessage}`);
    }
  }
}

async function requestJsonRepairFromLlm(brokenContent: string): Promise<string> {
  const response = await fetchLlmChatCompletions({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY}`
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL,
      messages: [
        {
          role: 'system',
          content:
            '你是 JSON 修复器。用户会给你一段不合法 JSON。请输出修复后的合法 JSON，保持原有字段语义，不要解释，不要 markdown，不要多余文本。'
        },
        {
          role: 'user',
          content: brokenContent
        }
      ]
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`JSON 修复请求失败 ${response.status}${text ? `: ${text}` : ''}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('JSON 修复请求未返回内容。');
  }

  return content;
}

async function fetchLlmChatCompletions(init: RequestInit): Promise<Response> {
  const url = `${getLlmBaseUrl()}/chat/completions`;
  const timeoutMs = getLlmTimeoutMs();
  const retryCount = getLlmRetryCount();
  let lastError: unknown = null;
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!shouldRetryHttpResponse(response.status) || attempt === retryCount) {
        return response;
      }
      lastResponse = response;
      await waitMs(getRetryDelayMs(attempt, response));
    } catch (error) {
      lastError = error;
      if (!isRetriableNetworkError(error) || attempt === retryCount) {
        break;
      }
      await waitMs(getRetryDelayMs(attempt));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  if (lastResponse) {
    return lastResponse;
  }
  throw new Error(buildNetworkFailureMessage(url, lastError, timeoutMs));
}

function shouldRetryHttpResponse(status: number) {
  return RETRIABLE_HTTP_STATUS.has(status);
}

function getRetryDelayMs(attempt: number, response?: Response) {
  const retryAfterMs = parseRetryAfterMs(response?.headers.get('retry-after'));
  if (retryAfterMs !== null) {
    return retryAfterMs;
  }

  const baseDelay = 500;
  const cappedExponentialDelay = Math.min(8_000, baseDelay * 2 ** attempt);
  const jitter = Math.floor(Math.random() * 250);
  return cappedExponentialDelay + jitter;
}

function parseRetryAfterMs(raw: string | null | undefined) {
  if (!raw) {
    return null;
  }

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(30_000, Math.round(seconds * 1_000));
  }

  const asDate = Date.parse(raw);
  if (Number.isNaN(asDate)) {
    return null;
  }

  return Math.max(0, Math.min(30_000, asDate - Date.now()));
}

function getLlmBaseUrl() {
  const configured = process.env.LLM_BASE_URL?.trim() || DEFAULT_LLM_BASE_URL;
  return configured.replace(/\/+$/, '');
}

function getLlmTimeoutMs() {
  const configured = Number(process.env.LLM_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured < 5_000) {
    return DEFAULT_LLM_REQUEST_TIMEOUT_MS;
  }
  return Math.round(configured);
}

function getLlmRetryCount() {
  const configured = Number(process.env.LLM_RETRY_COUNT);
  if (!Number.isFinite(configured) || configured < 0) {
    return DEFAULT_LLM_RETRY_COUNT;
  }
  return Math.min(10, Math.floor(configured));
}

function waitMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableNetworkError(error: unknown) {
  if (!(error instanceof Error)) {
    return false;
  }

  if (error.name === 'AbortError') {
    return true;
  }

  if (error.message === 'fetch failed') {
    return true;
  }

  const causeCode = getErrorCauseCode(error);
  return ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN'].includes(causeCode);
}

function getErrorCauseCode(error: Error) {
  const cause = (error as Error & { cause?: unknown }).cause;
  if (!cause || typeof cause !== 'object' || !('code' in cause)) {
    return '';
  }
  return String((cause as { code?: string }).code ?? '');
}

function buildNetworkFailureMessage(url: string, error: unknown, timeoutMs: number) {
  if (!(error instanceof Error)) {
    return `调用上游模型失败（${url}）：未知网络错误`;
  }

  if (error.name === 'AbortError') {
    return `调用上游模型超时（>${timeoutMs}ms）：${url}`;
  }

  const causeMessage =
    typeof (error as Error & { cause?: unknown }).cause === 'object' && (error as Error & { cause?: { message?: string } }).cause?.message
      ? ` / ${(error as Error & { cause?: { message?: string } }).cause?.message}`
      : '';
  return `调用上游模型失败：${error.message}${causeMessage}（${url}）`;
}

function normalizeWriterDraft(
  bibleInput: Partial<StoryBible>,
  scenarioInput: Omit<StoryScenario, 'id'>,
  prompt: string,
  storyGameMode: StoryGameMode,
  expectedRoleCount: number,
  roundCount: number
): WriterDraftResponse {
  const normalizedRoles = normalizeRoles(bibleInput.roles, expectedRoleCount, prompt);
  const normalizedOutline = normalizeTextList(bibleInput.outline);
  const normalizedEndings = normalizeTextList(bibleInput.endings);
  const fallback = buildFallbackWriterDraft(prompt, storyGameMode, expectedRoleCount, roundCount);

  return {
    bible: {
      title: asString(bibleInput.title) || fallback.bible.title,
      genre: asString(bibleInput.genre) || fallback.bible.genre,
      storyGameMode: bibleInput.storyGameMode ? normalizeStoryGameMode(bibleInput.storyGameMode) : storyGameMode,
      playerCountLabel: asString(bibleInput.playerCountLabel) || `${expectedRoleCount}人`,
      premise: asString(bibleInput.premise) || fallback.bible.premise,
      background: asString(bibleInput.background) || fallback.bible.background,
      currentCrisis: asString(bibleInput.currentCrisis) || fallback.bible.currentCrisis,
      coreSecret: asString(bibleInput.coreSecret) || fallback.bible.coreSecret,
      outline: normalizedOutline.length >= 3 ? normalizedOutline : fallback.bible.outline,
      endings: normalizedEndings.length >= 1 ? normalizedEndings : fallback.bible.endings,
      roles: normalizedRoles
    },
    scenario: normalizeScenario(scenarioInput, bibleInput, storyGameMode, roundCount)
  };
}

function parseWriterDraftContent(content: string) {
  try {
    return JSON.parse(content);
  } catch {
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) {
      return JSON.parse(fenced);
    }

    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return JSON.parse(content.slice(start, end + 1));
    }

    throw new Error('LLM did not return valid JSON content.');
  }
}

function normalizeRoles(input: StoryBible['roles'] | undefined, expectedCount: number, prompt: string) {
  const roles = (Array.isArray(input) ? input : [])
    .slice(0, expectedCount)
    .map((entry, index) => normalizeRole(entry, index))
    .filter(
      (entry): entry is WriterRole =>
        Boolean(
          entry?.id &&
            entry?.label &&
            entry?.publicIdentity &&
            entry?.hiddenDrive &&
            entry?.relationshipHook &&
            entry?.specialty &&
            entry?.suggestedTag &&
            entry?.suggestedBackground &&
            entry?.coreTag &&
            entry?.secretAgenda
        )
    );
  if (roles.length >= expectedCount) {
    return roles;
  }
  const padded = [...roles];
  for (let index = padded.length; index < expectedCount; index += 1) {
    padded.push(buildFallbackRole(index, prompt));
  }
  return padded;
}

function buildCinematicStoryBrief(prompt: string, storyGameMode: StoryGameMode, playerCount: number, roundCount: number) {
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim();
  const compactPrompt = normalizedPrompt || '一场被遮掩的事故';
  const inferredGenre = inferStoryGenre(compactPrompt);
  const inferredSpace = inferStorySpace(compactPrompt);
  const inferredConflict = inferCoreConflict(compactPrompt);
  const inferredTwist = inferTwistDirection(compactPrompt);
  const inferredCountdown = inferCountdownPressure(compactPrompt, roundCount);
  const intensity = normalizedPrompt.length <= 10 ? '用户输入很短，请主动扩写并补足细节。' : '在保留用户意图的前提下继续增强戏剧浓度。';

  return [
    `原始提示词：${compactPrompt}`,
    `建议题材：${inferredGenre}`,
    `建议空间：${inferredSpace}`,
    `核心冲突：${inferredConflict}`,
    `反转方向：${inferredTwist}`,
    `倒计时压力：${inferredCountdown}`,
    `玩法模式：${getStoryGameModeGuide(storyGameMode, roundCount)}`,
    `角色规模：${playerCount}人，多给彼此牵制、旧怨、利益交换和误会。`,
    `节奏要求：总回合约 ${roundCount}，前半段抛钩子和假线索，中段升级冲突，后段揭露真相并逼出代价性选择。`,
    '写法要求：避免只有设定没有事件，必须让每一幕都能推动局势变化，并让角色私欲和主线真相互相碰撞。',
    intensity
  ].join('\n');
}

function normalizeRole(input: Partial<WriterRole> | undefined, index: number): WriterRole | null {
  if (!input?.label || !input.publicIdentity || !input.hiddenDrive || !input.relationshipHook || !input.specialty) {
    return null;
  }

  const mechanics = buildRoleMechanics(input);
  return {
    id: input.id?.trim() || `role-${index + 1}`,
    archetypeId: input.archetypeId?.trim() || slugifyRoleId(input.label, index),
    label: input.label.trim(),
    publicIdentity: input.publicIdentity.trim(),
    hiddenDrive: input.hiddenDrive.trim(),
    relationshipHook: input.relationshipHook.trim(),
    specialty: input.specialty.trim(),
    suggestedTag: typeof input.suggestedTag === 'string' && input.suggestedTag.trim() ? input.suggestedTag.trim() : mechanics.coreTag,
    suggestedBackground:
      typeof input.suggestedBackground === 'string' && input.suggestedBackground.trim()
        ? input.suggestedBackground.trim()
        : `你不是为了旁观而来到这里。${input.hiddenDrive.trim()}`,
    stats: mechanics.stats,
    startingItems: mechanics.startingItems,
    coreTag: mechanics.coreTag,
    secretAgenda: normalizeSecretAgenda(input.secretAgenda, input),
    settingPack: normalizeSettingPack(input.settingPack, input)
  };
}

function buildFallbackWriterDraft(prompt: string, storyGameMode: StoryGameMode, playerCount: number, roundCount: number): WriterDraftResponse {
  const roles = Array.from({ length: playerCount }, (_, index) => buildFallbackRole(index, prompt));
  const title = buildFallbackTitle(prompt);
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim() || '一场被遮掩的事故';
  const conflict = inferCoreConflict(normalizedPrompt);
  const twist = inferTwistDirection(normalizedPrompt);
  const countdownPressure = inferCountdownPressure(normalizedPrompt, roundCount);
  const premise = `你们因“${normalizedPrompt}”被卷入同一场封闭危机，${conflict}。`;
  const scenarioInput: Omit<StoryScenario, 'id'> = {
    title,
    premise,
    storyGameMode,
    openingLine: `警报响起后，所有退路都在迅速关闭，而${countdownPressure}。`,
    macroObjective: getModeMacroObjective(storyGameMode),
    countdown: {
      label: '剩余行动步数',
      shortLabel: '步数',
      max: 12,
      recoverLabel: '步数'
    },
    gameplayMode: 'llm',
    beats: [],
    npcs: [],
    glossary: normalizeGlossary(undefined),
    locations: buildFallbackLocations()
  };

  return {
    bible: {
      title,
      genre: inferStoryGenre(normalizedPrompt),
      storyGameMode,
      playerCountLabel: `${playerCount}人`,
      premise,
      background: `围绕“${normalizedPrompt}”的旧事从未真正结束，所有在场者都和那次失衡有或深或浅的关系。`,
      currentCrisis: `通讯中断、出口受限，而${countdownPressure}。`,
      coreSecret: twist,
      outline: ['开场异常迫使所有人表态', '沿着假线索试探彼此立场', '旧关系和隐瞒开始反噬现场', '反转暴露真正的动机与代价', '在时限内执行终局决策'],
      endings: getModeEndings(storyGameMode),
      roles
    },
    scenario: normalizeScenario(scenarioInput, undefined, storyGameMode, roundCount)
  };
}

function buildFallbackRole(index: number, prompt: string): WriterRole {
  const tagCycle: WriterRole['coreTag'][] = ['冷静', '说客', '钢铁意志', '潜行训练', '机械直觉', '危机嗅觉'];
  const coreTag = tagCycle[index % tagCycle.length] ?? '冷静';
  const mechanics = mechanicsByTag(coreTag);
  const normalizedPrompt = prompt.replace(/\s+/g, ' ').trim() || '这场危机';
  const personas = [
    {
      label: '现场工程顾问',
      publicIdentity: '你以设备检修顾问的身份被临时召入现场。',
      hiddenDrive: `你怀疑“${normalizedPrompt}”并非意外，想找出被改写的技术记录。`,
      relationshipHook: '你曾和现场的一名核心成员共同处理过一次被压下的事故。',
      specialty: '拆解系统异常并重建关键时序'
    },
    {
      label: '危机沟通协调员',
      publicIdentity: '你负责稳定情绪、协调现场信息与指令传达。',
      hiddenDrive: `你收到匿名警告，称“${normalizedPrompt}”背后有人刻意带节奏。`,
      relationshipHook: '你和某位当事人有旧日互助关系，对方可能只信你。',
      specialty: '高压对话、关系破冰与信息套取'
    },
    {
      label: '外聘安保主管',
      publicIdentity: '你名义上负责封控和秩序维持。',
      hiddenDrive: `你要确认“${normalizedPrompt}”中的关键目标是否被人提前转移。`,
      relationshipHook: '你掌握一份内部通行名单，但名单上有一个不该出现的名字。',
      specialty: '高风险突入、压制冲突与路线控制'
    },
    {
      label: '隐秘调查记者',
      publicIdentity: '你以普通参与者身份进入现场，暗中记录每个异常细节。',
      hiddenDrive: `你追查“${normalizedPrompt}”已久，想拿到能公开的决定性证据。`,
      relationshipHook: '你曾采访过相关旧案幸存者，对方留下过一句警告。',
      specialty: '隐蔽观察、证据串联与叙事反推'
    },
    {
      label: '系统审计分析师',
      publicIdentity: '你受邀核对流程和日志，排查责任链路。',
      hiddenDrive: `你发现“${normalizedPrompt}”的审计链存在人为断层，必须确认篡改源头。`,
      relationshipHook: '你与某位负责人曾在不同立场下交锋过，对方对你高度戒备。',
      specialty: '日志复盘、异常建模与风险推演'
    },
    {
      label: '应急医疗支援',
      publicIdentity: '你负责现场急救与压力状态评估。',
      hiddenDrive: `你察觉“${normalizedPrompt}”中的伤情分布不合常理，怀疑有人提前布局。`,
      relationshipHook: '你救过现场某人一命，对方欠你一个不能公开的人情。',
      specialty: '伤情判断、压力干预与关键照护'
    }
  ] as const;
  const base = personas[index % personas.length] ?? personas[0];
  const startingItemByPersona: ItemId[] = (() => {
    if (/医疗|急救|医护/.test(base.label)) return ['medkit'];
    if (/工程|系统|审计/.test(base.label)) return ['sealant-foam'];
    if (/沟通|调查/.test(base.label)) return ['oxygen-canister'];
    return mechanics.startingItems;
  })();

  return {
    id: `role-${index + 1}`,
    archetypeId: `generated-role-${index + 1}`,
    label: base.label,
    publicIdentity: base.publicIdentity,
    hiddenDrive: base.hiddenDrive,
    relationshipHook: base.relationshipHook,
    specialty: base.specialty,
    suggestedTag: coreTag,
    suggestedBackground: `你因为“${normalizedPrompt}”再次回到这个局里，这次不打算空手而归。`,
    stats: mechanics.stats,
    startingItems: startingItemByPersona,
    coreTag,
    secretAgenda: normalizeSecretAgenda(undefined, {
      label: base.label,
      hiddenDrive: base.hiddenDrive,
      relationshipHook: base.relationshipHook,
      specialty: base.specialty
    }),
    settingPack: normalizeSettingPack(undefined, {
      label: base.label,
      hiddenDrive: base.hiddenDrive,
      relationshipHook: base.relationshipHook,
      specialty: base.specialty
    })
  };
}

function buildFallbackTitle(prompt: string) {
  const normalized = prompt.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '封锁现场 / 临时剧本';
  }
  if (normalized.length <= 8) {
    return `${normalized}疑云`;
  }
  return `${normalized.slice(0, 18)} / 临时剧本`;
}

function normalizeSecretAgenda(
  input: unknown,
  role: Pick<WriterRole, 'label' | 'hiddenDrive' | 'relationshipHook' | 'specialty'> | Partial<WriterRole>
): WriterRole['secretAgenda'] {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const triggerKeywords = Array.isArray(raw.triggerKeywords)
    ? raw.triggerKeywords.map((entry) => asString(entry)).filter(Boolean).slice(0, 4)
    : [];
  const label = asString(role.label) || '这个角色';
  const hiddenDrive = asString(role.hiddenDrive) || '你还有一件不能公开的事情要完成。';
  const relationshipHook = asString(role.relationshipHook) || '';
  const specialty = asString(role.specialty) || '你擅长从混乱里找到突破口。';

  return {
    title: asString(raw.title) || `${label}的私密任务`,
    description: asString(raw.description) || `${hiddenDrive} 你需要在脱身前留下属于自己的结果。`,
    successHint: asString(raw.successHint) || `尝试围绕“${relationshipHook || specialty}”采取行动。`,
    triggerKeywords: triggerKeywords.length ? triggerKeywords : buildSecretAgendaKeywords({ hiddenDrive, relationshipHook, specialty }),
    requiredProgress:
      typeof raw.requiredProgress === 'number' && Number.isFinite(raw.requiredProgress)
        ? clampNumber(raw.requiredProgress, 1, 3)
        : 2
  };
}

function normalizeSettingPack(input: unknown, role: Partial<WriterRole>): RoleSettingPack {
  const raw = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const hiddenDrive = asString(role.hiddenDrive) || '你有不能公开的真实企图。';
  const specialty = asString(role.specialty) || '你习惯先观察再出手。';
  const label = asString(role.label) || '该角色';
  const relationshipHook = asString(role.relationshipHook) || '你与现场某人有旧关联。';
  const env = raw.environmentPlaybook && typeof raw.environmentPlaybook === 'object'
    ? (raw.environmentPlaybook as Record<string, unknown>)
    : {};
  const guide = raw.interactionGuide && typeof raw.interactionGuide === 'object'
    ? (raw.interactionGuide as Record<string, unknown>)
    : {};

  return {
    coreBelief: asString(raw.coreBelief) || `${label}相信信息差比蛮力更能改变结局。`,
    immediateNeed: asString(raw.immediateNeed) || '先稳住当前局势，避免局面提前崩塌。',
    longTermNeed: asString(raw.longTermNeed) || hiddenDrive,
    stressBehaviors: normalizeStringList(raw.stressBehaviors, 2, ['在压力下会重复确认退路', `会优先使用${specialty}争取主动`]),
    behaviorPrinciples: normalizeStringList(raw.behaviorPrinciples, 3, ['先保全筹码', '避免无收益冲突', '优先处理可验证线索']),
    actionTendencies: normalizeStringList(raw.actionTendencies, 3, ['先观察后决策', '优先小步试探', '保留底牌再推进']),
    environmentPlaybook: {
      confined: asString(env.confined) || '在封闭空间优先控住出入口和节奏。',
      social: asString(env.social) || `在社交场景围绕“${relationshipHook}”交换信息。`,
      highPressure: asString(env.highPressure) || '高压下先保命与控时，再做关键抉择。'
    },
    interactionGuide: {
      trustGain: asString(guide.trustGain) || '先给可验证的小信息，再索取关键反馈。',
      trustBreak: asString(guide.trustBreak) || '公开羞辱或强行逼供会迅速破坏信任。',
      bargainingChip: asString(guide.bargainingChip) || specialty,
      tabooTopics: normalizeStringList(guide.tabooTopics, 2, ['真实动机', '旧案责任'])
    }
  };
}

function normalizeStringList(input: unknown, minCount: number, fallback: string[]): string[] {
  const entries = Array.isArray(input) ? input.map((entry) => asString(entry)).filter(Boolean) : [];
  if (entries.length >= minCount) {
    return entries.slice(0, 8);
  }
  return fallback.slice(0, Math.max(minCount, fallback.length));
}

function buildSecretAgendaKeywords(role: Pick<WriterRole, 'hiddenDrive' | 'relationshipHook' | 'specialty'>) {
  const source = `${role.hiddenDrive} ${role.relationshipHook} ${role.specialty}`;
  const matches = source.match(/[\u4e00-\u9fa5A-Za-z0-9]{2,8}/g) ?? [];
  return Array.from(new Set(matches)).slice(0, 4).filter((entry) => entry.length >= 2);
}

function buildRoleMechanics(input: Partial<WriterRole>): { stats: Stats; startingItems: ItemId[]; coreTag: WriterRole['coreTag'] } {
  const suggestedTag = typeof input.suggestedTag === 'string' ? input.suggestedTag.trim() : '';
  if (isTagId(suggestedTag)) {
    return mechanicsByTag(suggestedTag);
  }

  const source = `${input.label ?? ''} ${input.specialty ?? ''} ${input.publicIdentity ?? ''} ${input.hiddenDrive ?? ''}`;
  if (/(医生|医护|法医|治疗|急救|心理|护士)/.test(source)) return mechanicsByTag('战地急救');
  if (/(工程|设备|维修|检修|机电|审计|系统|控制|终端|线路)/.test(source)) return mechanicsByTag('机械直觉');
  if (/(安保|警探|保镖|警卫|猎人|乘警|执法|战术)/.test(source)) return mechanicsByTag('钢铁意志');
  if (/(危机|风控|预警|侦测|嗅觉)/.test(source)) return mechanicsByTag('危机嗅觉');
  if (/(窃贼|骗子|记者|演员|旅客|访客|学徒|线人|潜入)/.test(source)) return mechanicsByTag('潜行训练');
  return mechanicsByTag('冷静');
}

function mechanicsByTag(tag: WriterRole['coreTag']): { stats: Stats; startingItems: ItemId[]; coreTag: WriterRole['coreTag'] } {
  switch (tag) {
    case '机械直觉':
      return { coreTag: tag, stats: { physique: 3, mind: 4, empathy: 1 }, startingItems: ['sealant-foam'] };
    case '战地急救':
      return { coreTag: tag, stats: { physique: 2, mind: 2, empathy: 4 }, startingItems: ['medkit'] };
    case '危机嗅觉':
      return { coreTag: tag, stats: { physique: 3, mind: 3, empathy: 2 }, startingItems: ['oxygen-canister'] };
    case '幸运星':
      return { coreTag: tag, stats: { physique: 2, mind: 3, empathy: 3 }, startingItems: [] };
    case '说客':
      return { coreTag: tag, stats: { physique: 2, mind: 3, empathy: 4 }, startingItems: ['medkit'] };
    case '钢铁意志':
      return { coreTag: tag, stats: { physique: 4, mind: 3, empathy: 1 }, startingItems: [] };
    case '潜行训练':
      return { coreTag: tag, stats: { physique: 3, mind: 2, empathy: 3 }, startingItems: ['oxygen-canister'] };
    case '冷静':
    default:
      return { coreTag: '冷静', stats: { physique: 2, mind: 4, empathy: 2 }, startingItems: [] };
  }
}

function isTagId(value: string): value is WriterRole['coreTag'] {
  return ['机械直觉', '战地急救', '危机嗅觉', '幸运星', '冷静', '钢铁意志', '说客', '潜行训练'].includes(value);
}

function slugifyRoleId(label: string, index: number) {
  const ascii = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return ascii || `role-${index + 1}`;
}

function pickBestRoleForPrompt(roles: WriterRole[], archetypeId: string, prompt: string) {
  const promptTag = buildSuggestedTags(archetypeId, prompt)[0];
  if (promptTag) {
    const byTag = roles.find((role) => role.coreTag === promptTag || role.suggestedTag === promptTag);
    if (byTag) return byTag;
  }

  const fallbackProfile = ARCHETYPES.find((entry) => entry.id === archetypeId);
  if (fallbackProfile) {
    const byCoreTag = roles.find((role) => role.coreTag === fallbackProfile.defaultTag || role.suggestedTag === fallbackProfile.defaultTag);
    if (byCoreTag) return byCoreTag;
  }

  return roles[0];
}

function normalizeTextList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .map((entry) => normalizeTextEntry(entry))
    .filter((entry): entry is string => Boolean(entry));
}

function normalizeTextEntry(entry: unknown): string | null {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value || null;
  }

  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const candidateKeys = ['title', 'description', 'summary', 'text', 'content', 'condition'];
  const parts = candidateKeys
    .map((key) => (typeof (entry as Record<string, unknown>)[key] === 'string' ? String((entry as Record<string, unknown>)[key]).trim() : ''))
    .filter(Boolean);

  if (parts.length > 0) {
    return parts.join(' / ');
  }

  try {
    return JSON.stringify(entry);
  } catch {
    return null;
  }
}

function normalizeScenario(input: Omit<StoryScenario, 'id'>, bibleInput: Partial<StoryBible> | undefined, storyGameMode: StoryGameMode, roundCount: number = 8): StoryScenario {
  const title = asString(input.title) || asString(bibleInput?.title) || '临时故事';
  const premise = asString(input.premise) || asString(bibleInput?.premise) || '一场封闭危机正在升级。';
  const openingLine = asString(input.openingLine) || '灯光闪烁，所有人的神经都被拉紧。';
  const macroObjective = asString(input.macroObjective) || getModeMacroObjective(storyGameMode);
  const fallbackScenario = { title, premise, openingLine, macroObjective };
  const sourceLocations = input.locations && Object.keys(input.locations).length >= 4 ? input.locations : buildFallbackLocations();
  const { locations: normalizedLocations, idMap: locationIdMap } = normalizeLocations(sourceLocations);

  return {
    id: `generated-${Date.now()}`,
    title,
    premise,
    openingLine,
    macroObjective,
    storyGameMode: normalizeStoryGameMode(input.storyGameMode ?? bibleInput?.storyGameMode ?? storyGameMode),
    countdown: normalizeCountdown(input.countdown, fallbackScenario),
    gameplayMode: input.gameplayMode === 'llm' ? 'llm' : 'llm',
    beats: normalizeBeats(input.beats, locationIdMap, roundCount),
    npcs: normalizeNpcs(input.npcs, normalizedLocations),
    glossary: normalizeGlossary(input.glossary),
    locations: normalizedLocations
  };
}

function normalizeNpcs(
  input: unknown,
  locations: Record<LocationId, LocationDefinition>
): StoryNpc[] {
  const locationIds = Object.keys(locations) as LocationId[];
  const fallbackLocation = locationIds[0];
  const rawList = Array.isArray(input) ? input : [];

  const normalized = rawList
    .map((entry, index) => normalizeNpc(entry, index, locationIds, fallbackLocation))
    .filter((entry): entry is StoryNpc => Boolean(entry))
    .slice(0, 5);

  if (normalized.length >= 2) {
    return normalized;
  }

  const generatedFallback: StoryNpc[] = locationIds.slice(0, 2).map((locationId, index) => ({
    id: `npc-${index + 1}`,
    name: index === 0 ? '现场目击者' : '临时协助者',
    publicIdentity: index === 0 ? '你无法确认其真实立场。' : '看似愿意合作，但始终保留余地。',
    hiddenDrive: index === 0 ? '他在掩护某段不该曝光的过去。' : '他只在局势对自己有利时才会出手。',
    attitude: index === 0 ? 'neutral' : 'friendly',
    locationId,
    clue: '对话中会反复提及一处被忽略的细节。',
    status: '保持警惕'
  }));

  return generatedFallback;
}

function normalizeNpc(
  input: unknown,
  index: number,
  locationIds: LocationId[],
  fallbackLocation: LocationId | undefined
): StoryNpc | null {
  if (!input || typeof input !== 'object' || !fallbackLocation) {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const name = asString(raw.name);
  const publicIdentity = asString(raw.publicIdentity);
  const hiddenDrive = asString(raw.hiddenDrive);
  const clue = asString(raw.clue);
  const rawStatus = asString(raw.status);
  if (!name || !publicIdentity || !hiddenDrive || !clue) {
    return null;
  }

  const locationIdRaw = asString(raw.locationId);
  const locationId = locationIds.includes(locationIdRaw) ? locationIdRaw : fallbackLocation;
  const attitudeRaw = asString(raw.attitude);
  const attitude: StoryNpc['attitude'] =
    attitudeRaw === 'friendly' || attitudeRaw === 'hostile' ? attitudeRaw : 'neutral';
  const status = normalizeNpcStatus(rawStatus, attitude);

  return {
    id: asString(raw.id) || `npc-${index + 1}`,
    name,
    publicIdentity,
    hiddenDrive,
    attitude,
    locationId,
    clue,
    status
  };
}

function normalizeNpcStatus(status: string, attitude: StoryNpc['attitude']) {
  const unsafe = /(私密任务|隐藏动机|秘密目标|围绕|寻找机会|“|”|\"|任务)/;
  if (!status || unsafe.test(status)) {
    if (attitude === 'friendly') return '正在尝试建立合作。';
    if (attitude === 'hostile') return '态度强硬，持续施压。';
    return '保持观望，暂不表态。';
  }
  return status.length > 32 ? `${status.slice(0, 32)}。` : status;
}

function normalizeBeats(input: unknown, locationIdMap: Map<string, LocationId>, roundCount: number): StoryBeat[] {
  const targetBeatCount = inferBeatCountByRoundCount(roundCount);
  const beats = Array.isArray(input)
    ? input
        .map((entry, index) => normalizeBeat(entry, index, locationIdMap))
        .filter((entry): entry is StoryBeat => Boolean(entry))
    : [];

  if (beats.length >= Math.max(3, targetBeatCount - 1)) {
    return beats.slice(0, targetBeatCount + 1);
  }
  const fallbackLocation = Array.from(new Set(locationIdMap.values()))[0] ?? 'area-1';
  const fallbackBeats: StoryBeat[] = [
    {
      id: 'beat-1',
      title: '确认第一现场',
      summary: '先从最直接的线索入手。',
      guidance: '查看当前区域最异常的痕迹。',
      locationId: fallbackLocation,
      actionType: 'inspect',
      targetLabel: '可疑痕迹',
      skill: 'mind',
      requiredItemId: null,
      rewardItemId: null,
      countdownDelta: 0,
      successText: '你捕捉到了有价值的线索。',
      failText: '你暂时没有看出端倪。',
      suggestions: ['查看可疑痕迹', '询问在场人物']
    },
    {
      id: 'beat-2',
      title: '争取主动权',
      summary: '通过对话或行动改变局势。',
      guidance: '说服关键人物或执行一次关键动作。',
      locationId: fallbackLocation,
      actionType: 'persuade',
      targetLabel: '关键人物',
      skill: 'empathy',
      requiredItemId: null,
      rewardItemId: null,
      countdownDelta: 1,
      successText: '你争取到了短暂优势。',
      failText: '对方仍在试探你。',
      suggestions: ['说服关键人物', '继续追问细节']
    },
    {
      id: 'beat-3',
      title: '执行终局动作',
      summary: '在压力下完成决定性一步。',
      guidance: '抓住最后窗口推进主目标。',
      locationId: fallbackLocation,
      actionType: 'use_item',
      targetLabel: '关键装置',
      skill: 'mind',
      requiredItemId: null,
      rewardItemId: null,
      countdownDelta: 1,
      successText: '你把故事推向了终局。',
      failText: '时机稍纵即逝。',
      suggestions: ['使用关键装置', '检查剩余资源']
    }
  ];

  while (fallbackBeats.length < targetBeatCount) {
    const index = fallbackBeats.length + 1;
    fallbackBeats.push({
      id: `beat-${index}`,
      title: `阶段推进 ${index}`,
      summary: '在压力下继续推进主线。',
      guidance: '继续处理最关键的阻碍。',
      locationId: fallbackLocation,
      actionType: index % 3 === 0 ? 'persuade' : index % 2 === 0 ? 'use_item' : 'inspect',
      targetLabel: index % 3 === 0 ? '关键人物' : '关键装置',
      skill: index % 3 === 0 ? 'empathy' : 'mind',
      requiredItemId: null,
      rewardItemId: null,
      countdownDelta: 0,
      successText: '你把局势又往前推了一步。',
      failText: '推进受阻，但仍有下一次机会。',
      suggestions: ['继续推进关键目标', '检查当前资源']
    });
  }

  return fallbackBeats.slice(0, targetBeatCount);
}

function normalizeBeat(input: unknown, index: number, locationIdMap: Map<string, LocationId>): StoryBeat | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const locationId = normalizeBeatLocation(raw.locationId, locationIdMap);
  const actionType = normalizeBeatAction(raw.actionType);
  const targetLabel = normalizeGlossaryValue(asString(raw.targetLabel), '');
  const title = normalizeGlossaryValue(asString(raw.title), '');
  const guidance = normalizeGlossaryValue(asString(raw.guidance), '');
  const successText = normalizeGlossaryValue(asString(raw.successText), '');
  const failText = normalizeGlossaryValue(asString(raw.failText), '');

  if (!locationId || !actionType || !targetLabel || !title || !guidance || !successText || !failText) {
    return null;
  }

  return {
    id: normalizeGlossaryValue(asString(raw.id), `beat-${index + 1}`),
    title,
    summary: normalizeGlossaryValue(asString(raw.summary), guidance),
    guidance,
    locationId,
    actionType,
    targetLabel,
    skill: normalizeBeatSkill(raw.skill),
    requiredItemId: normalizeBeatItem(raw.requiredItemId),
    rewardItemId: normalizeBeatItem(raw.rewardItemId),
    countdownDelta: typeof raw.countdownDelta === 'number' && Number.isFinite(raw.countdownDelta) ? clampNumber(raw.countdownDelta, -3, 3) : 0,
    successText,
    failText,
    suggestions: Array.isArray(raw.suggestions)
      ? raw.suggestions.map((entry) => asString(entry)).filter((entry): entry is string => Boolean(entry?.trim())).slice(0, 4)
      : []
  };
}

function normalizeGlossary(input: Partial<ScenarioGlossary> | undefined): ScenarioGlossary {
  const safeInput = input ?? {};

  const toolLabel = normalizeGlossaryValue(safeInput.toolLabel, ITEM_LIBRARY['insulated-wrench'].label);
  const keyItemLabel = normalizeGlossaryValue(safeInput.keyItemLabel, ITEM_LIBRARY['captain-keycard'].label);
  const repairMaterialLabel = normalizeGlossaryValue(safeInput.repairMaterialLabel, ITEM_LIBRARY['sealant-foam'].label);

  return {
    toolLabel,
    keyItemLabel,
    repairMaterialLabel,
    powerNodeLabel: normalizeGlossaryValue(safeInput.powerNodeLabel, '核心装置'),
    cabinetLabel: normalizeGlossaryValue(safeInput.cabinetLabel, '补给柜'),
    survivorLabel: normalizeGlossaryValue(safeInput.survivorLabel, '现场证人'),
    gateLabel: normalizeGlossaryValue(safeInput.gateLabel, '封锁门'),
    exitVehicleLabel: normalizeGlossaryValue(safeInput.exitVehicleLabel, '撤离载具'),
    itemLabels: {
      'insulated-wrench': normalizeGlossaryValue(safeInput.itemLabels?.['insulated-wrench'], toolLabel),
      'captain-keycard': normalizeGlossaryValue(safeInput.itemLabels?.['captain-keycard'], keyItemLabel),
      medkit: normalizeGlossaryValue(safeInput.itemLabels?.medkit, '应急医疗包'),
      'oxygen-canister': normalizeGlossaryValue(safeInput.itemLabels?.['oxygen-canister'], '关键补给'),
      'sealant-foam': normalizeGlossaryValue(safeInput.itemLabels?.['sealant-foam'], repairMaterialLabel)
    }
  };
}

function buildFallbackLocations(): Record<LocationId, LocationDefinition> {
  return {
    hall: {
      id: 'hall',
      label: '门厅',
      description: '所有动线都会经过这里，信息最杂也最危险。',
      atmosphere: '脚步声和低语交错，气氛紧绷。',
      connected: ['archive', 'control-room'],
      pointsOfInterest: ['可疑血迹', '破损监控']
    },
    archive: {
      id: 'archive',
      label: '档案室',
      description: '尘封记录堆满墙面，许多页被刻意抽走。',
      atmosphere: '纸张翻动声像在催促你快一点。',
      connected: ['hall', 'med-bay'],
      pointsOfInterest: ['旧案记录', '被撬开的抽屉']
    },
    'control-room': {
      id: 'control-room',
      label: '控制室',
      description: '这里掌握着大部分系统权限。',
      atmosphere: '告警灯忽明忽暗。',
      connected: ['hall', 'escape-bay'],
      pointsOfInterest: ['主控终端', '封锁闸门']
    },
    'med-bay': {
      id: 'med-bay',
      label: '医务间',
      description: '治疗与审问都可能在这里发生。',
      atmosphere: '药水味混着消毒水味道。',
      connected: ['archive'],
      pointsOfInterest: ['急救柜', '诊疗记录']
    },
    'escape-bay': {
      id: 'escape-bay',
      label: '撤离区',
      description: '最终撤离手段就停在这里。',
      atmosphere: '金属震动声不断放大焦虑。',
      connected: ['control-room'],
      pointsOfInterest: ['撤离载具', '发射面板']
    }
  };
}

function normalizePlayerCount(input: number | undefined) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 1;
  }
  return Math.max(1, Math.min(6, Math.round(input)));
}

function normalizeRoundCount(input: number | undefined) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return 8;
  }
  return Math.max(4, Math.min(20, Math.round(input)));
}

function inferBeatCountByRoundCount(roundCount: number) {
  if (roundCount <= 5) return 4;
  if (roundCount <= 8) return 5;
  if (roundCount <= 11) return 7;
  if (roundCount <= 14) return 9;
  if (roundCount <= 17) return 11;
  return 13;
}

function normalizeCountdown(
  input: Partial<CountdownPresentation> | undefined,
  scenario: Pick<StoryScenario, 'title' | 'premise' | 'openingLine' | 'macroObjective'>
): CountdownPresentation {
  const inferred = inferCountdownPresentation(`${scenario.title} ${scenario.premise} ${scenario.openingLine} ${scenario.macroObjective}`);
  return {
    label: typeof input?.label === 'string' && input.label.trim() ? input.label.trim() : inferred.label,
    shortLabel: typeof input?.shortLabel === 'string' && input.shortLabel.trim() ? input.shortLabel.trim() : inferred.shortLabel,
    max: typeof input?.max === 'number' && Number.isFinite(input.max) ? clampNumber(input.max, 4, 24) : inferred.max,
    recoverLabel: typeof input?.recoverLabel === 'string' && input.recoverLabel.trim() ? input.recoverLabel.trim() : inferred.recoverLabel
  };
}

function inferCountdownPresentation(source: string): CountdownPresentation {
  if (/(潜艇|深潜|氧气|密闭|舱|太空|窒息|失压|呼吸)/.test(source)) {
    return {
      label: '剩余氧气',
      shortLabel: '氧气',
      max: 12,
      recoverLabel: '氧气'
    };
  }

  if (/(限时|倒计时|小时|钟头|黎明|天亮|午夜|爆炸前|追捕|处决|审判|列车|失控)/.test(source)) {
    return {
      label: '剩余时间',
      shortLabel: '小时',
      max: 8,
      recoverLabel: '时间'
    };
  }

  return {
    label: '剩余行动步数',
    shortLabel: '步数',
    max: 12,
    recoverLabel: '步数'
  };
}

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeGlossaryValue(value: string | undefined, fallback: string) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeBeatLocation(value: unknown, locationIdMap: Map<string, LocationId>): LocationId | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const normalized = value.trim();
  return locationIdMap.get(normalized) ?? normalized;
}

function normalizeBeatAction(value: unknown) {
  return ['inspect', 'move', 'repair', 'force', 'use_item', 'persuade'].includes(String(value))
    ? (value as StoryBeat['actionType'])
    : null;
}

function normalizeBeatSkill(value: unknown): SkillKey | undefined {
  return ['physique', 'mind', 'empathy'].includes(String(value)) ? (value as SkillKey) : undefined;
}

function normalizeBeatItem(value: unknown): ItemId | null {
  return ['insulated-wrench', 'captain-keycard', 'medkit', 'oxygen-canister', 'sealant-foam'].includes(String(value))
    ? (value as ItemId)
    : null;
}

function normalizeLocation(id: LocationId, input: Partial<LocationDefinition> | undefined): LocationDefinition {
  if (!input?.label || !input.description || !input.atmosphere || !input.pointsOfInterest?.length) {
    throw new Error(`模型返回的区域结构不完整: ${id}`);
  }

  return {
    id,
    label: input.label,
    description: input.description,
    atmosphere: input.atmosphere,
    connected: Array.isArray(input.connected) ? input.connected.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : [],
    pointsOfInterest: input.pointsOfInterest
  };
}

function normalizeLocations(input: unknown): {
  locations: Record<LocationId, LocationDefinition>;
  idMap: Map<string, LocationId>;
} {
  const rawEntries: Array<[string, Partial<LocationDefinition>]> = Array.isArray(input)
    ? input.map((value, index) => [String(index), (value ?? {}) as Partial<LocationDefinition>])
    : input && typeof input === 'object'
      ? Object.entries(input as Record<string, Partial<LocationDefinition>>)
      : [];

  const usedIds = new Set<string>();
  const entries = rawEntries.map(([rawKey, value], index) => {
    const candidateId = typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : rawKey;
    const safeId = toUniqueLocationId(toSafeLocationId(candidateId, index), usedIds);
    return [rawKey, safeId, value] as const;
  });

  if (entries.length < 4) {
    throw new Error('模型返回的地点数量不足。');
  }

  const idMap = new Map<string, LocationId>();
  entries.forEach(([rawKey, safeId, value]) => {
    idMap.set(rawKey, safeId);
    if (typeof value?.id === 'string' && value.id.trim()) {
      idMap.set(value.id.trim(), safeId);
    }
  });

  const normalized = Object.fromEntries(
    entries.map(([_, safeId, value]) => [safeId, normalizeLocation(safeId, value)])
  ) as Record<LocationId, LocationDefinition>;
  const validIds = new Set(Object.keys(normalized));

  for (const location of Object.values(normalized)) {
    location.connected = location.connected
      .map((entry) => idMap.get(entry) ?? toSafeLocationId(entry, 0))
      .filter((entry) => validIds.has(entry) && entry !== location.id);
    if (location.connected.length === 0) {
      throw new Error(`地点 ${location.id} 缺少有效连接。`);
    }
  }

  return {
    locations: normalized,
    idMap
  };
}

function toSafeLocationId(candidate: string, index: number): LocationId {
  const trimmed = candidate.trim().toLowerCase();
  const slug = trimmed
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (slug || `area-${index + 1}`) as LocationId;
}

function toUniqueLocationId(baseId: LocationId, used: Set<string>): LocationId {
  if (!used.has(baseId)) {
    used.add(baseId);
    return baseId;
  }
  let counter = 2;
  let next = `${baseId}-${counter}` as LocationId;
  while (used.has(next)) {
    counter += 1;
    next = `${baseId}-${counter}` as LocationId;
  }
  used.add(next);
  return next;
}

export function getItemLabel(session: GameSession, itemId: ItemId) {
  return session.scenario.glossary.itemLabels[itemId] ?? ITEM_LIBRARY[itemId].label;
}

export function getTargetLabel(session: GameSession, targetId: string) {
  switch (targetId) {
    case 'locker':
      return getFirstPoi(session, 'crew-quarters', '储物点');
    case 'relay':
      return session.scenario.glossary.powerNodeLabel;
    case 'console':
      return getFirstPoi(session, 'control-room', '主控终端');
    case 'cabinet':
      return session.scenario.glossary.cabinetLabel;
    case 'survivor':
      return session.scenario.glossary.survivorLabel;
    case 'bulkhead':
      return session.scenario.glossary.gateLabel;
    case 'escape-pod':
      return session.scenario.glossary.exitVehicleLabel;
    case 'self':
      return '自己';
    default:
      return '当前区域';
  }
}

function getFirstPoi(session: GameSession, preferredLocationId: string, fallback: string) {
  return session.world.locations[preferredLocationId]?.pointsOfInterest[0] ?? Object.values(session.world.locations)[0]?.pointsOfInterest[0] ?? fallback;
}

function buildLocationKeywordMap(session: GameSession): Array<[LocationId, string[]]> {
  return (Object.keys(session.world.locations) as LocationId[]).map((id) => {
    const location = requireAiLocation(session, id);
    return [id, [location.label, ...location.pointsOfInterest].map((entry) => entry.toLowerCase())];
  });
}

function requireAiLocation(session: GameSession, locationId: LocationId) {
  const location = session.world.locations[locationId];
  if (!location) {
    throw new Error(`故事地点不存在：${locationId}`);
  }
  return location;
}
