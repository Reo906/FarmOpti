export type CropKey = 'wheat' | 'barley' | 'canola' | 'lentil' | 'beans' | 'oats';
export type Severity = 1 | 2 | 3;
export type MachineType = 'combine' | 'chaser' | 'truck' | 'sprayer';
export type MachineHealth = 'Nominal' | 'Restricted' | 'Standby';
export type DashboardView = 'command' | 'harvest' | 'grain' | 'protection' | 'agronomy' | 'fleet' | 'people' | 'markets' | 'rules';

export interface Property {
  id: string;
  name: string;
  town: string;
  ha: number;
}

export interface CropDefinition {
  key: CropKey;
  label: string;
  cls: string;
  price: number;
  exposure: number;
}

export interface FarmField {
  id: string;
  name: string;
  prop: string;
  crop: CropKey;
  variety: string;
  ha: number;
  done: number;
  yield: number;
  moist: number;
  ready: 'Ready' | 'Ready 14:00' | 'Ready 16:00' | 'Fri' | 'Sat' | 'Mon' | 'Complete';
  ndvi: number;
  soil: string;
  risk: string;
  whp: string | null;
  grade: string;
}

export interface MachineAsset {
  id: string;
  type: MachineType;
  make: string;
  rate: number;
  cost: number;
  hours: number;
  health: MachineHealth;
  cap: number;
  oper: string | null;
  fuel: number;
  note: string;
}

export interface Contractor {
  name: string;
  machine: string;
  rate: number;
  cost: number;
  lead: number;
  phone: string;
  status: string;
}

export interface StorageLocation {
  id: string;
  name: string;
  cap: number | null;
  held: number;
  crop: string;
  type: 'On-farm' | 'Receival';
  note: string;
}

export interface ContractCommitment {
  id: string;
  buyer: string;
  grade: string;
  tonnes: number;
  filled: number;
  due: string;
  price: number;
  penalty: string;
}

export interface PestObservation {
  id: string;
  pest: string;
  host: string;
  count: string;
  thresh: string;
  sev: Severity;
  action: string;
  trend: string;
  link: 'harvest' | 'grain' | null;
}

export interface ChemicalWithholding {
  field: string;
  product: string;
  applied: string;
  whp: string;
  clears: string;
  status: 'blocking' | 'clear';
}

export interface ResistanceStatus {
  weed: string;
  group: string;
  status: 'Confirmed resistant' | 'Suspected' | 'Susceptible';
  pct: number;
  note: string;
}

export interface PersonRoster {
  name: string;
  role: string;
  on: string;
  shift: string;
  hours14: number;
  fatigue: 'Green' | 'Amber' | 'Red';
  tickets: string[];
}

export interface ServiceItem {
  asset: string;
  item: string;
  due: string;
  sev: Severity;
  cost: number;
}

export interface WeatherDay {
  day: string;
  max: number;
  min: number;
  rain: number;
  prob: number;
  wind: string;
  delta: number;
  gfdi: number;
}

export interface MarginRow {
  field: string;
  crop: CropKey;
  gm: number;
}

export interface FarmRule {
  id: string;
  res: string;
  field: string;
  trig: string;
  win: string;
  con: string;
  src: string;
  on: boolean;
  trigMm?: number;
}

export interface ChatMessage {
  who: 'sys' | 'me';
  text: string;
}

export interface HarvestBlock {
  m: string;
  f: string;
  name: string;
  crop: CropKey;
  s: number;
  e: number;
  ha: number;
}

export interface OptimiserCandidate {
  id: string;
  label: string;
  detail: string;
  h2: 'off' | 'restricted';
  contractor: boolean;
  sequence: string[];
  haul: number;
  blocks: HarvestBlock[];
  harvested: number;
  exposedHa: number;
  lossValue: number;
  opCost: number;
  contractorCost: number;
  penalty: number;
  net: number;
  truckLimited: boolean;
  blockedByRule: boolean;
  deadline: number;
}

export interface DashboardState {
  phase: 'normal' | 'disrupted' | 'reoptimised';
  rainHours: number;
  rainMm: number;
  rainProb: number;
  h2: {
    state: 'Nominal' | 'Restricted';
    cap: number;
    note: string;
  };
  rules: FarmRule[];
  view: DashboardView;
  plan: OptimiserCandidate | null;
  prevPlan: OptimiserCandidate | null;
  lastImprovement: number;
  ruleAdded: boolean;
  pending: FarmRule | null;
  chat: ChatMessage[];
  evaluated?: OptimiserCandidate[];
}

export interface YallambeeOpsDashboard {
  farm: {
    name: string;
    season: string;
    properties: Property[];
  };
  crops: Record<CropKey, CropDefinition>;
  fields: FarmField[];
  machines: MachineAsset[];
  contractor: Contractor;
  storage: StorageLocation[];
  contracts: ContractCommitment[];
  pests: PestObservation[];
  chem: ChemicalWithholding[];
  resistance: ResistanceStatus[];
  people: PersonRoster[];
  service: ServiceItem[];
  weather: WeatherDay[];
  margin: MarginRow[];
  state: DashboardState;
}

export default YallambeeOpsDashboard;

// Scheduler domain types used by the executable farm optimiser.
export type Resource = 'H1' | 'H2' | 'C1';
export type Route = 'receival' | 'split';

export interface Field {
  id: string;
  name: string;
  crop: 'Wheat' | 'Canola' | 'Barley';
  hectares: number;
  yield: number;
  price: number;
  moisture: number;
  ready: number;
  rainLoss: number;
  color: string;
}

export interface Scenario {
  rainAt: number;
  rainDuration: number;
  rainMm: number;
  probability: number;
  h2Capacity: number;
  disrupted: boolean;
}

export interface Strategy {
  id: string;
  label: string;
  h2: boolean;
  contractor: boolean;
}

export interface Rule {
  resource: Resource;
  field: string;
  rainfallMm: number;
  windowHours: number;
  kind: 'prohibit-after-rain';
  source: string;
}

export interface Assignment {
  hour: number;
  resource: Resource;
  field: string;
  hectares: number;
  destination: Route extends 'split' ? string : 'storage' | 'receival';
  tonnes: number;
}

export interface Economics {
  weatherLoss: number;
  delayCost: number;
  deliveryPenalty: number;
  contractorCost: number;
  machineCost: number;
  transportCost: number;
  totalCost: number;
  contribution: number;
}

export interface Plan {
  strategy: Strategy;
  route: Route;
  order: string[];
  assignments: Assignment[];
  remaining: Record<string, number>;
  preRainRemaining: Record<string, number>;
  destinations: { storage: number; receival: number };
  harvested: number;
  beforeRain: number;
  exposed: number;
  deliveredOnTime: number;
  economics: Economics;
}

export interface SearchResult {
  best: Plan;
  alternatives: Plan[];
  evaluated: number;
}
