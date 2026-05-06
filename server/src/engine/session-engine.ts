import {
  ARCHETYPES,
  CUSTOM_TAG_WHITELIST,
  ITEM_LIBRARY,
  SUBMARINE_TEMPLATE,
  TAG_RULES,
  type ActionType,
  type ActorObservation,
  type CreateSessionRequest,
  type EventLogEntry,
  type FilteredAction,
  type GameSession,
  type ItemId,
  type LocationId,
  type NpcIntentDecision,
  type ObjectiveState,
  type ParsedAction,
  type Resolution,
  type SaveMeta,
  type SelectedRoleProfile,
  type SessionSnapshot,
  type SkillKey,
  type StoryBeat,
  type StoryNpc,
  type StoryScenario,
  type TagId,
  type TurnOrderEntry
} from '@wax-museum/shared';

const FREE_ACTIONS = new Set<ActionType>(['inspect', 'inventory', 'help']);
const LOG_TAIL_SIZE = 8;
const INITIAL_HP = 3;
const INITIAL_SAN = 3;
const INITIAL_OXYGEN = 12;
const INITIAL_DANGER = 0;
const MAX_HP = INITIAL_HP;
const DEFAULT_MAX_ROUNDS = 20;
const MIN_ROUNDS = 4;
const MAX_ROUNDS = 20;
const PLAYER_ACTOR_ID = 'player';

const ACTION_POINT_BASE_COST: Record<ActionType, number> = {
  inspect: 1,
  inventory: 0,
  help: 0,
  move: 2,
  repair: 3,
  force: 3,
  use_item: 2,
  persuade: 2
};

type TargetId =
  | 'location'
  | 'locker'
  | 'relay'
  | 'console'
  | 'cabinet'
  | 'survivor'
  | 'bulkhead'
  | 'escape-pod'
  | 'self';

export interface EnginePresentation {
  publicText: string;
  systemText: string;
}

export interface EngineResult {
  session: GameSession;
  filteredAction: FilteredAction;
  resolution: Resolution;
  presentation: EnginePresentation;
}

interface NpcTurnOutcome {
  publicText: string;
  systemText: string;
  dangerDelta: number;
  damage: number;
  stateChanges: string[];
}

interface TurnAdvanceOutcome {
  publicText: string;
  systemText: string;
  stateChanges: string[];
  dangerDelta: number;
  damage: number;
}

export type NpcIntentDecider = (input: {
  session: GameSession;
  npc: StoryNpc;
  observation: ActorObservation;
}) => Promise<NpcIntentDecision | null>;

function requireLocation(session: Pick<GameSession, 'world'>, locationId: LocationId) {
  const location = session.world.locations[locationId];
  if (!location) {
    throw new Error(`故事地点不存在：${locationId}`);
  }
  return location;
}

export function createNewSession(request: CreateSessionRequest, scenario?: StoryScenario): GameSession {
  const activeScenario = scenario ?? createScenarioFromTemplate();
  const generatedNpcPool = buildNpcPoolFromRoles(
    request.generatedRoles ?? [],
    request.selectedRole?.id ?? null,
    activeScenario
  );
  if (generatedNpcPool.length > 0) {
    activeScenario.npcs = generatedNpcPool;
  }
  const startLocationId = getStartLocationId(activeScenario);
  const selectedRole = request.selectedRole;
  const archetype = selectedRole ? null : ARCHETYPES.find((entry) => entry.id === request.archetypeId);
  if (!selectedRole && !archetype) {
    throw new Error('未知的角色模板。');
  }

  const customTag = request.customTag.trim();
  const maxRounds = activeScenario.storyGameMode === 'versus' ? undefined : normalizeRoundCount(request.roundCount);
  const normalizedCustomTag = CUSTOM_TAG_WHITELIST.includes(customTag as TagId)
    ? (customTag as TagId)
    : null;
  const notes: string[] = [];

  if (request.customBackground.trim()) {
    notes.push(`背景备注：${request.customBackground.trim()}`);
  }

  if (selectedRole) {
    notes.push(`公开身份：${selectedRole.publicIdentity}`);
    notes.push(`隐藏动机：${selectedRole.hiddenDrive}`);
    notes.push(`关系钩子：${selectedRole.relationshipHook}`);
    notes.push(`角色专长：${selectedRole.specialty}`);
  }

  if (customTag && !normalizedCustomTag) {
    notes.push(`自定义标签“${customTag}”未进入规则白名单，仅保留为叙事备注。`);
  }

  const session: GameSession = {
    sessionId: createSessionId(),
    phase: 'active',
    scenario: structuredClone(activeScenario),
    player: {
      archetypeId: selectedRole?.id || archetype!.id,
      archetypeLabel: selectedRole?.label || archetype!.label,
      customBackground: request.customBackground.trim(),
      customTag: customTag || null,
      notes,
      stats: selectedRole ? { ...selectedRole.stats } : { ...archetype!.stats },
      tags: normalizedCustomTag
        ? [selectedRole?.coreTag ?? archetype!.defaultTag, normalizedCustomTag]
        : [selectedRole?.coreTag ?? archetype!.defaultTag],
      hp: INITIAL_HP,
      san: INITIAL_SAN,
      inventory: [...(selectedRole?.startingItems ?? archetype!.startingItems)],
      locationId: startLocationId,
      secretAgenda: selectedRole
        ? {
            ...selectedRole.secretAgenda,
            progress: 0,
            status: 'active'
          }
        : null,
      settingPack: selectedRole?.settingPack ?? null
    },
    world: {
      templateId: activeScenario.id,
      oxygen: activeScenario.countdown.max,
      danger: INITIAL_DANGER,
      turn: 0,
      maxRounds,
      currentRound: 1,
      playerActionPoints: 0,
      npcActionPoints: {},
      turnOrder: [],
      activeActorId: PLAYER_ACTOR_ID,
      storyBeatIndex: activeScenario.gameplayMode === 'llm' ? 0 : undefined,
      locations: structuredClone(activeScenario.locations),
      visitedLocations: [startLocationId],
      flags: {
        wrenchFound: false,
        powerRestored: false,
        keycardHinted: false,
        keycardRecovered: false,
        consoleDecoded: false,
        escapeBayUnlocked: false,
        launchInspected: false,
        launchReady: false,
        escapeLaunched: false,
        survivorPresent: true,
        survivorHelped: false
      }
    },
    objectives: createEmptyObjectives(),
    eventLog: [],
    saveMeta: createEmptySaveMeta()
  };

  startRound(session, Math.random);
  refreshDerivedState(session);

  session.eventLog.push({
    step: 0,
    intent: '开局',
    filteredAction: '任务简报',
    tier: 'success',
    publicText: `${activeScenario.openingLine} 你从${requireLocation(session, session.player.locationId).label}醒来，四周只剩零碎回声。`,
    systemText: session.objectives.dynamicGuide,
    timestamp: new Date().toISOString()
  });

  return refreshDerivedState(session);
}

function buildNpcPoolFromRoles(
  roles: SelectedRoleProfile[],
  selectedRoleId: string | null,
  scenario: StoryScenario
): StoryNpc[] {
  if (!Array.isArray(roles) || roles.length === 0) {
    return [];
  }

  const locationIds = Object.keys(scenario.locations) as LocationId[];
  if (locationIds.length === 0) {
    return [];
  }

  return roles
    .filter((role) => role.id !== selectedRoleId)
    .slice(0, 6)
    .map((role, index) => {
      const locationId = locationIds[index % locationIds.length] ?? locationIds[0]!;
      const attitude = inferNpcAttitude(role.coreTag, index);
      return {
        id: role.id,
        name: role.label,
        publicIdentity: role.publicIdentity,
        hiddenDrive: role.hiddenDrive,
        attitude,
        locationId,
        clue: role.relationshipHook,
        status: buildNpcPublicStatus(attitude),
        motiveAnchor: role.settingPack?.immediateNeed ?? role.hiddenDrive,
        interactionTips: [
          role.settingPack?.interactionGuide.trustGain ?? '先给对方可验证的小信息。',
          role.settingPack?.interactionGuide.bargainingChip ?? role.specialty,
          ...(role.settingPack?.interactionGuide.tabooTopics?.slice(0, 1).map((entry) => `避免触碰：${entry}`) ?? [])
        ],
        privateState: {
          coreGoal: role.hiddenDrive,
          shortTermGoal: role.settingPack?.immediateNeed ?? '先确保自己在当前回合不吃亏。',
          strategy: role.settingPack?.actionTendencies?.[0] ?? role.specialty,
          stress: 0,
          memory: [],
          lastAction: 'observe'
        }
      };
    });
}

