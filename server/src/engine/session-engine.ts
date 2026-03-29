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
const MAX_OXYGEN = INITIAL_OXYGEN + 2;

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

export function createNewSession(request: CreateSessionRequest, scenario?: StoryScenario): GameSession {
  const activeScenario = scenario ?? createScenarioFromTemplate();
  const archetype = ARCHETYPES.find((entry) => entry.id === request.archetypeId);
  if (!archetype) {
    throw new Error('未知的角色模板。');
  }

  const customTag = request.customTag.trim();
  const normalizedCustomTag = CUSTOM_TAG_WHITELIST.includes(customTag as TagId)
    ? (customTag as TagId)
    : null;
  const notes: string[] = [];
  const selectedRole = request.selectedRole;

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
      archetypeId: archetype.id,
      archetypeLabel: selectedRole?.label || archetype.label,
      customBackground: request.customBackground.trim(),
      customTag: customTag || null,
      notes,
      stats: { ...archetype.stats },
      tags: normalizedCustomTag ? [archetype.defaultTag, normalizedCustomTag] : [archetype.defaultTag],
      hp: INITIAL_HP,
      san: INITIAL_SAN,
      inventory: [...archetype.startingItems],
      locationId: 'crew-quarters'
    },
    world: {
      templateId: activeScenario.id,
      oxygen: INITIAL_OXYGEN,
      danger: INITIAL_DANGER,
      turn: 0,
      locations: structuredClone(activeScenario.locations),
      visitedLocations: ['crew-quarters'],
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
    publicText: `${activeScenario.openingLine} 你从${activeScenario.locations[session.player.locationId].label}醒来，四周只剩零碎回声。`,
    systemText: session.objectives.dynamicGuide,
    timestamp: new Date().toISOString()
  });

  return refreshDerivedState(session);
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
  const currentLocation = session.world.locations[session.player.locationId];
  const targetId = (parsed.targetId ?? 'location') as TargetId;

  if (parsed.type === 'inventory' || parsed.type === 'help') {
    return { ...parsed, validity: 'accepted' };
  }

  if (parsed.type === 'inspect') {
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

    if (parsed.locationId === 'escape-bay' && !session.world.flags.escapeBayUnlocked) {
      return {
        ...parsed,
        type: 'inspect',
        consumesTurn: false,
        validity: 'redirected',
        redirectedFrom: 'move',
        targetId: 'bulkhead',
        targetLabel: getTargetLabel(session, 'bulkhead'),
        reason: `${session.world.locations['escape-bay'].label} 还被${getTargetLabel(session, 'bulkhead')}锁住。`
      };
    }

    if (!currentLocation.connected.includes(parsed.locationId)) {
      return rejectAction(parsed, '当前舱室无法直达那个位置。');
    }

    return { ...parsed, validity: 'accepted' };
  }

  if (parsed.type === 'repair') {
    if (session.player.locationId !== 'engine-room') {
      return rejectAction(parsed, `${getTargetLabel(session, 'relay')}不在这里。`);
    }

    if (!hasItem(session, 'insulated-wrench')) {
      return rejectAction(parsed, `你需要先找到${getItemLabel(session, 'insulated-wrench')}。`);
    }

    return {
      ...parsed,
      targetId: 'relay',
      targetLabel: getTargetLabel(session, 'relay'),
      validity: 'accepted'
    };
  }

  if (parsed.type === 'force') {
    const inferredTarget = inferForceTarget(session, targetId);
    if (!inferredTarget) {
      return rejectAction(parsed, '这里没有适合强行破开的目标。');
    }

    return {
      ...parsed,
      targetId: inferredTarget,
      targetLabel: getTargetLabel(session, inferredTarget),
      validity: 'accepted'
    };
  }

  if (parsed.type === 'persuade') {
    if (session.player.locationId !== 'med-bay' || !session.world.flags.survivorPresent) {
      return rejectAction(parsed, '这里没人能被你说服。');
    }

    return {
      ...parsed,
      targetId: 'survivor',
      targetLabel: getTargetLabel(session, 'survivor'),
      validity: 'accepted'
    };
  }

  if (parsed.type === 'use_item') {
    const inferred = inferUseItemTarget(session, parsed);
    if (!inferred) {
      return rejectAction(parsed, '现在没有合适的使用对象。');
    }

    if (inferred.toolId && !hasItem(session, inferred.toolId)) {
      return rejectAction(parsed, `你身上没有${getItemLabel(session, inferred.toolId)}。`);
    }

    if (inferred.targetId === 'bulkhead' && session.player.locationId !== 'control-room') {
      return rejectAction(parsed, `只有在${session.world.locations['control-room'].label}的${getTargetLabel(session, 'bulkhead')}前才能使用${getItemLabel(session, 'captain-keycard')}。`);
    }

    if (inferred.targetId === 'escape-pod' && (session.player.locationId !== 'escape-bay' || !session.world.flags.escapeBayUnlocked)) {
      return rejectAction(parsed, `${getTargetLabel(session, 'escape-pod')}还没有准备好。`);
    }

    return {
      ...parsed,
      ...inferred,
      validity: 'accepted'
    };
  }

  return rejectAction(parsed, '无法识别的行动。');
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
      working.world.oxygen = clamp(working.world.oxygen - 1, 0, MAX_OXYGEN);
      resolution.oxygenCost = 1;
      resolution.stateChanges.unshift('氧气 -1');
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
        presentation.publicText += ' 警报在耳边拉长成一条尖线，你的呼吸先于舱体彻底耗尽。';
      } else {
        presentation.publicText += ' 疼痛和失血让你再也站不起来。';
      }
    }

    if (working.world.flags.escapeLaunched) {
      working.phase = 'escaped';
    }
  }

  refreshDerivedState(working);
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
  let phase: ObjectiveState['phase'] = 'find-tool';
  let dynamicGuide = `先在${session.world.locations['crew-quarters'].label}找到${getItemLabel(session, 'insulated-wrench')}。`;

  if (session.phase === 'escaped') {
    phase = 'resolution';
    dynamicGuide = `你已经脱离 ${session.scenario.title}，记录这局生还经过。`;
  } else if (session.phase === 'failed') {
    phase = 'resolution';
    dynamicGuide = '本局已经失败，可以从开始页继续旧存档或新开一局。';
  } else if (!session.world.flags.wrenchFound) {
    phase = 'find-tool';
    dynamicGuide = `先在${session.world.locations['crew-quarters'].label}寻找${getItemLabel(session, 'insulated-wrench')}。`;
  } else if (!session.world.flags.powerRestored) {
    phase = 'restore-power';
    dynamicGuide = `带着${getItemLabel(session, 'insulated-wrench')}去${session.world.locations['engine-room'].label}处理${getTargetLabel(session, 'relay')}。`;
  } else if (!session.world.flags.consoleDecoded) {
    phase = 'investigate-console';
    dynamicGuide = `供能恢复后，去${session.world.locations['control-room'].label}查看${getTargetLabel(session, 'console')}，确认谁把线索藏了起来。`;
  } else if (!session.world.flags.keycardRecovered) {
    phase = 'get-keycard';
    dynamicGuide = `去${session.world.locations['med-bay'].label}，从${getTargetLabel(session, 'cabinet')}里拿到${getItemLabel(session, 'captain-keycard')}。`;
  } else if (!session.world.flags.survivorHelped) {
    phase = 'stabilize-survivor';
    dynamicGuide = `在${session.world.locations['med-bay'].label}稳住${getTargetLabel(session, 'survivor')}，对方也许知道最后的启动条件。`;
  } else if (!session.world.flags.escapeBayUnlocked) {
    phase = 'reach-escape-bay';
    dynamicGuide = `回到${session.world.locations['control-room'].label}，用${getItemLabel(session, 'captain-keycard')}解锁通往${session.world.locations['escape-bay'].label}的${getTargetLabel(session, 'bulkhead')}。`;
  } else if (session.player.locationId !== 'escape-bay') {
    phase = 'reach-escape-bay';
    dynamicGuide = `穿过${getTargetLabel(session, 'bulkhead')}，前往${session.world.locations['escape-bay'].label}。`;
  } else if (!session.world.flags.launchInspected) {
    phase = 'prepare-launch';
    dynamicGuide = `先查看${getTargetLabel(session, 'escape-pod')}，确认它还缺哪一步才能真正启动。`;
  } else if (!session.world.flags.launchReady) {
    phase = 'prepare-launch';
    dynamicGuide = `用${getItemLabel(session, 'oxygen-canister')}或其他情报补齐最后的启动准备，再尝试发车。`;
  } else {
    phase = 'prepare-launch';
    dynamicGuide = `启动${getTargetLabel(session, 'escape-pod')}，立刻脱离 ${session.scenario.title}。`;
  }

  return {
    macroObjective: session.scenario.macroObjective,
    dynamicGuide,
    phase,
    countdownLabel: `氧气 ${session.world.oxygen}/${INITIAL_OXYGEN}`,
    availableActionsHint: listAvailableActions(session)
  };
}

