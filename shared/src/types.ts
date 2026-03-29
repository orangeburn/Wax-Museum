export type TemplateId = string;
export type ArchetypeId = 'engineer' | 'medic' | 'security' | 'passenger';
export type LocationId =
  | 'crew-quarters'
  | 'engine-room'
  | 'med-bay'
  | 'control-room'
  | 'escape-bay';
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
  locations: Record<LocationId, LocationDefinition>;
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

export interface StoryScenario {
  id: string;
  title: string;
  premise: string;
  openingLine: string;
  macroObjective: string;
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

export interface WorldState {
  templateId: TemplateId;
  oxygen: number;
  danger: number;
  turn: number;
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
}

export interface ParsedAction {
  type: ActionType;
  rawIntent: string;
  normalizedIntent: string;
  targetId?: string;
  targetLabel: string;
  locationId?: LocationId;
  toolId?: ItemId;
  consumesTurn: boolean;
}

export interface FilteredAction extends ParsedAction {
  validity: 'accepted' | 'redirected' | 'rejected';
  reason?: string;
  redirectedFrom?: ActionType;
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
  selectedRole?: SelectedRoleProfile;
  customBackground: string;
  customTag: string;
}

export interface StoryOutlineRequest {
  templateId: TemplateId;
  archetypeId: ArchetypeId;
  prompt: string;
}

export interface StoryOutlineResponse {
  title: string;
  premise: string;
  twist: string;
  secret: string;
  openingHook: string;
  suggestedBackground: string;
  suggestedTags: string[];
}

export interface StoryScenarioRequest {
  templateId: TemplateId;
  archetypeId: ArchetypeId;
  prompt: string;
}

export interface WriterDraftRequest {
  prompt: string;
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
}

export interface StoryBible {
  title: string;
  genre: string;
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
  label: string;
  publicIdentity: string;
  hiddenDrive: string;
  relationshipHook: string;
  specialty: string;
  suggestedTag: string;
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
