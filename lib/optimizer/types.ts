export interface FieldRow {
  field_id: string;
  area_ha: number;
  current_crop: string;
  planned_crop: string;
  irrigable: number;
  x_km: number;
  y_km: number;
}

export interface FieldStateRow {
  date: string;
  field_id: string;
  growth_stage: string;
  readiness: number;
  soil_moisture: number;
  soil_temperature_c: number;
  expected_yield_t_ha: number;
  nitrogen_index: number;
  weed_pressure: number;
  pest_pressure: number;
  disease_pressure: number;
  seedbed_readiness: number;
}

export interface WeatherRow {
  time: number; // timestamp (ms, UTC)
  temperature_c: number;
  wind_kmh: number;
  rain_mm: number;
}

export interface LabourRow {
  date: string;
  available_workers: number;
  workday_start: string;
  workday_end: string;
}

export interface MachineRow {
  machine_id: string;
  machine_type: string;
  cost_per_hour_aud: number;
  current_field: string;
}

export interface MachineAvailabilityRow {
  date: string;
  machine_id: string;
  available: number;
  available_from: string | null;
  available_to: string | null;
}

export interface WaterRow {
  date: string;
  available_water_ml: number;
  max_delivery_ml_per_day: number;
}

export interface EconomicsRow {
  date: string;
  variable_type: string;
  item: string;
  unit: string;
  value: number;
}

export interface ManagementPlanRow {
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  amount: number | null;
  unit: string;
  allowed_from: string;
  allowed_to: string;
  required: boolean;
  depends_on: string;
  min_gap_hours: number | null;
}

export interface ExternalVariables {
  fields: FieldRow[];
  state: FieldStateRow[];
  weather: WeatherRow[];
  labour: LabourRow[];
  machines: MachineRow[];
  machineAvailability: MachineAvailabilityRow[];
  water: WaterRow[];
  economics: EconomicsRow[];
  management: ManagementPlanRow[];
}

export interface ActionResult {
  direct_revenue_aud: number;
  direct_cost_aud: number;
  direct_cash_effect_aud: number;
  state_yield_effect_t_ha: number;
  water_ml: number;
  candidate_score: number;
}

export interface Candidate extends ActionResult {
  candidate_id: string;
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  required: boolean;
  depends_on: string;
  min_gap_hours: number;
  start_time: number;
  end_time: number;
  duration_hours: number;
  machine_type: string;
  eligible_machine_ids: string[];
  workers_required: number;
}

export interface FieldStateSnapshot {
  crop: string;
  planted: boolean;
  newly_planted: boolean;
  harvested: boolean;
  growth_stage: string;
  readiness: number;
  soil_moisture: number;
  soil_temperature_c: number;
  expected_yield_t_ha: number;
  nitrogen_index: number;
  weed_pressure: number;
  pest_pressure: number;
  disease_pressure: number;
  seedbed_readiness: number;
}

export interface OptionAction extends Candidate {
  option_id?: string;
  action_key?: string;
  state_after: FieldStateSnapshot;
}

export interface FieldOption {
  option_id: string;
  field_id: string;
  total_direct_cash_effect_aud: number;
  terminal_value_aud: number;
  objective_value_aud: number;
  actions: OptionAction[];
  final_state: FieldStateSnapshot;
}

export interface ScheduleRow {
  option_id: string;
  candidate_id: string;
  plan_id: string;
  field_id: string;
  operation: string;
  target: string;
  start_time: number;
  end_time: number;
  machine_id: string;
  workers_required: number;
  water_ml: number;
  direct_revenue_aud: number;
  direct_cost_aud: number;
  direct_cash_effect_aud: number;
  state_yield_effect_t_ha: number;
}

export interface SelectedOptionSummary {
  option_id: string;
  field_id: string;
  direct_cash_effect_aud: number;
  terminal_value_aud: number;
  objective_value_aud: number;
}

export interface OptimizationSummary {
  status: "optimal" | "feasible";
  total_direct_cash_effect_aud: number;
  total_terminal_value_aud: number;
  total_objective_value_aud: number;
  num_scheduled_actions: number;
  selected_options: SelectedOptionSummary[];
}

export interface OptimizationScenario {
  forbid_plan_ids?: string[];
  force_plan_ids?: string[];
  force_candidate_ids?: Record<string, string>;
}

export type AlternativeObjective = "value" | "cost" | "risk" | "smoothness" | "earliness" | "lateness";

export interface OptimizationVariant {
  objective?: AlternativeObjective;
  minObjectiveValue?: number;
  labourCapacityFactor?: number;
  forbidOptionSets?: string[][];
}

export interface ScheduleMetrics {
  total_cost_aud: number;
  total_water_ml: number;
  peak_labour: number;
  mean_start_time: number;
  risk_score: number;
}

export interface AlternativePlan {
  plan_id: string;
  label: string;
  reason: string;
  objective_value_aud: number;
  optimality_ratio: number;
  selected_option_ids: string[];
  schedule: ScheduleRow[];
  summary: OptimizationSummary;
  metrics: ScheduleMetrics;
}

export interface AlternativePlansResult {
  baseline_objective_aud: number;
  min_optimality_ratio: number;
  plans: AlternativePlan[];
}