function createSessionId() {
  return globalThis.crypto?.randomUUID?.() ?? `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getItemLabel(session: GameSession, itemId: ItemId) {
  return session.scenario.glossary.itemLabels[itemId] ?? ITEM_LIBRARY[itemId].label;
}

function getTargetLabel(session: GameSession, targetId: string) {
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

function getSceneObject(session: Pick<GameSession, 'world'>, objectId: string) {
  for (const location of Object.values(session.world.locations)) {
    const sceneObject = (location.sceneObjects ?? []).find((entry) => entry.id === objectId);
    if (sceneObject) {
      return sceneObject;
    }
  }
  return null;
}

function mapObjectIdToTargetId(objectId: string | undefined): TargetId | null {
  switch (objectId) {
    case 'crew-locker':
      return 'locker';
    case 'engine-relay':
      return 'relay';
    case 'control-console':
      return 'console';
    case 'med-cabinet':
      return 'cabinet';
    case 'med-survivor':
      return 'survivor';
    case 'control-bulkhead':
      return 'bulkhead';
    case 'escape-pod':
      return 'escape-pod';
    default:
      return null;
  }
}

function buildNpcPublicStatus(attitude: StoryNpc['attitude']) {
  if (attitude === 'friendly') {
    return '正在尝试建立合作。';
  }
  if (attitude === 'hostile') {
    return '态度强硬，持续施压。';
  }
  return '保持观望，暂不表态。';
}

function inferNpcAttitude(tag: TagId, index: number): StoryNpc['attitude'] {
  if (tag === '说客' || tag === '战地急救') {
    return 'friendly';
  }
  if (tag === '钢铁意志' || tag === '危机嗅觉') {
    return 'hostile';
  }
  return index % 2 === 0 ? 'neutral' : 'friendly';
}

function normalizeRoundCount(input: number | undefined) {
  if (typeof input !== 'number' || !Number.isFinite(input)) {
    return DEFAULT_MAX_ROUNDS;
  }
  return Math.max(MIN_ROUNDS, Math.min(MAX_ROUNDS, Math.round(input)));
}

function getPrimarySkillForAction(actionType: ActionType): SkillKey {
  if (actionType === 'persuade') return 'empathy';
  if (actionType === 'repair' || actionType === 'inspect' || actionType === 'use_item') return 'mind';
  return 'physique';
}

function getPlayerActionPointCost(session: GameSession, actionType: ActionType) {
  return FREE_ACTIONS.has(actionType) ? 0 : 1;
}

function getPlayerRoundActionPoints(session: GameSession) {
  const average = (session.player.stats.physique + session.player.stats.mind + session.player.stats.empathy) / 3;
  let ap = average >= 4 ? 4 : average <= 2 ? 2 : 3;
  if (session.player.hp <= 1) ap -= 1;
  if (session.player.san <= 1) ap -= 1;
  if (session.world.danger >= 6) ap -= 1;
  return clamp(ap, 2, 4);
}

function getNpcPseudoStats(npc: StoryNpc) {
  if (npc.attitude === 'hostile') {
    return { physique: 4, mind: 2, empathy: 1 } as const;
  }
  if (npc.attitude === 'friendly') {
    return { physique: 2, mind: 3, empathy: 4 } as const;
  }
  return { physique: 3, mind: 3, empathy: 2 } as const;
}

function getNpcActionPointCost(npc: StoryNpc, actionType: ActionType) {
  return FREE_ACTIONS.has(actionType) ? 0 : 1;
}

function getNpcRoundActionPoints(npc: StoryNpc) {
  const stats = getNpcPseudoStats(npc);
  const average = (stats.physique + stats.mind + stats.empathy) / 3;
  let ap = average >= 3.3 ? 4 : average <= 2.3 ? 2 : 3;
  const stress = npc.privateState?.stress ?? 0;
  if (stress >= 4) ap -= 1;
  return clamp(ap, 2, 4);
}

function refreshRoundActionPoints(session: GameSession) {
  session.world.playerActionPoints = getPlayerRoundActionPoints(session);
  const npcs = session.scenario.npcs ?? [];
  const npcActionPoints: Record<string, number> = {};
  npcs.forEach((npc) => {
    npcActionPoints[npc.id] = getNpcRoundActionPoints(npc);
  });
  session.world.npcActionPoints = npcActionPoints;
}

function rollTwoDice(randomSource: () => number) {
  const dieA = Math.floor(randomSource() * 6) + 1;
  const dieB = Math.floor(randomSource() * 6) + 1;
  return dieA + dieB;
}

function buildTurnOrder(session: GameSession, randomSource: () => number): TurnOrderEntry[] {
  const entries: TurnOrderEntry[] = [
    {
      actorId: PLAYER_ACTOR_ID,
      actorLabel: session.player.archetypeLabel,
      actorType: 'player',
      initiative: rollTwoDice(randomSource)
    },
    ...((session.scenario.npcs ?? []).map((npc) => ({
      actorId: npc.id,
      actorLabel: npc.name,
      actorType: 'npc' as const,
      initiative: rollTwoDice(randomSource)
    })))
  ];

  return entries.sort((left, right) => {
    if (right.initiative !== left.initiative) {
      return right.initiative - left.initiative;
    }
    if (left.actorType !== right.actorType) {
      return left.actorType === 'player' ? -1 : 1;
    }
    return left.actorLabel.localeCompare(right.actorLabel, 'zh-Hans-CN');
  });
}

function startRound(session: GameSession, randomSource: () => number) {
  refreshRoundActionPoints(session);
  session.world.turnOrder = buildTurnOrder(session, randomSource);
  session.world.activeActorId = session.world.turnOrder[0]?.actorId ?? PLAYER_ACTOR_ID;
}

function getMaxCountdown(session: GameSession) {
  return session.scenario.countdown.max + 2;
}

function getRoundCapLabel(session: GameSession) {
  return session.world.maxRounds ? String(session.world.maxRounds) : '无限';
}

function getStartLocationId(scenario: StoryScenario): LocationId {
  if (isDynamicScenario(scenario)) {
    return scenario.beats?.[0]?.locationId ?? Object.keys(scenario.locations)[0] ?? 'crew-quarters';
  }
  return 'crew-quarters';
}

function getCurrentActor(session: GameSession) {
  const activeActorId = session.world.activeActorId ?? PLAYER_ACTOR_ID;
  if (activeActorId === PLAYER_ACTOR_ID) {
    return {
      actorId: PLAYER_ACTOR_ID,
      actorLabel: session.player.archetypeLabel,
      actorType: 'player' as const
    };
  }

  const npc = (session.scenario.npcs ?? []).find((entry) => entry.id === activeActorId);
  if (!npc) {
    return {
      actorId: PLAYER_ACTOR_ID,
      actorLabel: session.player.archetypeLabel,
      actorType: 'player' as const
    };
  }

  return {
    actorId: npc.id,
    actorLabel: npc.name,
    actorType: 'npc' as const
  };
}

function advanceToNextActor(session: GameSession) {
  const order = session.world.turnOrder ?? [];
  if (!order.length) {
    session.world.activeActorId = PLAYER_ACTOR_ID;
    return false;
  }

  const currentId = session.world.activeActorId ?? order[0]?.actorId ?? PLAYER_ACTOR_ID;
  const currentIndex = order.findIndex((entry) => entry.actorId === currentId);
  const nextIndex = currentIndex + 1;
  if (currentIndex === -1) {
    return false;
  }
  if (nextIndex >= order.length) {
    return false;
  }
  session.world.activeActorId = order[nextIndex]!.actorId;
  return true;
}

function beginNextRound(session: GameSession, randomSource: () => number, stateChanges: string[]) {
  session.world.currentRound = (session.world.currentRound ?? 1) + 1;
  if (session.world.maxRounds !== undefined && (session.world.currentRound ?? 1) > session.world.maxRounds) {
    session.phase = 'failed';
    stateChanges.push('已达到最大回合数');
    return;
  }

  startRound(session, randomSource);
  const orderLabel = (session.world.turnOrder ?? [])
    .map((entry) => `${entry.actorLabel}(${entry.initiative})`)
    .join(' > ');
  stateChanges.push(`进入第 ${session.world.currentRound} 回合`);
  if (orderLabel) {
    stateChanges.push(`先攻顺序：${orderLabel}`);
  }
}

function resolveNpcTurn(session: GameSession, npc: StoryNpc, randomSource: () => number): NpcTurnOutcome {
  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;
  const publicWorld = {
    turn: session.world.turn,
    oxygen: session.world.oxygen,
    danger: session.world.danger,
    playerLocationId: session.player.locationId,
    playerHp: session.player.hp
  };

  const apPool = session.world.npcActionPoints ?? {};
  if (typeof apPool[npc.id] !== 'number') {
    apPool[npc.id] = getNpcRoundActionPoints(npc);
  }
  session.world.npcActionPoints = apPool;

  if ((apPool[npc.id] ?? 0) > 0) {
    ensureNpcPrivateState(npc);
    const action = decideNpcAction(session, npc, publicWorld, randomSource);
    const actionType: ActionType =
      action.type === 'share-clue'
        ? 'persuade'
        : action.type === 'pressure'
          ? 'force'
          : action.type === 'reposition'
            ? 'move'
            : 'inspect';
    const actionCost = getNpcActionPointCost(npc, actionType);

    if ((apPool[npc.id] ?? 0) >= actionCost) {
      apPool[npc.id] = Math.max(0, (apPool[npc.id] ?? 0) - actionCost);
      session.world.turn += 1;

      if (action.type === 'share-clue') {
        npc.status = '压低声音提供了关键信息。';
        publicSnippets.push(`${npc.name}在${requireLocation(session, npc.locationId).label}提醒你：${npc.clue}`);
        dangerDelta -= 1;
        stateChanges.push(`NPC协助：${npc.name}降低了局势压力`);
      } else if (action.type === 'pressure') {
        npc.status = '通过言行持续施压。';
        publicSnippets.push(`${npc.name}忽然逼近一步，明显在试探你的底线。`);
        dangerDelta += 1;
        stateChanges.push(`NPC施压：${npc.name}让局势更紧绷`);
        if (randomSource() < 0.25) {
          damage += 1;
          stateChanges.push(`NPC冲突：${npc.name}造成了直接伤害`);
        }
      } else if (action.type === 'observe') {
        npc.status = '保持观察，暂时不直接介入。';
        if (randomSource() < 0.2) {
          publicSnippets.push(`${npc.name}没有接话，只是记下了你刚才的动作。`);
        }
      } else if (action.type === 'reposition') {
        const moveCandidates = getNpcMoveCandidates(session, npc.locationId);
        const nextLocation = pickBestNpcMove(session, npc, moveCandidates, publicWorld, randomSource);
        if (nextLocation && nextLocation !== npc.locationId) {
          npc.locationId = nextLocation;
          npc.status = `已转移到${requireLocation(session, nextLocation).label}附近活动。`;
          publicSnippets.push(`${npc.name}转移到了${requireLocation(session, nextLocation).label}。`);
        }
      }

      npc.privateState!.stress = clamp(npc.privateState!.stress + action.stressDelta, 0, 5);
      npc.privateState!.lastAction = action.type;
      npc.privateState!.memory = [action.memory, ...npc.privateState!.memory].slice(0, 6);
      stateChanges.push(`${npc.name} 行动点 -${actionCost}`);
    } else {
      apPool[npc.id] = 0;
    }
  }

  return {
    publicText: publicSnippets.slice(0, 2).join(' '),
    systemText: systemSnippets.join(' / '),
    dangerDelta,
    damage,
    stateChanges
  };
}

function resolveTurnQueueUntilPlayer(session: GameSession, randomSource: () => number): TurnAdvanceOutcome {
  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;
  let safety = 0;

  while (session.phase === 'active' && safety < 64) {
    safety += 1;
    const currentActor = getCurrentActor(session);
    if (currentActor.actorType === 'player') {
      break;
    }

    const npc = (session.scenario.npcs ?? []).find((entry) => entry.id === currentActor.actorId);
    if (!npc) {
      if (!advanceToNextActor(session)) {
        beginNextRound(session, randomSource, stateChanges);
      }
      continue;
    }

    const npcOutcome = resolveNpcTurn(session, npc, randomSource);
    if (npcOutcome.publicText) {
      publicSnippets.push(npcOutcome.publicText);
    }
    if (npcOutcome.systemText) {
      systemSnippets.push(npcOutcome.systemText);
    }
    stateChanges.push(...npcOutcome.stateChanges);
    dangerDelta += npcOutcome.dangerDelta;
    damage += npcOutcome.damage;

    const pairOutcome = resolveNpcPairInteractions(session, randomSource);
    publicSnippets.push(...pairOutcome.publicSnippets);
    systemSnippets.push(...pairOutcome.systemSnippets);
    stateChanges.push(...pairOutcome.stateChanges);
    dangerDelta += pairOutcome.dangerDelta;
    damage += pairOutcome.damage;

    if (!advanceToNextActor(session)) {
      beginNextRound(session, randomSource, stateChanges);
    }
  }

  return {
    publicText: publicSnippets.filter(Boolean).slice(0, 3).join(' '),
    systemText: systemSnippets.filter(Boolean).join(' / '),
    stateChanges,
    dangerDelta,
    damage
  };
}

async function resolveNpcTurnWithDecider(
  session: GameSession,
  npc: StoryNpc,
  randomSource: () => number,
  npcIntentDecider?: NpcIntentDecider
): Promise<NpcTurnOutcome> {
  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;
  const publicWorld = {
    turn: session.world.turn,
    oxygen: session.world.oxygen,
    danger: session.world.danger,
    playerLocationId: session.player.locationId,
    playerHp: session.player.hp
  };

  const apPool = session.world.npcActionPoints ?? {};
  if (typeof apPool[npc.id] !== 'number') {
    apPool[npc.id] = getNpcRoundActionPoints(npc);
  }
  session.world.npcActionPoints = apPool;

  if ((apPool[npc.id] ?? 0) > 0) {
    ensureNpcPrivateState(npc);
    const observation = buildActorObservation(session, npc.id);
    const llmDecision = npcIntentDecider
      ? await npcIntentDecider({ session, npc, observation }).catch(() => null)
      : null;
    const action = coerceNpcDecision(session, npc, publicWorld, llmDecision, randomSource);
    const actionType: ActionType =
      action.type === 'share-clue'
        ? 'persuade'
        : action.type === 'pressure'
          ? 'force'
          : action.type === 'reposition'
            ? 'move'
            : 'inspect';
    const actionCost = getNpcActionPointCost(npc, actionType);

    if ((apPool[npc.id] ?? 0) >= actionCost) {
      apPool[npc.id] = Math.max(0, (apPool[npc.id] ?? 0) - actionCost);
      session.world.turn += 1;

      if (action.type === 'share-clue') {
        npc.status = '压低声音提供了关键信息。';
        publicSnippets.push(`${npc.name}在${requireLocation(session, npc.locationId).label}提醒你：${npc.clue}`);
        dangerDelta -= 1;
        stateChanges.push(`NPC协助：${npc.name}降低了局势压力`);
      } else if (action.type === 'pressure') {
        npc.status = '通过言行持续施压。';
        publicSnippets.push(`${npc.name}忽然逼近一步，明显在试探你的底线。`);
        dangerDelta += 1;
        stateChanges.push(`NPC施压：${npc.name}让局势更紧绷`);
        if (randomSource() < 0.25) {
          damage += 1;
          stateChanges.push(`NPC冲突：${npc.name}造成了直接伤害`);
        }
      } else if (action.type === 'observe') {
        npc.status = '保持观察，暂时不直接介入。';
        if (randomSource() < 0.2) {
          publicSnippets.push(`${npc.name}没有接话，只是记下了眼前局势。`);
        }
      } else if (action.type === 'reposition') {
        const moveCandidates = getNpcMoveCandidates(session, npc.locationId);
        const nextLocation = pickBestNpcMove(session, npc, moveCandidates, publicWorld, randomSource);
        if (nextLocation && nextLocation !== npc.locationId) {
          npc.locationId = nextLocation;
          npc.status = `已转移到${requireLocation(session, nextLocation).label}附近活动。`;
          publicSnippets.push(`${npc.name}转移到了${requireLocation(session, nextLocation).label}。`);
        }
      }

      npc.privateState!.stress = clamp(npc.privateState!.stress + action.stressDelta, 0, 5);
      npc.privateState!.lastAction = action.type;
      npc.privateState!.memory = [action.memory, ...npc.privateState!.memory].slice(0, 6);
      stateChanges.push(`${npc.name} 行动点 -${actionCost}`);
    } else {
      apPool[npc.id] = 0;
    }
  }

  return { publicText: publicSnippets.slice(0, 2).join(' '), systemText: systemSnippets.join(' / '), dangerDelta, damage, stateChanges };
}

async function resolveTurnQueueUntilPlayerWithDecider(
  session: GameSession,
  randomSource: () => number,
  npcIntentDecider?: NpcIntentDecider
): Promise<TurnAdvanceOutcome> {
  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;
  let safety = 0;

  while (session.phase === 'active' && safety < 64) {
    safety += 1;
    const currentActor = getCurrentActor(session);
    if (currentActor.actorType === 'player') break;

    const npc = (session.scenario.npcs ?? []).find((entry) => entry.id === currentActor.actorId);
    if (!npc) {
      if (!advanceToNextActor(session)) beginNextRound(session, randomSource, stateChanges);
      continue;
    }

    const npcOutcome = await resolveNpcTurnWithDecider(session, npc, randomSource, npcIntentDecider);
    if (npcOutcome.publicText) publicSnippets.push(npcOutcome.publicText);
    if (npcOutcome.systemText) systemSnippets.push(npcOutcome.systemText);
    stateChanges.push(...npcOutcome.stateChanges);
    dangerDelta += npcOutcome.dangerDelta;
    damage += npcOutcome.damage;

    const pairOutcome = resolveNpcPairInteractions(session, randomSource);
    publicSnippets.push(...pairOutcome.publicSnippets);
    systemSnippets.push(...pairOutcome.systemSnippets);
    stateChanges.push(...pairOutcome.stateChanges);
    dangerDelta += pairOutcome.dangerDelta;
    damage += pairOutcome.damage;

    if (!advanceToNextActor(session)) beginNextRound(session, randomSource, stateChanges);
  }

  return { publicText: publicSnippets.filter(Boolean).slice(0, 3).join(' '), systemText: systemSnippets.filter(Boolean).join(' / '), stateChanges, dangerDelta, damage };
}

export function buildSnapshot(session: GameSession): SessionSnapshot {
  const scenario = structuredClone(session.scenario);
  if (scenario.npcs?.length) {
    scenario.npcs = scenario.npcs.map((npc) => ({
      ...npc,
      hiddenDrive: '未知',
      motiveAnchor: undefined,
      interactionTips: undefined,
      privateState: undefined
    }));
  }

  return {
    sessionId: session.sessionId,
    phase: session.phase,
    scenario,
    player: structuredClone(session.player),
    world: structuredClone(session.world),
    objectives: structuredClone(session.objectives),
    logTail: session.eventLog.slice(-LOG_TAIL_SIZE)
  };
}

export function buildActorObservation(session: GameSession, actorId: string): ActorObservation {
  const isPlayer = actorId === PLAYER_ACTOR_ID;
  const npc = isPlayer ? null : (session.scenario.npcs ?? []).find((entry) => entry.id === actorId) ?? null;
  const actorLocationId = isPlayer ? session.player.locationId : npc?.locationId ?? session.player.locationId;
  const currentLocation = requireLocation(session, actorLocationId);
  const visibleLocationIds = new Set<LocationId>([actorLocationId, ...currentLocation.connected]);
  const visibleNpcs = (session.scenario.npcs ?? [])
    .filter((entry) => visibleLocationIds.has(entry.locationId))
    .map((entry) => ({
      id: entry.id,
      name: entry.name,
      publicIdentity: entry.publicIdentity,
      attitude: entry.attitude,
      locationId: entry.locationId,
      status: entry.status,
      clue: entry.locationId === actorLocationId ? entry.clue : undefined
    }));

  return {
    actorId,
    actorType: isPlayer ? 'player' : 'npc',
    actorLabel: isPlayer ? session.player.archetypeLabel : npc?.name ?? actorId,
    currentLocation,
    visibleLocations: Array.from(visibleLocationIds).map((locationId) => requireLocation(session, locationId)),
    visibleSceneObjects: currentLocation.sceneObjects ?? [],
    visibleNpcs,
    publicWorld: {
      turn: session.world.turn,
      currentRound: session.world.currentRound,
      maxRounds: session.world.maxRounds,
      countdownLabel: session.scenario.countdown.shortLabel,
      countdownValue: session.world.oxygen,
      danger: session.world.danger,
      activeActorId: session.world.activeActorId
    },
    playerPublic: {
      locationId: session.player.locationId,
      hp: session.player.hp,
      san: session.player.san
    },
    inventory: isPlayer ? [...session.player.inventory] : [],
    availableActionsHint: listActorActions(session, actorId),
    recentPublicEvents: session.eventLog.slice(-LOG_TAIL_SIZE).map((entry) => entry.publicText),
    privateBrief: npc?.privateState
      ? {
          coreGoal: npc.privateState.coreGoal,
          shortTermGoal: npc.privateState.shortTermGoal,
          strategy: npc.privateState.strategy,
          stress: npc.privateState.stress,
          memory: [...npc.privateState.memory]
        }
      : undefined
  };
}

export function filterAction(session: GameSession, parsed: ParsedAction): FilteredAction {
  const filteredParsed = applyStoryFilter(session, parsed);
  if (isDynamicScenario(session.scenario)) {
    return filterDynamicAction(session, filteredParsed);
  }

  const currentLocation = requireLocation(session, session.player.locationId);
  const targetId = ((mapObjectIdToTargetId(filteredParsed.objectId) ?? filteredParsed.targetId) ?? 'location') as TargetId;

  if (filteredParsed.type === 'inventory' || filteredParsed.type === 'help') {
    return { ...filteredParsed, validity: 'accepted' };
  }

  if (filteredParsed.type === 'inspect') {
    return {
      ...filteredParsed,
      targetId,
      targetLabel: filteredParsed.objectId
        ? (getSceneObject(session, filteredParsed.objectId)?.label ?? filteredParsed.targetLabel)
        : (filteredParsed.targetLabel || currentLocation.label),
      validity: 'accepted'
    };
  }

  if (filteredParsed.type === 'move') {
    if (!filteredParsed.locationId) {
      return rejectAction(filteredParsed, '移动目标不明确。');
    }

    if (!session.world.locations[filteredParsed.locationId]) {
      return rejectAction(filteredParsed, '这个地点不存在于当前地图。');
    }

    if (filteredParsed.locationId === session.player.locationId) {
      return {
        ...filteredParsed,
        type: 'inspect',
        consumesTurn: false,
        validity: 'redirected',
        redirectedFrom: 'move',
        targetId: 'location',
        targetLabel: currentLocation.label,
        reason: '你已经在这里了，先观察周围更有帮助。'
      };
    }

    return { ...filteredParsed, validity: 'accepted' };
  }

  if (filteredParsed.type === 'repair') {
    if (session.player.locationId !== 'engine-room') {
      return rejectAction(filteredParsed, `${getTargetLabel(session, 'relay')}不在这里。`);
    }

    if (!hasItem(session, 'insulated-wrench')) {
      return rejectAction(filteredParsed, `你需要先找到${getItemLabel(session, 'insulated-wrench')}。`);
    }

    return {
      ...filteredParsed,
      targetId: 'relay',
      targetLabel: getTargetLabel(session, 'relay'),
      validity: 'accepted'
    };
  }

  if (filteredParsed.type === 'force') {
    const inferredTarget = inferForceTarget(session, targetId);
    if (!inferredTarget) {
      return rejectAction(filteredParsed, '这里没有适合强行破开的目标。');
    }

    return {
      ...filteredParsed,
      targetId: inferredTarget,
      targetLabel: getTargetLabel(session, inferredTarget),
      validity: 'accepted'
    };
  }

  if (filteredParsed.type === 'persuade') {
    const roomNpcs = getNpcsAtPlayerLocation(session);
    if (roomNpcs.length > 0) {
      const targetNpc = pickNpcPersuasionTarget(roomNpcs, filteredParsed.targetLabel);
      return {
        ...filteredParsed,
        targetId: `npc:${targetNpc.id}`,
        targetLabel: targetNpc.name,
        validity: 'accepted'
      };
    }

    if (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent) {
      return rejectAction(filteredParsed, '这里没人能与你互动。');
    }

    return {
      ...filteredParsed,
      targetId: 'survivor',
      targetLabel: getTargetLabel(session, 'survivor'),
      validity: 'accepted'
    };
  }

  if (filteredParsed.type === 'use_item') {
    const inferred = inferUseItemTarget(session, filteredParsed);
    if (!inferred) {
      return rejectAction(filteredParsed, '现在没有合适的使用对象。');
    }

    if (inferred.toolId && !hasItem(session, inferred.toolId)) {
      return rejectAction(filteredParsed, `你身上没有${getItemLabel(session, inferred.toolId)}。`);
    }

    if (inferred.targetId === 'bulkhead' && session.player.locationId !== 'control-room') {
      return rejectAction(parsed, `只有在${requireLocation(session, 'control-room').label}的${getTargetLabel(session, 'bulkhead')}前才能使用${getItemLabel(session, 'captain-keycard')}。`);
    }

    if (inferred.targetId === 'escape-pod' && session.player.locationId !== 'escape-bay') {
      return rejectAction(parsed, `${getTargetLabel(session, 'escape-pod')}还没有准备好。`);
    }

    return {
      ...filteredParsed,
      ...inferred,
      validity: 'accepted'
    };
  }

  return rejectAction(filteredParsed, '无法识别的行动。');
}

export function applyParsedAction(
  session: GameSession,
  parsed: ParsedAction,
  randomSource: () => number = Math.random
): EngineResult {
  const working = structuredClone(session) as GameSession;
  const queueOutcome = resolveTurnQueueUntilPlayer(working, randomSource);
  const filteredAction = filterAction(working, parsed);
  const presentation: EnginePresentation = {
    publicText: queueOutcome.publicText,
    systemText: queueOutcome.systemText
  };

  let resolution: Resolution;
  let skippedTurn = false;

  if (queueOutcome.dangerDelta !== 0) {
    working.world.danger = clamp(working.world.danger + queueOutcome.dangerDelta, 0, 9);
  }
  if (queueOutcome.damage > 0) {
    working.player.hp = clamp(working.player.hp - queueOutcome.damage, 0, MAX_HP);
  }

  if (working.phase !== 'active') {
    resolution = {
      tier: 'fail',
      summary: '本局已结束。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 局势已经无法继续推进。`.trim();
    presentation.systemText = `${presentation.systemText} / 本局已结束。`.trim();
  } else if (getCurrentActor(working).actorType !== 'player') {
    resolution = {
      tier: 'fail',
      summary: '当前还没轮到你行动。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 其他角色还在行动，你暂时插不上手。`.trim();
    presentation.systemText = `${presentation.systemText} / 等待轮到你。`.trim();
  } else if (/(结束回合|跳过|skip)/i.test(parsed.rawIntent)) {
    const remainingAp = working.world.playerActionPoints ?? 0;
    working.world.playerActionPoints = 0;
    skippedTurn = true;
    resolution = {
      tier: 'cost',
      summary: '你提前结束了自己的回合。',
      stateChanges: [...queueOutcome.stateChanges, `放弃剩余行动点 ${remainingAp}`],
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 你压下继续行动的冲动，把剩余空档让给了其他人。`.trim();
    presentation.systemText = `${presentation.systemText} / 你的回合提前结束。`.trim();
  } else {

  if (filteredAction.validity === 'rejected') {
    resolution = {
      tier: 'fail',
      summary: filteredAction.reason ?? '行动被现实滤镜拒绝。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} ${filteredAction.reason ?? '你的意图没有通过现实滤镜。'}`.trim();
    presentation.systemText = `${presentation.systemText} / 状态未变化。`.trim();
  } else {
    const actionPointCost = filteredAction.consumesTurn ? getPlayerActionPointCost(working, filteredAction.type) : 0;
    if (filteredAction.consumesTurn && (working.world.playerActionPoints ?? 0) < actionPointCost) {
      resolution = {
        tier: 'fail',
        summary: '本回合行动点不足。',
        stateChanges: queueOutcome.stateChanges,
        oxygenCost: 0,
        dangerDelta: queueOutcome.dangerDelta,
        damage: queueOutcome.damage
      };
      presentation.publicText = `${presentation.publicText} 你想执行这个动作，但本回合行动点不足（需要 ${actionPointCost}，剩余 ${working.world.playerActionPoints ?? 0}）。`.trim();
      presentation.systemText = `${presentation.systemText} / 请先使用低消耗动作，或结束回合。`.trim();
    } else {
    const outcome = executeAcceptedAction(working, filteredAction, randomSource);
    resolution = outcome.resolution;
    resolution.stateChanges.unshift(...queueOutcome.stateChanges);
    resolution.dangerDelta += queueOutcome.dangerDelta;
    resolution.damage += queueOutcome.damage;
    presentation.publicText = `${presentation.publicText} ${outcome.publicText}`.trim();
    presentation.systemText = `${presentation.systemText} / ${outcome.systemText}`.trim();

    if (filteredAction.consumesTurn) {
      working.world.turn += 1;
      working.world.playerActionPoints = Math.max(0, (working.world.playerActionPoints ?? 0) - actionPointCost);
      resolution.stateChanges.unshift(`行动点 -${actionPointCost}`);
    }

    if (filteredAction.type === 'move' && filteredAction.consumesTurn) {
      working.world.oxygen = clamp(working.world.oxygen - 1, 0, getMaxCountdown(working));
      resolution.oxygenCost = 1;
      resolution.stateChanges.unshift(`${working.scenario.countdown.shortLabel} -1`);
    }

    if (filteredAction.consumesTurn) {
      const pairOutcome = resolveNpcPairInteractions(working, randomSource);
      if (pairOutcome.publicSnippets.length) {
        presentation.publicText = `${presentation.publicText} ${pairOutcome.publicSnippets.join(' ')}`.trim();
      }
      if (pairOutcome.systemSnippets.length) {
        presentation.systemText = `${presentation.systemText} / ${pairOutcome.systemSnippets.join(' / ')}`.trim();
      }
      resolution.dangerDelta += pairOutcome.dangerDelta;
      resolution.damage += pairOutcome.damage;
      resolution.stateChanges.push(...pairOutcome.stateChanges);
    }

    const playerTurnEndsNow =
      filteredAction.consumesTurn &&
      (filteredAction.type === 'move' || (working.world.playerActionPoints ?? 0) <= 0);

    if (playerTurnEndsNow && working.phase === 'active') {
      if (!advanceToNextActor(working)) {
        beginNextRound(working, randomSource, resolution.stateChanges);
      }
      const nextQueue = resolveTurnQueueUntilPlayer(working, randomSource);
      if (nextQueue.publicText) {
        presentation.publicText = `${presentation.publicText} ${nextQueue.publicText}`.trim();
      }
      if (nextQueue.systemText) {
        presentation.systemText = `${presentation.systemText} / ${nextQueue.systemText}`.trim();
      }
      resolution.dangerDelta += nextQueue.dangerDelta;
      resolution.damage += nextQueue.damage;
      resolution.stateChanges.push(...nextQueue.stateChanges);
    }

    if (resolution.dangerDelta !== 0) {
      working.world.danger = clamp(working.world.danger + resolution.dangerDelta, 0, 9);
      resolution.stateChanges.push(formatDangerChange(resolution.dangerDelta));
    }

    if (resolution.damage > 0) {
      working.player.hp = clamp(working.player.hp - resolution.damage, 0, MAX_HP);
      resolution.stateChanges.push(`HP -${resolution.damage}`);
    }

    if (working.world.oxygen <= 0 || working.player.hp <= 0) {
      working.phase = 'failed';
      if (working.world.oxygen <= 0) {
        presentation.publicText += ` ${getCountdownEmptyNarration(working.scenario)}`;
      } else {
        presentation.publicText += ' 疼痛和失血让你再也站不起来。';
      }
    }

    if (working.world.flags.escapeLaunched) {
      working.phase = 'escaped';
    }
    }
  }
  }

  if (skippedTurn && working.phase === 'active') {
    if (!advanceToNextActor(working)) {
      beginNextRound(working, randomSource, resolution.stateChanges);
    }
    const nextQueue = resolveTurnQueueUntilPlayer(working, randomSource);
    if (nextQueue.publicText) {
      presentation.publicText = `${presentation.publicText} ${nextQueue.publicText}`.trim();
    }
    if (nextQueue.systemText) {
      presentation.systemText = `${presentation.systemText} / ${nextQueue.systemText}`.trim();
    }
    resolution.dangerDelta += nextQueue.dangerDelta;
    resolution.damage += nextQueue.damage;
    resolution.stateChanges.push(...nextQueue.stateChanges);
    if (resolution.dangerDelta !== 0) {
      working.world.danger = clamp(working.world.danger + nextQueue.dangerDelta, 0, 9);
    }
    if (resolution.damage > 0) {
      working.player.hp = clamp(working.player.hp - nextQueue.damage, 0, MAX_HP);
    }
  }

  refreshDerivedState(working);
  applySecretAgendaProgress(working, parsed.rawIntent, presentation.publicText);
  working.eventLog.push(createLogEntry(working, parsed.rawIntent, filteredAction, resolution, presentation));
  refreshDerivedState(working);

  return {
    session: working,
    filteredAction,
    resolution,
    presentation
  };
}

