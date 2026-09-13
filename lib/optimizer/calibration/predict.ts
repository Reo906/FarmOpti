import type { ConstantModel, GradientBoostingModel, ResidualPredictor } from "./types";

function oneHotVector(model: GradientBoostingModel, features: Record<string, string | number>): number[] {
  const vector: number[] = [];
  for (const [name, categories] of Object.entries(model.categories)) {
    const raw = String(features[name] ?? "");
    for (const category of categories) {
      vector.push(raw === category ? 1 : 0);
    }
  }
  for (const name of model.numeric) {
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
  const vector = oneHotVector(gb, features);
  let prediction = gb.init;
  for (const tree of gb.trees) {
    prediction += gb.learning_rate * treeValue(tree, vector);
  }
  return prediction;
}