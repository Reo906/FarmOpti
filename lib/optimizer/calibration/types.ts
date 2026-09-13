export interface GradientBoostingModel {
  kind: "gradient_boosting";
  categories: Record<string, string[]>;
  numeric: string[];
  learning_rate: number;
  init: number;
  trees: Array<{
    feature: number[];
    threshold: number[];
    left: number[];
    right: number[];
    value: number[];
  }>;
}

export interface ConstantModel {
  kind: "constant";
  value: number;
}

export type ResidualPredictor = GradientBoostingModel | ConstantModel;

export interface SupportCounts {
  all: number;
  by_crop: Record<string, number>;
  by_field_crop: Record<string, number>;
}

export interface FarmCalibrationMetadata {
  farm_id: string;
  training_rows: number;
  fields: string[];
  crops: string[];
  model_version: number;
  trained_at: string;
  samples: {
    irrigation: number;
    fertiliser: number;
    spray: number;
    yield_rows: number;
    yield_seasons: number;
  };
  support: Record<string, SupportCounts>;
  feature_names: Record<string, string[]>;
  confidence_k: number;
  trained_models: string[];
  skipped_models: string[];
  fit: Record<
    string,
    {
      samples: number;
      generic_mae: number;
      generic_bias: number;
      calibrated_mae: number;
      mae_improvement: number;
      mean_correction: number;
    }
  >;
}

export interface FarmCalibration {
  metadata: FarmCalibrationMetadata;
  irrigation: ResidualPredictor | null;
  fertiliser: ResidualPredictor | null;
  spray: ResidualPredictor | null;
  yield: ResidualPredictor | null;
}