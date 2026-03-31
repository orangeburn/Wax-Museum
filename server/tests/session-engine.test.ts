import { describe, expect, it } from 'vitest';
import { createNewSession, applyParsedAction } from '../src/engine/session-engine.js';
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

  it('redirects impossible early movement and rejects invalid repairs', async () => {
    const ai = new LocalAiService();
    const session = createNewSession({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: '冷静'
    });

    const redirectAttempt = await ai.intentToAction(session, '我直接前往逃生舱');
    const redirected = applyParsedAction(session, redirectAttempt, () => 0.5);
    expect(redirected.filteredAction.validity).toBe('redirected');
    expect(redirected.filteredAction.type).toBe('inspect');
    expect(redirected.session.world.oxygen).toBe(12);

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
    expect(result.session.world.oxygen).toBe(11);
    expect(result.session.world.danger).toBe(1);
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
