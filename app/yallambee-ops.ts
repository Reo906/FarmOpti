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
  crop: string;
  operation: string;
  target: string;
  planId: string;
  cashEffect: number;
  workers: number;
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

export const yallambeeOpsDashboard: YallambeeOpsDashboard = {
  farm: {
    name: 'Yallambee Cropping Co.',
    season: '2026–27',
    properties: [
      { id: 'YHB', name: 'Yallambee Home Block', town: 'Rupanyup', ha: 6120 },
      { id: 'BAN', name: 'Banyena Downs', town: 'Banyena', ha: 4980 },
      { id: 'KEL', name: 'Kellalac North', town: 'Kellalac', ha: 4310 },
      { id: 'CWE', name: 'Coonooer West', town: 'Coonooer', ha: 3020 },
    ],
  },
  crops: {
    wheat: { key: 'wheat', label: 'Wheat', cls: 'cw', price: 372, exposure: 155 },
    barley: { key: 'barley', label: 'Barley', cls: 'cb', price: 318, exposure: 224 },
    canola: { key: 'canola', label: 'Canola', cls: 'cc', price: 755, exposure: 296 },
    lentil: { key: 'lentil', label: 'Lentils', cls: 'cl', price: 1020, exposure: 412 },
    beans: { key: 'beans', label: 'Faba beans', cls: 'cf', price: 540, exposure: 198 },
    oats: { key: 'oats', label: 'Oats', cls: 'co', price: 295, exposure: 132 },
  },
  fields: [
    {
      id: 'N4',
      name: 'North 4',
      prop: 'YHB',
      crop: 'lentil',
      variety: 'Hallmark XT',
      ha: 214,
      done: 0,
      yield: 2.1,
      moist: 11.4,
      ready: 'Ready',
      ndvi: 0.14,
      soil: 'Grey vertosol',
      risk: 'Boggy after >15 mm; single western access track',
      whp: null,
      grade: 'Lentil #1',
    },
    {
      id: 'WS',
      name: 'Woolshed',
      prop: 'YHB',
      crop: 'canola',
      variety: '44Y30 RR',
      ha: 214,
      done: 52,
      yield: 2.4,
      moist: 7.1,
      ready: 'Ready',
      ndvi: 0.12,
      soil: 'Sandy loam',
      risk: 'Windrows shatter above 45 km/h',
      whp: null,
      grade: 'CAN',
    },
    {
      id: 'TM',
      name: 'Twelve Mile',
      prop: 'YHB',
      crop: 'wheat',
      variety: 'Scepter',
      ha: 268,
      done: 168,
      yield: 3.6,
      moist: 10.8,
      ready: 'Ready',
      ndvi: 0.17,
      soil: 'Grey vertosol',
      risk: '—',
      whp: null,
      grade: 'APW1',
    },
    {
      id: 'AIR',
      name: 'Airstrip',
      prop: 'BAN',
      crop: 'barley',
      variety: 'RGT Planet',
      ha: 172,
      done: 0,
      yield: 4.1,
      moist: 12.6,
      ready: 'Ready 14:00',
      ndvi: 0.19,
      soil: 'Red chromosol',
      risk: 'Malt grade — moisture ceiling 12.5%',
      whp: null,
      grade: 'MALT1',
    },
    {
      id: 'CHB',
      name: 'Church Block',
      prop: 'BAN',
      crop: 'wheat',
      variety: 'Vixen',
      ha: 196,
      done: 196,
      yield: 3.2,
      moist: 10.2,
      ready: 'Complete',
      ndvi: 0.11,
      soil: 'Red chromosol',
      risk: '—',
      whp: null,
      grade: 'APW1',
    },
    {
      id: 'STR',
      name: 'Stony Rise',
      prop: 'BAN',
      crop: 'lentil',
      variety: 'GIA Lightning',
      ha: 158,
      done: 0,
      yield: 1.8,
      moist: 12.9,
      ready: 'Ready 16:00',
      ndvi: 0.16,
      soil: 'Calcarosol',
      risk: 'Rocky — front height limits ground speed',
      whp: '2026-12-05',
      grade: 'Lentil #2',
    },
    {
      id: 'DAM',
      name: 'Dam Paddock',
      prop: 'KEL',
      crop: 'wheat',
      variety: 'Rockstar',
      ha: 304,
      done: 0,
      yield: 3.9,
      moist: 11.9,
      ready: 'Fri',
      ndvi: 0.24,
      soil: 'Grey vertosol',
      risk: '—',
      whp: null,
      grade: 'APW1',
    },
    {
      id: 'LSW',
      name: 'Long Swamp',
      prop: 'KEL',
      crop: 'beans',
      variety: 'PBA Amberley',
      ha: 171,
      done: 0,
      yield: 2.9,
      moist: 13.8,
      ready: 'Sat',
      ndvi: 0.31,
      soil: 'Grey vertosol',
      risk: 'Low-lying; standing water after 20 mm',
      whp: null,
      grade: 'FAB1',
    },
    {
      id: 'KE',
      name: 'Kellalac East',
      prop: 'KEL',
      crop: 'barley',
      variety: 'Maximus CL',
      ha: 226,
      done: 226,
      yield: 3.8,
      moist: 11.1,
      ready: 'Complete',
      ndvi: 0.1,
      soil: 'Sandy loam',
      risk: '—',
      whp: null,
      grade: 'BAR1',
    },
    {
      id: 'BR',
      name: 'Banyena Ridge',
      prop: 'BAN',
      crop: 'wheat',
      variety: 'Scepter',
      ha: 288,
      done: 288,
      yield: 3.4,
      moist: 10.6,
      ready: 'Complete',
      ndvi: 0.1,
      soil: 'Red chromosol',
      risk: '—',
      whp: null,
      grade: 'APW1',
    },
    {
      id: 'BOR',
      name: 'Bore Paddock',
      prop: 'CWE',
      crop: 'oats',
      variety: 'Yallara',
      ha: 142,
      done: 0,
      yield: 2.6,
      moist: 12.2,
      ready: 'Mon',
      ndvi: 0.28,
      soil: 'Sandy loam',
      risk: 'Hay contract — separate windrow crew',
      whp: null,
      grade: 'OAT1',
    },
    {
      id: 'H60',
      name: 'Highway 60',
      prop: 'CWE',
      crop: 'canola',
      variety: 'Nuseed Raptor',
      ha: 198,
      done: 198,
      yield: 2.2,
      moist: 6.8,
      ready: 'Complete',
      ndvi: 0.09,
      soil: 'Sandy loam',
      risk: '—',
      whp: null,
      grade: 'CAN',
    },
  ],
  machines: [
    { id: 'H1', type: 'combine', make: 'John Deere X9 1100', rate: 12.4, cost: 412, hours: 2841, health: 'Nominal', cap: 1, oper: 'Dean R.', fuel: 78, note: 'Sieve losses 0.9% (target <1.2%)' },
    { id: 'H2', type: 'combine', make: 'Case IH AF9250', rate: 11.8, cost: 395, hours: 3376, health: 'Nominal', cap: 1, oper: 'Josh M.', fuel: 64, note: 'Rotor bearing trend flat' },
    { id: 'CB1', type: 'chaser', make: 'Finch 30t', rate: 0, cost: 88, hours: 1204, health: 'Nominal', cap: 1, oper: 'Tyrell K.', fuel: 52, note: 'Paired to H1' },
    { id: 'CB2', type: 'chaser', make: 'Haukaas 26t', rate: 0, cost: 82, hours: 998, health: 'Nominal', cap: 1, oper: 'Sam O.', fuel: 41, note: 'Paired to H2' },
    { id: 'T1', type: 'truck', make: 'Kenworth T610 B-dbl', rate: 0, cost: 141, hours: 0, health: 'Nominal', cap: 1, oper: 'Bruce H.', fuel: 66, note: 'Murtoa run · 62 min turnaround' },
    { id: 'T2', type: 'truck', make: 'Kenworth T410 semi', rate: 0, cost: 118, hours: 0, health: 'Nominal', cap: 1, oper: 'Ange P.', fuel: 71, note: 'Murtoa run · 58 min turnaround' },
    { id: 'T3', type: 'truck', make: 'Mack Trident tipper', rate: 0, cost: 104, hours: 0, health: 'Standby', cap: 1, oper: '—', fuel: 88, note: 'Spare — needs a relief driver to run' },
    { id: 'SP1', type: 'sprayer', make: 'Goldacres G8 6000', rate: 0, cost: 174, hours: 1687, health: 'Nominal', cap: 1, oper: 'Kate L.', fuel: 34, note: 'Summer weed program from 22 Dec' },
  ],
  contractor: {
    name: 'Delaney Harvesting',
    machine: 'CLAAS Lexion 8700',
    rate: 9.2,
    cost: 585,
    lead: 6,
    phone: '0438 22 41xx',
    status: 'Available — 2 units at Murtoa',
  },
  storage: [
    { id: 'RUP', name: 'Rupanyup bunker', cap: 8000, held: 5140, crop: 'Wheat APW1', type: 'On-farm', note: 'Aeration running 22:00–06:00' },
    { id: 'SB', name: 'Home silo bank', cap: 2400, held: 1880, crop: 'Barley MALT1', type: 'On-farm', note: 'Silo 4 sealed — fumigation clears 14 Dec' },
    { id: 'MUR', name: 'GrainCorp Murtoa', cap: null, held: 3620, crop: 'Delivered', type: 'Receival', note: 'Queue 34 min · sample lane 2 closed' },
    { id: 'DOO', name: 'Wimmera Grain Dooen', cap: null, held: 1290, crop: 'Delivered', type: 'Receival', note: 'Queue 11 min · canola only until 12:00' },
  ],
  contracts: [
    { id: 'C-3391', buyer: 'GrainCorp', grade: 'APW1 wheat', tonnes: 1500, filled: 1080, due: '18 Dec', price: 372, penalty: 'A$14/t washout' },
    { id: 'C-3402', buyer: 'Wimmera Malt', grade: 'MALT1 barley', tonnes: 600, filled: 214, due: '22 Dec', price: 341, penalty: 'Grade fallback to feed −A$23/t' },
    { id: 'C-3410', buyer: 'AgriOils', grade: 'Canola CAN', tonnes: 900, filled: 900, due: 'Delivered', price: 755, penalty: '—' },
    { id: 'C-3418', buyer: 'Pulse Exporters', grade: 'Lentil #1', tonnes: 400, filled: 0, due: '9 Jan', price: 1020, penalty: 'A$38/t washout' },
  ],
  pests: [
    { id: 'P1', pest: 'Native budworm', host: 'Lentils — North 4, Stony Rise', count: '14 grubs / 10 sweeps', thresh: '8 / 10 sweeps', sev: 1, action: 'Above threshold. Crop within 5 days of harvest — spraying not viable, harvest timing is the control.', trend: '+6 since 1 Dec', link: 'harvest' },
    { id: 'P2', pest: 'Lesser grain borer', host: 'Home silo bank — silo 4', count: '3 adults / probe', thresh: 'Nil tolerance', sev: 1, action: 'Silo 4 sealed and under phosphine. Do not fill until 14 Dec.', trend: 'Detected 2 Dec', link: 'grain' },
    { id: 'P3', pest: 'Green peach aphid', host: 'Canola — Woolshed', count: 'Trace', thresh: '20% plants', sev: 3, action: 'Crop desiccated. Monitoring closed for season.', trend: 'Falling', link: null },
    { id: 'P4', pest: 'Russian wheat aphid', host: 'Wheat — Dam Paddock', count: '2% tillers', thresh: '20% tillers', sev: 3, action: 'Below threshold at grain fill. No action.', trend: 'Stable', link: null },
    { id: 'P5', pest: 'Mice', host: 'Bunker perimeter — Rupanyup', count: '6 / 100 m chew card', thresh: '4 / 100 m', sev: 2, action: 'Bait perimeter before bunker fill resumes Friday.', trend: '+2 this week', link: 'grain' },
  ],
  chem: [
    { field: 'Stony Rise', product: 'Glyphosate 570 (desiccation)', applied: '28 Nov', whp: '7 days', clears: '5 Dec 07:00', status: 'blocking' },
    { field: 'Long Swamp', product: 'Diquat 200', applied: '1 Dec', whp: '4 days', clears: '5 Dec 12:00', status: 'blocking' },
    { field: 'North 4', product: 'Glyphosate 570 (desiccation)', applied: '25 Nov', whp: '7 days', clears: '2 Dec 07:00', status: 'clear' },
    { field: 'Airstrip', product: '—', applied: '—', whp: '—', clears: '—', status: 'clear' },
  ],
  resistance: [
    { weed: 'Annual ryegrass', group: 'Group 9 (glyphosate)', status: 'Confirmed resistant', pct: 62, note: 'Yallambee Home Block fencelines — swap to double-knock' },
    { weed: 'Annual ryegrass', group: 'Group 1 (fops)', status: 'Confirmed resistant', pct: 88, note: 'Whole enterprise — no longer used in-crop' },
    { weed: 'Sowthistle', group: 'Group 2 (SU)', status: 'Suspected', pct: 31, note: 'Test strip sown at Kellalac North' },
    { weed: 'Wild radish', group: 'Group 5', status: 'Susceptible', pct: 6, note: 'Monitor Coonooer West' },
    { weed: 'Brome grass', group: 'Group 9', status: 'Susceptible', pct: 3, note: '—' },
  ],
  people: [
    { name: 'Dean Rowntree', role: 'Combine operator', on: 'H1', shift: '05:30–19:30', hours14: 118, fatigue: 'Amber', tickets: ['HR licence', 'Chem AQF3'] },
    { name: 'Josh Mataira', role: 'Combine operator', on: 'H2', shift: '05:30–19:30', hours14: 126, fatigue: 'Amber', tickets: ['HR licence'] },
    { name: 'Tyrell Kane', role: 'Chaser bin', on: 'CB1', shift: '06:00–20:00', hours14: 104, fatigue: 'Green', tickets: ['MR licence'] },
    { name: 'Sam Okafor', role: 'Chaser bin', on: 'CB2', shift: '06:00–20:00', hours14: 97, fatigue: 'Green', tickets: ['MR licence'] },
    { name: 'Bruce Hehir', role: 'Truck driver', on: 'T1', shift: '06:00–18:00', hours14: 132, fatigue: 'Red', tickets: ['MC licence', 'Fatigue BFM'] },
    { name: 'Ange Pirotta', role: 'Truck driver', on: 'T2', shift: '07:00–19:00', hours14: 88, fatigue: 'Green', tickets: ['HC licence'] },
    { name: 'Kate Ling', role: 'Spray / relief', on: 'SP1', shift: 'On call', hours14: 61, fatigue: 'Green', tickets: ['Chem AQF3', 'HR licence'] },
    { name: 'Rob Ellery', role: 'Maintenance', on: 'Workshop', shift: '07:00–17:00', hours14: 79, fatigue: 'Green', tickets: ['Hot works'] },
    { name: 'Priya Nadar', role: 'Grain admin', on: 'Office', shift: '08:00–16:00', hours14: 66, fatigue: 'Green', tickets: ['—'] },
  ],
  service: [
    { asset: 'H1', item: '500 h service', due: 'in 41 h', sev: 3, cost: 2400 },
    { asset: 'H2', item: 'Rotor drive inspection', due: 'open', sev: 1, cost: 1850 },
    { asset: 'T3', item: 'Trailer brake service', due: '18 Dec', sev: 3, cost: 640 },
    { asset: 'CB1', item: 'Auger flighting wear', due: 'in 120 h', sev: 3, cost: 980 },
    { asset: 'SP1', item: 'Boom section 4 nozzle check', due: 'before 22 Dec', sev: 3, cost: 180 },
  ],
  weather: [
    { day: 'Thu 4', max: 34, min: 16, rain: 0, prob: 5, wind: 'N 18–26', delta: 9.4, gfdi: 21 },
    { day: 'Fri 5', max: 31, min: 18, rain: 8, prob: 40, wind: 'NW 25–35', delta: 5.1, gfdi: 34 },
    { day: 'Sat 6', max: 24, min: 14, rain: 6, prob: 55, wind: 'SW 20–28', delta: 3.2, gfdi: 9 },
    { day: 'Sun 7', max: 27, min: 11, rain: 0, prob: 10, wind: 'S 12–18', delta: 6.8, gfdi: 14 },
    { day: 'Mon 8', max: 30, min: 13, rain: 0, prob: 5, wind: 'NE 10–16', delta: 8.1, gfdi: 19 },
    { day: 'Tue 9', max: 33, min: 15, rain: 0, prob: 5, wind: 'N 15–22', delta: 9.9, gfdi: 26 },
  ],
  margin: [
    { field: 'Banyena Ridge', crop: 'wheat', gm: 612 },
    { field: 'Kellalac East', crop: 'barley', gm: 548 },
    { field: 'Church Block', crop: 'wheat', gm: 501 },
    { field: 'Highway 60', crop: 'canola', gm: 874 },
    { field: 'Twelve Mile', crop: 'wheat', gm: 664 },
    { field: 'Airstrip', crop: 'barley', gm: 702 },
    { field: 'North 4', crop: 'lentil', gm: 938 },
    { field: 'Stony Rise', crop: 'lentil', gm: 571 },
    { field: 'Dam Paddock', crop: 'wheat', gm: 718 },
    { field: 'Long Swamp', crop: 'beans', gm: 489 },
  ],
  state: {
    phase: 'normal',
    rainHours: 31.2,
    rainMm: 8,
    rainProb: 0.35,
    h2: { state: 'Nominal', cap: 1, note: 'Rotor bearing trend flat' },
    rules: [
      {
        id: 'R-01',
        res: 'Any combine',
        field: 'Long Swamp',
        trig: 'Standing water',
        win: '—',
        con: 'No entry until surface dry',
        src: 'Mick Farrar · 12 Nov',
        on: true,
      },
      {
        id: 'R-02',
        res: 'T1 (B-double)',
        field: 'Kellalac North',
        trig: 'Any rainfall > 8 mm',
        win: '12 h',
        con: 'Use farm track only, no highway shortcut',
        src: 'Bruce Hehir · 21 Nov',
        on: true,
      },
      {
        id: 'R-03',
        res: 'All harvest',
        field: 'Enterprise',
        trig: 'GFDI ≥ 35',
        win: 'Live',
        con: 'Harvest stops — CFA district ban',
        src: 'Standing policy',
        on: true,
      },
    ],
    view: 'command',
    plan: null,
    prevPlan: null,
    lastImprovement: 0,
    ruleAdded: false,
    pending: null,
    chat: [{ who: 'sys', text: 'Tell me anything the plan should know — paddock quirks, machine limits, driver preferences. I\'ll turn it into a rule you can check before it\'s used.' }],
  },
};

export default yallambeeOpsDashboard;
