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
  locations: {
    'crew-quarters': {
      id: 'crew-quarters',
      label: '船员舱',
      description: '逼仄的舱室里横着倾倒的储物柜与散开的个人物品。',
      atmosphere: '灯管忽明忽暗，金属床架在震动里发出细碎回响。',
      connected: ['engine-room', 'med-bay'],
      pointsOfInterest: ['储物柜', '航行清单', '服务通道']
    },
    'engine-room': {
      id: 'engine-room',
      label: '机轮舱',
      description: '主继电器所在的区域仍有火花跳动，地面上积着冷凝水。',
      atmosphere: '每一次震动都像有人在舱壁另一侧敲击。',
      connected: ['crew-quarters', 'control-room'],
      pointsOfInterest: ['主继电器', '动力面板', '泄漏管线']
    },
    'med-bay': {
      id: 'med-bay',
      label: '医务舱',
      description: '柜门半开，担架滑出固定卡扣，空气里都是消毒水和铁锈味。',
      atmosphere: '角落里蜷着一名幸存者，呼吸又急又浅。',
      connected: ['crew-quarters'],
      pointsOfInterest: ['急救柜', '幸存者林沅', '药品台']
    },
    'control-room': {
      id: 'control-room',
      label: '控制室',
      description: '主控台在备用电源下闪着微弱指示灯，通往逃生舱的闸门紧闭。',
      atmosphere: '舷窗外黑得像实心的海，只有告警灯在玻璃上来回扫动。',
      connected: ['engine-room', 'escape-bay'],
      pointsOfInterest: ['主控终端', '封闭闸门', '导航座椅']
    },
    'escape-bay': {
      id: 'escape-bay',
      label: '逃生舱',
      description: '小型逃生艇悬在干坞位，接口灯终于亮起了待发的绿色。',
      atmosphere: '这里比别处更安静，只剩海水压力在外壳上拉扯。',
      connected: ['control-room'],
      pointsOfInterest: ['逃生艇', '启动面板', '固定缆索']
    }
  }
};