export function listAvailableActions(session: GameSession): string[] {
  const hints: string[] = [];
  const location = session.player.locationId;

  hints.push(`查看${session.world.locations[location].label}`);

  if (location === 'crew-quarters') {
    if (!session.world.flags.wrenchFound) {
      hints.push(`查看${getTargetLabel(session, 'locker')}`);
      hints.push(`强行撬开${getTargetLabel(session, 'locker')}`);
    }
    hints.push(`前往${session.world.locations['engine-room'].label}`);
    hints.push(`前往${session.world.locations['med-bay'].label}`);
  }

  if (location === 'engine-room') {
    if (!session.world.flags.powerRestored) {
      hints.push(`修理${getTargetLabel(session, 'relay')}`);
      hints.push(`查看${getTargetLabel(session, 'relay')}`);
      if (hasItem(session, 'sealant-foam') && hasItem(session, 'insulated-wrench')) {
        hints.push(`使用${getItemLabel(session, 'sealant-foam')}修复${getTargetLabel(session, 'relay')}`);
      }
    }
    hints.push(`查看${session.world.locations['engine-room'].pointsOfInterest[1]}`);
    hints.push(`前往${session.world.locations['control-room'].label}`);
    hints.push(`前往${session.world.locations['crew-quarters'].label}`);
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
    hints.push(`前往${session.world.locations['crew-quarters'].label}`);
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
    hints.push(`前往${session.world.locations['engine-room'].label}`);
  }

  if (location === 'escape-bay') {
    hints.push(`查看${getTargetLabel(session, 'escape-pod')}`);
    if (session.world.flags.launchInspected && !session.world.flags.launchReady && hasItem(session, 'oxygen-canister')) {
      hints.push(`使用${getItemLabel(session, 'oxygen-canister')}`);
    }
    hints.push(`启动${getTargetLabel(session, 'escape-pod')}`);
    hints.push(`前往${session.world.locations['control-room'].label}`);
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
  const location = session.world.locations[session.player.locationId];
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
        `最好先去${session.world.locations['control-room'].label}核对转移日志。`,
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
      `${session.world.locations['med-bay'].label}里的关键柜体仍然锁定。`,
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
    if (session.player.archetypeId === 'passenger' && !session.world.flags.keycardRecovered) {
      giveItem(session, 'captain-keycard');
      session.world.flags.keycardRecovered = true;
      session.world.flags.keycardHinted = true;
      session.world.flags.consoleDecoded = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'captain-keycard')}`);
      return successResult(
        `你扶着${getTargetLabel(session, 'console')}稳住身体时，旁边暗格里突然滑出了 ${getItemLabel(session, 'captain-keycard')}。`,
        `你意外在${session.world.locations['control-room'].label}直接找到了关键通行物。`,
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
      `${getTargetLabel(session, 'console')}恢复了几条残缺日志，其中一条写着：${getItemLabel(session, 'captain-keycard')}已转移至${getTargetLabel(session, 'cabinet')}；另一条则提醒，撤离载具在强制休眠后还需要人工预充启动气压。`,
      '控制区日志为你确认了关键通行物的位置，也提前暴露了最终逃生步骤。',
      stateChanges
    );
  }

  if (session.player.locationId === 'control-room' && target === 'bulkhead') {
    const detail = session.world.flags.escapeBayUnlocked
      ? `${getTargetLabel(session, 'bulkhead')}已经滑开，${session.world.locations['escape-bay'].label}那侧的提示灯在闪。`
      : `${getTargetLabel(session, 'bulkhead')}死死咬合着，旁边只剩一处等待${getItemLabel(session, 'captain-keycard')}唤醒的识别槽。`;
    return successResult(detail, `${session.world.locations['control-room'].label}到${session.world.locations['escape-bay'].label}的通路状态已更新。`, stateChanges);
  }

  if (session.player.locationId === 'escape-bay' && target === 'escape-pod') {
    if (!session.world.flags.launchInspected) {
      session.world.flags.launchInspected = true;
      return successResult(
        `${getTargetLabel(session, 'escape-pod')}的仪表虽然亮了起来，但启动页上还卡着一行红字：预充气压不足，需要便携气源手动灌入。`,
        `${getTargetLabel(session, 'escape-pod')}还不能直接启动，你还差最后一次准备。`,
        stateChanges
      );
    }

    if (!session.world.flags.launchReady) {
      return successResult(
        `${getTargetLabel(session, 'escape-pod')}的外壳在低鸣，像随时能冲出去，却始终停在最后一重安全锁前。你还得补上预充气压。`,
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
  const place = session.world.locations[destination];
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
    return checkedResult(check, `你在${getTargetLabel(session, 'bulkhead')}的轨道里硬生生撬出一个空隙，伴随一声闷响，门体终于滑开。`, `通往${session.world.locations['escape-bay'].label}的路线被强行打开。`, stateChanges);
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
      '军医处理稳定了幸存者，并提前拿到了逃生关键物资。',
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
        `你把${getItemLabel(session, 'oxygen-canister')}接上${getTargetLabel(session, 'escape-pod')}侧面的应急接口，指针终于越过红线，整台装置像被重新唤醒。`,
        `${getTargetLabel(session, 'escape-pod')}已经具备发射条件。`,
        stateChanges
      );
    }

    consumeItem(session, 'oxygen-canister');
    session.world.oxygen = clamp(session.world.oxygen + 2, 0, MAX_OXYGEN);
    stateChanges.push('氧气 +2');
    return successResult('冷气迅速灌入肺里，你终于重新把呼吸拉回了节奏。', `${getItemLabel(session, 'oxygen-canister')}已使用。`, stateChanges);
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
    return successResult(`${getItemLabel(session, 'captain-keycard')}划过识别槽，${getTargetLabel(session, 'bulkhead')}终于发出一声沉闷的解锁声。`, `${session.world.locations['escape-bay'].label}通路已打开。`, stateChanges);
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
    return checkedResult(check, `${getTargetLabel(session, 'survivor')}终于稳住呼吸，把藏着的一份${getItemLabel(session, 'oxygen-canister')}塞进你手里，还提醒你撤离装置在强制休眠后必须手动补一口启动气压。`, '幸存者被安抚并提供了物资，也说出了最后的启动条件。', stateChanges);
  }

  if (check.tier === 'cost') {
    if (!session.world.flags.survivorHelped) {
      giveItem(session, 'oxygen-canister');
      session.world.flags.survivorHelped = true;
      stateChanges.push(`获得 ${getItemLabel(session, 'oxygen-canister')}`);
    }
    return checkedResult(check, `${getTargetLabel(session, 'survivor')}勉强点头，把${getItemLabel(session, 'oxygen-canister')}递给你，但对方的惊慌也让${session.world.locations['med-bay'].label}的动静更大了。混乱里，你还是听清了那句“启动前先补气压”。`, '你拿到了帮助，但局势更乱。', stateChanges, 0, 1);
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
    systemText: `${presentation.systemText}${resolution.stateChanges.length ? ` (${resolution.stateChanges.join(' / ')})` : ''}`,
    timestamp: new Date().toISOString()
  };
}

function refreshDerivedState(session: GameSession) {
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
    availableActionsHint: []
  };
}

function createScenarioFromTemplate(): StoryScenario {
  return {
    id: SUBMARINE_TEMPLATE.id,
    title: SUBMARINE_TEMPLATE.label,
    premise: SUBMARINE_TEMPLATE.premise,
    openingLine: SUBMARINE_TEMPLATE.openingLine,
    macroObjective: SUBMARINE_TEMPLATE.macroObjective,
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
    danger: 0,
    dynamicGuide: ''
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatDangerChange(delta: number) {
  return delta > 0 ? `危险值 +${delta}` : `危险值 ${delta}`;
}
