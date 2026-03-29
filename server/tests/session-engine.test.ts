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
    expect(rejected.filteredAction.validity).toBe('rejected');
    expect(rejected.resolution.summary).toContain('主继电器不在这里');
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
});
