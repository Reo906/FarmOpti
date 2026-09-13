/**
 * A from-scratch CART regression tree, built to match scikit-learn's
 * DecisionTreeRegressor under the exact configuration GradientBoostingRegressor
 * uses internally (squared-error impurity, min_samples_split=2,
 * min_samples_leaf=1, max_features=None -- i.e. no randomness anywhere: every
 * feature and every row is considered at every split). Under that
 * configuration `random_state` has no effect on sklearn's own fit either,
 * since nothing in it samples rows or features -- so an exact-greedy search
 * here is the right reproduction, not an approximation.
 *
 * Exported node shape matches lib/optimizer/calibration/types.ts's
 * GradientBoostingModel.trees[number] exactly: parallel `feature`/
 * `threshold`/`left`/`right`/`value` arrays, root at index 0, `left[node]
 * === -1 && right[node] === -1` marking a leaf (see predict.ts).
 */

export interface TreeExport {
  feature: number[];
  threshold: number[];
  left: number[];
  right: number[];
  value: number[];
}

interface Split {
  feature: number;
  threshold: number;
  leftRows: number[];
  rightRows: number[];
}

function mean(values: number[], rows: number[]): number {
  let sum = 0;
  for (const i of rows) sum += values[i];
  return rows.length > 0 ? sum / rows.length : 0;
}

/**
 * Exact-greedy best split across every feature and every candidate threshold,
 * scored by total post-split sum-of-squared-errors (lower is better). Ties
 * keep the first-encountered split (lowest feature index, then lowest
 * threshold), matching a left-to-right, top-to-bottom exhaustive scan.
 */
function bestSplit(X: number[][], y: number[], rows: number[], numFeatures: number): Split | null {
  const n = rows.length;
  if (n < 2) return null;

  let totalSum = 0;
  let totalSumSq = 0;
  for (const i of rows) {
    totalSum += y[i];
    totalSumSq += y[i] * y[i];
  }

  let best: { score: number; feature: number; threshold: number; order: number[]; splitAt: number } | null = null;
  const EPS = 1e-12;

  for (let f = 0; f < numFeatures; f++) {
    const order = [...rows].sort((a, b) => X[a][f] - X[b][f]);

    let leftSum = 0;
    let leftSumSq = 0;

    for (let p = 1; p < n; p++) {
      const i = order[p - 1];
      leftSum += y[i];
      leftSumSq += y[i] * y[i];

      // Never split between two rows with an identical feature value --
      // there is no threshold that actually separates them.
      if (X[order[p - 1]][f] === X[order[p]][f]) continue;

      const leftN = p;
      const rightN = n - p;
      const rightSum = totalSum - leftSum;
      const rightSumSq = totalSumSq - leftSumSq;
      const leftSse = leftSumSq - (leftSum * leftSum) / leftN;
      const rightSse = rightSumSq - (rightSum * rightSum) / rightN;
      const score = leftSse + rightSse;

      if (best === null || score < best.score - EPS) {
        const threshold = (X[order[p - 1]][f] + X[order[p]][f]) / 2;
        best = { score, feature: f, threshold, order, splitAt: p };
      }
    }
  }

  if (best === null) return null;

  return {
    feature: best.feature,
    threshold: best.threshold,
    leftRows: best.order.slice(0, best.splitAt),
    rightRows: best.order.slice(best.splitAt),
  };
}

export function buildRegressionTree(X: number[][], y: number[], maxDepth: number): TreeExport {
  const numFeatures = X.length > 0 ? X[0].length : 0;
  const tree: TreeExport = { feature: [], threshold: [], left: [], right: [], value: [] };

  function build(rows: number[], depth: number): number {
    const index = tree.feature.length;
    tree.feature.push(-2);
    tree.threshold.push(-2);
    tree.left.push(-1);
    tree.right.push(-1);
    tree.value.push(mean(y, rows));

    if (depth >= maxDepth) return index;

    const split = bestSplit(X, y, rows, numFeatures);
    if (!split) return index;

    const leftIndex = build(split.leftRows, depth + 1);
    const rightIndex = build(split.rightRows, depth + 1);

    tree.feature[index] = split.feature;
    tree.threshold[index] = split.threshold;
    tree.left[index] = leftIndex;
    tree.right[index] = rightIndex;

    return index;
  }

  build(
    Array.from({ length: y.length }, (_, i) => i),
    0,
  );

  return tree;
}
