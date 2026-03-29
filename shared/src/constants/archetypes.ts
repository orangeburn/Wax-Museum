import type { ArchetypeDefinition, InventoryItem, ItemId, TagId, TagRule } from '../types.js';

export const ITEM_LIBRARY: Record<ItemId, InventoryItem> = {
  'insulated-wrench': {
    id: 'insulated-wrench',
    label: '绝缘扳手',
    description: '艇员舱的维护工具，修复主继电器时必需。'
  },
  'captain-keycard': {
    id: 'captain-keycard',
    label: '舰长钥匙卡',
    description: '可解锁控制室通往逃生舱的封闭闸门。'
  },
  medkit: {
    id: 'medkit',
    label: '急救包',
    description: '恢复 1 点 HP。',
    consumable: true
  },
  'oxygen-canister': {
    id: 'oxygen-canister',
    label: '便携氧气罐',
    description: '恢复 2 点氧气。',
    consumable: true
  },
  'sealant-foam': {
    id: 'sealant-foam',
    label: '应急密封泡沫',
    description: '用于临时堵漏，叙事上能稳定局面。'
  }
};

export const TAG_RULES: Record<TagId, TagRule> = {
  '机械直觉': {
    id: '机械直觉',
    label: '机械直觉',
    summary: '对机械结构的理解极强，修理时更稳。',
    stat: 'mind',
    bonus: 12,
    actions: ['repair', 'inspect'],
    customAllowed: false
  },
  '战地急救': {
    id: '战地急救',
    label: '战地急救',
    summary: '处置伤情和情绪波动时更有把握。',
    stat: 'empathy',
    bonus: 10,
    actions: ['use_item', 'persuade'],
    customAllowed: false
  },
  '危机嗅觉': {
    id: '危机嗅觉',
    label: '危机嗅觉',
    summary: '对危险动线极为敏感，搜查和移动更高效。',
    stat: 'mind',
    bonus: 8,
    actions: ['inspect', 'move'],
    customAllowed: false
  },
  '幸运星': {
    id: '幸运星',
    label: '幸运星',
    summary: '在边缘操作里总能捞到一线机会。',
    stat: 'physique',
    bonus: 8,
    actions: ['force', 'use_item'],
    customAllowed: false
  },
  '冷静': {
    id: '冷静',
    label: '冷静',
    summary: '高压环境下依然能保持判断力。',
    stat: 'mind',
    bonus: 8,
    actions: ['repair', 'inspect'],
    customAllowed: true
  },
  '钢铁意志': {
    id: '钢铁意志',
    label: '钢铁意志',
    summary: '扛得住冲击，强行突破时不容易崩。',
    stat: 'physique',
    bonus: 10,
    actions: ['force', 'move'],
    customAllowed: true
  },
  '说客': {
    id: '说客',
    label: '说客',
    summary: '善于安抚和说服别人配合。',
    stat: 'empathy',
    bonus: 12,
    actions: ['persuade'],
    customAllowed: true
  },
  '潜行训练': {
    id: '潜行训练',
    label: '潜行训练',
    summary: '动作更轻更快，穿越危险区时更可靠。',
    stat: 'physique',
    bonus: 8,
    actions: ['move', 'force'],
    customAllowed: true
  }
};

export const CUSTOM_TAG_WHITELIST = Object.values(TAG_RULES)
  .filter((tag) => tag.customAllowed)
  .map((tag) => tag.id);

export const ARCHETYPES: ArchetypeDefinition[] = [
  {
    id: 'engineer',
    label: '工程师',
    summary: '懂结构、能修机，是这艘潜艇最后的理智手。',
    prompt: '你熟悉艇内线路与应急流程，知道继电器和动力舱的脾气。',
    defaultTag: '机械直觉',
    stats: { physique: 2, mind: 4, empathy: 2 },
    startingItems: ['sealant-foam']
  },
  {
    id: 'medic',
    label: '军医',
    summary: '能稳住伤者，也能在压力下维持队伍秩序。',
    prompt: '你熟悉医疗舱布局，知道哪些柜子通常藏着紧急物资。',
    defaultTag: '战地急救',
    stats: { physique: 2, mind: 3, empathy: 4 },
    startingItems: ['medkit']
  },
  {
    id: 'security',
    label: '安保员',
    summary: '擅长强行推进，在险境中更敢破局。',
    prompt: '你接受过艇内危机处理训练，熟悉封舱与突入流程。',
    defaultTag: '钢铁意志',
    stats: { physique: 4, mind: 3, empathy: 1 },
    startingItems: []
  },
  {
    id: 'passenger',
    label: '乘客',
    summary: '不专业，但总有些出人意料的活路。',
    prompt: '你只是误入这场事故，却比任何人都更想活着出去。',
    defaultTag: '幸运星',
    stats: { physique: 3, mind: 2, empathy: 3 },
    startingItems: []
  }
];
