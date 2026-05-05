export type TemplateId = string;
export type ArchetypeId = string;
export type LocationId = string;
export type ItemId =
  | 'insulated-wrench'
  | 'captain-keycard'
  | 'medkit'
  | 'oxygen-canister'
  | 'sealant-foam';
export type ActionType =
  | 'inspect'
  | 'inventory'
  | 'help'
  | 'move'
  | 'repair'
  | 'force'
  | 'use_item'
  | 'persuade';
export type ResolutionTier = 'success' | 'cost' | 'fail';
export type SessionPhase = 'briefing' | 'active' | 'escaped' | 'failed';
export type ObjectivePhase =
  | 'find-tool'
  | 'restore-power'
  | 'investigate-console'
  | 'get-keycard'
  | 'stabilize-survivor'
  | 'reach-escape-bay'
  | 'prepare-launch'
  | 'resolution';
export type SkillKey = 'physique' | 'mind' | 'empathy';
export type GameplayMode = 'template' | 'llm';
export type StoryGameMode = 'survival' | 'puzzle' | 'versus';
export type TagId =
  | '机械直觉'
  | '战地急救'
  | '危机嗅觉'
  | '幸运星'
  | '冷静'
  | '钢铁意志'
  | '说客'
  | '潜行训练';

export interface Stats {
  physique: number;
  mind: number;
  empathy: number;
}

export interface InventoryItem {
  id: ItemId;
  label: string;
  description: string;
  consumable?: boolean;
}

export interface ArchetypeDefinition {
  id: ArchetypeId;
  label: string;
  summary: string;
  prompt: string;
  defaultTag: TagId;
  stats: Stats;
  startingItems: ItemId[];
}

export interface TagRule {
  id: TagId;
  label: string;
  summary: string;
  stat: SkillKey;
  bonus: number;
  actions: ActionType[] | 'all';
  customAllowed: boolean;
}

export interface LocationDefinition {
  id: LocationId;
  label: string;
  description: string;
  atmosphere: string;
  connected: LocationId[];
  pointsOfInterest: string[];
}

export interface TemplateDefinition {
  id: TemplateId;
  label: string;
  premise: string;
  openingLine: string;
  macroObjective: string;
  initialOxygen: number;
  initialDanger: number;
  initialHp: number;
  initialSan: number;
  countdown: CountdownPresentation;
  locations: Record<LocationId, LocationDefinition>;
}

export interface CountdownPresentation {
  label: string;
  shortLabel: string;
  max: number;
  recoverLabel: string;
}

export interface ScenarioGlossary {
  toolLabel: string;
  keyItemLabel: string;
  repairMaterialLabel: string;
  powerNodeLabel: string;
  cabinetLabel: string;
  survivorLabel: string;
  gateLabel: string;
  exitVehicleLabel: string;
  itemLabels: Record<ItemId, string>;
}

export interface StoryBeat {
  id: string;
  title: string;
  summary: string;
  guidance: string;
  locationId: LocationId;
  actionType: ActionType;
  targetLabel: string;
  skill?: SkillKey;
  requiredItemId?: ItemId | null;
  rewardItemId?: ItemId | null;
  countdownDelta?: number;
  successText: string;
  failText: string;
  suggestions: string[];
}

export interface SecretAgenda {
  title: string;
  description: string;
  successHint: string;
  triggerKeywords: string[];
  requiredProgress: number;
  progress: number;
  status: 'active' | 'completed' | 'failed';
}

export interface RoleSettingPack {
  coreBelief: string;
  immediateNeed: string;
  longTermNeed: string;
  stressBehaviors: string[];
  behaviorPrinciples: string[];
  actionTendencies: string[];
  environmentPlaybook: {
    confined: string;
    social: string;
    highPressure: string;
  };
  interactionGuide: {
    trustGain: string;
    trustBreak: string;
    bargainingChip: string;
    tabooTopics: string[];
  };
}

