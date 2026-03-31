import {
  ARCHETYPES,
  ITEM_LIBRARY,
  type ActionType,
  type CountdownPresentation,
  type FilteredAction,
  type GameSession,
  type ItemId,
  type LocationDefinition,
  type LocationId,
  type NarrationPayload,
  type ParsedAction,
  type Resolution,
  type ScenarioGlossary,
  type SkillKey,
  type StoryBeat,
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
export interface AiService {
  intentToAction(session: GameSession, intent: string): Promise<ParsedAction>;
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

  async generateStoryOutline(input: StoryOutlineRequest): Promise<StoryOutlineResponse> {
    const draft = await this.generateWriterDraft({
      prompt: input.prompt
    });
    const archetype = ARCHETYPES.find((entry) => entry.id === input.archetypeId);
    const role = pickBestRoleForPrompt(draft.bible.roles, input.archetypeId, input.prompt);

    return {
      title: archetype ? `${archetype.label} / ${draft.bible.title}` : role ? `${role.label} / ${draft.bible.title}` : draft.bible.title,
      premise: draft.bible.premise,
      twist: draft.bible.outline[2] ?? draft.bible.currentCrisis,
      secret: draft.bible.coreSecret,
      openingHook: draft.scenario.openingLine,
      suggestedBackground: role?.suggestedBackground ?? `你曾因为 ${input.prompt.trim()} 被卷入这场故事。`,
      suggestedTags: role ? [role.suggestedTag] : buildSuggestedTags(input.archetypeId, input.prompt)
    };
  }

  async generateScenario(input: StoryScenarioRequest): Promise<StoryScenario> {
    const draft = await this.generateWriterDraft({
      prompt: input.prompt
    });
    return draft.scenario;
  }

  async generateWriterDraft(input: WriterDraftRequest): Promise<WriterDraftResponse> {
    const prompt = input.prompt.trim();
    if (!prompt) {
      throw new Error('请先输入一句故事 Prompt。');
    }

    if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
      throw new Error('未配置自定义故事生成模型，请检查 .env 中的 LLM_API_KEY 和 LLM_MODEL。');
    }

    try {
      const generated = await requestWriterDraftFromLlm(prompt);
      if (!generated) {
        throw new Error('模型没有返回可用的故事草案。');
      }

      return generated;
    } catch (error) {
      const detail = error instanceof Error ? error.message : '未知错误';
      throw new Error(`自定义故事生成失败：${detail}`);
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

async function parseDynamicIntentWithLlm(session: GameSession, intent: string): Promise<ParsedAction | null> {
  if (!process.env.LLM_API_KEY || !process.env.LLM_MODEL) {
    return null;
  }

  const currentBeat = session.scenario.beats?.[session.world.storyBeatIndex ?? 0];
  if (!currentBeat) {
    return null;
  }

  try {
    const response = await fetch(`${process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
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
              playerIntent: intent
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

async function requestWriterDraftFromLlm(prompt: string): Promise<WriterDraftResponse> {
  try {
    const response = await fetch(`${process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
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
              '你是中文互动悬疑游戏的编剧 agent。用户会给出简短要求，比如“风雪山庄，4人，逃生/破案”。请只输出 JSON 对象，不要使用 markdown 代码块，不要解释。JSON 必须包含 bible 和 scenario。bible 必含：title,genre,playerCountLabel,premise,background,currentCrisis,coreSecret,outline,endings,roles。outline 至少 6 段，要能支撑完整游玩流程，包含开场危机、设施处理、线索调查、幸存者/证人互动、关键转折、终局抉择。roles 必须是 4 个不同职业的对象，职业名称和身份由故事主题决定，不要固定成工程师/医生/保安/乘客。每个 role 必含：id,archetypeId,label,publicIdentity,hiddenDrive,relationshipHook,specialty,suggestedTag,suggestedBackground,secretAgenda。secretAgenda 必含：title,description,successHint,triggerKeywords,requiredProgress，并且必须是这个角色的私密个人目标，不要和宏观目标完全重复。archetypeId 也请使用与职业相符的自定义英文短 id。scenario 必含：title,premise,openingLine,macroObjective,countdown,glossary,locations,gameplayMode,beats。gameplayMode 固定写 llm。countdown 必含：label,shortLabel,max,recoverLabel，并且要按故事主题决定表现形式；密闭空间可写成氧气，限时求生可写成小时数，其他故事可写成行动步数。locations 必须是 4 到 7 个自定义地点，以对象形式返回，键和值里的 id 都使用简短英文短横线 id；每个地点含 id,label,description,atmosphere,connected,pointsOfInterest。connected 里的值必须引用这些自定义地点 id。beats 至少 5 个，必须体现这局故事自己的玩法链，不能复用“修机房-拿钥匙卡-开门-逃生舱”这种固定模板。每个 beat 必含：id,title,summary,guidance,locationId,actionType,targetLabel,skill,requiredItemId,rewardItemId,countdownDelta,successText,failText,suggestions。locationId 必须来自你自己定义的 locations。actionType 只能从 inspect,move,repair,force,use_item,persuade 里选；skill 只能从 physique,mind,empathy 里选；requiredItemId 和 rewardItemId 只能从 insulated-wrench,captain-keycard,medkit,oxygen-canister,sealant-foam 里选或 null。openingLine 和 macroObjective 要体现这是一个中等体量的多阶段互动故事，不要写成几步就结束的短遭遇。glossary 必含 toolLabel,keyItemLabel,repairMaterialLabel,powerNodeLabel,cabinetLabel,survivorLabel,gateLabel,exitVehicleLabel,itemLabels。不要把故事固定成潜艇，除非用户明确要求。文案全部中文。'
          },
          {
            role: 'user',
            content: prompt
          }
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

    const parsed = parseWriterDraftContent(content) as {
      bible?: Partial<StoryBible>;
      scenario?: Omit<StoryScenario, 'id'>;
    };

    if (!parsed.bible || !parsed.scenario) {
      throw new Error('上游接口返回的 JSON 中缺少 bible 或 scenario。');
    }

    return normalizeWriterDraft(parsed.bible, parsed.scenario, prompt);
  } catch (error) {
    throw error;
  }
}

function normalizeWriterDraft(
  bibleInput: Partial<StoryBible>,
  scenarioInput: Omit<StoryScenario, 'id'>,
  _prompt: string
): WriterDraftResponse {
  const normalizedRoles = normalizeRoles(bibleInput.roles);
  const normalizedOutline = normalizeTextList(bibleInput.outline);
  const normalizedEndings = normalizeTextList(bibleInput.endings);

  if (
    !bibleInput.title ||
    !bibleInput.genre ||
    !bibleInput.playerCountLabel ||
    !bibleInput.premise ||
    !bibleInput.background ||
    !bibleInput.currentCrisis ||
    !bibleInput.coreSecret ||
    normalizedOutline.length < 3 ||
    normalizedEndings.length < 1 ||
    normalizedRoles.length !== 4
  ) {
    throw new Error('模型返回的故事结构不完整。');
  }

  return {
    bible: {
      title: bibleInput.title,
      genre: bibleInput.genre,
      playerCountLabel: bibleInput.playerCountLabel,
      premise: bibleInput.premise,
      background: bibleInput.background,
      currentCrisis: bibleInput.currentCrisis,
      coreSecret: bibleInput.coreSecret,
      outline: normalizedOutline,
      endings: normalizedEndings,
      roles: normalizedRoles
    },
    scenario: normalizeScenario(scenarioInput)
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

function normalizeRoles(input: StoryBible['roles'] | undefined) {
  const roles = (Array.isArray(input) ? input : [])
    .slice(0, 4)
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
  return roles;
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
    secretAgenda: normalizeSecretAgenda(input.secretAgenda, input)
  };
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
  if (/(医生|医护|法医|治疗|急救|心理|护士)/.test(source)) return mechanicsByTag('说客');
  if (/(安保|警探|保镖|警卫|猎人|乘警|执法|战术)/.test(source)) return mechanicsByTag('钢铁意志');
  if (/(窃贼|骗子|记者|演员|旅客|访客|学徒|线人|潜入)/.test(source)) return mechanicsByTag('潜行训练');
  return mechanicsByTag('冷静');
}

function mechanicsByTag(tag: WriterRole['coreTag']): { stats: Stats; startingItems: ItemId[]; coreTag: WriterRole['coreTag'] } {
  switch (tag) {
    case '说客':
      return { coreTag: tag, stats: { physique: 2, mind: 3, empathy: 4 }, startingItems: ['medkit'] };
    case '钢铁意志':
      return { coreTag: tag, stats: { physique: 4, mind: 3, empathy: 1 }, startingItems: [] };
    case '潜行训练':
      return { coreTag: tag, stats: { physique: 3, mind: 2, empathy: 3 }, startingItems: [] };
    case '冷静':
    default:
      return { coreTag: '冷静', stats: { physique: 2, mind: 4, empathy: 2 }, startingItems: ['sealant-foam'] };
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

function normalizeScenario(input: Omit<StoryScenario, 'id'>): StoryScenario {
  if (
    !input.title ||
    !input.premise ||
    !input.openingLine ||
    !input.macroObjective ||
    !input.glossary ||
    !input.locations ||
    Object.keys(input.locations).length < 4
  ) {
    throw new Error('模型返回的场景结构不完整。');
  }

  const normalizedLocations = normalizeLocations(input.locations);

  return {
    id: `generated-${Date.now()}`,
    title: input.title,
    premise: input.premise,
    openingLine: input.openingLine,
    macroObjective: input.macroObjective,
    countdown: normalizeCountdown(input.countdown, input),
    gameplayMode: input.gameplayMode === 'llm' ? 'llm' : 'llm',
    beats: normalizeBeats(input.beats),
    glossary: normalizeGlossary(input.glossary),
    locations: normalizedLocations
  };
}

function normalizeBeats(input: unknown): StoryBeat[] {
  const beats = Array.isArray(input)
    ? input
        .map((entry, index) => normalizeBeat(entry, index))
        .filter((entry): entry is StoryBeat => Boolean(entry))
    : [];

  if (beats.length >= 3) {
    return beats;
  }

  throw new Error('模型返回的玩法节点不足，无法生成动态玩法链。');
}

function normalizeBeat(input: unknown, index: number): StoryBeat | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const raw = input as Record<string, unknown>;
  const locationId = normalizeBeatLocation(raw.locationId);
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
  if (!input) {
    throw new Error('模型返回的术语表缺失。');
  }

  const toolLabel = normalizeGlossaryValue(input.toolLabel, ITEM_LIBRARY['insulated-wrench'].label);
  const keyItemLabel = normalizeGlossaryValue(input.keyItemLabel, ITEM_LIBRARY['captain-keycard'].label);
  const repairMaterialLabel = normalizeGlossaryValue(input.repairMaterialLabel, ITEM_LIBRARY['sealant-foam'].label);

  return {
    toolLabel,
    keyItemLabel,
    repairMaterialLabel,
    powerNodeLabel: normalizeGlossaryValue(input.powerNodeLabel, '核心装置'),
    cabinetLabel: normalizeGlossaryValue(input.cabinetLabel, '补给柜'),
    survivorLabel: normalizeGlossaryValue(input.survivorLabel, '现场证人'),
    gateLabel: normalizeGlossaryValue(input.gateLabel, '封锁门'),
    exitVehicleLabel: normalizeGlossaryValue(input.exitVehicleLabel, '撤离载具'),
    itemLabels: {
      'insulated-wrench': normalizeGlossaryValue(input.itemLabels?.['insulated-wrench'], toolLabel),
      'captain-keycard': normalizeGlossaryValue(input.itemLabels?.['captain-keycard'], keyItemLabel),
      medkit: normalizeGlossaryValue(input.itemLabels?.medkit, '应急医疗包'),
      'oxygen-canister': normalizeGlossaryValue(input.itemLabels?.['oxygen-canister'], '关键补给'),
      'sealant-foam': normalizeGlossaryValue(input.itemLabels?.['sealant-foam'], repairMaterialLabel)
    }
  };
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

function normalizeBeatLocation(value: unknown): LocationId | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
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

function normalizeLocations(input: Record<string, Partial<LocationDefinition>>): Record<LocationId, LocationDefinition> {
  const entries = Object.entries(input);
  if (entries.length < 4) {
    throw new Error('模型返回的地点数量不足。');
  }

  const normalized = Object.fromEntries(entries.map(([id, value]) => [id, normalizeLocation(id, value)])) as Record<LocationId, LocationDefinition>;
  const validIds = new Set(Object.keys(normalized));

  for (const location of Object.values(normalized)) {
    location.connected = location.connected.filter((entry) => validIds.has(entry) && entry !== location.id);
    if (location.connected.length === 0) {
      throw new Error(`地点 ${location.id} 缺少有效连接。`);
    }
  }

  return normalized;
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