export async function applyParsedActionWithNpcAi(
  session: GameSession,
  parsed: ParsedAction,
  randomSource: () => number = Math.random,
  npcIntentDecider?: NpcIntentDecider
): Promise<EngineResult> {
  const working = structuredClone(session) as GameSession;
  const queueOutcome = await resolveTurnQueueUntilPlayerWithDecider(working, randomSource, npcIntentDecider);
  const filteredAction = filterAction(working, parsed);
  const presentation: EnginePresentation = {
    publicText: queueOutcome.publicText,
    systemText: queueOutcome.systemText
  };

  let resolution: Resolution;
  let skippedTurn = false;

  if (queueOutcome.dangerDelta !== 0) {
    working.world.danger = clamp(working.world.danger + queueOutcome.dangerDelta, 0, 9);
  }
  if (queueOutcome.damage > 0) {
    working.player.hp = clamp(working.player.hp - queueOutcome.damage, 0, MAX_HP);
  }

  if (working.phase !== 'active') {
    resolution = {
      tier: 'fail',
      summary: '本局已结束。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 局势已经无法继续推进。`.trim();
    presentation.systemText = `${presentation.systemText} / 本局已结束。`.trim();
  } else if (getCurrentActor(working).actorType !== 'player') {
    resolution = {
      tier: 'fail',
      summary: '当前还没轮到你行动。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 其他角色还在行动，你暂时插不上手。`.trim();
    presentation.systemText = `${presentation.systemText} / 等待轮到你。`.trim();
  } else if (/(结束回合|跳过|skip)/i.test(parsed.rawIntent)) {
    const remainingAp = working.world.playerActionPoints ?? 0;
    working.world.playerActionPoints = 0;
    skippedTurn = true;
    resolution = {
      tier: 'cost',
      summary: '你提前结束了自己的回合。',
      stateChanges: [...queueOutcome.stateChanges, `放弃剩余行动点 ${remainingAp}`],
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} 你压下继续行动的冲动，把剩余空档让给了其他人。`.trim();
    presentation.systemText = `${presentation.systemText} / 你的回合提前结束。`.trim();
  } else if (filteredAction.validity === 'rejected') {
    resolution = {
      tier: 'fail',
      summary: filteredAction.reason ?? '行动被现实滤镜拒绝。',
      stateChanges: queueOutcome.stateChanges,
      oxygenCost: 0,
      dangerDelta: queueOutcome.dangerDelta,
      damage: queueOutcome.damage
    };
    presentation.publicText = `${presentation.publicText} ${filteredAction.reason ?? '你的意图没有通过现实滤镜。'}`.trim();
    presentation.systemText = `${presentation.systemText} / 状态未变化。`.trim();
  } else {
    const actionPointCost = filteredAction.consumesTurn ? getPlayerActionPointCost(working, filteredAction.type) : 0;
    if (filteredAction.consumesTurn && (working.world.playerActionPoints ?? 0) < actionPointCost) {
      resolution = {
        tier: 'fail',
        summary: '本回合行动点不足。',
        stateChanges: queueOutcome.stateChanges,
        oxygenCost: 0,
        dangerDelta: queueOutcome.dangerDelta,
        damage: queueOutcome.damage
      };
      presentation.publicText = `${presentation.publicText} 你想执行这个动作，但本回合行动点不足（需要 ${actionPointCost}，剩余 ${working.world.playerActionPoints ?? 0}）。`.trim();
      presentation.systemText = `${presentation.systemText} / 请先使用低消耗动作，或结束回合。`.trim();
    } else {
      const outcome = executeAcceptedAction(working, filteredAction, randomSource);
      resolution = outcome.resolution;
      resolution.stateChanges.unshift(...queueOutcome.stateChanges);
      resolution.dangerDelta += queueOutcome.dangerDelta;
      resolution.damage += queueOutcome.damage;
      presentation.publicText = `${presentation.publicText} ${outcome.publicText}`.trim();
      presentation.systemText = `${presentation.systemText} / ${outcome.systemText}`.trim();

      if (filteredAction.consumesTurn) {
        working.world.turn += 1;
        working.world.playerActionPoints = Math.max(0, (working.world.playerActionPoints ?? 0) - actionPointCost);
        resolution.stateChanges.unshift(`行动点 -${actionPointCost}`);
      }

      if (filteredAction.type === 'move' && filteredAction.consumesTurn) {
        working.world.oxygen = clamp(working.world.oxygen - 1, 0, getMaxCountdown(working));
        resolution.oxygenCost = 1;
        resolution.stateChanges.unshift(`${working.scenario.countdown.shortLabel} -1`);
      }

      if (filteredAction.consumesTurn) {
        const pairOutcome = resolveNpcPairInteractions(working, randomSource);
        if (pairOutcome.publicSnippets.length) {
          presentation.publicText = `${presentation.publicText} ${pairOutcome.publicSnippets.join(' ')}`.trim();
        }
        if (pairOutcome.systemSnippets.length) {
          presentation.systemText = `${presentation.systemText} / ${pairOutcome.systemSnippets.join(' / ')}`.trim();
        }
        resolution.dangerDelta += pairOutcome.dangerDelta;
        resolution.damage += pairOutcome.damage;
        resolution.stateChanges.push(...pairOutcome.stateChanges);
      }

      const playerTurnEndsNow =
        filteredAction.consumesTurn &&
        (filteredAction.type === 'move' || (working.world.playerActionPoints ?? 0) <= 0);

      if (playerTurnEndsNow && working.phase === 'active') {
        if (!advanceToNextActor(working)) {
          beginNextRound(working, randomSource, resolution.stateChanges);
        }
        const nextQueue = await resolveTurnQueueUntilPlayerWithDecider(working, randomSource, npcIntentDecider);
        if (nextQueue.publicText) presentation.publicText = `${presentation.publicText} ${nextQueue.publicText}`.trim();
        if (nextQueue.systemText) presentation.systemText = `${presentation.systemText} / ${nextQueue.systemText}`.trim();
        resolution.dangerDelta += nextQueue.dangerDelta;
        resolution.damage += nextQueue.damage;
        resolution.stateChanges.push(...nextQueue.stateChanges);
      }

      if (resolution.dangerDelta !== 0) {
        working.world.danger = clamp(working.world.danger + resolution.dangerDelta, 0, 9);
        resolution.stateChanges.push(formatDangerChange(resolution.dangerDelta));
      }
      if (resolution.damage > 0) {
        working.player.hp = clamp(working.player.hp - resolution.damage, 0, MAX_HP);
        resolution.stateChanges.push(`HP -${resolution.damage}`);
      }
      if (working.world.oxygen <= 0 || working.player.hp <= 0) {
        working.phase = 'failed';
        presentation.publicText += working.world.oxygen <= 0
          ? ` ${getCountdownEmptyNarration(working.scenario)}`
          : ' 疼痛和失血让你再也站不起来。';
      }
      if (working.world.flags.escapeLaunched) {
        working.phase = 'escaped';
      }
    }
  }

  if (skippedTurn && working.phase === 'active') {
    if (!advanceToNextActor(working)) {
      beginNextRound(working, randomSource, resolution.stateChanges);
    }
    const nextQueue = await resolveTurnQueueUntilPlayerWithDecider(working, randomSource, npcIntentDecider);
    if (nextQueue.publicText) presentation.publicText = `${presentation.publicText} ${nextQueue.publicText}`.trim();
    if (nextQueue.systemText) presentation.systemText = `${presentation.systemText} / ${nextQueue.systemText}`.trim();
    resolution.dangerDelta += nextQueue.dangerDelta;
    resolution.damage += nextQueue.damage;
    resolution.stateChanges.push(...nextQueue.stateChanges);
    if (resolution.dangerDelta !== 0) {
      working.world.danger = clamp(working.world.danger + nextQueue.dangerDelta, 0, 9);
    }
    if (resolution.damage > 0) {
      working.player.hp = clamp(working.player.hp - nextQueue.damage, 0, MAX_HP);
    }
  }

  refreshDerivedState(working);
  applySecretAgendaProgress(working, parsed.rawIntent, presentation.publicText);
  working.eventLog.push(createLogEntry(working, parsed.rawIntent, filteredAction, resolution, presentation));
  refreshDerivedState(working);

  return { session: working, filteredAction, resolution, presentation };
}

export function deriveObjectiveState(session: GameSession): ObjectiveState {
  if (isDynamicScenario(session.scenario)) {
    return deriveDynamicObjectiveState(session);
  }
  const activeActor = getCurrentActor(session);

  let phase: ObjectiveState['phase'] = 'find-tool';
  let dynamicGuide = `先在${requireLocation(session, 'crew-quarters').label}找到${getItemLabel(session, 'insulated-wrench')}。`;

  if (session.phase === 'escaped') {
    phase = 'resolution';
    dynamicGuide = `你已经脱离 ${session.scenario.title}，记录这局生还经过。`;
  } else if (session.phase === 'failed') {
    phase = 'resolution';
    dynamicGuide = '本局已经失败，可以从开始页继续旧存档或新开一局。';
  } else if (!session.world.flags.wrenchFound) {
    phase = 'find-tool';
    dynamicGuide = `先在${requireLocation(session, 'crew-quarters').label}寻找${getItemLabel(session, 'insulated-wrench')}。`;
  } else if (!session.world.flags.powerRestored) {
    phase = 'restore-power';
    dynamicGuide = `带着${getItemLabel(session, 'insulated-wrench')}去${requireLocation(session, 'engine-room').label}处理${getTargetLabel(session, 'relay')}。`;
  } else if (!session.world.flags.consoleDecoded) {
    phase = 'investigate-console';
    dynamicGuide = `供能恢复后，去${requireLocation(session, 'control-room').label}查看${getTargetLabel(session, 'console')}，确认谁把线索藏了起来。`;
  } else if (!session.world.flags.keycardRecovered) {
    phase = 'get-keycard';
    dynamicGuide = `去${requireLocation(session, 'med-bay').label}，从${getTargetLabel(session, 'cabinet')}里拿到${getItemLabel(session, 'captain-keycard')}。`;
  } else if (!session.world.flags.survivorHelped) {
    phase = 'stabilize-survivor';
    dynamicGuide = `在${requireLocation(session, 'med-bay').label}稳住${getTargetLabel(session, 'survivor')}，对方也许知道最后的启动条件。`;
  } else if (!session.world.flags.escapeBayUnlocked) {
    phase = 'reach-escape-bay';
    dynamicGuide = `回到${requireLocation(session, 'control-room').label}，用${getItemLabel(session, 'captain-keycard')}解锁通往${requireLocation(session, 'escape-bay').label}的${getTargetLabel(session, 'bulkhead')}。`;
  } else if (session.player.locationId !== 'escape-bay') {
    phase = 'reach-escape-bay';
    dynamicGuide = `穿过${getTargetLabel(session, 'bulkhead')}，前往${requireLocation(session, 'escape-bay').label}。`;
  } else if (!session.world.flags.launchInspected) {
    phase = 'prepare-launch';
    dynamicGuide = `先查看${getTargetLabel(session, 'escape-pod')}，确认它还缺哪一步才能真正启动。`;
  } else if (!session.world.flags.launchReady) {
    phase = 'prepare-launch';
    dynamicGuide = `用${getItemLabel(session, 'oxygen-canister')}补齐最后的启动准备，再尝试启动${getTargetLabel(session, 'escape-pod')}。`;
  } else {
    phase = 'prepare-launch';
    dynamicGuide = `启动${getTargetLabel(session, 'escape-pod')}，立刻脱离 ${session.scenario.title}。`;
  }

  return {
    macroObjective: session.scenario.macroObjective,
    dynamicGuide,
    phase,
    countdownLabel: `${session.scenario.countdown.shortLabel} ${session.world.oxygen}/${session.scenario.countdown.max} | 回合 ${(session.world.currentRound ?? 1)}/${getRoundCapLabel(session)} | 当前 ${activeActor.actorLabel} | AP ${session.world.playerActionPoints ?? 0}`,
    availableActionsHint: listAvailableActions(session),
    secretAgendaStatus: formatSecretAgendaStatus(session)
  };
}

export function listAvailableActions(session: GameSession): string[] {
  if (isDynamicScenario(session.scenario)) {
    return listDynamicActions(session);
  }

  const hints: string[] = [];
  const currentLocation = requireLocation(session, session.player.locationId);

  hints.push(`查看${currentLocation.label}`);
  (currentLocation.sceneObjects ?? []).forEach((sceneObject) => {
    sceneObject.interactionHints.forEach((hint) => hints.push(hint));
  });
  currentLocation.connected.forEach((locationId) => {
    hints.push(`前往${requireLocation(session, locationId).label}`);
  });

  getNpcsAtPlayerLocation(session).forEach((npc) => {
    hints.push(`说服${npc.name}`);
    hints.push(`查看${npc.name}`);
  });

  if (hasItem(session, 'medkit')) {
    hints.push(`使用${getItemLabel(session, 'medkit')}`);
  }
  if (hasItem(session, 'oxygen-canister')) {
    hints.push(`使用${getItemLabel(session, 'oxygen-canister')}`);
  }

  hints.push('查看背包');
  hints.push('请求提示');
  const uniqueHints = Array.from(new Set(hints));
  if (uniqueHints.length <= 9 || uniqueHints.includes('请求提示') && uniqueHints.indexOf('请求提示') < 9) {
    return uniqueHints.slice(0, 9);
  }
  return [...uniqueHints.slice(0, 8), '请求提示'];
}
function listSandboxMoveTargets(session: GameSession): LocationId[] {
  return (Object.keys(session.world.locations) as LocationId[]).filter((locationId) => locationId !== session.player.locationId);
}

export function describeFilteredAction(session: GameSession, action: FilteredAction): string {
  switch (action.type) {
    case 'inspect':
      return `查看 ${action.targetLabel}`;
    case 'inventory':
      return '查看背包';
    case 'help':
      return '请求提示';
    case 'move':
      return `前往 ${action.targetLabel}`;
    case 'repair':
      return `修理 ${action.targetLabel}`;
    case 'force':
      return `强行处理 ${action.targetLabel}`;
    case 'use_item':
      return action.toolId
        ? `使用 ${getItemLabel(session, action.toolId)}${action.targetLabel ? ` -> ${action.targetLabel}` : ''}`
        : `操作 ${action.targetLabel}`;
    case 'persuade':
      return `说服 ${action.targetLabel}`;
    default:
      return action.targetLabel;
  }
}

function executeAcceptedAction(
  session: GameSession,
  action: FilteredAction,
  randomSource: () => number
): { resolution: Resolution; publicText: string; systemText: string } {
  if (isDynamicScenario(session.scenario)) {
    return executeDynamicAction(session, action, randomSource);
  }

  switch (action.type) {
    case 'inspect':
      return inspectAction(session, action);
    case 'inventory':
      return inventoryAction(session);
    case 'help':
      return helpAction(session);
    case 'move':
      return moveAction(session, action);
    case 'repair':
      return repairAction(session, action, randomSource);
    case 'force':
      return forceAction(session, action, randomSource);
    case 'use_item':
      return useItemAction(session, action);
    case 'persuade':
      return persuadeAction(session, action, randomSource);
    default:
      return {
        resolution: {
          tier: 'fail',
          summary: '无效行动。',
          stateChanges: [],
          oxygenCost: 0,
          dangerDelta: 0,
          damage: 0
        },
        publicText: '现实滤镜没能把你的意图转成可执行动作。',
        systemText: '状态未变化。'
      };
  }
}

function inspectAction(session: GameSession, action: FilteredAction) {
  const target = (action.targetId ?? 'location') as TargetId;
  const location = requireLocation(session, session.player.locationId);
  const stateChanges: string[] = [];

  if (session.player.locationId === 'crew-quarters' && target === 'locker' && !session.world.flags.wrenchFound) {
    giveItem(session, 'insulated-wrench');
    session.world.flags.wrenchFound = true;
    stateChanges.push(`获得 ${getItemLabel(session, 'insulated-wrench')}`);
    return successResult(
      `你拨开歪斜的柜门，在杂物后面摸到了 ${getItemLabel(session, 'insulated-wrench')}。`,
      '找到后续修理所需的关键工具。',
      stateChanges
    );
  }

  if (session.player.locationId === 'med-bay' && target === 'cabinet' && !session.world.flags.keycardRecovered) {
    if (!session.world.flags.consoleDecoded) {
      return successResult(
        `${getTargetLabel(session, 'cabinet')}的层板被人重新排过，像是专门藏过东西。没有${getTargetLabel(session, 'console')}里的调拨记录，你很难确定真正要找的是哪一层。`,
        `最好先去${requireLocation(session, 'control-room').label}核对转移日志。`,
        stateChanges
      );
    }

    if (session.world.flags.powerRestored) {
      giveItem(session, 'captain-keycard');
      session.world.flags.keycardRecovered = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
      return successResult(
        `${getTargetLabel(session, 'cabinet')}在恢复供电后终于弹开，你从最内侧拿到了 ${getItemLabel(session, 'captain-keycard')}。`,
        '逃生线路的第二个门槛已经被清掉。',
        stateChanges
      );
    }

    return successResult(
      `${getTargetLabel(session, 'cabinet')}的电子锁还死着，面板毫无反应。你需要先稳定核心供能。`,
      `${requireLocation(session, 'med-bay').label}里的关键柜体仍然锁定。`,
      stateChanges
    );
  }

  if (session.player.locationId === 'med-bay' && target === 'survivor') {
    return successResult(
      `${getTargetLabel(session, 'survivor')}缩在角落里，明显还没从冲击里缓过来。也许你可以先安抚对方。`,
      '现场还有一名关键见证者，可尝试交谈。',
      stateChanges
    );
  }

  if (session.player.locationId === 'control-room' && target === 'console' && session.world.flags.powerRestored) {
    if ((session.player.tags.includes('潜行训练') || session.player.tags.includes('幸运星')) && !session.world.flags.keycardRecovered) {
      giveItem(session, 'captain-keycard');
      session.world.flags.keycardRecovered = true;
      session.world.flags.keycardHinted = true;
      session.world.flags.consoleDecoded = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
      return successResult(
        `你扶着${getTargetLabel(session, 'console')}稳住身体时，旁边暗格里突然滑出了 ${getItemLabel(session, 'captain-keycard')}。`,
        `你意外在${requireLocation(session, 'control-room').label}直接找到了关键通行物。`,
        stateChanges
      );
    }

    if (!session.world.flags.keycardHinted) {
      session.world.flags.keycardHinted = true;
      stateChanges.push(`日志提示：${getItemLabel(session, 'captain-keycard')}曾转移到${getTargetLabel(session, 'cabinet')}`);
    }
    if (!session.world.flags.consoleDecoded) {
      session.world.flags.consoleDecoded = true;
      stateChanges.push('控制台残缺日志已拼出完整转移链');
    }

    return successResult(
      `${getTargetLabel(session, 'console')}恢复了几条残缺日志，其中一条写着：${getItemLabel(session, 'captain-keycard')}已转移至${getTargetLabel(session, 'cabinet')}；另一条则提醒，撤离载具在强制休眠后还需要额外的启动补给。`,
      '控制区日志为你确认了关键通行物的位置，也提前暴露了最终逃生步骤。',
      stateChanges
    );
  }

  if (session.player.locationId === 'control-room' && target === 'bulkhead') {
    const detail = session.world.flags.escapeBayUnlocked
      ? `${getTargetLabel(session, 'bulkhead')}已经滑开，${requireLocation(session, 'escape-bay').label}那侧的提示灯在闪。`
      : `${getTargetLabel(session, 'bulkhead')}死死咬合着，旁边只剩一处等待${getItemLabel(session, 'captain-keycard')}唤醒的识别槽。`;
    return successResult(detail, `${requireLocation(session, 'control-room').label}到${requireLocation(session, 'escape-bay').label}的通路状态已更新。`, stateChanges);
  }

  if (session.player.locationId === 'escape-bay' && target === 'escape-pod') {
    if (!session.world.flags.launchInspected) {
      session.world.flags.launchInspected = true;
      return successResult(
        `${getTargetLabel(session, 'escape-pod')}的仪表虽然亮了起来，但启动页上还卡着一行红字：预充资源不足，需要额外补给手动灌入。`,
        `${getTargetLabel(session, 'escape-pod')}还不能直接启动，你还差最后一次准备。`,
        stateChanges
      );
    }

    if (!session.world.flags.launchReady) {
      return successResult(
        `${getTargetLabel(session, 'escape-pod')}的外壳在低鸣，像随时能冲出去，却始终停在最后一重安全锁前。你还得补上最后的启动资源。`,
        `你需要想办法让${getTargetLabel(session, 'escape-pod')}进入可发射状态。`,
        stateChanges
      );
    }

    return successResult(
      `${getTargetLabel(session, 'escape-pod')}停在通道尽头，只差最后一次启动指令。`,
      `${getTargetLabel(session, 'escape-pod')}已待命，可直接启动。`,
      stateChanges
    );
  }

  return successResult(
    `${location.description} ${location.atmosphere}`,
    `${location.label}的可交互点：${location.pointsOfInterest.join('、')}`,
    stateChanges
  );
}

function inventoryAction(session: GameSession) {
  const items = session.player.inventory.map((item) => getItemLabel(session, item));
  return successResult(
    items.length ? `你摸了摸身上的装备：${items.join('、')}。` : '你身上几乎什么都没有，只剩呼吸越来越重。',
    '背包检查完成。',
    []
  );
}

function helpAction(session: GameSession) {
  return successResult(
    `系统给出的当前引导是：${session.objectives.dynamicGuide}`,
    `建议动作：${session.objectives.availableActionsHint.join('、')}`,
    []
  );
}

function moveAction(session: GameSession, action: FilteredAction) {
  const destination = action.locationId as LocationId;
  const place = requireLocation(session, destination);
  session.player.locationId = destination;
  if (!session.world.visitedLocations.includes(destination)) {
    session.world.visitedLocations.push(destination);
  }

  return successResult(
    `你穿过吱嘎作响的通道进入${place.label}。${place.atmosphere}`,
    `已抵达 ${place.label}，当前行动段结束。`,
    ['切换场景，当前行动段结束']
  );
}

function resolveNpcAutonomyRound(session: GameSession, randomSource: () => number): NpcTurnOutcome {
  const npcList = session.scenario.npcs ?? [];
  if (!npcList.length) {
    return {
      publicText: '',
      systemText: '',
      dangerDelta: 0,
      damage: 0,
      stateChanges: []
    };
  }

  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;
  const publicWorld = {
    turn: session.world.turn,
    oxygen: session.world.oxygen,
    danger: session.world.danger,
    playerLocationId: session.player.locationId,
    playerHp: session.player.hp
  };

  const apPool = session.world.npcActionPoints ?? {};
  npcList.forEach((npc) => {
    if (typeof apPool[npc.id] !== 'number') {
      apPool[npc.id] = getNpcRoundActionPoints(npc);
    }
  });
  session.world.npcActionPoints = apPool;

  let safety = 0;
  while (safety < 32) {
    safety += 1;
    let progressed = false;

    for (const npc of npcList) {
      if ((apPool[npc.id] ?? 0) <= 0) {
        continue;
      }

      ensureNpcPrivateState(npc);
      const action = decideNpcAction(session, npc, publicWorld, randomSource);
      const actionType: ActionType =
        action.type === 'share-clue'
          ? 'persuade'
          : action.type === 'pressure'
            ? 'force'
            : action.type === 'reposition'
              ? 'move'
              : 'inspect';
      const actionCost = getNpcActionPointCost(npc, actionType);

      if ((apPool[npc.id] ?? 0) < actionCost) {
        apPool[npc.id] = 0;
        continue;
      }
      const nextAp = (apPool[npc.id] ?? 0) - actionCost;
      apPool[npc.id] = Math.max(0, nextAp);
      progressed = true;

      if (action.type === 'share-clue') {
        npc.status = '压低声音提供了关键信息。';
        publicSnippets.push(`${npc.name}在${requireLocation(session, npc.locationId).label}提醒你：${npc.clue}`);
        dangerDelta -= 1;
        stateChanges.push(`NPC协助：${npc.name}降低了局势压力`);
      } else if (action.type === 'pressure') {
        npc.status = '通过言行持续施压。';
        publicSnippets.push(`${npc.name}忽然逼近一步，明显在试探你的底线。`);
        dangerDelta += 1;
        stateChanges.push(`NPC施压：${npc.name}让局势更紧绷`);
        if (randomSource() < 0.25) {
          damage += 1;
          stateChanges.push(`NPC冲突：${npc.name}造成了直接伤害`);
        }
      } else if (action.type === 'observe') {
        npc.status = '保持观察，暂时不直接介入。';
        if (randomSource() < 0.2) {
          publicSnippets.push(`${npc.name}没有接话，只是记下了你刚才的动作。`);
        }
      } else if (action.type === 'reposition') {
        const moveCandidates = getNpcMoveCandidates(session, npc.locationId);
        const nextLocation = pickBestNpcMove(session, npc, moveCandidates, publicWorld, randomSource);
        if (nextLocation && nextLocation !== npc.locationId) {
          npc.locationId = nextLocation;
          npc.status = `已转移到${requireLocation(session, nextLocation).label}附近活动。`;
        }
      }

      npc.privateState!.stress = clamp(npc.privateState!.stress + action.stressDelta, 0, 5);
      npc.privateState!.lastAction = action.type;
      npc.privateState!.memory = [action.memory, ...npc.privateState!.memory].slice(0, 6);
      stateChanges.push(`${npc.name} 行动点 -${actionCost}`);
    }

    if (!progressed) {
      break;
    }
  }

  const pairOutcome = resolveNpcPairInteractions(session, randomSource);
  publicSnippets.unshift(...pairOutcome.publicSnippets);
  systemSnippets.push(...pairOutcome.systemSnippets);
  stateChanges.push(...pairOutcome.stateChanges);
  dangerDelta += pairOutcome.dangerDelta;
  damage += pairOutcome.damage;

  if (dangerDelta !== 0 || damage > 0) {
    systemSnippets.push(`NPC行动轮已结算（危险值${dangerDelta >= 0 ? '+' : ''}${dangerDelta}，伤害+${damage}）。`);
  }

  return {
    publicText: publicSnippets.slice(0, 2).join(' '),
    systemText: systemSnippets.join(' / '),
    dangerDelta,
    damage,
    stateChanges
  };
}

function resolveNpcPairInteractions(session: GameSession, randomSource: () => number) {
  const npcs = session.scenario.npcs ?? [];
  const byLocation = new Map<LocationId, StoryNpc[]>();
  npcs.forEach((npc) => {
    const bucket = byLocation.get(npc.locationId) ?? [];
    bucket.push(npc);
    byLocation.set(npc.locationId, bucket);
  });

  const publicSnippets: string[] = [];
  const systemSnippets: string[] = [];
  const stateChanges: string[] = [];
  let dangerDelta = 0;
  let damage = 0;

  for (const [locationId, roomNpcs] of byLocation.entries()) {
    if (roomNpcs.length < 2) {
      continue;
    }

    const friendly = roomNpcs.filter((npc) => npc.attitude === 'friendly');
    const hostile = roomNpcs.filter((npc) => npc.attitude === 'hostile');
    const locationLabel = requireLocation(session, locationId).label;

    if (friendly.length > 0 && hostile.length > 0 && randomSource() < 0.6) {
      dangerDelta += 1;
      publicSnippets.push(`${friendly[0]!.name}和${hostile[0]!.name}在${locationLabel}爆发了激烈争执。`);
      stateChanges.push(`NPC互斥：${friendly[0]!.name}与${hostile[0]!.name}冲突升级`);
      continue;
    }

    if (friendly.length >= 2 && randomSource() < 0.5) {
      dangerDelta -= 1;
      publicSnippets.push(`${friendly[0]!.name}和${friendly[1]!.name}在${locationLabel}迅速交换了情报。`);
      stateChanges.push(`NPC协同：${friendly[0]!.name}与${friendly[1]!.name}稳定了局势`);
      continue;
    }

    if (hostile.length >= 2 && randomSource() < 0.5) {
      damage += 1;
      publicSnippets.push(`${hostile[0]!.name}和${hostile[1]!.name}的对抗波及到周边，局势更加失控。`);
      stateChanges.push(`NPC内斗：${hostile[0]!.name}与${hostile[1]!.name}造成连带伤害`);
      systemSnippets.push(`${locationLabel}发生了高风险 NPC 对抗。`);
    }
  }

  return {
    publicSnippets: publicSnippets.slice(0, 1),
    systemSnippets,
    stateChanges,
    dangerDelta,
    damage
  };
}

function ensureNpcPrivateState(npc: StoryNpc) {
  if (npc.privateState) {
    return;
  }
  npc.privateState = {
    coreGoal: npc.hiddenDrive,
    shortTermGoal: npc.motiveAnchor ?? '先维持自身安全与筹码。',
    strategy: npc.interactionTips?.[0] ?? '先观察再行动。',
    stress: 0,
    memory: [],
    lastAction: 'observe'
  };
}

function decideNpcAction(
  session: GameSession,
  npc: StoryNpc,
  publicWorld: { turn: number; oxygen: number; danger: number; playerLocationId: LocationId; playerHp: number },
  randomSource: () => number
) {
  const sameRoom = npc.locationId === publicWorld.playerLocationId;
  const privateState = npc.privateState!;
  const pressureLevel = publicWorld.danger + (publicWorld.oxygen <= 4 ? 1 : 0) + privateState.stress;

  if (sameRoom && npc.attitude === 'friendly' && pressureLevel <= 5) {
    return {
      type: 'share-clue' as const,
      stressDelta: -1,
      memory: `T${publicWorld.turn}: 与玩家同室并提供合作线索。`
    };
  }

  if (sameRoom && npc.attitude === 'hostile') {
    return {
      type: 'pressure' as const,
      stressDelta: 1,
      memory: `T${publicWorld.turn}: 在${requireLocation(session, npc.locationId).label}对玩家施压。`
    };
  }

  if (!sameRoom && shouldTrackPlayer(npc, publicWorld, randomSource)) {
    return {
      type: 'reposition' as const,
      stressDelta: 0,
      memory: `T${publicWorld.turn}: 尝试调整站位以贴近关键场景。`
    };
  }

  return {
    type: 'observe' as const,
    stressDelta: pressureLevel >= 6 ? 1 : 0,
    memory: `T${publicWorld.turn}: 保持观察，等待更有利窗口。`
  };
}

function coerceNpcDecision(
  session: GameSession,
  npc: StoryNpc,
  publicWorld: { turn: number; oxygen: number; danger: number; playerLocationId: LocationId; playerHp: number },
  decision: NpcIntentDecision | null,
  randomSource: () => number
) {
  if (!decision?.intent?.trim() && !decision?.actionType) {
    return decideNpcAction(session, npc, publicWorld, randomSource);
  }

  const intent = `${decision.intent ?? ''} ${decision.actionType ?? ''}`.toLowerCase();
  if (/(施压|逼问|威胁|阻止|force|pressure)/.test(intent)) {
    return {
      type: 'pressure' as const,
      stressDelta: 1,
      memory: `T${publicWorld.turn}: 基于可见信息决定施压。${decision.reason ?? ''}`.trim()
    };
  }
  if (/(分享|提醒|合作|说服|persuade|clue|线索|协助)/.test(intent)) {
    return {
      type: 'share-clue' as const,
      stressDelta: -1,
      memory: `T${publicWorld.turn}: 基于可见信息决定协助。${decision.reason ?? ''}`.trim()
    };
  }
  if (/(前往|移动|靠近|追踪|move|go|reposition)/.test(intent)) {
    return {
      type: 'reposition' as const,
      stressDelta: 0,
      memory: `T${publicWorld.turn}: 基于可见信息决定移动。${decision.reason ?? ''}`.trim()
    };
  }
  if (/(观察|查看|等待|inspect|observe|wait)/.test(intent)) {
    return {
      type: 'observe' as const,
      stressDelta: publicWorld.danger >= 6 ? 1 : 0,
      memory: `T${publicWorld.turn}: 基于可见信息决定观察。${decision.reason ?? ''}`.trim()
    };
  }

  return decideNpcAction(session, npc, publicWorld, randomSource);
}

function shouldTrackPlayer(
  npc: StoryNpc,
  publicWorld: { turn: number; oxygen: number; danger: number; playerLocationId: LocationId; playerHp: number },
  randomSource: () => number
) {
  const privateState = npc.privateState!;
  const goalSignal = `${privateState.shortTermGoal} ${privateState.strategy}`.toLowerCase();
  const isInterventionRole = /(控制|监视|跟进|保护|审问|施压|守住|阻止|追)/.test(goalSignal);
  if (isInterventionRole) {
    return true;
  }
  if (npc.attitude === 'hostile') {
    return randomSource() < 0.7;
  }
  if (npc.attitude === 'friendly' && publicWorld.playerHp <= 1) {
    return true;
  }
  return randomSource() < 0.35;
}

function pickBestNpcMove(
  session: GameSession,
  npc: StoryNpc,
  moveCandidates: LocationId[],
  publicWorld: { playerLocationId: LocationId },
  randomSource: () => number
) {
  if (!moveCandidates.length) {
    return null;
  }

  const privateState = npc.privateState!;
  const goalSignal = `${privateState.shortTermGoal} ${privateState.strategy}`.toLowerCase();
  if (/(跟|追|盯|监视|保护|拦|堵|接触玩家)/.test(goalSignal) && moveCandidates.includes(publicWorld.playerLocationId)) {
    return publicWorld.playerLocationId;
  }

  if (npc.attitude === 'hostile' && moveCandidates.includes(publicWorld.playerLocationId)) {
    return publicWorld.playerLocationId;
  }

  return moveCandidates[Math.floor(randomSource() * moveCandidates.length)];
}

function getNpcMoveCandidates(session: GameSession, locationId: LocationId): LocationId[] {
  const location = session.world.locations[locationId];
  if (!location) {
    return listSandboxMoveTargets(session);
  }

  const connected = location.connected.filter((entry) => entry !== locationId);
  if (connected.length > 0) {
    return connected;
  }

  return listSandboxMoveTargets(session);
}

function repairAction(session: GameSession, action: FilteredAction, randomSource: () => number) {
  const check = runSkillCheck(session, 'mind', action.type, 102, randomSource, 8);
  const stateChanges: string[] = [];

  if (check.tier === 'success') {
    session.world.flags.powerRestored = true;
    stateChanges.push('核心供能恢复');
    return checkedResult(check, `你把${getItemLabel(session, 'insulated-wrench')}卡进${getTargetLabel(session, 'relay')}的断口里，线路终于重新咬合。`, `${getTargetLabel(session, 'relay')}修复成功。`, stateChanges);
  }

  if (check.tier === 'cost') {
    session.world.flags.powerRestored = true;
    stateChanges.push('核心供能恢复');
    return checkedResult(check, `${getTargetLabel(session, 'relay')}在一阵刺耳爆鸣后重新送能，你却被反冲擦过手臂，差点跪下。`, '供能恢复，但你付出了代价。', stateChanges, 1, 1);
  }

  return checkedResult(check, `你刚把线路接上，${getTargetLabel(session, 'relay')}就先一步炸开，系统警报反而更尖。`, '修理失败，局势恶化。', stateChanges, 1, 1);
}

function forceAction(session: GameSession, action: FilteredAction, randomSource: () => number) {
  const target = action.targetId as TargetId;
  const stateChanges: string[] = [];

  if (target === 'locker') {
    const check = runSkillCheck(session, 'physique', action.type, 86, randomSource);
    if (check.tier === 'success') {
      if (!session.world.flags.wrenchFound) {
        giveItem(session, 'insulated-wrench');
        session.world.flags.wrenchFound = true;
        stateChanges.push(`获得 ${getItemLabel(session, 'insulated-wrench')}`);
      }
      return checkedResult(check, `你猛地把卡住的${getTargetLabel(session, 'locker')}掰开，藏在后面的${getItemLabel(session, 'insulated-wrench')}终于掉了出来。`, `${getTargetLabel(session, 'locker')}被成功破开。`, stateChanges);
    }

    if (check.tier === 'cost') {
      if (!session.world.flags.wrenchFound) {
        giveItem(session, 'insulated-wrench');
        session.world.flags.wrenchFound = true;
        stateChanges.push(`获得 ${getItemLabel(session, 'insulated-wrench')}`);
      }
      return checkedResult(check, `${getTargetLabel(session, 'locker')}被你硬生生撬开了，但一块断裂边缘划破了手背。`, '你拿到了工具，但受了点伤。', stateChanges, 1, 1);
    }

    return checkedResult(check, `你把${getTargetLabel(session, 'locker')}震得更歪了，里面的东西仍卡在更深处。`, '强行破坏失败。', stateChanges, 0, 1);
  }

  if (target === 'cabinet') {
    const check = runSkillCheck(session, 'physique', action.type, 96, randomSource);
    if (check.tier === 'success') {
      if (!session.world.flags.keycardRecovered) {
        giveItem(session, 'captain-keycard');
        session.world.flags.keycardRecovered = true;
        stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
      }
      return checkedResult(check, `你用肩膀顶住${getTargetLabel(session, 'cabinet')}猛然发力，锁芯崩开，${getItemLabel(session, 'captain-keycard')}从杂物堆里滑了出来。`, `你绕过供能要求拿到了${getItemLabel(session, 'captain-keycard')}。`, stateChanges);
    }

    if (check.tier === 'cost') {
      if (!session.world.flags.keycardRecovered) {
        giveItem(session, 'captain-keycard');
        session.world.flags.keycardRecovered = true;
        stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
      }
      return checkedResult(check, `${getTargetLabel(session, 'cabinet')}终于被你撬开，但断裂碎片在狭小空间里弹起，割破了你的前臂。`, `你拿到了${getItemLabel(session, 'captain-keycard')}，但也暴露在更糟的局面里。`, stateChanges, 1, 1);
    }

    return checkedResult(check, `${getTargetLabel(session, 'cabinet')}纹丝不动，你只换来一阵手臂发麻。`, `${getTargetLabel(session, 'cabinet')}仍然锁着。`, stateChanges, 0, 1);
  }

  const check = runSkillCheck(session, 'physique', action.type, 110, randomSource);
  if (check.tier === 'success') {
    session.world.flags.escapeBayUnlocked = true;
    stateChanges.push(`${getTargetLabel(session, 'bulkhead')}被强行破开`);
    return checkedResult(check, `你在${getTargetLabel(session, 'bulkhead')}的轨道里硬生生撬出一个空隙，伴随一声闷响，门体终于滑开。`, `通往${requireLocation(session, 'escape-bay').label}的路线被强行打开。`, stateChanges);
  }

  if (check.tier === 'cost') {
    session.world.flags.escapeBayUnlocked = true;
    stateChanges.push(`${getTargetLabel(session, 'bulkhead')}被强行破开`);
    return checkedResult(check, `${getTargetLabel(session, 'bulkhead')}被你撞开半寸后终于退让，但反弹回来的冲击几乎把你拍回地面。`, '封锁被打开了，但你被重重反噬。', stateChanges, 1, 1);
  }

  return checkedResult(check, `${getTargetLabel(session, 'bulkhead')}只是发出一声钝响，你的肩膀却像被铁锤砸过。`, `${getTargetLabel(session, 'bulkhead')}仍然紧闭。`, stateChanges, 0, 1);
}

function useItemAction(session: GameSession, action: FilteredAction) {
  const stateChanges: string[] = [];

  if (action.toolId === 'sealant-foam' && action.targetId === 'relay' && session.player.locationId === 'engine-room') {
    if (session.world.flags.powerRestored) {
      return successResult(`${getTargetLabel(session, 'relay')}附近的漏点已经被压住了，你没必要再浪费${getItemLabel(session, 'sealant-foam')}。`, '核心供能已恢复，未消耗封堵材料。', stateChanges);
    }

    if (!hasItem(session, 'insulated-wrench')) {
      return successResult(`你比划了一下泄漏点的位置，但没有${getItemLabel(session, 'insulated-wrench')}配合，单靠${getItemLabel(session, 'sealant-foam')}还不足以完成修复。`, `仍然需要${getItemLabel(session, 'insulated-wrench')}。`, stateChanges);
    }

    consumeItem(session, 'sealant-foam');
    session.world.flags.powerRestored = true;
    stateChanges.push('核心供能恢复');
    stateChanges.push('危险值 -1');
    session.world.danger = clamp(session.world.danger - 1, 0, 9);
    return successResult(
      `你先用${getItemLabel(session, 'sealant-foam')}压住泄漏和火花，再用${getItemLabel(session, 'insulated-wrench')}把断开的节点重新卡回去，整套动作像排练过一样流畅。`,
      `你用工程处理思路稳定了${getTargetLabel(session, 'relay')}并恢复核心供能。`,
      stateChanges
    );
  }

  if (action.toolId === 'medkit' && action.targetId === 'survivor') {
    if (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent) {
      return successResult('你环顾四周，却找不到需要你立刻处理伤情的人。', '当前没有可治疗的目标。', stateChanges);
    }

    if (session.world.flags.survivorHelped) {
      return successResult('林沅的呼吸已经平稳下来，你把剩下的药品重新收紧。', '幸存者状态稳定，未额外消耗急救包。', stateChanges);
    }

    consumeItem(session, 'medkit');
    session.world.flags.survivorHelped = true;
    giveItem(session, 'oxygen-canister');
    stateChanges.push(`获得 ${getItemLabel(session, 'oxygen-canister')}`);

    if (!session.world.flags.keycardRecovered) {
      giveItem(session, 'captain-keycard');
      session.world.flags.keycardRecovered = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
    }

    session.world.danger = clamp(session.world.danger - 1, 0, 9);
    session.world.oxygen = clamp(session.world.oxygen + 2, 0, getMaxCountdown(session));
    stateChanges.push('危险值 -1');
    stateChanges.push(`${session.scenario.countdown.recoverLabel} +2`);

    return successResult(
      `你用${getItemLabel(session, 'medkit')}替${getTargetLabel(session, 'survivor')}止住了伤势，对方终于缓过神来，把${getItemLabel(session, 'captain-keycard')}和${getItemLabel(session, 'oxygen-canister')}一起塞给你。`,
      '你稳定了幸存者，并提前拿到了推进撤离的关键物资。',
      stateChanges
    );
  }

  if (action.toolId === 'medkit') {
    if (session.player.hp >= MAX_HP) {
      return successResult(`你拆开${getItemLabel(session, 'medkit')}看了一眼，又重新包好。现在还不到必须用的时候。`, `HP 已满，未消耗${getItemLabel(session, 'medkit')}。`, stateChanges);
    }

    consumeItem(session, 'medkit');
    session.player.hp = clamp(session.player.hp + 1, 0, MAX_HP);
    stateChanges.push('HP +1');
    return successResult('你快速处理好伤口，疼痛虽然还在，但至少不再继续失血。', `${getItemLabel(session, 'medkit')}生效。`, stateChanges);
  }

  if (action.toolId === 'oxygen-canister') {
    if (session.player.locationId === 'escape-bay' && session.world.flags.launchInspected && !session.world.flags.launchReady) {
      consumeItem(session, 'oxygen-canister');
      session.world.flags.launchReady = true;
      stateChanges.push(`${getTargetLabel(session, 'escape-pod')}预充完成`);
      return successResult(
        `你把${getItemLabel(session, 'oxygen-canister')}接上${getTargetLabel(session, 'escape-pod')}的预充接口，指示终于越过红线，整台装置像被重新唤醒。`,
        `${getTargetLabel(session, 'escape-pod')}已经具备发射条件。`,
        stateChanges
      );
    }

    consumeItem(session, 'oxygen-canister');
    session.world.oxygen = clamp(session.world.oxygen + 2, 0, getMaxCountdown(session));
    stateChanges.push(`${session.scenario.countdown.recoverLabel} +2`);
    return successResult(getCountdownRecoverNarration(session), `${getItemLabel(session, 'oxygen-canister')}已使用。`, stateChanges);
  }

  if (action.toolId === 'sealant-foam') {
    consumeItem(session, 'sealant-foam');
    session.world.danger = clamp(session.world.danger - 1, 0, 9);
    stateChanges.push('危险值 -1');
    return successResult(`你把${getItemLabel(session, 'sealant-foam')}压进漏缝，局面暂时稳定了一些。`, '局面暂时稳定了一些。', stateChanges);
  }

  if (action.toolId === 'captain-keycard') {
    session.world.flags.escapeBayUnlocked = true;
    stateChanges.push(`${getTargetLabel(session, 'bulkhead')}已解锁`);
    return successResult(`${getItemLabel(session, 'captain-keycard')}划过识别槽，${getTargetLabel(session, 'bulkhead')}终于发出一声沉闷的解锁声。`, `${requireLocation(session, 'escape-bay').label}通路已打开。`, stateChanges);
  }

  if (action.targetId === 'escape-pod') {
    if (!session.world.flags.launchInspected) {
      return successResult(`你把手压上启动面板，却发现${getTargetLabel(session, 'escape-pod')}连预检都还没做完。最好先检查一遍。`, `先查看${getTargetLabel(session, 'escape-pod')}的状态。`, stateChanges);
    }

    if (!session.world.flags.launchReady) {
      return successResult(`启动程序刚跳了两行就被掐断，屏幕反复提示缺少预充气压。你现在硬按下去，只会把最后的机会烧掉。`, `${getTargetLabel(session, 'escape-pod')}尚未准备完成。`, stateChanges);
    }

    session.world.flags.escapeLaunched = true;
    stateChanges.push(`${getTargetLabel(session, 'escape-pod')}已启动`);
    return successResult(`你砸下启动面板，${getTargetLabel(session, 'escape-pod')}像脱钩的箭一样冲了出去，身后的${session.scenario.title}迅速退成一片黑影。`, `你成功离开了 ${session.scenario.title}。`, stateChanges);
  }

  return successResult('你摆弄了一下手头的物品，但现在还用不上。', '没有发生关键变化。', stateChanges);
}

function persuadeAction(session: GameSession, action: FilteredAction, randomSource: () => number) {
  if (!action.targetId?.startsWith('npc:')) {
    const roomNpcs = getNpcsAtPlayerLocation(session);
    if (roomNpcs.length > 0) {
      const targetNpc = pickNpcPersuasionTarget(roomNpcs, action.targetLabel);
      return persuadeNpcAction(
        session,
        {
          ...action,
          targetId: `npc:${targetNpc.id}`,
          targetLabel: targetNpc.name
        },
        randomSource
      );
    }
  }

  if (action.targetId?.startsWith('npc:')) {
    return persuadeNpcAction(session, action, randomSource);
  }

  const check = runSkillCheck(session, 'empathy', action.type, 96, randomSource);
  const stateChanges: string[] = [];

  if (check.tier === 'success') {
    if (!session.world.flags.survivorHelped) {
      giveItem(session, 'oxygen-canister');
      session.world.flags.survivorHelped = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'oxygen-canister')}`);
    }
    return checkedResult(check, `${getTargetLabel(session, 'survivor')}终于稳住呼吸，把藏着的一份${getItemLabel(session, 'oxygen-canister')}塞进你手里，还提醒你撤离装置在强制休眠后必须先补齐启动资源。`, '幸存者被安抚并提供了物资，也说出了最后的启动条件。', stateChanges);
  }

  if (check.tier === 'cost') {
    if (!session.world.flags.survivorHelped) {
      giveItem(session, 'oxygen-canister');
      session.world.flags.survivorHelped = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'oxygen-canister')}`);
    }
    return checkedResult(check, `${getTargetLabel(session, 'survivor')}勉强点头，把${getItemLabel(session, 'oxygen-canister')}递给你，但对方的惊慌也让${requireLocation(session, 'med-bay').label}的动静更大了。混乱里，你还是听清了那句“启动前先补齐资源”。`, '你拿到了帮助，但局势更乱。', stateChanges, 0, 1);
  }

  return checkedResult(check, '你的话没能让她冷静下来，她反而把更多器械撞翻在地。', '说服失败，危险进一步累积。', stateChanges, 0, 1);
}

function persuadeNpcAction(session: GameSession, action: FilteredAction, randomSource: () => number) {
  const npcId = action.targetId?.slice(4);
  const npc = (session.scenario.npcs ?? []).find((entry) => entry.id === npcId && entry.locationId === session.player.locationId);
  if (!npc) {
    return checkedResult(
      runSkillCheck(session, 'empathy', action.type, 100, randomSource),
      '你尝试和对方建立对话，但人已经不在眼前。',
      'NPC目标不存在或已离开当前区域。',
      [],
      0,
      0
    );
  }

  ensureNpcPrivateState(npc);
  const baseDifficulty = npc.attitude === 'hostile' ? 108 : npc.attitude === 'neutral' ? 96 : 88;
  const check = runSkillCheck(session, 'empathy', action.type, baseDifficulty, randomSource);
  const stateChanges: string[] = [];

  if (check.tier === 'success') {
    if (npc.attitude === 'hostile') {
      npc.attitude = 'neutral';
      stateChanges.push(`关系变化：${npc.name}对你的敌意降低`);
    } else if (npc.attitude === 'neutral') {
      npc.attitude = 'friendly';
      stateChanges.push(`关系变化：${npc.name}开始愿意协作`);
    } else {
      stateChanges.push(`NPC协助：${npc.name}主动给出关键提示`);
    }
    npc.status = '被你说动，暂时进入协作姿态。';
    npc.privateState!.stress = clamp(npc.privateState!.stress - 1, 0, 5);
    npc.privateState!.memory = [`T${session.world.turn}: 接受了玩家的说服。`, ...npc.privateState!.memory].slice(0, 6);
    return checkedResult(check, `${npc.name}沉默了几秒，最终选择和你交换信息：“${npc.clue}”`, `${npc.name}对你当前立场有所松动。`, stateChanges, 0, -1);
  }

  if (check.tier === 'cost') {
    npc.status = '态度有所波动，但仍保留戒心。';
    npc.privateState!.stress = clamp(npc.privateState!.stress + 1, 0, 5);
    npc.privateState!.memory = [`T${session.world.turn}: 与玩家达成了有限沟通。`, ...npc.privateState!.memory].slice(0, 6);
    return checkedResult(check, `${npc.name}没有完全相信你，但愿意先把话听完。`, `${npc.name}暂时观望，你争取到了一点对话空间。`, stateChanges, 0, 0);
  }

  npc.status = '拒绝合作，态度更强硬。';
  npc.privateState!.stress = clamp(npc.privateState!.stress + 1, 0, 5);
  npc.privateState!.memory = [`T${session.world.turn}: 拒绝了玩家说服。`, ...npc.privateState!.memory].slice(0, 6);
  return checkedResult(check, `${npc.name}冷冷打断了你，连眼神都没再给你。`, `${npc.name}拒绝配合，局势更紧张。`, stateChanges, 0, 1);
}

function getNpcsAtPlayerLocation(session: GameSession) {
  return (session.scenario.npcs ?? []).filter((npc) => npc.locationId === session.player.locationId);
}

function pickNpcPersuasionTarget(npcs: StoryNpc[], targetLabel: string | undefined) {
  const normalized = (targetLabel ?? '').trim().toLowerCase();
  const exact = npcs.find((npc) => npc.name.toLowerCase() === normalized);
  if (exact) {
    return exact;
  }
  const contains = npcs.find((npc) => normalized && npc.name.toLowerCase().includes(normalized));
  return contains ?? npcs[0]!;
}

function runSkillCheck(
  session: GameSession,
  skill: SkillKey,
  actionType: ActionType,
  difficulty: number,
  randomSource: () => number,
  situationalBonus = 0
) {
  const roll = Math.floor(randomSource() * 100);
  const score = session.player.stats[skill] * 15 + getTagBonus(session.player.tags, skill, actionType) + situationalBonus - session.world.danger * 5 + roll;
  const tier = score >= difficulty ? 'success' : score >= difficulty - 15 ? 'cost' : 'fail';
  return { tier, skill, difficulty, roll, score } as const;
}

function getTagBonus(tags: TagId[], skill: SkillKey, actionType: ActionType) {
  return tags.reduce((total, tag) => {
    const rule = TAG_RULES[tag];
    if (!rule) {
      return total;
    }

    const applies = rule.actions === 'all' || rule.actions.includes(actionType);
    if (rule.stat !== skill || !applies) {
      return total;
    }

    return total + rule.bonus;
  }, 0);
}

function successResult(publicText: string, systemText: string, stateChanges: string[]) {
  return {
    resolution: {
      tier: 'success' as const,
      summary: systemText,
      stateChanges,
      oxygenCost: 0,
      dangerDelta: 0,
      damage: 0
    },
    publicText,
    systemText
  };
}

function checkedResult(
  check: ReturnType<typeof runSkillCheck>,
  publicText: string,
  systemText: string,
  stateChanges: string[],
  damage = 0,
  dangerDelta = 0
) {
  return {
    resolution: {
      tier: check.tier,
      summary: systemText,
      stateChanges,
      skill: check.skill,
      difficulty: check.difficulty,
      roll: check.roll,
      score: check.score,
      oxygenCost: 0,
      dangerDelta,
      damage
    },
    publicText,
    systemText
  };
}

function inferForceTarget(session: GameSession, target: TargetId): TargetId | null {
  if (target !== 'location') {
    return target;
  }

  switch (session.player.locationId) {
    case 'crew-quarters':
      return 'locker';
    case 'med-bay':
      return 'cabinet';
    case 'control-room':
      return 'bulkhead';
    default:
      return null;
  }
}

function inferUseItemTarget(
  session: GameSession,
  parsed: ParsedAction
): Pick<FilteredAction, 'toolId' | 'targetId' | 'targetLabel'> | null {
  if (parsed.toolId === 'medkit' && parsed.targetId === 'survivor') {
    return { toolId: 'medkit', targetId: 'survivor', targetLabel: getTargetLabel(session, 'survivor') };
  }
  if (parsed.toolId === 'medkit') {
    return { toolId: 'medkit', targetId: 'self', targetLabel: '自己' };
  }
  if (parsed.toolId === 'oxygen-canister') {
    return { toolId: 'oxygen-canister', targetId: 'self', targetLabel: '自己' };
  }
  if (parsed.toolId === 'sealant-foam') {
    return { toolId: 'sealant-foam', targetId: 'relay', targetLabel: getTargetLabel(session, 'relay') };
  }
  if (parsed.toolId === 'captain-keycard' || parsed.targetId === 'bulkhead') {
    return { toolId: 'captain-keycard', targetId: 'bulkhead', targetLabel: getTargetLabel(session, 'bulkhead') };
  }
  if (parsed.targetId === 'escape-pod' || session.player.locationId === 'escape-bay') {
    return { targetId: 'escape-pod', targetLabel: getTargetLabel(session, 'escape-pod') };
  }
  return null;
}

function applyStoryFilter(session: GameSession, parsed: ParsedAction): ParsedAction {
  const currentLocation = requireLocation(session, session.player.locationId);

  if (parsed.type === 'use_item') {
    const adaptedItem = adaptRequestedItemToStory(session, parsed);
    if (adaptedItem) {
      return {
        ...parsed,
        toolId: adaptedItem.itemId,
        targetId: adaptedItem.targetId ?? parsed.targetId,
        targetLabel: adaptedItem.targetLabel ?? getItemLabel(session, adaptedItem.itemId),
        storyFilterNote: adaptedItem.note
      };
    }
  }

  if (parsed.type === 'move' && !parsed.locationId) {
    return {
      ...parsed,
      type: 'inspect',
      targetId: 'location',
      targetLabel: currentLocation.label,
      consumesTurn: false,
      storyFilterNote: `你说的去处在这局故事里并不存在，动作被收束成先观察${currentLocation.label}。`
    };
  }

  if (parsed.type === 'repair' && session.player.locationId !== 'engine-room') {
    return {
      ...parsed,
      type: 'inspect',
      targetId: 'location',
      targetLabel: currentLocation.label,
      consumesTurn: false,
      storyFilterNote: `当前场景没有可直接修理的核心装置，你先观察${currentLocation.label}里真正能动手的部分。`
    };
  }

  if (
    parsed.type === 'persuade' &&
    getNpcsAtPlayerLocation(session).length === 0 &&
    (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent)
  ) {
    return {
      ...parsed,
      type: 'inspect',
      targetId: 'location',
      targetLabel: currentLocation.label,
      consumesTurn: false,
      storyFilterNote: `这里没有能直接交涉的对象，你的举动被理解成先试探${currentLocation.label}的气氛和痕迹。`
    };
  }

  return parsed;
}

function adaptRequestedItemToStory(
  session: GameSession,
  parsed: ParsedAction
): { itemId: ItemId; targetId?: string; targetLabel?: string; note: string } | null {
  const requested = extractRequestedProp(parsed.rawIntent);
  const explicitlyBrandishing = /(掏出|拿出|亮出|举起)/.test(parsed.rawIntent);

  if (!parsed.toolId && !requested && !explicitlyBrandishing) {
    return null;
  }

  if (parsed.toolId && hasItem(session, parsed.toolId)) {
    return null;
  }

  const available = session.player.inventory;
  if (!available.length) {
    return null;
  }

  const chosen = pickInventoryFallback(session, parsed.rawIntent);
  if (!chosen) {
    return null;
  }

  const chosenLabel = getItemLabel(session, chosen);
  return {
    itemId: chosen,
    targetId: parsed.targetId ?? 'self',
    targetLabel: parsed.targetLabel || '自己',
    note: requested
      ? `故事滤镜生效：你身上没有${requested}，最后摸出来的是${chosenLabel}。`
      : `故事滤镜生效：现场没有你描述的那件东西，你顺手改用了${chosenLabel}。`
  };
}

function extractRequestedProp(intent: string) {
  const match = intent.match(/(?:掏出|拿出|亮出|举起|使用|用)([^，。；、\s]{1,8})/);
  return match?.[1]?.trim() || '';
}

function pickInventoryFallback(session: GameSession, rawIntent: string): ItemId | null {
  const intent = rawIntent.toLowerCase();
  const inventory = session.player.inventory;
  const labelEntries = Object.entries(session.scenario.glossary.itemLabels) as Array<[ItemId, string]>;

  const score = (itemId: ItemId) => {
    const label = labelEntries.find(([id]) => id === itemId)?.[1] ?? ITEM_LIBRARY[itemId].label;
    let value = 0;
    if (/(枪|刀|武器|手枪|步枪|威胁|射击)/.test(intent)) value += /(棒|扳手|罐|泡沫|香蕉|工具)/.test(label) ? 3 : 1;
    if (/(吃|喝|咬|吞)/.test(intent)) value += /(氧|罐|香蕉|药|包)/.test(label) ? 3 : 0;
    if (/(救|治疗|包扎)/.test(intent)) value += itemId === 'medkit' ? 5 : 0;
    if (/(修|接线|稳定|封堵)/.test(intent)) value += itemId === 'insulated-wrench' || itemId === 'sealant-foam' ? 5 : 0;
    if (/(门|锁|刷卡|开门)/.test(intent)) value += itemId === 'captain-keycard' ? 5 : 0;
    if (value === 0) value = 1;
    return value;
  };

  return inventory.slice().sort((left, right) => score(right) - score(left))[0] ?? null;
}

function hasItem(session: GameSession, itemId: ItemId) {
  return session.player.inventory.includes(itemId);
}

function giveItem(session: GameSession, itemId: ItemId) {
  if (!session.player.inventory.includes(itemId)) {
    session.player.inventory.push(itemId);
  }
}

function consumeItem(session: GameSession, itemId: ItemId) {
  session.player.inventory = session.player.inventory.filter((entry) => entry !== itemId);
}

function rejectAction(parsed: ParsedAction, reason: string): FilteredAction {
  return {
    ...parsed,
    validity: 'rejected',
    reason
  };
}

function createLogEntry(
  session: GameSession,
  rawIntent: string,
  filteredAction: FilteredAction,
  resolution: Resolution,
  presentation: EnginePresentation
): EventLogEntry {
  return {
    step: session.eventLog.length,
    intent: rawIntent,
    filteredAction: describeFilteredAction(session, filteredAction),
    tier: resolution.tier,
    publicText: presentation.publicText,
    systemText: `${presentation.systemText}${filteredAction.storyFilterNote ? ` / ${filteredAction.storyFilterNote}` : ''}${resolution.stateChanges.length ? ` (${resolution.stateChanges.join(' / ')})` : ''}`,
    timestamp: new Date().toISOString()
  };
}

function refreshDerivedState(session: GameSession) {
  refreshSecretAgenda(session);
  session.objectives = deriveObjectiveState(session);
  session.saveMeta = createSaveMeta(session);
  return session;
}

function createSaveMeta(session: GameSession): SaveMeta {
  return {
    sessionId: session.sessionId,
    title: `${session.player.archetypeLabel} / ${session.scenario.title}`,
    updatedAt: new Date().toISOString(),
    phase: session.phase,
    archetypeId: session.player.archetypeId,
    oxygen: session.world.oxygen,
    countdownName: session.scenario.countdown.shortLabel,
    danger: session.world.danger,
    dynamicGuide: session.objectives.dynamicGuide
  };
}

function createEmptyObjectives(): ObjectiveState {
  return {
    macroObjective: '',
    dynamicGuide: '',
    phase: 'find-tool',
    countdownLabel: '',
    availableActionsHint: [],
    secretAgendaStatus: ''
  };
}

function createScenarioFromTemplate(): StoryScenario {
  return {
    id: SUBMARINE_TEMPLATE.id,
    title: SUBMARINE_TEMPLATE.label,
    premise: SUBMARINE_TEMPLATE.premise,
    openingLine: SUBMARINE_TEMPLATE.openingLine,
    macroObjective: SUBMARINE_TEMPLATE.macroObjective,
    countdown: structuredClone(SUBMARINE_TEMPLATE.countdown),
    gameplayMode: 'template',
    beats: [],
    locations: structuredClone(SUBMARINE_TEMPLATE.locations),
    glossary: {
      toolLabel: '绝缘扳手',
      keyItemLabel: '舰长钥匙卡',
      repairMaterialLabel: '应急密封泡沫',
      powerNodeLabel: '主继电器',
      cabinetLabel: '急救柜',
      survivorLabel: '幸存者林沅',
      gateLabel: '封闭闸门',
      exitVehicleLabel: '逃生艇',
      itemLabels: {
        'insulated-wrench': '绝缘扳手',
        'captain-keycard': '舰长钥匙卡',
        medkit: '急救包',
        'oxygen-canister': '便携氧气罐',
        'sealant-foam': '应急密封泡沫'
      }
    }
  };
}

function createEmptySaveMeta(): SaveMeta {
  return {
    sessionId: '',
    title: '',
    updatedAt: new Date().toISOString(),
    phase: 'briefing',
    archetypeId: 'engineer',
    oxygen: INITIAL_OXYGEN,
    countdownName: '氧气',
    danger: 0,
    dynamicGuide: ''
  };
}

function getCountdownRecoverNarration(session: GameSession) {
  const label = session.scenario.countdown.recoverLabel;
  if (label.includes('氧')) return '冷气迅速灌入肺里，你终于重新把呼吸拉回了节奏。';
  if (label.includes('小时')) return '你重新争取到一点时间，局势虽然还危险，但倒计时终于没那么咄咄逼人。';
  return '你重新争取到一点行动余裕，至少还能再撑几个回合。';
}

function isDynamicScenario(scenario: StoryScenario) {
  return scenario.gameplayMode === 'llm' && Array.isArray(scenario.beats) && scenario.beats.length > 0;
}

function getCurrentBeat(session: GameSession): StoryBeat | null {
  if (!isDynamicScenario(session.scenario)) {
    return null;
  }

  const index = session.world.storyBeatIndex ?? 0;
  return session.scenario.beats?.[index] ?? null;
}

function filterDynamicAction(session: GameSession, parsed: ParsedAction): FilteredAction {
  const currentLocation = requireLocation(session, session.player.locationId);
  const targetId = parsed.targetId ?? 'location';

  if (parsed.type === 'inventory' || parsed.type === 'help' || parsed.type === 'inspect') {
    return {
      ...parsed,
      targetId,
      targetLabel: parsed.targetLabel || currentLocation.label,
      validity: 'accepted'
    };
  }

  if (parsed.type === 'move') {
    if (!parsed.locationId) {
      return rejectAction(parsed, '移动目标不明确。');
    }

    if (!session.world.locations[parsed.locationId]) {
      return rejectAction(parsed, '这个地点不存在于当前地图。');
    }

    if (parsed.locationId === session.player.locationId) {
      return {
        ...parsed,
        type: 'inspect',
        consumesTurn: false,
        validity: 'redirected',
        redirectedFrom: 'move',
        targetId: 'location',
        targetLabel: currentLocation.label,
        reason: '你已经在这里了，先观察周围更有帮助。'
      };
    }

    return { ...parsed, validity: 'accepted' };
  }

  if (parsed.type === 'use_item' && parsed.toolId && !hasItem(session, parsed.toolId)) {
    return rejectAction(parsed, `你身上没有${getItemLabel(session, parsed.toolId)}。`);
  }

  if (parsed.type === 'persuade') {
    const roomNpcs = getNpcsAtPlayerLocation(session);
    if (roomNpcs.length > 0) {
      const targetNpc = pickNpcPersuasionTarget(roomNpcs, parsed.targetLabel);
      return {
        ...parsed,
        targetId: `npc:${targetNpc.id}`,
        targetLabel: targetNpc.name,
        validity: 'accepted'
      };
    }
  }

  return {
    ...parsed,
    targetId,
    targetLabel: parsed.targetLabel || currentLocation.label,
    validity: 'accepted'
  };
}

function deriveDynamicObjectiveState(session: GameSession): ObjectiveState {
  const beat = getCurrentBeat(session);
  let dynamicGuide = '故事已经来到结尾。';
  const activeActor = getCurrentActor(session);

  if (session.phase === 'escaped') {
    dynamicGuide = `你已经脱离 ${session.scenario.title}，记录这局生还经过。`;
  } else if (session.phase === 'failed') {
    dynamicGuide = '本局已经失败，可以从开始页继续旧存档或新开一局。';
  } else if (beat) {
    dynamicGuide = beat.guidance;
  }

  return {
    macroObjective: session.scenario.macroObjective,
    dynamicGuide,
    phase: session.phase === 'active' ? 'prepare-launch' : 'resolution',
    countdownLabel: `${session.scenario.countdown.shortLabel} ${session.world.oxygen}/${session.scenario.countdown.max} | 回合 ${(session.world.currentRound ?? 1)}/${getRoundCapLabel(session)} | 当前 ${activeActor.actorLabel} | AP ${session.world.playerActionPoints ?? 0}`,
    availableActionsHint: listDynamicActions(session),
    secretAgendaStatus: formatSecretAgendaStatus(session)
  };
}

function listDynamicActions(session: GameSession): string[] {
  const beat = getCurrentBeat(session);
  const location = session.player.locationId;
  const hints = new Set<string>();
  const currentLocation = requireLocation(session, location);

  hints.add(`查看${currentLocation.label}`);

  if (beat) {
    beat.suggestions.forEach((entry) => hints.add(entry));
    if (beat.locationId !== location) {
      hints.add(`前往${requireLocation(session, beat.locationId).label}`);
    }
  }

  getNpcsAtPlayerLocation(session).forEach((npc) => {
    hints.add(`说服${npc.name}`);
    hints.add(`查看${npc.name}`);
  });

  listSandboxMoveTargets(session).forEach((entry) => {
    hints.add(`前往${requireLocation(session, entry).label}`);
  });

  session.player.inventory.forEach((itemId) => {
    hints.add(`使用${getItemLabel(session, itemId)}`);
  });

  hints.add('查看背包');
  hints.add('请求提示');
  return Array.from(hints).slice(0, 9);
}

function listActorActions(session: GameSession, actorId: string): string[] {
  if (actorId === PLAYER_ACTOR_ID) {
    return [...session.objectives.availableActionsHint];
  }

  const npc = (session.scenario.npcs ?? []).find((entry) => entry.id === actorId);
  if (!npc) {
    return [];
  }

  const location = requireLocation(session, npc.locationId);
  const hints = new Set<string>();
  hints.add(`查看${location.label}`);
  (location.sceneObjects ?? []).forEach((sceneObject) => {
    sceneObject.interactionHints.slice(0, 2).forEach((hint) => hints.add(hint));
  });
  location.connected.forEach((locationId) => hints.add(`前往${requireLocation(session, locationId).label}`));

  if (npc.locationId === session.player.locationId) {
    hints.add(`和${session.player.archetypeLabel}交涉`);
    hints.add(`向${session.player.archetypeLabel}施压`);
  }

  (session.scenario.npcs ?? [])
    .filter((entry) => entry.id !== npc.id && entry.locationId === npc.locationId)
    .forEach((entry) => {
      hints.add(`和${entry.name}交换信息`);
      hints.add(`观察${entry.name}`);
    });

  hints.add('保持观察');
  return Array.from(hints).slice(0, 9);
}

function executeDynamicAction(
  session: GameSession,
  action: FilteredAction,
  randomSource: () => number
): { resolution: Resolution; publicText: string; systemText: string } {
  if (action.type === 'inventory') {
    return inventoryAction(session);
  }

  if (action.type === 'help') {
    return helpAction(session);
  }

  if (action.type === 'move') {
    return moveAction(session, action);
  }

  if (action.type === 'persuade' && getNpcsAtPlayerLocation(session).length > 0) {
    return persuadeNpcAction(session, action, randomSource);
  }

  if (action.type === 'inspect' && !isBeatMatch(session, action)) {
    const location = requireLocation(session, session.player.locationId);
    const [publicText, systemText] = buildFilteredOffMainNarration(session, action, location);
    return successResult(publicText, systemText, []);
  }

  const beat = getCurrentBeat(session);
  if (!beat) {
    return successResult('故事的关键节点已经全部完成。', '没有剩余主线节点。', []);
  }

  const check = runSkillCheck(session, beat.skill ?? inferDynamicSkill(action.type), action.type, 96, randomSource, 4);
  if (!isBeatMatch(session, action)) {
    const [publicText, systemText] = buildFilteredOffMainNarration(session, action, requireLocation(session, session.player.locationId), beat);
    return checkedResult(
      check,
      publicText,
      systemText,
      [],
      0,
      action.type === 'force' ? 1 : 0
    );
  }

  const stateChanges: string[] = [];
  if (beat.rewardItemId) {
    giveItem(session, beat.rewardItemId);
    stateChanges.push(`获得 ${getItemLabel(session, beat.rewardItemId)}`);
  }

  if (beat.requiredItemId && action.toolId === beat.requiredItemId && ITEM_LIBRARY[beat.requiredItemId].consumable) {
    consumeItem(session, beat.requiredItemId);
    stateChanges.push(`消耗 ${getItemLabel(session, beat.requiredItemId)}`);
  }

  if (beat.countdownDelta) {
    session.world.oxygen = clamp(session.world.oxygen + beat.countdownDelta, 0, getMaxCountdown(session));
    stateChanges.push(`${session.scenario.countdown.recoverLabel} ${beat.countdownDelta > 0 ? `+${beat.countdownDelta}` : beat.countdownDelta}`);
  }

  if (check.tier === 'fail') {
    return checkedResult(check, beat.failText, `节点“${beat.title}”推进失败。`, stateChanges, 0, 1);
  }

  session.world.storyBeatIndex = (session.world.storyBeatIndex ?? 0) + 1;
  if ((session.world.storyBeatIndex ?? 0) >= (session.scenario.beats?.length ?? 0)) {
    session.world.flags.escapeLaunched = true;
  }

  return checkedResult(
    check,
    beat.successText,
    `节点“${beat.title}”已推进。`,
    stateChanges
  );
}

function isBeatMatch(session: GameSession, action: FilteredAction) {
  const beat = getCurrentBeat(session);
  if (!beat) {
    return false;
  }

  if (action.dynamicBeatId === beat.id) {
    return true;
  }

  if (session.player.locationId !== beat.locationId) {
    return false;
  }

  if (action.type !== beat.actionType) {
    return false;
  }

  if (beat.requiredItemId && action.toolId !== beat.requiredItemId) {
    return false;
  }

  const normalizedBeatTarget = beat.targetLabel.toLowerCase();
  const normalizedActionTarget = (action.targetLabel ?? '').toLowerCase();
  if (normalizedBeatTarget && normalizedActionTarget) {
    return normalizedBeatTarget.includes(normalizedActionTarget) || normalizedActionTarget.includes(normalizedBeatTarget);
  }

  return true;
}

function inferDynamicSkill(actionType: ActionType): SkillKey {
  switch (actionType) {
    case 'repair':
    case 'inspect':
      return 'mind';
    case 'persuade':
      return 'empathy';
    default:
      return 'physique';
  }
}

function buildFilteredOffMainNarration(
  session: GameSession,
  action: FilteredAction,
  location: ReturnType<typeof requireLocation>,
  beat?: StoryBeat | null
): [string, string] {
  const agenda = session.player.secretAgenda;
  const focus = action.targetLabel || location.pointsOfInterest[0] || location.label;
  const beatTitle = beat?.title ?? '眼前这件事';
  const agendaHint = agenda?.status === 'active' ? ` 这反而让你想起自己的私事：${agenda.title}。` : '';
  const atmosphereTail = location.atmosphere ? ` ${location.atmosphere}` : '';
  const bodilyFlavor = classifyOffMainFlavor(action.rawIntent, action.normalizedIntent);

  switch (action.type) {
    case 'inspect':
      if (bodilyFlavor === 'gross-habit') {
        return [
          `你下意识做了个不太体面的细碎动作，指尖刚碰到鼻尖，${location.label}里的空气就显得更黏滞了。${location.description}${atmosphereTail}${agendaHint}`,
          `${location.label}没有因为这点小动作发生变化，只是把你的紧张照得更明显。`
        ];
      }
      if (bodilyFlavor === 'bathroom-urge') {
        return [
          `一阵更现实的生理压力突然顶了上来，你不得不先分神压住那股狼狈。${location.label}里的每一秒都因此更难熬了。${location.description}${atmosphereTail}${agendaHint}`,
          `你现在最先感受到的不是线索，而是身体在催你别再拖了。`
        ];
      }
      if (bodilyFlavor === 'panic-release') {
        return [
          `你试着用一个小动作把心里的绷紧抖掉，可${location.label}并没有因此松下来。${location.description}${atmosphereTail}${agendaHint}`,
          `${location.label}里的压迫感还在，眼前这件事也没有因为这点自我安抚就变轻。`
        ];
      }
      if (bodilyFlavor === 'provocation') {
        return [
          `你故意往更刺耳的方向说了一句，像在拿火星去蹭${location.label}里本就干燥的空气。${location.description}${atmosphereTail}${agendaHint}`,
          `这点挑衅没有换来答案，只让${location.label}里的敌意更清晰了。`
        ];
      }
      if (bodilyFlavor === 'play-dumb') {
        return [
          `你把神情放空，装出一副什么都没听懂的样子，想先从眼前这阵压迫里滑过去。${location.description}${atmosphereTail}${agendaHint}`,
          `这点装傻暂时替你挡了一下视线，可事情本身并没有因此消失。`
        ];
      }
      if (bodilyFlavor === 'stalling') {
        return [
          `你故意把动作放慢，像是在给自己多拖一口气。可${location.label}里的局势没有陪你一起停下来。${location.description}${atmosphereTail}${agendaHint}`,
          `你确实拖到了几秒，但真正逼近你的东西一点也没退。`
        ];
      }
      if (bodilyFlavor === 'begging') {
        return [
          `你下意识放低姿态，声音里先泄了半口气。${location.label}没有立刻给你怜悯，只把那点狼狈照得更亮。${location.description}${atmosphereTail}${agendaHint}`,
          `求饶没有换来宽恕，只让你更清楚自己正站在多窄的地方。`
        ];
      }
      if (bodilyFlavor === 'meltdown') {
        return [
          `你让情绪猛地冲出了喉咙，像是想用失控把这一刻撕开。可${location.label}只是把那阵回音完整地弹了回来。${location.description}${atmosphereTail}${agendaHint}`,
          `这场失控没把事情推开，反而让四周显得更逼仄了。`
        ];
      }
      return [
        `你转去翻看${focus}。${location.label}里那些零碎痕迹没有立刻给出答案，却让${location.description}${atmosphereTail}${agendaHint}`,
        `${location.label}里的这次观察只让现场轮廓更清楚了些，${beatTitle}还得从别处找突破口。`
      ];
    case 'persuade':
      return [
        `你试着把话头递向${focus}，可这里的气氛只是轻轻一滞，没有谁真的接住你的试探。${agendaHint}`,
        `这场交涉只在${location.label}留下了一点松动，真正的回应还没有出现。`
      ];
    case 'force':
      return [
        `你朝${focus}猛地施压，声音在${location.label}里炸开，却只换来更紧绷的回声。眼前的局面还是没有松口。${agendaHint}`,
        `这一下只是把${location.label}里的气氛压得更紧了，事情本身还卡在那里。`
      ];
    case 'use_item':
      return [
        `你把${action.toolId ? getItemLabel(session, action.toolId) : focus}先用在眼前的细节上，动作本身成立了，却更像一次临场准备。${agendaHint}`,
        `这点布置暂时稳住了${location.label}里的细节，但还没把事情真正推开。`
      ];
    case 'repair':
      return [
        `你下意识想对${focus}动手处理，可眼下更像一轮摸底，而不是正式修复。${agendaHint}`,
        `这次动手只让你摸清了${location.label}里更细的一层问题，事情还没真正转动。`
      ];
    default:
      return [
        `你在${location.label}做了一个不完全顺着眼前局势的动作。现场没有立刻给出回报，只把它沉成一阵更清晰的不安。${agendaHint}`,
        `这一下没有白费，只是暂时还没长成真正的结果。`
      ];
  }
}

function classifyOffMainFlavor(rawIntent: string, normalizedIntent: string) {
  const haystack = `${rawIntent} ${normalizedIntent}`;
  if (/(挖鼻屎|抠鼻|挖鼻孔)/.test(haystack)) {
    return 'gross-habit';
  }
  if (/(拉屎|上厕所|憋不住|大便|便意)/.test(haystack)) {
    return 'bathroom-urge';
  }
  if (/(挑衅|激怒|骂他|骂人|嘲讽|阴阳怪气|挑衅他)/.test(haystack)) {
    return 'provocation';
  }
  if (/(装傻|假装不懂|糊弄|装没事|装无辜)/.test(haystack)) {
    return 'play-dumb';
  }
  if (/(拖延|磨蹭|再等等|我不急|先不管|拖一会)/.test(haystack)) {
    return 'stalling';
  }
  if (/(求饶|别杀我|别打我|放过我|我错了)/.test(haystack)) {
    return 'begging';
  }
  if (/(发疯|乱叫|尖叫|狂笑|胡言乱语|发癫)/.test(haystack)) {
    return 'meltdown';
  }
  if (/(发呆|深呼吸|揉脸|发抖|冷静一下|缓一缓)/.test(haystack)) {
    return 'panic-release';
  }
  return 'generic';
}

function getCountdownEmptyNarration(scenario: StoryScenario) {
  const label = scenario.countdown.label;
  if (label.includes('氧')) return '警报在耳边拉长成一条尖线，你的呼吸先于舱体彻底耗尽。';
  if (label.includes('小时')) return '最后一点时间被你亲手耗光，故事在来不及补救之前就已经塌了下去。';
  return '你最后的行动余裕被彻底耗尽，局势再没给你下一步。';
}

function applySecretAgendaProgress(session: GameSession, rawIntent: string, publicText: string) {
  const agenda = session.player.secretAgenda;
  if (!agenda || agenda.status !== 'active') {
    return;
  }

  const haystack = `${rawIntent} ${publicText}`.toLowerCase();
  const matched = agenda.triggerKeywords.some((entry) => haystack.includes(entry.toLowerCase()));
  if (!matched) {
    return;
  }

  agenda.progress = clamp(agenda.progress + 1, 0, agenda.requiredProgress);
  if (agenda.progress >= agenda.requiredProgress) {
    agenda.status = 'completed';
  }
}

function refreshSecretAgenda(session: GameSession) {
  const agenda = session.player.secretAgenda;
  if (!agenda) {
    return;
  }

  if (agenda.status === 'completed') {
    return;
  }

  if (session.phase === 'failed' || session.phase === 'escaped') {
    agenda.status = agenda.progress >= agenda.requiredProgress ? 'completed' : 'failed';
  }
}

function formatSecretAgendaStatus(session: GameSession) {
  const agenda = session.player.secretAgenda;
  if (!agenda) {
    return '';
  }

  if (agenda.status === 'completed') {
    return `秘密目标已完成 ${agenda.progress}/${agenda.requiredProgress}`;
  }

  if (agenda.status === 'failed') {
    return `秘密目标失败 ${agenda.progress}/${agenda.requiredProgress}`;
  }

  return `秘密目标进行中 ${agenda.progress}/${agenda.requiredProgress}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatDangerChange(delta: number) {
  return delta > 0 ? `危险值 +${delta}` : `危险值 ${delta}`;
}









