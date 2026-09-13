import { buildFeatureVector } from "./predict";
import { buildRegressionTree } from "./tree";
import type { GradientBoostingModel } from "./types";

export interface GradientBoostingHyperparams {
  nEstimators: number;
  maxDepth: number;
  learningRate: number;
}

export const DEFAULT_HYPERPARAMS: GradientBoostingHyperparams = {
  nEstimators: 40,
  maxDepth: 2,
  learningRate: 0.1,
};

/** scikit-learn's OneHotEncoder(categories="auto") learns categories as each column's sorted unique values. */
function fitCategories(rows: Record<string, string | number>[], categorical: string[]): Record<string, string[]> {
  const categories: Record<string, string[]> = {};
  for (const name of categorical) {
    const values = new Set<string>();
    for (const row of rows) values.add(String(row[name] ?? ""));
    categories[name] = [...values].sort();
  }
  return categories;
}

/**
 * Trains a gradient-boosted regression ensemble matching
 * sklearn.ensemble.GradientBoostingRegressor(loss="squared_error") under the
 * hyperparameters farm_calibration used: init = mean(y) (the loss's constant
 * optimum, matching sklearn's DummyRegressor init_), then `nEstimators`
 * rounds of fitting a depth-`maxDepth` regression tree to the current
 * pseudo-residuals (y - F(x), squared-error's negative gradient) and adding
 * `learningRate * tree(x)` to the running prediction.
 */
export function trainGradientBoosting(
  rows: Record<string, string | number>[],
  categorical: string[],
  numeric: string[],
  y: number[],
  hyperparams: GradientBoostingHyperparams = DEFAULT_HYPERPARAMS,
): GradientBoostingModel {
  const categories = fitCategories(rows, categorical);
  const X = rows.map((row) => buildFeatureVector(categories, numeric, row));

  const init = y.reduce((sum, v) => sum + v, 0) / y.length;
  const predictions = new Array(y.length).fill(init);
  const trees: GradientBoostingModel["trees"] = [];

  for (let round = 0; round < hyperparams.nEstimators; round++) {
    const residuals = y.map((value, i) => value - predictions[i]);
    const tree = buildRegressionTree(X, residuals, hyperparams.maxDepth);
    trees.push(tree);

    for (let i = 0; i < y.length; i++) {
      predictions[i] += hyperparams.learningRate * evaluateTree(tree, X[i]);
    }
  }

  return {
    kind: "gradient_boosting",
    categories,
    numeric,
    learning_rate: hyperparams.learningRate,
    init,
    trees,
  };
}

function evaluateTree(tree: GradientBoostingModel["trees"][number], vector: number[]): number {
  let node = 0;
  while (tree.left[node] !== -1 || tree.right[node] !== -1) {
    node = vector[tree.feature[node]] <= tree.threshold[node] ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}
