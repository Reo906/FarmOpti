import type { ConstantModel, GradientBoostingModel, ResidualPredictor } from "./types";

/**
 * Builds the same flat feature vector shape used at training time: one 0/1
 * column per (categorical feature, category) pair -- in the order the
 * categories were recorded -- followed by the numeric columns in order.
 * Shared between training and inference so a model's `feature` indices
 * always mean the same thing on both sides.
 */
export function buildFeatureVector(
  categories: Record<string, string[]>,
  numeric: string[],
  features: Record<string, string | number>,
): number[] {
  const vector: number[] = [];
  for (const [name, values] of Object.entries(categories)) {
    const raw = String(features[name] ?? "");
    for (const category of values) {
      vector.push(raw === category ? 1 : 0);
    }
  }
  for (const name of numeric) {
    const value = Number(features[name]);
    vector.push(Number.isFinite(value) ? value : 0);
  }
  return vector;
}

function treeValue(tree: GradientBoostingModel["trees"][number], vector: number[]): number {
  let node = 0;
  while (tree.left[node] !== -1 || tree.right[node] !== -1) {
    const feature = tree.feature[node];
    const threshold = tree.threshold[node];
    node = vector[feature] <= threshold ? tree.left[node] : tree.right[node];
  }
  return tree.value[node];
}

export function predictResidual(model: ResidualPredictor | null | undefined, features: Record<string, string | number>): number {
  if (!model) return 0;
  if (model.kind === "constant") return (model as ConstantModel).value;

  const gb = model as GradientBoostingModel;
  const vector = buildFeatureVector(gb.categories, gb.numeric, features);
  let prediction = gb.init;
  for (const tree of gb.trees) {
    prediction += gb.learning_rate * treeValue(tree, vector);
  }
  return prediction;
}
