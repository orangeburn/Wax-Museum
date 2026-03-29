import { type SessionSnapshot } from '@wax-museum/shared';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppRoutes } from './App';

function createBaseSnapshot(): SessionSnapshot {
  return {
    sessionId: 'session-1',
    phase: 'active',
    scenario: {
      id: 'submarine-escape',
      title: '失事潜艇',
      premise: '测试前提',
      openingLine: '测试开场',
      macroObjective: '在氧气耗尽前恢复关键电力、拿到钥匙卡并启动逃生舱。',
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
      },
      locations: {
        'crew-quarters': {
          id: 'crew-quarters',
          label: '船员舱',
          description: '测试船员舱',
          atmosphere: '测试氛围',
          connected: ['engine-room', 'med-bay'],
          pointsOfInterest: ['储物柜']
        },
        'engine-room': {
          id: 'engine-room',
          label: '机轮舱',
          description: '测试机轮舱',
          atmosphere: '火花乱跳',
          connected: ['crew-quarters', 'control-room'],
          pointsOfInterest: ['主继电器']
        },
        'med-bay': {
          id: 'med-bay',
          label: '医务舱',
          description: '测试医务舱',
          atmosphere: '药剂气味',
          connected: ['crew-quarters'],
          pointsOfInterest: ['急救柜']
        },
        'control-room': {
          id: 'control-room',
          label: '控制室',
          description: '测试控制室',
          atmosphere: '灯光闪烁',
          connected: ['engine-room'],
          pointsOfInterest: ['主控终端', '封闭闸门']
        },
        'escape-bay': {
          id: 'escape-bay',
          label: '逃生舱',
          description: '测试逃生舱',
          atmosphere: '等待发射',
          connected: ['control-room'],
          pointsOfInterest: ['逃生艇']
        }
      }
    },
    player: {
      archetypeId: 'engineer',
      archetypeLabel: '工程师',
      customBackground: '测试背景',
      customTag: '冷静',
      notes: [],
      stats: { physique: 2, mind: 4, empathy: 2 },
      tags: ['机械直觉', '冷静'],
      hp: 3,
      san: 3,
      inventory: ['sealant-foam'],
      locationId: 'crew-quarters'
    },
    world: {
      templateId: 'submarine-escape',
      oxygen: 9,
      danger: 0,
      turn: 0,
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
      },
      locations: {
        'crew-quarters': {
          id: 'crew-quarters',
          label: '船员舱',
          description: '测试船员舱',
          atmosphere: '测试氛围',
          connected: ['engine-room', 'med-bay'],
          pointsOfInterest: ['储物柜']
        },
        'engine-room': {
          id: 'engine-room',
          label: '机轮舱',
          description: '测试机轮舱',
          atmosphere: '火花乱跳',
          connected: ['crew-quarters', 'control-room'],
          pointsOfInterest: ['主继电器']
        },
        'med-bay': {
          id: 'med-bay',
          label: '医务舱',
          description: '测试医务舱',
          atmosphere: '药剂气味',
          connected: ['crew-quarters'],
          pointsOfInterest: ['急救柜']
        },
        'control-room': {
          id: 'control-room',
          label: '控制室',
          description: '测试控制室',
          atmosphere: '灯光闪烁',
          connected: ['engine-room'],
          pointsOfInterest: ['主控终端', '封闭闸门']
        },
        'escape-bay': {
          id: 'escape-bay',
          label: '逃生舱',
          description: '测试逃生舱',
          atmosphere: '等待发射',
          connected: ['control-room'],
          pointsOfInterest: ['逃生艇']
        }
      }
    },
    objectives: {
      macroObjective: '在氧气耗尽前恢复关键电力、拿到钥匙卡并启动逃生舱。',
      dynamicGuide: '先在船员舱寻找绝缘扳手。',
      phase: 'find-tool',
      countdownLabel: '氧气 9/9',
      availableActionsHint: ['查看储物柜', '前往机轮舱', '查看背包'],
    },
    logTail: [
      {
        step: 0,
        intent: '开局',
        filteredAction: '任务简报',
        tier: 'success',
        publicText: '你在船员舱醒来。',
        systemText: '先在船员舱寻找绝缘扳手。',
        timestamp: '2026-03-27T00:00:00.000Z'
      }
    ]
  };
}

