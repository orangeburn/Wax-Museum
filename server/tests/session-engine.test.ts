import { describe, expect, it } from 'vitest';
import { appendPlayerPublicMessage, applyParsedAction, applyParsedActionWithNpcAi, buildActorObservation, buildSnapshot, createNewSession } from '../src/engine/session-engine.js';
import { LocalAiService } from '../src/services/ai.js';

describe('session engine', () => {
  it('keeps non-whitelisted custom tags as narrative notes only', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '曾参与过深潜事故调查。',
      customTag: '天选之子'
    });

    expect(session.player.tags).toEqual(['机械直觉']);
    expect(session.player.notes.join(' ')).toContain('未进入规则白名单');
    expect(session.objectives.dynamicGuide).toContain('绝缘扳手');
  });

  it('builds round order from 2d6 initiative and keeps action points within a 2-point spread', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      selectedRole: {
        id: 'role-player',
        archetypeId: 'engineer',
        label: '调查工程师',
        publicIdentity: '你负责排查事故设备链路。',
        hiddenDrive: '你怀疑有人提前动过系统。',
        relationshipHook: '你和现场一人共享一段被压下的事故记忆。',
        specialty: '复盘日志与设备异常',
        suggestedTag: '冷静',
        suggestedBackground: '你带着旧案留下的愧疚回来。',
        stats: { physique: 2, mind: 4, empathy: 2 },
        startingItems: ['insulated-wrench'],
        coreTag: '冷静',
        secretAgenda: {
          title: '私密任务',
          description: '查清谁改写了记录。',
          successHint: '多追日志和旧案。',
          triggerKeywords: ['日志', '旧案'],
          requiredProgress: 2
        }
      },
      generatedRoles: [
        {
          id: 'role-player',
          archetypeId: 'engineer',
          label: '调查工程师',
          publicIdentity: '你负责排查事故设备链路。',
          hiddenDrive: '你怀疑有人提前动过系统。',
          relationshipHook: '你和现场一人共享一段被压下的事故记忆。',
          specialty: '复盘日志与设备异常',
          suggestedTag: '冷静',
          suggestedBackground: '你带着旧案留下的愧疚回来。',
          stats: { physique: 2, mind: 4, empathy: 2 },
          startingItems: ['insulated-wrench'],
          coreTag: '冷静',
          secretAgenda: {
            title: '私密任务',
            description: '查清谁改写了记录。',
            successHint: '多追日志和旧案。',
            triggerKeywords: ['日志', '旧案'],
            requiredProgress: 2
          }
        },
        {
          id: 'role-npc-a',
          archetypeId: 'medic',
          label: '联络员',
          publicIdentity: '后勤接口人',
          hiddenDrive: '确保信息可控',
          relationshipHook: '你知道谁在撒谎。',
          specialty: '协调口径',
          suggestedTag: '说客',
          suggestedBackground: '你想保住自己的位置。',
          stats: { physique: 2, mind: 3, empathy: 4 },
          startingItems: ['medkit'],
          coreTag: '说客',
          secretAgenda: {
            title: '私密任务',
            description: '稳住局面。',
            successHint: '先合作后套话。',
            triggerKeywords: ['合作', '口径'],
            requiredProgress: 2
          }
        },
        {
          id: 'role-npc-b',
          archetypeId: 'security',
          label: '守望者',
          publicIdentity: '值班记录员',
          hiddenDrive: '阻止任何人离开',
          relationshipHook: '你见过事故发生前最后一次换岗。',
          specialty: '施压与封控',
          suggestedTag: '钢铁意志',
          suggestedBackground: '你认定有人必须被留下。',
          stats: { physique: 4, mind: 2, empathy: 1 },
          startingItems: ['oxygen-canister'],
          coreTag: '钢铁意志',
          secretAgenda: {
            title: '私密任务',
            description: '别让任何人轻松脱身。',
            successHint: '卡住关键出口。',
            triggerKeywords: ['出口', '封控'],
            requiredProgress: 2
          }
        }
      ],
      customBackground: '',
      customTag: ''
    });

    const actorAps = [
      session.world.playerActionPoints ?? 0,
      ...Object.values(session.world.npcActionPoints ?? {})
    ];

    expect(Math.max(...actorAps) - Math.min(...actorAps)).toBeLessThanOrEqual(2);
    expect((session.world.turnOrder ?? []).every((entry) => entry.initiative >= 2 && entry.initiative <= 12)).toBe(true);
  });

  it('allows sandbox movement and still story-filters invalid repairs', async () => {
    const ai = new LocalAiService();
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: '冷静'
    });

    const redirectAttempt = await ai.intentToAction(session, '我直接前往逃生舱');
    const redirected = applyParsedAction(session, redirectAttempt, () => 0.5);
    expect(redirected.filteredAction.validity).toBe('accepted');
    expect(redirected.filteredAction.type).toBe('move');
    expect(redirected.session.player.locationId).toBe('escape-bay');
    expect(redirected.session.world.oxygen).toBe(11);

    const invalidRepair = await ai.intentToAction(session, '我现在修理主继电器');
    const rejected = applyParsedAction(session, invalidRepair, () => 0.5);
    expect(rejected.filteredAction.validity).toBe('accepted');
    expect(rejected.filteredAction.storyFilterNote).toContain('当前场景没有可直接修理的核心装置');
    expect(rejected.filteredAction.type).toBe('inspect');
  });

  it('consumes oxygen and adds danger on risky failures', async () => {
    const ai = new LocalAiService();
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'passenger',
      customBackground: '',
      customTag: ''
    });

    const parsed = await ai.intentToAction(session, '我强行撬开储物柜');
    const result = applyParsedAction(session, parsed, () => 0);

    expect(result.resolution.tier).toBe('fail');
    expect(result.session.world.oxygen).toBe(12);
    expect(result.session.world.danger).toBe(1);
  });

  it('runs an NPC autonomy turn after movement', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.scenario.npcs = [
      {
        id: 'npc-warden',
        name: '守望者',
        publicIdentity: '值班记录员',
        hiddenDrive: '阻止任何人离开',
        attitude: 'hostile',
        locationId: 'engine-room',
        clue: '他不断重复“谁都别想离开”。',
        status: '态度强硬，持续施压。'
      }
    ];
    session.world.playerActionPoints = 2;
    session.world.npcActionPoints = { 'npc-warden': 2 };
    session.world.turnOrder = [
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 12 },
      { actorId: 'npc-warden', actorLabel: '守望者', actorType: 'npc', initiative: 8 }
    ];
    session.world.activeActorId = 'player';

    const moved = applyParsedAction(
      session,
      {
        type: 'move',
        rawIntent: '前往机轮舱',
        normalizedIntent: '前往机轮舱',
        targetLabel: '机轮舱',
        locationId: 'engine-room',
        consumesTurn: true
      },
      () => 0.99
    );

    expect(moved.session.player.locationId).toBe('engine-room');
    expect(moved.session.world.oxygen).toBe(11);
    expect(moved.session.world.danger).toBe(1);
    expect(moved.presentation.publicText).toContain('守望者');
    expect(moved.resolution.stateChanges.join(' / ')).toContain('NPC施压');
  });

  it('builds NPC observations without leaking hidden drives to the player snapshot', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });
    session.scenario.npcs = [
      {
        id: 'npc-hidden',
        name: '守望者',
        publicIdentity: '值班记录员',
        hiddenDrive: '阻止任何人离开',
        attitude: 'hostile',
        locationId: session.player.locationId,
        clue: '“谁都别想离开。”',
        status: '态度强硬，持续施压。',
        privateState: {
          coreGoal: '阻止任何人离开',
          shortTermGoal: '贴近玩家并制造压力',
          strategy: '施压',
          stress: 1,
          memory: ['看见玩家醒来']
        }
      }
    ];
    session.world.playerActionPoints = 2;
    session.world.npcActionPoints = { 'npc-helper': 3 };
    session.world.turnOrder = [
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 12 },
      { actorId: 'npc-helper', actorLabel: '联络员', actorType: 'npc', initiative: 8 }
    ];
    session.world.activeActorId = 'player';
    session.world.playerActionPoints = 2;

    const snapshot = buildSnapshot(session);
    const npcSnapshot = snapshot.scenario.npcs?.[0];
    expect(npcSnapshot?.hiddenDrive).toBe('未知');
    expect(npcSnapshot?.privateState).toBeUndefined();

    const observation = buildActorObservation(session, 'npc-hidden');
    expect(observation.privateBrief?.coreGoal).toBe('阻止任何人离开');
    expect((observation.visibleNpcs[0] as { hiddenDrive?: string } | undefined)?.hiddenDrive).toBeUndefined();
  });

  it('stores public chat messages in snapshots and actor observations', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    const updated = appendPlayerPublicMessage(session, '谁看见了权限卡？');
    const snapshot = buildSnapshot(updated);
    const observation = buildActorObservation(updated, 'player');

    expect(snapshot.publicMessages.at(-1)?.content).toBe('谁看见了权限卡？');
    expect(snapshot.publicMessages.at(-1)?.speakerType).toBe('player');
    expect(observation.publicMessages.at(-1)?.content).toBe('谁看见了权限卡？');
  });

  it('lets an async NPC intent decider drive NPC actions from observation', async () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });
    session.scenario.npcs = [
      {
        id: 'npc-helper',
        name: '联络员',
        publicIdentity: '后勤接口人',
        hiddenDrive: '确保信息可控',
        attitude: 'friendly',
        locationId: 'engine-room',
        clue: '“先看供能，再谈撤离。”',
        status: '保持观望，暂不表态。'
      }
    ];
    session.world.playerActionPoints = 2;
    session.world.npcActionPoints = { 'npc-helper': 3 };
    session.world.turnOrder = [
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 12 },
      { actorId: 'npc-helper', actorLabel: '联络员', actorType: 'npc', initiative: 8 }
    ];
    session.world.activeActorId = 'player';

    const result = await applyParsedActionWithNpcAi(
      session,
      {
        type: 'move',
        rawIntent: '前往机轮舱',
        normalizedIntent: '前往机轮舱',
        targetLabel: '机轮舱',
        locationId: 'engine-room',
        consumesTurn: true
      },
      () => 0.99,
      async ({ observation }) => {
        expect(observation.actorId).toBe('npc-helper');
        expect(observation.privateBrief?.coreGoal).toBe('确保信息可控');
        return {
          intent: '向玩家分享线索',
          actionType: 'persuade',
          reason: '玩家进入了我所在的位置'
        };
      }
    );

    expect(result.presentation.publicText).toContain('联络员');
    expect(result.resolution.stateChanges.join(' / ')).toContain('NPC协助');
  });

  it('lets NPC AI publish public chat messages during its turn', async () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });
    session.scenario.npcs = [
      {
        id: 'npc-helper',
        name: '联络员',
        publicIdentity: '后勤接口人',
        hiddenDrive: '确认玩家掌握了多少信息',
        attitude: 'friendly',
        locationId: 'engine-room',
        clue: '“先问谁靠近过控制室。”',
        status: '保持观望，暂不表态。'
      }
    ];
    session.world.playerActionPoints = 0;
    session.world.npcActionPoints = { 'npc-helper': 2 };
    session.world.turnOrder = [
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 12 },
      { actorId: 'npc-helper', actorLabel: '联络员', actorType: 'npc', initiative: 8 }
    ];
    session.world.activeActorId = 'player';

    const result = await applyParsedActionWithNpcAi(
      session,
      {
        type: 'help',
        rawIntent: '结束回合',
        normalizedIntent: '结束回合',
        targetLabel: '当前区域',
        consumesTurn: false
      },
      () => 0.99,
      async () => ({
        intent: '观察公屏反应',
        actionType: 'inspect',
        publicMessage: '我只问一句：谁最后碰过控制室？',
        reason: '用公开问题试探其他人'
      })
    );

    expect(result.session.publicMessages.at(-1)?.speakerLabel).toBe('联络员');
    expect(result.session.publicMessages.at(-1)?.content).toBe('我只问一句：谁最后碰过控制室？');
    expect(result.presentation.publicText).toContain('公屏发言');
  });

  it('lets NPCs collect scene items into a limited backpack', async () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });
    session.scenario.npcs = [
      {
        id: 'npc-scavenger',
        name: '联络员',
        publicIdentity: '后勤接口人',
        hiddenDrive: '确保物资不落空',
        attitude: 'friendly',
        locationId: 'engine-room',
        clue: '“现场物资比口供更可靠。”',
        status: '保持观望，暂不表态。',
        inventory: ['medkit', 'sealant-foam', 'captain-keycard', 'insulated-wrench']
      }
    ];
    session.world.locations['engine-room'].sceneObjects.push({
      id: 'engine-oxygen',
      label: '备用氧气罐',
      category: 'container',
      description: '一只被卡在工具箱底部的备用氧气罐。',
      interactionHints: ['拾取备用氧气罐'],
      hiddenItemId: 'oxygen-canister'
    });
    session.world.npcActionPoints = { 'npc-scavenger': 3 };
    session.world.turnOrder = [
      { actorId: 'npc-scavenger', actorLabel: '联络员', actorType: 'npc', initiative: 12 },
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 8 }
    ];
    session.world.activeActorId = 'npc-scavenger';

    const result = await applyParsedActionWithNpcAi(
      session,
      {
        type: 'help',
        rawIntent: '请求提示',
        normalizedIntent: '请求提示',
        targetLabel: '当前区域',
        consumesTurn: false
      },
      () => 0.5,
      async () => ({
        intent: '拾取备用氧气罐',
        actionType: 'inspect',
        reason: '现场有可用补给'
      })
    );

    const npc = result.session.scenario.npcs?.[0];
    expect(npc?.inventory).toEqual(['medkit', 'sealant-foam', 'captain-keycard', 'insulated-wrench']);
    expect(result.presentation.publicText).toContain('背包已经装不下');

    npc!.inventory = ['medkit'];
    result.session.world.activeActorId = 'npc-scavenger';
    result.session.world.npcActionPoints = { 'npc-scavenger': 3 };
    const collected = await applyParsedActionWithNpcAi(
      result.session,
      {
        type: 'help',
        rawIntent: '请求提示',
        normalizedIntent: '请求提示',
        targetLabel: '当前区域',
        consumesTurn: false
      },
      () => 0.5,
      async () => ({
        intent: '拾取备用氧气罐',
        actionType: 'inspect',
        reason: '背包还有空间'
      })
    );

    expect(collected.session.scenario.npcs?.[0]?.inventory).toContain('oxygen-canister');
    expect(collected.resolution.stateChanges.join(' / ')).toContain('NPC获得');
  });

  it('lets NPCs use carried items when they are necessary', async () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });
    session.world.oxygen = 3;
    session.scenario.npcs = [
      {
        id: 'npc-supplier',
        name: '补给员',
        publicIdentity: '后勤接口人',
        hiddenDrive: '保住可撤离窗口',
        attitude: 'friendly',
        locationId: session.player.locationId,
        clue: '“氧气不能再拖。”',
        status: '正在尝试建立合作。',
        inventory: ['oxygen-canister']
      }
    ];
    session.world.npcActionPoints = { 'npc-supplier': 3 };
    session.world.turnOrder = [
      { actorId: 'npc-supplier', actorLabel: '补给员', actorType: 'npc', initiative: 12 },
      { actorId: 'player', actorLabel: session.player.archetypeLabel, actorType: 'player', initiative: 8 }
    ];
    session.world.activeActorId = 'npc-supplier';

    const result = await applyParsedActionWithNpcAi(
      session,
      {
        type: 'help',
        rawIntent: '请求提示',
        normalizedIntent: '请求提示',
        targetLabel: '当前区域',
        consumesTurn: false
      },
      () => 0.5,
      async ({ observation }) => {
        expect(observation.inventory).toEqual(['oxygen-canister']);
        return {
          intent: '使用氧气罐稳定局面',
          actionType: 'use_item',
          reason: '倒计时已经很低'
        };
      }
    );

    expect(result.session.world.oxygen).toBe(5);
    expect(result.session.scenario.npcs?.[0]?.inventory).toEqual([]);
    expect(result.resolution.stateChanges.join(' / ')).toContain('补给员使用便携氧气罐');
  });

  it('allows player to interact with an NPC in the same room', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.player.locationId = 'engine-room';
    session.scenario.npcs = [
      {
        id: 'npc-sentry',
        name: '哨兵',
        publicIdentity: '值班员',
        hiddenDrive: '监视所有进出者',
        attitude: 'neutral',
        locationId: 'engine-room',
        clue: '“你最好先确认供能状态。”',
        status: '保持观望，暂不表态。'
      }
    ];

    const result = applyParsedAction(session, {
      type: 'persuade',
      rawIntent: '说服哨兵',
      normalizedIntent: '说服哨兵',
      targetLabel: '哨兵',
      consumesTurn: true
    }, () => 0.99);

    expect(result.filteredAction.validity).toBe('accepted');
    expect(result.session.scenario.npcs?.[0]?.attitude).toBe('friendly');
    expect(result.presentation.publicText).toContain('哨兵');
  });

  it('resolves npc-to-npc interactions when they share a location', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.scenario.npcs = [
      {
        id: 'npc-a',
        name: '联络员',
        publicIdentity: '后勤接口人',
        hiddenDrive: '确保信息可控',
        attitude: 'friendly',
        locationId: 'engine-room',
        clue: '“不要把话说死。”',
        status: '正在尝试建立合作。'
      },
      {
        id: 'npc-b',
        name: '守望者',
        publicIdentity: '值班记录员',
        hiddenDrive: '阻止任何人离开',
        attitude: 'hostile',
        locationId: 'engine-room',
        clue: '“谁都别想离开。”',
        status: '态度强硬，持续施压。'
      }
    ];

    const moved = applyParsedAction(session, {
      type: 'move',
      rawIntent: '前往机轮舱',
      normalizedIntent: '前往机轮舱',
      targetLabel: '机轮舱',
      locationId: 'engine-room',
      consumesTurn: true
    }, () => 0.2);

    expect(moved.resolution.stateChanges.join(' / ')).toContain('NPC互斥');
  });

  it('can finish the full escape route', async () => {
    const ai = new LocalAiService();
    let session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: '冷静'
    });

    const commands = [
      '查看储物柜',
      '前往机轮舱',
      '修理主继电器',
      '前往控制室',
      '查看主控终端',
      '前往机轮舱',
      '前往船员舱',
      '前往医务舱',
      '查看急救柜',
      '说服幸存者',
      '前往船员舱',
      '前往机轮舱',
      '前往控制室',
      '使用舰长钥匙卡',
      '前往逃生舱',
      '查看逃生艇',
      '使用便携氧气罐',
      '启动逃生艇'
    ];

    for (const command of commands) {
      const parsed = await ai.intentToAction(session, command);
      session = applyParsedAction(session, parsed, () => 0.99).session;
    }

    expect(session.phase).toBe('escaped');
    expect(session.world.flags.powerRestored).toBe(true);
    expect(session.world.flags.keycardRecovered).toBe(true);
    expect(session.world.flags.escapeBayUnlocked).toBe(true);
    expect(session.world.flags.launchReady).toBe(true);
  });

  it('offers a broader set of guided actions during play', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    expect(session.objectives.availableActionsHint.length).toBeGreaterThanOrEqual(5);
    expect(session.objectives.availableActionsHint).toContain('请求提示');
  });

  it('absorbs reasonable off-main actions through the story filter without inventing a fake side branch', () => {
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.scenario = {
      ...session.scenario,
      id: 'generated-story',
      title: '风雪山庄疑局',
      premise: '暴雪把所有人困在山庄里。',
      openingLine: '门厅里有血。',
      macroObjective: '确认真相并离开山庄。',
      gameplayMode: 'llm',
      countdown: {
        label: '剩余行动步数',
        shortLabel: '步数',
        max: 12,
        recoverLabel: '步数'
      },
      beats: [
        {
          id: 'beat-open',
          title: '查看门厅血迹',
          summary: '先确认第一现场。',
          guidance: '先去门厅查看血迹。',
          locationId: 'crew-quarters',
          actionType: 'inspect',
          targetLabel: '门厅血迹',
          skill: 'mind',
          requiredItemId: null,
          rewardItemId: null,
          countdownDelta: 0,
          successText: '你在门厅血迹里找到了新的方向。',
          failText: '你什么也没看出来。',
          suggestions: ['查看门厅血迹']
        }
      ]
    };
    session.world.templateId = 'generated-story';
    session.world.oxygen = 10;
    session.world.storyBeatIndex = 0;
    session.objectives.dynamicGuide = '先去门厅查看血迹。';
    session.objectives.availableActionsHint = ['查看门厅血迹'];

    const offMain = {
      type: 'inspect' as const,
      rawIntent: '查看旧记录',
      normalizedIntent: '查看旧记录',
      targetLabel: '旧记录',
      targetId: 'records',
      consumesTurn: false
    };

    const first = applyParsedAction(session, offMain, () => 0.7).session;
    expect(first.objectives.dynamicGuide).toBe('先去门厅查看血迹。');
    expect(first.eventLog.at(-1)?.publicText).toContain('你转去翻看旧记录');
    expect(first.eventLog.at(-1)?.systemText).toContain('还得从别处找突破口');
  });

  it('adapts missing props through the story filter based on actual inventory', async () => {
    const ai = new LocalAiService();
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'passenger',
      customBackground: '',
      customTag: ''
    });

    session.scenario.glossary.itemLabels['oxygen-canister'] = '香蕉';
    session.player.inventory = ['oxygen-canister'];

    const parsed = await ai.intentToAction(session, '我掏出手枪');
    const result = applyParsedAction(session, parsed, () => 0.9);

    expect(result.filteredAction.type).toBe('use_item');
    expect(result.filteredAction.toolId).toBe('oxygen-canister');
    expect(result.filteredAction.storyFilterNote).toContain('你身上没有手枪');
    expect(result.filteredAction.storyFilterNote).toContain('香蕉');
  });

  it('varies low-value bodily actions instead of collapsing them into the same narration', () => {
    let session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.scenario = {
      ...session.scenario,
      id: 'generated-story',
      title: '风雪山庄疑局',
      premise: '暴雪把所有人困在山庄里。',
      openingLine: '门厅里有血。',
      macroObjective: '确认真相并离开山庄。',
      gameplayMode: 'llm',
      countdown: {
        label: '剩余行动步数',
        shortLabel: '步数',
        max: 12,
        recoverLabel: '步数'
      },
      beats: [
        {
          id: 'beat-open',
          title: '查看门厅血迹',
          summary: '先确认第一现场。',
          guidance: '先去门厅查看血迹。',
          locationId: 'crew-quarters',
          actionType: 'inspect',
          targetLabel: '门厅血迹',
          skill: 'mind',
          requiredItemId: null,
          rewardItemId: null,
          countdownDelta: 0,
          successText: '你在门厅血迹里找到了新的方向。',
          failText: '你什么也没看出来。',
          suggestions: ['查看门厅血迹']
        }
      ]
    };
    session.world.templateId = 'generated-story';
    session.world.storyBeatIndex = 0;
    session.objectives.dynamicGuide = '先去门厅查看血迹。';
    session.objectives.availableActionsHint = ['查看门厅血迹'];

    const nosePick = applyParsedAction(
      session,
      {
        type: 'inspect',
        rawIntent: '挖鼻屎',
        normalizedIntent: '挖鼻屎',
        targetLabel: '自己',
        targetId: 'self',
        consumesTurn: false
      },
      () => 0.7
    ).session.eventLog.at(-1);

    const bathroom = applyParsedAction(
      session,
      {
        type: 'inspect',
        rawIntent: '我要拉屎',
        normalizedIntent: '我要拉屎',
        targetLabel: '自己',
        targetId: 'self',
        consumesTurn: false
      },
      () => 0.7
    ).session.eventLog.at(-1);

    expect(nosePick?.publicText).toContain('不太体面的细碎动作');
    expect(bathroom?.publicText).toContain('生理压力');
    expect(nosePick?.publicText).not.toBe(bathroom?.publicText);
  });

  it('distinguishes provocation, stalling, and begging into different filtered narrations', () => {
    let session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    session.scenario = {
      ...session.scenario,
      id: 'generated-story',
      title: '风雪山庄疑局',
      premise: '暴雪把所有人困在山庄里。',
      openingLine: '门厅里有血。',
      macroObjective: '确认真相并离开山庄。',
      gameplayMode: 'llm',
      countdown: {
        label: '剩余行动步数',
        shortLabel: '步数',
        max: 12,
        recoverLabel: '步数'
      },
      beats: [
        {
          id: 'beat-open',
          title: '查看门厅血迹',
          summary: '先确认第一现场。',
          guidance: '先去门厅查看血迹。',
          locationId: 'crew-quarters',
          actionType: 'inspect',
          targetLabel: '门厅血迹',
          skill: 'mind',
          requiredItemId: null,
          rewardItemId: null,
          countdownDelta: 0,
          successText: '你在门厅血迹里找到了新的方向。',
          failText: '你什么也没看出来。',
          suggestions: ['查看门厅血迹']
        }
      ]
    };
    session.world.templateId = 'generated-story';
    session.world.storyBeatIndex = 0;
    session.objectives.dynamicGuide = '先去门厅查看血迹。';
    session.objectives.availableActionsHint = ['查看门厅血迹'];

    const provoke = applyParsedAction(session, {
      type: 'inspect',
      rawIntent: '我嘲讽他两句',
      normalizedIntent: '我嘲讽他两句',
      targetLabel: '自己',
      targetId: 'self',
      consumesTurn: false
    }, () => 0.7).session.eventLog.at(-1);

    const stall = applyParsedAction(session, {
      type: 'inspect',
      rawIntent: '我先拖一会',
      normalizedIntent: '我先拖一会',
      targetLabel: '自己',
      targetId: 'self',
      consumesTurn: false
    }, () => 0.7).session.eventLog.at(-1);

    const beg = applyParsedAction(session, {
      type: 'inspect',
      rawIntent: '别杀我，我错了',
      normalizedIntent: '别杀我，我错了',
      targetLabel: '自己',
      targetId: 'self',
      consumesTurn: false
    }, () => 0.7).session.eventLog.at(-1);

    expect(provoke?.publicText).toContain('更刺耳的方向');
    expect(stall?.publicText).toContain('故意把动作放慢');
    expect(beg?.publicText).toContain('放低姿态');
    expect(provoke?.publicText).not.toBe(stall?.publicText);
    expect(stall?.publicText).not.toBe(beg?.publicText);
  });
});

