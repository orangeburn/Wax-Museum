import {
  ARCHETYPES,
  ITEM_LIBRARY,
  type ActionType,
  type FilteredAction,
  type GameSession,
  type ItemId,
  type LocationDefinition,
  type LocationId,
  type NarrationPayload,
  type ParsedAction,
  type Resolution,
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
const SCENARIO_LOCATION_IDS: LocationId[] = ['crew-quarters', 'engine-room', 'med-bay', 'control-room', 'escape-bay'];

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
        ? session.world.locations[locationId].label
        : toolId
          ? getItemLabel(session, toolId)
          : targetId
            ? getTargetLabel(session, targetId)
            : session.world.locations[session.player.locationId].label,
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
    const role = draft.bible.roles.find((entry) => entry.archetypeId === input.archetypeId) ?? draft.bible.roles[0];

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

    if (process.env.LLM_API_KEY && process.env.LLM_MODEL) {
      const generated = await requestWriterDraftFromLlm(prompt);
      if (generated) {
        return generated;
      }
    }

    return buildFallbackWriterDraft(prompt);
  }

  async composeNarration(input: {
    session: GameSession;
    filteredAction: FilteredAction;
    resolution: Resolution;
    presentation: EnginePresentation;
  }): Promise<NarrationPayload> {
    const location = input.session.world.locations[input.session.player.locationId];
    const tone =
      input.resolution.tier === 'success'
        ? '局面终于被你扳回了一寸。'
        : input.resolution.tier === 'cost'
          ? '你硬是把事情往前推了半步，但代价也跟着落下。'
          : '这个故事没有轻易放过你。';

    const systems = [input.presentation.systemText, ...input.resolution.stateChanges];
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

function inferActionType(normalizedIntent: string): ActionType {
  if (!normalizedIntent) return 'help';
  if (/(背包|物品|inventory)/.test(normalizedIntent)) return 'inventory';
  if (/(帮助|提示|怎么办|help)/.test(normalizedIntent)) return 'help';
  if (/(使用|刷卡|启动|发射|吃|喝|用|use|launch)/.test(normalizedIntent)) return 'use_item';
  if (/(修|维修|重启|接线|fix|repair|校准|稳定)/.test(normalizedIntent)) return 'repair';
  if (/(砸|撬|撞开|强行|force|break|突入)/.test(normalizedIntent)) return 'force';
  if (/(说服|安抚|交谈|聊天|persuade|talk)/.test(normalizedIntent)) return 'persuade';
  if (/(去|前往|移动|进入|赶往|move|go)/.test(normalizedIntent)) return 'move';
  return 'inspect';
}

function findLocation(normalizedIntent: string, session: GameSession): LocationId | undefined {
  for (const locationId of SCENARIO_LOCATION_IDS) {
    const location = session.world.locations[locationId];
    if ([location.label, ...location.pointsOfInterest].some((entry) => normalizedIntent.includes(entry.toLowerCase()))) {
      return locationId;
    }
  }

  const fallbackKeywords: Array<[LocationId, string[]]> = [
    ['crew-quarters', ['起点', '宿舍', '休息区', '前厅']],
    ['engine-room', ['动力', '机房', '设备间', '锅炉', '配电']],
    ['med-bay', ['医务', '诊疗', '治疗', '储藏', '厨房']],
    ['control-room', ['控制', '终端', '主控', '书房', '监控']],
    ['escape-bay', ['出口', '撤离', '逃生', '车库', '庭院', '月台']]
  ];

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
  const targets: Array<[string, string[]]> = [
    ['cabinet', [session.scenario.glossary.cabinetLabel, '急救柜', '补给柜', '药柜', '档案柜']],
    ['locker', [session.world.locations['crew-quarters'].pointsOfInterest[0] ?? '储物柜', '储物柜', '工具柜', '行李柜']],
    ['relay', [session.scenario.glossary.powerNodeLabel, '主继电器', '动力节点', '核心装置', '锅炉', '主机']],
    ['console', [session.world.locations['control-room'].pointsOfInterest[0] ?? '主控终端', '主控终端', '终端', '控制台', '书桌']],
    ['survivor', [session.scenario.glossary.survivorLabel, '幸存者', '目击者', '管家', '证人']],
    ['bulkhead', [session.scenario.glossary.gateLabel, '封闭闸门', '闸门', '封锁门', '铁门']],
    ['escape-pod', [session.scenario.glossary.exitVehicleLabel, '逃生艇', '出口', '撤离装置', '雪地车']],
    ['self', ['自己', '我自己']]
  ];

  for (const [id, entries] of targets) {
    if (entries.filter((entry): entry is string => Boolean(entry)).some((entry) => normalizedIntent.includes(entry.toLowerCase()))) {
      return id;
    }
  }

  const fallbackTargetByLocation: Record<LocationId, string> = {
    'crew-quarters': 'locker',
    'engine-room': 'relay',
    'med-bay': 'cabinet',
    'control-room': 'console',
    'escape-bay': 'escape-pod'
  };

  return fallbackTargetByLocation[session.player.locationId];
}

function normalizeIntent(intent: string) {
  return intent.trim().toLowerCase();
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

function summarizePrompt(prompt: string) {
  return prompt
    .split(/[，,。；;、/\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function buildFallbackWriterDraft(prompt: string): WriterDraftResponse {
  const keywords = summarizePrompt(prompt);
  const anchor = keywords[0] ?? '封闭山庄';
  const headcount = keywords.find((entry) => /\d+人|多人|四人|五人|六人/.test(entry)) ?? '4人';
  const pressure = keywords[1] ?? '暴雪';
  const secret = keywords[2] ?? '被掩埋的旧案';
  const title = `${anchor}疑局`;
  const genre = `${pressure}封闭空间悬疑`;

  const bible: StoryBible = {
    title,
    genre,
    playerCountLabel: headcount,
    premise: `${pressure}切断了所有对外联系，你和另外几名互不完全信任的人被困在 ${anchor}。表面目标是活着出去，但真正能决定谁活到最后的，是谁先碰到 ${secret}，又是否敢把它从黑暗里拖出来。`,
    background: `${anchor}曾是个体面而安静的地方，直到一场旧案在今晚被重新翻开。停电、封路和失踪者把所有人逼回同一个屋檐下，每一句话都可能既是求救，也是试探。更糟的是，馆内许多设施并不是单纯故障，而像有人提前做过手脚，专门把幸存者一步步逼进同一条走廊。`,
    currentCrisis: `通讯中断，出口受阻，现场还留下足以指向内部人的新证据。你们必须一边设法离开，一边判断谁在说谎，还得赶在环境彻底失控前拼出完整的转移链、伤者口供与撤离条件。`,
    coreSecret: `真正的关键不只是“谁做的”，而是这起事件与多年前那起 ${secret} 有直接延续关系。今晚有人回来，不只是为了杀人灭口，更是为了借封闭危局迫使最后一个见证者交出当年的关键证据。`,
    outline: [
      `开场：${pressure}来得比预报更猛，${anchor}在几分钟内与外界失联，第一具不该出现的尸体或失踪痕迹迫使所有人留在原地。`,
      '第一轮调查：众人被迫先解决眼前的设施故障，谁掌握工具、谁负责恢复供能，决定了临时秩序会落到谁手里。',
      '中段：随着控制记录恢复，玩家意识到关键通行物被人刻意转移，旧关系和隐藏动机开始一层层浮出水面。',
      '第二轮调查：医护间里的幸存者既是证人也是诱饵，能否稳住对方，会直接影响你拿到的物资、口供和最终逃生条件。',
      `转折：一份隐藏记录揭示，今晚的危机不是偶发事故，而是有人借混乱重演 ${secret}，并试图让唯一的幸存证词在撤离前彻底沉没。`,
      '终局：玩家必须在保护关键证据、确认真凶、补齐撤离装置最后的启动条件之间做取舍，任何犹豫都会让结局变坏。'
    ],
    endings: [
      '成功逃离并带出关键证据，真相得以公之于众。',
      '有人活着离开，但为了保命放弃了真相，旧案继续被埋。',
      '真凶暴露，却在最后时刻切断退路，所有人被困在风雪里。'
    ],
    roles: buildFallbackRoles(anchor, prompt)
  };

  return {
    bible,
    scenario: buildScenarioFromBible(bible)
  };
}

function buildFallbackRoles(anchor: string, prompt: string): WriterRole[] {
  const flavor = prompt.trim();
  return [
    {
      id: 'role-engineer',
      archetypeId: 'engineer',
      label: '修缮顾问',
      publicIdentity: `你受邀来 ${anchor} 检查一处早就该停用的设备系统。`,
      hiddenDrive: '你知道旧事故并非天灾，某份维护记录曾被人改过。',
      relationshipHook: '你和其中一名住客有过一次失败合作，对方也许认得你。',
      specialty: '擅长判断结构故障、恢复设施、读懂被篡改的技术记录。',
      suggestedTag: '冷静',
      suggestedBackground: `你曾因为 ${flavor} 接触过类似事故。这次回来，你最在意的不是体面离场，而是确认当年到底是谁动了那份记录。`
    },
    {
      id: 'role-medic',
      archetypeId: 'medic',
      label: '值夜医生',
      publicIdentity: `你原本只是来 ${anchor} 为其中一位关键人物做例行诊疗。`,
      hiddenDrive: '你见过其中一人的旧伤，知道那伤势不可能只来自意外。',
      relationshipHook: '有人把你当成可信赖的倾诉对象，也有人担心你知道得太多。',
      specialty: '擅长处理伤势、稳定证人情绪、从细节看出谎言和异常。',
      suggestedTag: '说客',
      suggestedBackground: `你曾在一次救援里没能保住所有人。${flavor} 让你意识到，这次若再慢一步，死掉的不只是一个人。`
    },
    {
      id: 'role-security',
      archetypeId: 'security',
      label: '临时安保',
      publicIdentity: `你被雇来负责 ${anchor} 今晚的安全与秩序。`,
      hiddenDrive: '你接到过一笔额外酬劳，让你在必要时优先保护某个人离开。',
      relationshipHook: '在场至少有一人知道你不只是普通安保，可能随时揭穿你。',
      specialty: '擅长封锁路线、突破障碍、在高压局面里强行开路。',
      suggestedTag: '钢铁意志',
      suggestedBackground: `你本来只想把 ${flavor} 控制在可收拾的范围里，但现场发展得太快，你只能一边维持秩序，一边决定究竟该救谁。`
    },
    {
      id: 'role-passenger',
      archetypeId: 'passenger',
      label: '受邀来客',
      publicIdentity: `你表面上只是来 ${anchor} 过夜的客人。`,
      hiddenDrive: '你其实是冲着旧案线索来的，比任何人都更不该出现在这里。',
      relationshipHook: '有人以为你是无辜旁观者，这恰好给了你周旋空间。',
      specialty: '擅长观察他人情绪、误打误撞发现密道或藏匿物、在夹缝里保命。',
      suggestedTag: '潜行训练',
      suggestedBackground: `你曾以为自己已经离开了那段往事，但 ${flavor} 让你重新站回案发中心。这次你不想再只是侥幸活下来。`
    }
  ];
}

function buildScenarioFromBible(bible: StoryBible): StoryScenario {
  const title = bible.title;
  const keywords = summarizePrompt(`${bible.genre} ${bible.premise}`);
  const pressure = keywords[0] ?? '暴雪';
  const clue = keywords[1] ?? '旧记录';

  return {
    id: `generated-${Date.now()}`,
    title,
    premise: bible.premise,
    openingLine: `灯光闪了第三次以后，你终于确定今晚不会有人来救场。${pressure}把外面的一切都抹成了白噪音，而屋里只剩彼此的呼吸、断续警报和越积越重的猜疑。有人在故障发生前就动过这里的设施，这意味着你们现在面对的不是一场单纯意外。`,
    macroObjective: `在局势彻底失控前恢复关键设施，查出通行物和证词被谁转移，稳住仍然活着的见证者，补齐撤离装置最后的启动条件，并带着足够证明真相的线索离开 ${title}。`,
    glossary: {
      toolLabel: '维修钥匙',
      keyItemLabel: '馆主徽章',
      repairMaterialLabel: '稳压密封剂',
      powerNodeLabel: '主配电节点',
      cabinetLabel: '档案药品柜',
      survivorLabel: '受惊证人',
      gateLabel: '封锁铁门',
      exitVehicleLabel: '雪地车',
      itemLabels: {
        'insulated-wrench': '维修钥匙',
        'captain-keycard': '馆主徽章',
        medkit: '急救箱',
        'oxygen-canister': '肾上腺针剂',
        'sealant-foam': '稳压密封剂'
      }
    },
    locations: {
      'crew-quarters': buildLocation(
        'crew-quarters',
        '客房走廊',
        '老式客房一字排开，门缝里漏出的灯都显得不太可靠。',
        '地毯吸住了脚步声，像有人故意不想让你听清别人的动作。',
        ['engine-room', 'med-bay'],
        ['行李工具柜', clue, '侧廊']
      ),
      'engine-room': buildLocation(
        'engine-room',
        '地下机房',
        '备用锅炉和配电箱挤在一起，像这栋建筑压抑的心脏。',
        '每一次电流跳动都像在催你快一点做决定。',
        ['crew-quarters', 'control-room'],
        ['主配电节点', '锅炉阀门', '裂开的蒸汽管']
      ),
      'med-bay': buildLocation(
        'med-bay',
        '医护储藏间',
        '药箱、档案和被匆忙拖拽过的痕迹都留在这里。',
        '有人刚在这里待过，而且离开得很急。',
        ['crew-quarters'],
        ['档案药品柜', '受惊证人', '临时诊疗台']
      ),
      'control-room': buildLocation(
        'control-room',
        '馆主书房',
        '墙上的旧照片和监控终端一起盯着每个进门的人。',
        '你几乎能感觉到真相就卡在某个抽屉和某句谎话之间。',
        ['engine-room', 'escape-bay'],
        ['监控书桌', '封锁铁门', '壁炉旁座钟']
      ),
      'escape-bay': buildLocation(
        'escape-bay',
        '车库坡道',
        '唯一能穿出风雪的车就停在尽头，像一场最后的审判。',
        '要是不能立刻发动，你们就得把命留给夜色和低温。',
        ['control-room'],
        ['雪地车', '点火台', '卷帘门']
      )
    }
  };
}

function buildLocation(
  id: LocationId,
  label: string,
  description: string,
  atmosphere: string,
  connected: LocationId[],
  pointsOfInterest: string[]
): LocationDefinition {
  return { id, label, description, atmosphere, connected, pointsOfInterest };
}

async function requestWriterDraftFromLlm(prompt: string): Promise<WriterDraftResponse | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`${process.env.LLM_BASE_URL ?? 'https://api.openai.com/v1'}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.LLM_API_KEY}`
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL,
        temperature: 0.9,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              '你是中文互动悬疑游戏的编剧 agent。用户会给出简短要求，比如“风雪山庄，4人，逃生/破案”。请输出一个 JSON 对象，包含 bible 和 scenario。bible 必含：title,genre,playerCountLabel,premise,background,currentCrisis,coreSecret,outline,endings,roles。outline 至少 6 段，要能支撑完整游玩流程，包含开场危机、设施处理、线索调查、幸存者/证人互动、关键转折、终局抉择。roles 必须是 4 个对象，对应 archetypeId engineer/medic/security/passenger，并包含 id,label,publicIdentity,hiddenDrive,relationshipHook,specialty,suggestedTag,suggestedBackground。scenario 必含：title,premise,openingLine,macroObjective,glossary,locations。openingLine 和 macroObjective 要体现这是一个中等体量的多阶段互动故事，不要写成几步就结束的短遭遇。glossary 必含 toolLabel,keyItemLabel,repairMaterialLabel,powerNodeLabel,cabinetLabel,survivorLabel,gateLabel,exitVehicleLabel,itemLabels。locations 必须提供五个键 crew-quarters,engine-room,med-bay,control-room,escape-bay；每个值含 label,description,atmosphere,pointsOfInterest。不要把故事固定成潜艇，除非用户明确要求。文案全部中文。'
          },
          {
            role: 'user',
            content: prompt
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

    const parsed = JSON.parse(content) as {
      bible?: Partial<StoryBible>;
      scenario?: Omit<StoryScenario, 'id'>;
    };

    if (!parsed.bible || !parsed.scenario) {
      return null;
    }

    return normalizeWriterDraft(parsed.bible, parsed.scenario, prompt);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeWriterDraft(
  bibleInput: Partial<StoryBible>,
  scenarioInput: Omit<StoryScenario, 'id'>,
  prompt: string
): WriterDraftResponse {
  const fallback = buildFallbackWriterDraft(prompt);
  const fallbackRoles = fallback.bible.roles;
  const normalizedRoles = normalizeRoles(bibleInput.roles, fallbackRoles);

  return {
    bible: {
      title: bibleInput.title || fallback.bible.title,
      genre: bibleInput.genre || fallback.bible.genre,
      playerCountLabel: bibleInput.playerCountLabel || fallback.bible.playerCountLabel,
      premise: bibleInput.premise || fallback.bible.premise,
      background: bibleInput.background || fallback.bible.background,
      currentCrisis: bibleInput.currentCrisis || fallback.bible.currentCrisis,
      coreSecret: bibleInput.coreSecret || fallback.bible.coreSecret,
      outline: bibleInput.outline?.length ? bibleInput.outline : fallback.bible.outline,
      endings: bibleInput.endings?.length ? bibleInput.endings : fallback.bible.endings,
      roles: normalizedRoles
    },
    scenario: normalizeScenario(scenarioInput, fallback.scenario)
  };
}

function normalizeRoles(input: StoryBible['roles'] | undefined, fallbackRoles: WriterRole[]) {
  const roles = Array.isArray(input) ? input : [];
  return fallbackRoles.map((fallbackRole) => {
    const matched = roles.find((entry) => entry?.archetypeId === fallbackRole.archetypeId);
    return {
      id: matched?.id || fallbackRole.id,
      archetypeId: fallbackRole.archetypeId,
      label: matched?.label || fallbackRole.label,
      publicIdentity: matched?.publicIdentity || fallbackRole.publicIdentity,
      hiddenDrive: matched?.hiddenDrive || fallbackRole.hiddenDrive,
      relationshipHook: matched?.relationshipHook || fallbackRole.relationshipHook,
      specialty: matched?.specialty || fallbackRole.specialty,
      suggestedTag: matched?.suggestedTag || fallbackRole.suggestedTag,
      suggestedBackground: matched?.suggestedBackground || fallbackRole.suggestedBackground
    };
  });
}

function normalizeScenario(input: Omit<StoryScenario, 'id'>, fallback: StoryScenario): StoryScenario {
  return {
    id: `generated-${Date.now()}`,
    title: input.title || fallback.title,
    premise: input.premise || fallback.premise,
    openingLine: input.openingLine || fallback.openingLine,
    macroObjective: input.macroObjective || fallback.macroObjective,
    glossary: {
      ...fallback.glossary,
      ...input.glossary,
      itemLabels: {
        ...fallback.glossary.itemLabels,
        ...(input.glossary?.itemLabels ?? {})
      }
    },
    locations: {
      'crew-quarters': normalizeLocation('crew-quarters', input.locations?.['crew-quarters'], fallback.locations['crew-quarters']),
      'engine-room': normalizeLocation('engine-room', input.locations?.['engine-room'], fallback.locations['engine-room']),
      'med-bay': normalizeLocation('med-bay', input.locations?.['med-bay'], fallback.locations['med-bay']),
      'control-room': normalizeLocation('control-room', input.locations?.['control-room'], fallback.locations['control-room']),
      'escape-bay': normalizeLocation('escape-bay', input.locations?.['escape-bay'], fallback.locations['escape-bay'])
    }
  };
}

function normalizeLocation(id: LocationId, input: Partial<LocationDefinition> | undefined, fallback: LocationDefinition): LocationDefinition {
  return {
    id,
    label: input?.label || fallback.label,
    description: input?.description || fallback.description,
    atmosphere: input?.atmosphere || fallback.atmosphere,
    connected: fallback.connected,
    pointsOfInterest: input?.pointsOfInterest?.length ? input.pointsOfInterest : fallback.pointsOfInterest
  };
}

export function getItemLabel(session: GameSession, itemId: ItemId) {
  return session.scenario.glossary.itemLabels[itemId] ?? ITEM_LIBRARY[itemId].label;
}

export function getTargetLabel(session: GameSession, targetId: string) {
  switch (targetId) {
    case 'locker':
      return session.world.locations['crew-quarters'].pointsOfInterest[0] ?? '储物点';
    case 'relay':
      return session.scenario.glossary.powerNodeLabel;
    case 'console':
      return session.world.locations['control-room'].pointsOfInterest[0] ?? '主控终端';
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