export interface StoryNpc {
  id: string;
  name: string;
  publicIdentity: string;
  hiddenDrive: string;
  attitude: 'friendly' | 'neutral' | 'hostile';
  locationId: LocationId;
  clue: string;
  status: string;
  motiveAnchor?: string;
  interactionTips?: string[];
  privateState?: {
    coreGoal: string;
    shortTermGoal: string;
    strategy: string;
    stress: number;
    memory: string[];
    lastAction?: string;
  };
}

export interface StoryScenario {
  id: string;
  title: string;
  premise: string;
  openingLine: string;
  macroObjective: string;
  storyGameMode?: StoryGameMode;
  countdown: CountdownPresentation;
  gameplayMode?: GameplayMode;
  beats?: StoryBeat[];
  npcs?: StoryNpc[];
  locations: Record<LocationId, LocationDefinition>;
  glossary: ScenarioGlossary;
}

export interface PlayerCharacter {
  archetypeId: ArchetypeId;
  archetypeLabel: string;
  customBackground: string;
  customTag: string | null;
  notes: string[];
  stats: Stats;
  tags: TagId[];
  hp: number;
  san: number;
  inventory: ItemId[];
  locationId: LocationId;
  secretAgenda?: SecretAgenda | null;
  settingPack?: RoleSettingPack | null;
}

export interface WorldFlags {
  wrenchFound: boolean;
  powerRestored: boolean;
  keycardHinted: boolean;
  keycardRecovered: boolean;
  consoleDecoded: boolean;
  escapeBayUnlocked: boolean;
  launchInspected: boolean;
  launchReady: boolean;
  escapeLaunched: boolean;
  survivorPresent: boolean;
  survivorHelped: boolean;
}

export interface TurnOrderEntry {
  actorId: string;
  actorLabel: string;
  actorType: 'player' | 'npc';
  initiative: number;
}

export interface WorldState {
  templateId: TemplateId;
  oxygen: number;
  danger: number;
  turn: number;
  maxRounds?: number;
  currentRound?: number;
  playerActionPoints?: number;
  npcActionPoints?: Record<string, number>;
  turnOrder?: TurnOrderEntry[];
  activeActorId?: string;
  storyBeatIndex?: number;
  locations: Record<LocationId, LocationDefinition>;
  visitedLocations: LocationId[];
  flags: WorldFlags;
}

export interface ObjectiveState {
  macroObjective: string;
  dynamicGuide: string;
  phase: ObjectivePhase;
  countdownLabel: string;
  availableActionsHint: string[];
  secretAgendaStatus?: string;
}

export interface ParsedAction {
  type: ActionType;
  rawIntent: string;
  normalizedIntent: string;
  dynamicBeatId?: string;
  targetId?: string;
  targetLabel: string;
  locationId?: LocationId;
  toolId?: ItemId;
  consumesTurn: boolean;
  storyFilterNote?: string;
}

export interface FilteredAction extends ParsedAction {
  validity: 'accepted' | 'redirected' | 'rejected';
  reason?: string;
  redirectedFrom?: ActionType;
  storyFilterNote?: string;
}

export interface Resolution {
  tier: ResolutionTier;
  summary: string;
  stateChanges: string[];
  skill?: SkillKey;
  difficulty?: number;
  roll?: number;
  score?: number;
  oxygenCost: number;
  dangerDelta: number;
  damage: number;
}

export interface NarrationPayload {
  scene: string;
  systems: string[];
  dynamicGuide: string;
}

export interface EventLogEntry {
  step: number;
  intent: string;
  filteredAction: string;
  tier: ResolutionTier;
  publicText: string;
  systemText: string;
  timestamp: string;
}

export interface SaveMeta {
  sessionId: string;
  title: string;
  updatedAt: string;
  phase: SessionPhase;
  archetypeId: ArchetypeId;
  oxygen: number;
  countdownName: string;
  danger: number;
  dynamicGuide: string;
}

export interface SessionSnapshot {
  sessionId: string;
  phase: SessionPhase;
  scenario: StoryScenario;
  player: PlayerCharacter;
  world: WorldState;
  objectives: ObjectiveState;
  logTail: EventLogEntry[];
}

