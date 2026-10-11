import { classificationRates, PUBLIC_MIN_EVENTS, type ClassificationRates, type ConfusionMatrix, type MetricRow } from './metrics.ts';
import { EvaluationInputError } from './time.ts';

/**
 * ADR-0010: the main-algorithm classification threshold, registered before any formal sample.
 * Changing the algorithm version or the threshold requires a new threshold version and a new registration.
 */
export const SCORE_THRESHOLD_REGISTRATION = Object.freeze({
  algorithmVersion: 'sunset-heuristic/0.1',
  thresholdVersion: 'sunset-threshold/0.1-fixed60',
  scoreThreshold: 60,
  sensitivityGrid: Object.freeze([20, 40, 60, 80]),
  registeredAtUtc: '2026-10-11T00:00:00Z',
});

export interface ThresholdSensitivityRow {
  threshold: number;
  /** Raw counts are always kept. */
  confusion: ConfusionMatrix;
  /** Rates are hidden (all null) when classifiable < PUBLIC_MIN_EVENTS, same rule as publicSummary. */
  rates: ClassificationRates;
  ratesVisible: boolean;
}
export interface ThresholdSensitivity {
  minimumEvents: number;
  counts: { rows: number; unknownLabels: number; knownLabels: number; classifiable: number; missingScore: number };
  thresholds: ThresholdSensitivityRow[];
  /** Reference table only. No threshold is ranked, selected or called optimal. */
  interpretation: 'preregistered-reference-grid-not-selection';
}

/** Observed outcome >= grade 2 is "occurred"; predicted occurs when score >= threshold (same rule as evaluateGroup). */
export function thresholdSensitivity(rows: readonly Pick<MetricRow, 'observedGrade' | 'score'>[], grid: readonly number[]): ThresholdSensitivity {
  if (!Array.isArray(grid) || grid.length < 1 || grid.length > 20 ||
      grid.some((v, i) => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 100 || (i > 0 && v <= grid[i - 1]!))) {
    throw new EvaluationInputError('敏感性阈值网格须为 1–20 个严格递增的 0–100 数值。');
  }
  const counts = { rows: rows.length, unknownLabels: 0, knownLabels: 0, classifiable: 0, missingScore: 0 };
  const known: { observed: 0 | 1; score: number | null }[] = [];
  for (const row of rows) {
    const g = row.observedGrade, s = row.score;
    if (g !== null && (typeof g !== 'number' || !Number.isInteger(g) || g < 0 || g > 4)) throw new EvaluationInputError('实况等级必须是 0–4 整数或 null。');
    if (s !== null && (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 100)) throw new EvaluationInputError('评测数值无效，不自动裁剪或将缺失值转成零。');
    if (g === null) { counts.unknownLabels++; continue; }
    counts.knownLabels++;
    if (s === null) counts.missingScore++; else counts.classifiable++;
    known.push({ observed: g >= 2 ? 1 : 0, score: s });
  }
  const visible = counts.classifiable >= PUBLIC_MIN_EVENTS;
  const thresholds = grid.map(threshold => {
    const confusion: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (const item of known) {
      if (item.score === null) continue;
      const predicted = item.score >= threshold;
      if (predicted) { if (item.observed) confusion.tp++; else confusion.fp++; }
      else if (item.observed) confusion.fn++; else confusion.tn++;
    }
    const rates = visible ? classificationRates(confusion)
      : { accuracy: null, precision: null, pod: null, fpr: null, far: null, missRate: null };
    return { threshold, confusion, rates, ratesVisible: visible };
  });
  return { minimumEvents: PUBLIC_MIN_EVENTS, counts, thresholds, interpretation: 'preregistered-reference-grid-not-selection' };
}
