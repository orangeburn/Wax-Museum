import type { TemplateDefinition } from '../types.js';

export const SUBMARINE_TEMPLATE: TemplateDefinition = {
  id: 'submarine-escape',
  label: '失事潜艇',
  premise: '一艘深潜作业潜艇在海底失去主电力。氧气正在下降，逃生舱被锁死。',
  openingLine:
    '艇身发出低沉的挤压声，灯光一阵阵熄灭。广播已经断续失真，只剩下倒计时般的氧气警报。',
  macroObjective: '在氧气耗尽前恢复关键电力、拿到钥匙卡并启动逃生舱。',
  initialOxygen: 12,
  initialDanger: 0,
  initialHp: 3,
  initialSan: 3,
  countdown: {
    label: '剩余氧气',
    shortLabel: '氧气',
    max: 12,
    recoverLabel: '氧气'
  },
  locations: {
    'crew-quarters': {
      id: 'crew-quarters',
      label: '船员舱',
      description: '逼仄的舱室里横着倾倒的储物柜与散开的个人物品。',
      atmosphere: '灯管忽明忽暗，金属床架在震动里发出细碎回响。',
      connected: ['engine-room', 'med-bay'],
      pointsOfInterest: ['储物柜', '航行清单', '服务通道'],
      sceneObjects: [
        {
          id: 'crew-bunk',
          label: '金属床架',
          category: 'furniture',
          description: '双层床被撞得有些歪，床底卷着一只防水包。',
          interactionHints: ['查看床架', '搬动床架'],
          clueText: '床底的防水包上写着最近一次换岗时间。'
        },
        {
          id: 'crew-locker',
          label: '储物柜',
          category: 'container',
          description: '柜门被挤压到变形，里面卡着工具和个人物品。',
          interactionHints: ['查看储物柜', '强行撬开储物柜'],
          hiddenItemId: 'insulated-wrench',
          skillProfile: { inspect: 'mind', force: 'physique' },
          difficultyProfile: { inspect: 84, force: 92 },
          clueText: '柜门内侧夹着一张值班便笺，记录了继电器最近一次异常。'
        },
        {
          id: 'crew-desk',
          label: '书桌',
          category: 'furniture',
          description: '桌脚卡在地板槽里，抽屉半开，里面散着航行清单。',
          interactionHints: ['查看书桌', '搬动书桌'],
          skillProfile: { inspect: 'mind', force: 'physique' },
          difficultyProfile: { inspect: 88, force: 96 },
          clueText: '压在抽屉底部的清单写着一箱急救品曾被临时转运到医务舱。'
        },
        {
          id: 'crew-hatch',
          label: '服务通道',
          category: 'exit',
          description: '通道门半掩着，外面黑得只能听见管线回声。',
          interactionHints: ['前往机轮舱', '前往医务舱']
        }
      ]
    },
    'engine-room': {
      id: 'engine-room',
      label: '机轮舱',
      description: '主继电器所在的区域仍有火花跳动，地面上积着冷凝水。',
      atmosphere: '每一次震动都像有人在舱壁另一侧敲击。',
      connected: ['crew-quarters', 'control-room'],
      pointsOfInterest: ['主继电器', '动力面板', '泄漏管线'],
      sceneObjects: [
        {
          id: 'engine-relay',
          label: '主继电器',
          category: 'device',
          description: '绝缘壳裂开一条缝，里面时不时迸出细小蓝火。',
          interactionHints: ['查看主继电器', '修理主继电器', '使用密封泡沫修复主继电器'],
          requiredItemId: 'insulated-wrench',
          skillProfile: { inspect: 'mind', repair: 'mind', use_item: 'mind', force: 'physique' },
          difficultyProfile: { inspect: 86, repair: 102, use_item: 92 },
          clueText: '有人提前拆过这组接口，螺丝磨损方向和正常检修不一样。'
        },
        {
          id: 'engine-panel',
          label: '动力面板',
          category: 'device',
          description: '几组指示灯断断续续，像随时会整排熄灭。',
          interactionHints: ['查看动力面板'],
          clueText: '面板上的故障码指向控制室授权链断裂。'
        },
        {
          id: 'engine-pipe',
          label: '泄漏管线',
          category: 'hazard',
          description: '一段管线正在往外渗白雾，地面因此湿滑。',
          interactionHints: ['查看泄漏管线', '使用密封泡沫'],
          clueText: '泄漏不是事故主因，更像有人想掩盖继电器被动过手脚。'
        }
      ]
    },
    'med-bay': {
      id: 'med-bay',
      label: '医务舱',
      description: '柜门半开，担架滑出固定卡扣，空气里都是消毒水和铁锈味。',
      atmosphere: '角落里蜷着一名幸存者，呼吸又急又浅。',
      connected: ['crew-quarters'],
      pointsOfInterest: ['急救柜', '幸存者林沅', '药品台'],
      sceneObjects: [
        {
          id: 'med-cabinet',
          label: '急救柜',
          category: 'container',
          description: '电子锁还亮着红灯，几层抽屉被重新排过。',
          interactionHints: ['查看急救柜', '强行撬开急救柜'],
          hiddenItemId: 'captain-keycard',
          skillProfile: { inspect: 'mind', force: 'physique' },
          difficultyProfile: { inspect: 94, force: 98 },
          clueText: '柜内调拨单显示有人借急救转运名义藏过重要物品。'
        },
        {
          id: 'med-survivor',
          label: '幸存者林沅',
          category: 'character',
          description: '脸色灰白，伤口简单包扎过，明显撑不了太久。',
          interactionHints: ['说服幸存者林沅', '使用急救包救幸存者林沅', '查看幸存者林沅'],
          clueText: '她知道钥匙卡和最后启动资源分别被藏在哪。'
        },
        {
          id: 'med-counter',
          label: '药品台',
          category: 'container',
          description: '药瓶滚了一地，镇静剂和止血材料混在一起。',
          interactionHints: ['查看药品台'],
          clueText: '有一格药盒明显被人匆忙拿走过。'
        }
      ]
    },
    'control-room': {
      id: 'control-room',
      label: '控制室',
      description: '主控台在备用电源下闪着微弱指示灯，通往逃生舱的闸门紧闭。',
      atmosphere: '舷窗外黑得像实心的海，只有告警灯在玻璃上来回扫动。',
      connected: ['engine-room', 'escape-bay'],
      pointsOfInterest: ['主控终端', '封闭闸门', '导航座椅'],
      sceneObjects: [
        {
          id: 'control-console',
          label: '主控终端',
          category: 'device',
          description: '终端在备用电流下艰难闪烁，日志页要一页页手动恢复。',
          interactionHints: ['查看主控终端'],
          skillProfile: { inspect: 'mind' },
          difficultyProfile: { inspect: 96 },
          clueText: '日志会指向钥匙卡转移记录和逃生艇预充条件。'
        },
        {
          id: 'control-bulkhead',
          label: '封闭闸门',
          category: 'exit',
          description: '厚重的金属闸门锁死在通往逃生舱的通道上。',
          interactionHints: ['使用舰长钥匙卡', '强行破开封闭闸门', '查看封闭闸门'],
          skillProfile: { force: 'physique', use_item: 'mind', inspect: 'mind' },
          difficultyProfile: { force: 110, inspect: 90 },
          clueText: '机械锁本身没坏，真正的问题是授权链没有放行。'
        },
        {
          id: 'control-chair',
          label: '导航座椅',
          category: 'furniture',
          description: '座椅滑轨上沾着未干的盐渍，像刚有人匆忙起身。',
          interactionHints: ['查看导航座椅'],
          clueText: '盐渍说明有人在停电前去过外舱接口区。'
        }
      ]
    },
    'escape-bay': {
      id: 'escape-bay',
      label: '逃生舱',
      description: '小型逃生艇悬在干坞位，接口灯终于亮起了待发的绿色。',
      atmosphere: '这里比别处更安静，只剩海水压力在外壳上拉扯。',
      connected: ['control-room'],
      pointsOfInterest: ['逃生艇', '启动面板', '固定缆索'],
      sceneObjects: [
        {
          id: 'escape-pod',
          label: '逃生艇',
          category: 'exit',
          description: '艇门已经解锁，但预充和启动序列还没有全部完成。',
          interactionHints: ['查看逃生艇', '启动逃生艇'],
          skillProfile: { inspect: 'mind', use_item: 'mind' },
          difficultyProfile: { inspect: 88, use_item: 100 },
          clueText: '预充接口缺最后一份稳定供氧资源。'
        },
        {
          id: 'escape-panel',
          label: '启动面板',
          category: 'device',
          description: '一排指示灯从左到右慢慢扫过，像在等最终确认。',
          interactionHints: ['查看启动面板'],
          clueText: '只有在预充完成后，启动面板才会给出绿色发射许可。'
        },
        {
          id: 'escape-cable',
          label: '固定缆索',
          category: 'hazard',
          description: '缆索还扣着安全锁，发射前会自动弹开。',
          interactionHints: ['查看固定缆索'],
          clueText: '缆索没有异常，真正卡住撤离的是启动准备不足。'
        }
      ]
    }
  }
};
