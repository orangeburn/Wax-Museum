import {
  ARCHETYPES,
  CUSTOM_TAG_WHITELIST,
  ITEM_LIBRARY,
  SUBMARINE_TEMPLATE,
  TAG_RULES,
  type ActionType,
  type CreateSessionRequest,
  type EventLogEntry,
  type FilteredAction,
  type GameSession,
  type ItemId,
  type LocationId,
  type ObjectiveState,
  type ParsedAction,
  type Resolution,
  type SaveMeta,
  type SessionSnapshot,
  type SkillKey,
  type StoryBeat,
  type StoryScenario,
  type TagId
} from '@wax-museum/shared';
import { randomUUID } from 'node:crypto';
import { getItemLabel, getTargetLabel } from '../services/ai.js';

const FREE_ACTIONS = new Set<ActionType>(['inspect', 'inventory', 'help']);
const LOG_TAIL_SIZE = 8;
const INITIAL_HP = 3;
const INITIAL_SAN = 3;
const INITIAL_OXYGEN = 12;
const INITIAL_DANGER = 0;
const MAX_HP = INITIAL_HP;

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

function requireLocation(session: Pick<GameSession, 'world'>, locationId: LocationId) {
  const location = session.world.locations[locationId];
  if (!location) {
    throw new Error(`故事地点不存在：${locationId}`);
  }
  return location;
}

