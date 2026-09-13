export type Resource = 'H1' | 'H2' | 'C1';
export type Route = 'receival' | 'split';
export interface Field { id: string; name: string; crop: 'Wheat' | 'Canola' | 'Barley'; hectares: number; yield: number; price: number; moisture: number; ready: number; rainLoss: number; color: string; }
export interface Scenario { rainAt: number; rainDuration: number; rainMm: number; probability: number; h2Capacity: number; disrupted: boolean; }
export interface Rule { resource: Resource; field: string; rainfallMm: number; windowHours: number; kind: 'prohibit-after-rain'; source: string; }
export interface Strategy { id: string; label: string; h2: boolean; contractor: boolean; }
export interface Assignment { hour: number; resource: Resource; field: string; hectares: number; destination: 'storage' | 'receival'; tonnes: number; }
export interface Economics { weatherLoss: number; machineCost: number; transportCost: number; contractorCost: number; delayCost: number; deliveryPenalty: number; totalCost: number; contribution: number; }
export interface Plan { strategy: Strategy; route: Route; order: string[]; assignments: Assignment[]; economics: Economics; harvested: number; beforeRain: number; exposed: number; deliveredOnTime: number; destinations: {storage:number;receival:number}; remaining: Record<string, number>; preRainRemaining: Record<string, number>; }
export interface SearchResult { best: Plan; alternatives: Plan[]; evaluated: number; }