describe('app flow', () => {
  const originalFetch = globalThis.fetch;
  let snapshot = createBaseSnapshot();
  let saves: Array<{ sessionId: string; title: string; updatedAt: string; phase: string; archetypeId: string; oxygen: number; danger: number; dynamicGuide: string }> = [];

  beforeEach(() => {
    snapshot = createBaseSnapshot();
    saves = [];

    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : null;

      if (url === '/api/saves' && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(saves), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url === '/api/session' && init?.method === 'POST') {
        snapshot.player.customBackground = body.customBackground;
        snapshot.player.customTag = body.customTag;
        saves = [
          {
            sessionId: snapshot.sessionId,
            title: '工程师 / 失事潜艇',
            updatedAt: '2026-03-27T00:00:00.000Z',
            phase: 'active',
            archetypeId: 'engineer',
            oxygen: snapshot.world.oxygen,
            danger: snapshot.world.danger,
            dynamicGuide: snapshot.objectives.dynamicGuide
          }
        ];
        return new Response(JSON.stringify(snapshot), { status: 201, headers: { 'Content-Type': 'application/json' } });
      }

      if (url === '/api/writer/draft' && init?.method === 'POST') {
        return new Response(
          JSON.stringify({
            bible: {
              title: '风雪山庄疑局',
              genre: '暴雪封闭空间悬疑',
              playerCountLabel: '4人',
              premise: '暴雪把所有人困在山庄里，活着离开和查清真相同样重要。',
              background: '一桩旧案在今夜被重新翻开。',
              currentCrisis: '通讯中断，出口被封，还有新的血迹出现在走廊。',
              coreSecret: '真相和多年前的旧案直接相关。',
              outline: ['开场有人失踪', '中段众人互相试探', '转折指向内部人', '终局在证据和逃生之间抉择'],
              endings: ['带着真相离开', '活着离开但埋掉真相', '所有人一起被困'],
              roles: [
                {
                  id: 'role-engineer',
                  archetypeId: 'engineer',
                  label: '修缮顾问',
                  publicIdentity: '你受邀来山庄检查停用设备。',
                  hiddenDrive: '你知道旧事故并非天灾。',
                  relationshipHook: '有个住客曾和你有过失败合作。',
                  specialty: '擅长恢复设施和辨认假记录。',
                  suggestedTag: '冷静',
                  suggestedBackground: '你曾参与过一次深潜事故调查，这次回来是为了确认被删改的记录和山庄旧案是否有关。'
                },
                {
                  id: 'role-medic',
                  archetypeId: 'medic',
                  label: '值夜医生',
                  publicIdentity: '你来为关键人物做例行诊疗。',
                  hiddenDrive: '你见过不该出现的旧伤。',
                  relationshipHook: '有人愿意向你倾诉。',
                  specialty: '擅长稳住证人和伤情。',
                  suggestedTag: '说客',
                  suggestedBackground: '你曾在一次救援里慢了一步，这次不想再失手。'
                },
                {
                  id: 'role-security',
                  archetypeId: 'security',
                  label: '临时安保',
                  publicIdentity: '你负责维持今晚秩序。',
                  hiddenDrive: '你接过一笔额外酬劳。',
                  relationshipHook: '有人知道你不只是普通安保。',
                  specialty: '擅长突破障碍和控制路线。',
                  suggestedTag: '钢铁意志',
                  suggestedBackground: '你本来只想控场，现在却得决定该救谁。'
                },
                {
                  id: 'role-passenger',
                  archetypeId: 'passenger',
                  label: '受邀来客',
                  publicIdentity: '你表面只是普通客人。',
                  hiddenDrive: '你其实冲着旧案线索而来。',
                  relationshipHook: '别人都低估了你的动机。',
                  specialty: '擅长观察和保命。',
                  suggestedTag: '潜行训练',
                  suggestedBackground: '你以为自己离开了往事，但今晚又被拖了回来。'
                }
              ]
            },
            scenario: {
              id: 'generated-story',
              title: '风雪山庄疑局',
              premise: '暴雪把所有人困在山庄里，活着离开和查清真相同样重要。',
              openingLine: '灯光闪了第三次以后，你终于确定今晚不会有人来救场。',
              macroObjective: '恢复设施，拿到凭证，发动最后的雪地车离开山庄。',
              glossary: snapshot.scenario.glossary,
              locations: snapshot.scenario.locations
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url === `/api/session/${snapshot.sessionId}` && (!init || init.method === undefined)) {
        return new Response(JSON.stringify(snapshot), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      if (url === `/api/session/${snapshot.sessionId}/action` && init?.method === 'POST') {
        if (body.intent.includes('查看储物柜')) {
          snapshot = {
            ...snapshot,
            player: { ...snapshot.player, inventory: [...snapshot.player.inventory, 'insulated-wrench'] },
            world: { ...snapshot.world, flags: { ...snapshot.world.flags, wrenchFound: true } },
            objectives: { ...snapshot.objectives, dynamicGuide: '带着扳手去机轮舱修复主继电器。', phase: 'restore-power', availableActionsHint: ['前往机轮舱', '查看背包'] },
            logTail: [...snapshot.logTail, { step: 1, intent: body.intent, filteredAction: '查看 储物柜', tier: 'success', publicText: '你找到了一把绝缘扳手。', systemText: '获得 绝缘扳手', timestamp: '2026-03-27T00:00:01.000Z' }]
          };
        } else if (body.intent.includes('前往机轮舱')) {
          snapshot = {
            ...snapshot,
            player: { ...snapshot.player, locationId: 'engine-room' },
            world: { ...snapshot.world, oxygen: 8, visitedLocations: ['crew-quarters', 'engine-room'] },
            objectives: { ...snapshot.objectives, availableActionsHint: ['修理主继电器', '查看主继电器'] },
            logTail: [...snapshot.logTail, { step: 2, intent: body.intent, filteredAction: '前往 机轮舱', tier: 'success', publicText: '你抵达了机轮舱。', systemText: '氧气 -1', timestamp: '2026-03-27T00:00:02.000Z' }]
          };
        } else if (body.intent.includes('修理')) {
          snapshot = {
            ...snapshot,
            world: { ...snapshot.world, oxygen: 7, flags: { ...snapshot.world.flags, powerRestored: true } },
            objectives: { ...snapshot.objectives, dynamicGuide: '去医务舱，从急救柜里拿到舰长钥匙卡。', phase: 'get-keycard', availableActionsHint: ['前往控制室', '前往船员舱'] },
            logTail: [...snapshot.logTail, { step: 3, intent: body.intent, filteredAction: '修理 主继电器', tier: 'success', publicText: '主电力恢复了。', systemText: '主电力恢复 / 氧气 -1', timestamp: '2026-03-27T00:00:03.000Z' }]
          };
        }

        return new Response(JSON.stringify({
          filteredAction: { type: 'inspect', rawIntent: body.intent, normalizedIntent: body.intent, targetLabel: '测试', validity: 'accepted', consumesTurn: body.intent !== '查看储物柜' },
          resolution: { tier: 'success', summary: 'ok', stateChanges: [], oxygenCost: 0, dangerDelta: 0, damage: 0 },
          sessionSnapshot: snapshot,
          narration: {
            scene: snapshot.logTail.at(-1)?.publicText ?? '',
            systems: [snapshot.logTail.at(-1)?.systemText ?? ''],
            dynamicGuide: snapshot.objectives.dynamicGuide
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }

      return new Response(JSON.stringify({ message: 'not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  it('creates a game, plays several actions, and reloads from saved state', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('继续旧局');
    await user.click(screen.getByRole('button', { name: '创建新局' }));

    await screen.findByText('先给一句设定，让系统替你写出这局戏。');
    await user.type(screen.getByLabelText('故事 Prompt'), '风雪山庄，4人，逃生/破案');
    await user.click(screen.getByRole('button', { name: '生成剧本草案' }));
    await screen.findByRole('button', { name: /修缮顾问/ });
    await user.click(screen.getByRole('button', { name: '进入故事' }));

    await screen.findByText('当前位置：船员舱');
    await user.type(screen.getByLabelText('自然语言行动'), '查看储物柜');
    await user.click(screen.getByRole('button', { name: '执行行动' }));
    await screen.findByText('带着扳手去机轮舱修复主继电器。');

    await user.clear(screen.getByLabelText('自然语言行动'));
    await user.type(screen.getByLabelText('自然语言行动'), '前往机轮舱');
    await user.click(screen.getByRole('button', { name: '执行行动' }));
    await screen.findByText('当前位置：机轮舱');

    await user.clear(screen.getByLabelText('自然语言行动'));
    await user.type(screen.getByLabelText('自然语言行动'), '修理主继电器');
    await user.click(screen.getByRole('button', { name: '执行行动' }));
    await screen.findByText('去医务舱，从急救柜里拿到舰长钥匙卡。');

    render(
      <MemoryRouter initialEntries={['/session/session-1']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('当前位置：机轮舱')).toBeInTheDocument();
      expect(screen.getByText('去医务舱，从急救柜里拿到舰长钥匙卡。')).toBeInTheDocument();
    });
  });

  it('shows a resolution banner after escaping', async () => {
    snapshot = {
      ...createBaseSnapshot(),
      phase: 'escaped',
      world: {
        ...createBaseSnapshot().world,
        oxygen: 3,
        turn: 6,
        flags: {
          ...createBaseSnapshot().world.flags,
          powerRestored: true,
          keycardRecovered: true,
          escapeBayUnlocked: true,
          escapeLaunched: true
        }
      },
      objectives: {
        ...createBaseSnapshot().objectives,
        phase: 'resolution',
        dynamicGuide: '你已经成功离开潜艇。',
        availableActionsHint: []
      },
      logTail: [
        ...createBaseSnapshot().logTail,
        {
          step: 6,
          intent: '启动逃生艇',
          filteredAction: '使用 逃生艇',
          tier: 'success',
          publicText: '逃生艇像脱钩的箭一样冲出了干坞位。',
          systemText: '你成功离开了潜艇。',
          timestamp: '2026-03-27T00:00:06.000Z'
        }
      ]
    };

    render(
      <MemoryRouter initialEntries={['/session/session-1']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('你活着离开了 失事潜艇。');
    expect(screen.getByText('警报已经远去，剩下的是终于能慢慢呼吸的空气。')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '再开一局' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '已成功逃离' })).toBeDisabled();
  });

  it('generates a writer draft from a simple prompt and applies the selected role background', async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/create']}>
        <AppRoutes />
      </MemoryRouter>
    );

    await screen.findByText('先给一句设定，让系统替你写出这局戏。');
    await user.type(screen.getByLabelText('故事 Prompt'), '风雪山庄，4人，逃生/破案');
    await user.click(screen.getByRole('button', { name: '生成剧本草案' }));

    await screen.findByRole('heading', { name: '风雪山庄疑局', level: 2 });
    await user.click(screen.getByRole('button', { name: /值夜医生/ }));

    expect(screen.getByLabelText('角色背景')).toHaveValue('你曾在一次救援里慢了一步，这次不想再失手。');
    expect(screen.getByText('编剧建议 Tag：说客')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /修缮顾问/ }));
    expect(screen.getByLabelText('自定义 Tag')).toHaveValue('冷静');
  });
});