export function createNewSession(request: CreateSessionRequest, scenario?: StoryScenario): GameSession {
  const activeScenario = scenario ?? createScenarioFromTemplate();
  const startLocationId = getStartLocationId(activeScenario);
  const selectedRole = request.selectedRole;
  const archetype = selectedRole ? null : ARCHETYPES.find((entry) => entry.id === request.archetypeId);
  if (!selectedRole && !archetype) {
    throw new Error('未知的角色模板。');
  }

  const customTag = request.customTag.trim();
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
    sessionId: randomUUID(),
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
        : null
    },
    world: {
      templateId: activeScenario.id,
      oxygen: activeScenario.countdown.max,
      danger: INITIAL_DANGER,
      turn: 0,
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

function getMaxCountdown(session: GameSession) {
  return session.scenario.countdown.max + 2;
}

function getStartLocationId(scenario: StoryScenario): LocationId {
  if (isDynamicScenario(scenario)) {
    return scenario.beats?.[0]?.locationId ?? Object.keys(scenario.locations)[0] ?? 'crew-quarters';
  }
  return 'crew-quarters';
}

export function buildSnapshot(session: GameSession): SessionSnapshot {
  return {
    sessionId: session.sessionId,
    phase: session.phase,
    scenario: structuredClone(session.scenario),
    player: structuredClone(session.player),
    world: structuredClone(session.world),
    objectives: structuredClone(session.objectives),
    logTail: session.eventLog.slice(-LOG_TAIL_SIZE)
  };
}

export function filterAction(session: GameSession, parsed: ParsedAction): FilteredAction {
  const filteredParsed = applyStoryFilter(session, parsed);
  if (isDynamicScenario(session.scenario)) {
    return filterDynamicAction(session, filteredParsed);
  }

  const currentLocation = requireLocation(session, session.player.locationId);
  const targetId = (filteredParsed.targetId ?? 'location') as TargetId;

  if (filteredParsed.type === 'inventory' || filteredParsed.type === 'help') {
    return { ...filteredParsed, validity: 'accepted' };
  }

  if (filteredParsed.type === 'inspect') {
    return {
      ...filteredParsed,
      targetId,
      targetLabel: filteredParsed.targetLabel || currentLocation.label,
      validity: 'accepted'
    };
  }

  if (filteredParsed.type === 'move') {
    if (!filteredParsed.locationId) {
      return rejectAction(filteredParsed, '移动目标不明确。');
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

    if (filteredParsed.locationId === 'escape-bay' && !session.world.flags.escapeBayUnlocked) {
      return {
        ...filteredParsed,
        type: 'inspect',
        consumesTurn: false,
        validity: 'redirected',
        redirectedFrom: 'move',
        targetId: 'bulkhead',
        targetLabel: getTargetLabel(session, 'bulkhead'),
        reason: `${requireLocation(session, 'escape-bay').label} 还被${getTargetLabel(session, 'bulkhead')}锁住。`
      };
    }

    if (!currentLocation.connected.includes(filteredParsed.locationId)) {
      return rejectAction(filteredParsed, '当前舱室无法直达那个位置。');
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
    if (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent) {
      return rejectAction(filteredParsed, '这里没人能被你说服。');
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

    if (inferred.targetId === 'escape-pod' && (session.player.locationId !== 'escape-bay' || !session.world.flags.escapeBayUnlocked)) {
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
  const filteredAction = filterAction(working, parsed);
  const presentation: EnginePresentation = {
    publicText: '',
    systemText: ''
  };

  let resolution: Resolution;

  if (filteredAction.validity === 'rejected') {
    resolution = {
      tier: 'fail',
      summary: filteredAction.reason ?? '行动被现实滤镜拒绝。',
      stateChanges: [],
      oxygenCost: 0,
      dangerDelta: 0,
      damage: 0
    };
    presentation.publicText = filteredAction.reason ?? '你的意图没有通过现实滤镜。';
    presentation.systemText = '状态未变化。';
  } else {
    const outcome = executeAcceptedAction(working, filteredAction, randomSource);
    resolution = outcome.resolution;
    presentation.publicText = outcome.publicText;
    presentation.systemText = outcome.systemText;

    if (filteredAction.consumesTurn) {
      working.world.turn += 1;
      working.world.oxygen = clamp(working.world.oxygen - 1, 0, getMaxCountdown(working));
      resolution.oxygenCost = 1;
      resolution.stateChanges.unshift(`${working.scenario.countdown.shortLabel} -1`);
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

export function deriveObjectiveState(session: GameSession): ObjectiveState {
  if (isDynamicScenario(session.scenario)) {
    return deriveDynamicObjectiveState(session);
  }

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
    countdownLabel: `${session.scenario.countdown.shortLabel} ${session.world.oxygen}/${session.scenario.countdown.max}`,
    availableActionsHint: listAvailableActions(session),
    secretAgendaStatus: formatSecretAgendaStatus(session)
  };
}

export function listAvailableActions(session: GameSession): string[] {
  if (isDynamicScenario(session.scenario)) {
    return listDynamicActions(session);
  }

  const hints: string[] = [];
  const location = session.player.locationId;
  const currentLocation = requireLocation(session, location);

  hints.push(`查看${currentLocation.label}`);

  if (location === 'crew-quarters') {
    if (!session.world.flags.wrenchFound) {
      hints.push(`查看${getTargetLabel(session, 'locker')}`);
      hints.push(`强行撬开${getTargetLabel(session, 'locker')}`);
    }
    hints.push(`前往${requireLocation(session, 'engine-room').label}`);
    hints.push(`前往${requireLocation(session, 'med-bay').label}`);
  }

  if (location === 'engine-room') {
    if (!session.world.flags.powerRestored) {
      hints.push(`修理${getTargetLabel(session, 'relay')}`);
      hints.push(`查看${getTargetLabel(session, 'relay')}`);
      if (hasItem(session, 'sealant-foam') && hasItem(session, 'insulated-wrench')) {
        hints.push(`使用${getItemLabel(session, 'sealant-foam')}修复${getTargetLabel(session, 'relay')}`);
      }
    }
    hints.push(`查看${requireLocation(session, 'engine-room').pointsOfInterest[1]}`);
    hints.push(`前往${requireLocation(session, 'control-room').label}`);
    hints.push(`前往${requireLocation(session, 'crew-quarters').label}`);
  }

  if (location === 'med-bay') {
    hints.push(`查看${getTargetLabel(session, 'cabinet')}`);
    if (session.world.flags.survivorPresent) {
      hints.push(`查看${getTargetLabel(session, 'survivor')}`);
    }
    if (session.world.flags.survivorPresent && !session.world.flags.survivorHelped) {
      hints.push(`说服${getTargetLabel(session, 'survivor')}`);
      if (hasItem(session, 'medkit')) {
        hints.push(`使用${getItemLabel(session, 'medkit')}救${getTargetLabel(session, 'survivor')}`);
      }
    }
    hints.push(`前往${requireLocation(session, 'crew-quarters').label}`);
  }

  if (location === 'control-room') {
    hints.push(`查看${getTargetLabel(session, 'console')}`);
    hints.push(`查看${getTargetLabel(session, 'bulkhead')}`);
    if (session.world.flags.keycardRecovered && !session.world.flags.escapeBayUnlocked) {
      hints.push(`使用${getItemLabel(session, 'captain-keycard')}`);
    }
    if (!session.world.flags.escapeBayUnlocked) {
      hints.push(`强行破开${getTargetLabel(session, 'bulkhead')}`);
    }
    hints.push(`前往${requireLocation(session, 'engine-room').label}`);
  }

  if (location === 'escape-bay') {
    hints.push(`查看${getTargetLabel(session, 'escape-pod')}`);
    if (session.world.flags.launchInspected && !session.world.flags.launchReady && hasItem(session, 'oxygen-canister')) {
      hints.push(`使用${getItemLabel(session, 'oxygen-canister')}`);
    }
    hints.push(`启动${getTargetLabel(session, 'escape-pod')}`);
    hints.push(`前往${requireLocation(session, 'control-room').label}`);
  }

  if (hasItem(session, 'medkit')) {
    hints.push(`使用${getItemLabel(session, 'medkit')}`);
  }
  if (hasItem(session, 'oxygen-canister')) {
    hints.push(`使用${getItemLabel(session, 'oxygen-canister')}`);
  }

  hints.push('查看背包');
  hints.push('请求提示');
  return Array.from(new Set(hints)).slice(0, 9);
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
    `已抵达 ${place.label}。`,
    []
  );
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
    stateChanges.push('危险值 -1');

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

  if (parsed.type === 'persuade' && (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent)) {
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

    if (!currentLocation.connected.includes(parsed.locationId)) {
      return rejectAction(parsed, '当前区域无法直达那个位置。');
    }

    return { ...parsed, validity: 'accepted' };
  }

  if (parsed.type === 'use_item' && parsed.toolId && !hasItem(session, parsed.toolId)) {
    return rejectAction(parsed, `你身上没有${getItemLabel(session, parsed.toolId)}。`);
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
    countdownLabel: `${session.scenario.countdown.shortLabel} ${session.world.oxygen}/${session.scenario.countdown.max}`,
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

  currentLocation.connected.forEach((entry) => {
    hints.add(`前往${requireLocation(session, entry).label}`);
  });

  session.player.inventory.forEach((itemId) => {
    hints.add(`使用${getItemLabel(session, itemId)}`);
  });

  hints.add('查看背包');
  hints.add('请求提示');
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