export interface GameSession {
  sessionId: string;
  phase: SessionPhase;
  scenario: StoryScenario;
  player: PlayerCharacter;
  world: WorldState;
  objectives: ObjectiveState;
  eventLog: EventLogEntry[];
  saveMeta: SaveMeta;
}

export interface CreateSessionRequest {
  templateId: TemplateId;
  archetypeId: ArchetypeId;
  storyPrompt?: string;
  storyGameMode?: StoryGameMode;
  playerCount?: number;
  roundCount?: number;
  selectedRole?: SelectedRoleProfile;
  generatedRoles?: SelectedRoleProfile[];
  customBackground: string;
  customTag: string;
}

export interface StoryOutlineRequest {
  templateId: TemplateId;
  archetypeId: ArchetypeId;
  prompt: string;
  storyGameMode?: StoryGameMode;
  playerCount?: number;
  roundCount?: number;
}

export interface StoryOutlineResponse {
  title: string;
  premise: string;
  twist: string;
  secret: string;
  openingHook: string;
  modeGoal?: string;
  suggestedBackground: string;
  suggestedTags: string[];
}

export interface StoryScenarioRequest {
  templateId: TemplateId;
  archetypeId: ArchetypeId;
  prompt: string;
  storyGameMode?: StoryGameMode;
  playerCount?: number;
  roundCount?: number;
}

export interface WriterDraftRequest {
  prompt: string;
  storyGameMode?: StoryGameMode;
  playerCount?: number;
  roundCount?: number;
  outline?: StoryOutlineResponse;
}

export interface WriterRole {
  id: string;
  archetypeId: ArchetypeId;
  label: string;
  publicIdentity: string;
  hiddenDrive: string;
  relationshipHook: string;
  specialty: string;
  suggestedTag: string;
  suggestedBackground: string;
  stats: Stats;
  startingItems: ItemId[];
  coreTag: TagId;
  secretAgenda: Omit<SecretAgenda, 'progress' | 'status'>;
  settingPack?: RoleSettingPack;
}

export interface StoryBible {
  title: string;
  genre: string;
  storyGameMode?: StoryGameMode;
  playerCountLabel: string;
  premise: string;
  background: string;
  currentCrisis: string;
  coreSecret: string;
  outline: string[];
  endings: string[];
  roles: WriterRole[];
}

export interface WriterDraftResponse {
  bible: StoryBible;
  scenario: StoryScenario;
}

export interface SelectedRoleProfile {
  id: string;
  archetypeId: ArchetypeId;
  label: string;
  publicIdentity: string;
  hiddenDrive: string;
  relationshipHook: string;
  specialty: string;
  suggestedTag: string;
  suggestedBackground: string;
  stats: Stats;
  startingItems: ItemId[];
  coreTag: TagId;
  secretAgenda: Omit<SecretAgenda, 'progress' | 'status'>;
  settingPack?: RoleSettingPack;
}

export interface ActionRequest {
  intent: string;
}

export interface ActionResponse {
  filteredAction: FilteredAction;
  resolution: Resolution;
  sessionSnapshot: SessionSnapshot;
  narration: NarrationPayload;
}

export interface ActorObservation {
  actorId: string;
  actorType: 'player' | 'npc';
  actorLabel: string;
  currentLocation: LocationDefinition;
  visibleLocations: LocationDefinition[];
  visibleNpcs: Array<{
    id: string;
    name: string;
    publicIdentity: string;
    attitude: StoryNpc['attitude'];
    locationId: LocationId;
    status: string;
    clue?: string;
  }>;
  publicWorld: {
    turn: number;
    currentRound?: number;
    maxRounds?: number;
    countdownLabel: string;
    countdownValue: number;
    danger: number;
    activeActorId?: string;
  };
  playerPublic: {
    locationId: LocationId;
    hp: number;
    san: number;
  };
  inventory: ItemId[];
  availableActionsHint: string[];
  recentPublicEvents: string[];
  privateBrief?: {
    coreGoal: string;
    shortTermGoal: string;
    strategy: string;
    stress: number;
    memory: string[];
  };
}

export interface NpcIntentDecision {
  intent: string;
  actionType?: ActionType;
  reason?: string;
}
