import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

let saveDir: string;

beforeEach(async () => {
  saveDir = await mkdtemp(path.join(os.tmpdir(), 'wax-museum-'));
});

afterEach(async () => {
  await rm(saveDir, { recursive: true, force: true });
});

describe('session API', () => {
  it('creates saves, restores sessions, and can complete a full victory path', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });

    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '测试角色',
      customTag: '冷静'
    });

    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;

    const saves = await request(app).get('/api/saves');
    expect(saves.body).toHaveLength(1);
    expect(saves.body[0].sessionId).toBe(sessionId);

    const restored = await request(app).get(`/api/session/${sessionId}`);
    expect(restored.body.sessionId).toBe(sessionId);

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

    let lastResponse = restored;
    for (const command of commands) {
      lastResponse = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: command });
      expect(lastResponse.status).toBe(200);
    }

    expect(lastResponse.body.sessionSnapshot.phase).toBe('escaped');
    expect(lastResponse.body.narration.dynamicGuide).toContain('生还经过');
  });

  it('generates a structured story outline from a simple prompt', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });
    const originalApiKey = process.env.LLM_API_KEY;
    const originalModel = process.env.LLM_MODEL;
    process.env.LLM_API_KEY = '';
    process.env.LLM_MODEL = '';

    try {
      const generated = await request(app).post('/api/story-outline').send({
        templateId: 'submarine-escape',
        archetypeId: 'engineer',
        prompt: '我曾在一次深潜事故里失去同伴，这次想查清真相'
      });

      expect(generated.status).toBe(400);
      expect(generated.body.message).toContain('未配置自定义故事生成模型');
    } finally {
      process.env.LLM_API_KEY = originalApiKey;
      process.env.LLM_MODEL = originalModel;
    }
  });

  it('lets the medic resolve the survivor branch into a viable victory route', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });

    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'medic',
      customBackground: '',
      customTag: ''
    });

    expect(created.status).toBe(201);
    const sessionId = created.body.sessionId as string;

    const commands = [
      '查看储物柜',
      '前往机轮舱',
      '修理主继电器',
      '前往船员舱',
      '前往医务舱',
      '使用急救包救幸存者',
      '前往船员舱',
      '前往机轮舱',
      '前往控制室',
      '查看主控终端',
      '前往机轮舱',
      '前往船员舱',
      '前往医务舱',
      '查看急救柜',
      '前往船员舱',
      '前往机轮舱',
      '前往控制室',
      '使用舰长钥匙卡',
      '前往逃生舱',
      '查看逃生艇',
      '使用便携氧气罐',
      '启动逃生艇'
    ];

    let lastResponse = created;
    for (const command of commands) {
      lastResponse = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: command });
      expect(lastResponse.status).toBe(200);
    }

    expect(lastResponse.body.sessionSnapshot.phase).toBe('escaped');
    expect(lastResponse.body.sessionSnapshot.world.flags.survivorHelped).toBe(true);
    expect(lastResponse.body.sessionSnapshot.world.flags.launchReady).toBe(true);
    expect(lastResponse.body.sessionSnapshot.world.flags.keycardRecovered).toBe(true);
  });

  it('lets the engineer stabilize the relay with sealant foam for a safer power-restoration route', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });

    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: ''
    });

    const sessionId = created.body.sessionId as string;
    const commands = [
      '查看储物柜',
      '前往机轮舱',
      '使用密封泡沫修复主继电器',
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

    let lastResponse = created;
    for (const command of commands) {
      lastResponse = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: command });
      expect(lastResponse.status).toBe(200);
    }

    expect(lastResponse.body.sessionSnapshot.phase).toBe('escaped');
    expect(lastResponse.body.sessionSnapshot.world.flags.powerRestored).toBe(true);
  });

  it('lets the security role break through the scenario with a force-based route', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });

    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'security',
      customBackground: '',
      customTag: ''
    });

    const sessionId = created.body.sessionId as string;
    const commands = [
      '强行撬开储物柜',
      '前往船员舱',
      '前往医务舱',
      '强行撬开急救柜',
      '说服幸存者',
      '前往船员舱',
      '前往机轮舱',
      '前往控制室',
      '强行破开封闭闸门',
      '前往逃生舱',
      '查看逃生艇',
      '使用便携氧气罐',
      '启动逃生艇'
    ];

    let lastResponse = created;
    for (const command of commands) {
      lastResponse = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: command });
      expect(lastResponse.status).toBe(200);
    }

    expect(lastResponse.body.sessionSnapshot.phase).toBe('escaped');
    expect(lastResponse.body.sessionSnapshot.world.flags.escapeBayUnlocked).toBe(true);
  });

  it('lets the passenger luck into the keycard from the control room route', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });

    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'passenger',
      customBackground: '',
      customTag: ''
    });

    const sessionId = created.body.sessionId as string;
    const commands = [
      '查看储物柜',
      '前往机轮舱',
      '修理主继电器',
      '前往控制室',
      '查看主控终端',
      '前往机轮舱',
      '前往船员舱',
      '前往医务舱',
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

    let lastResponse = created;
    for (const command of commands) {
      lastResponse = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: command });
      expect(lastResponse.status).toBe(200);
    }

    expect(lastResponse.body.sessionSnapshot.phase).toBe('escaped');
    expect(lastResponse.body.sessionSnapshot.world.flags.keycardRecovered).toBe(true);
  });

  it('fails when oxygen is depleted through repeated movement', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });
    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'passenger',
      customBackground: '',
      customTag: ''
    });

    const sessionId = created.body.sessionId as string;
    const loop = ['前往医务舱', '前往船员舱'];
    let snapshot = created.body;

    for (let index = 0; index < 14; index += 1) {
      const response = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: loop[index % 2] });
      snapshot = response.body.sessionSnapshot;
      if (snapshot.phase === 'failed') {
        break;
      }
    }

    expect(snapshot.phase).toBe('failed');
    expect(snapshot.world.oxygen).toBe(0);
  });

  it('story-filters impossible actions while keeping the session usable', async () => {
    const { app } = createApp({ saveDir, randomSource: () => 0.99 });
    const created = await request(app).post('/api/session').send({
      templateId: 'submarine-escape',
      archetypeId: 'engineer',
      customBackground: '',
      customTag: '冷静'
    });

    const sessionId = created.body.sessionId as string;
    const invalid = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: '我现在修理主继电器' });
    expect(invalid.body.filteredAction.validity).toBe('accepted');
    expect(invalid.body.filteredAction.type).toBe('inspect');
    expect(invalid.body.filteredAction.storyFilterNote).toContain('当前场景没有可直接修理的核心装置');
    expect(invalid.body.sessionSnapshot.world.oxygen).toBe(12);

    const valid = await request(app).post(`/api/session/${sessionId}/action`).send({ intent: '查看储物柜' });
    expect(valid.body.filteredAction.validity).toBe('accepted');
    expect(valid.body.sessionSnapshot.player.inventory).toContain('insulated-wrench');
  });
});
