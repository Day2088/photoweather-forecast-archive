import { EvaluationInputError, evaluationUtcMs, leadBucket, type LeadBucket } from './time.ts';

export const PUBLIC_MIN_EVENTS = 30;
export interface MetricRow {
  eventId: string; weatherEpisodeId: string; eventAtUtc: string; asOfUtc: string;
  observedGrade: number | null;
  score: number | null;
  probability: number | null;
  baselineAProbability: number | null;
  baselineBProbability: number | null;
}
/** Versions refer to training-locked artifacts, not a claim of verified calibration. */
export interface MetricConfig {
  scoreThreshold: number | null;
  thresholdVersion: string | null;
  calibrationVersion: string | null;
  baselineAVersion: string | null;
  baselineBVersion: string | null;
}
export interface ConfusionMatrix { tp: number; fp: number; fn: number; tn: number }
export interface ClassificationRates {
  accuracy: number | null; precision: number | null; pod: number | null;
  fpr: number | null; far: number | null; missRate: number | null;
}
export interface ReliabilityBin {
  lower: number; upper: number; upperInclusive: boolean;
  n: number; meanProbability: number | null; observedFrequency: number | null;
}
const noRates = (): ClassificationRates => ({ accuracy: null, precision: null, pod: null, fpr: null, far: null, missRate: null });
const ratio = (n: number, d: number): number | null => d === 0 ? null : n / d;
function numberOrNull(value: unknown, max: number): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max)) {
    throw new EvaluationInputError('评测数值无效，不自动裁剪或将缺失值转成零。');
  }
}
function version(value: unknown): void {
  if (value !== null && (typeof value !== 'string' || !value.trim())) throw new EvaluationInputError('评测版本无效。');
}
export function classificationRates(matrix: ConfusionMatrix): ClassificationRates {
  for (const value of [matrix.tp, matrix.fp, matrix.fn, matrix.tn]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new EvaluationInputError('混淆矩阵必须是非负整数。');
  }
  const { tp, fp, fn, tn } = matrix;
  if (!Number.isSafeInteger(tp + fp + fn + tn)) throw new EvaluationInputError('混淆矩阵总数超出精确整数范围。');
  return { accuracy: ratio(tp + tn, tp + fp + fn + tn), precision: ratio(tp, tp + fp),
    pod: ratio(tp, tp + fn), fpr: ratio(fp, fp + tn), far: ratio(fp, tp + fp), missRate: ratio(fn, tp + fn) };
}
export function brierScore(pairs: readonly { probability: number; observed: 0 | 1 }[]): number | null {
  let sum = 0;
  for (const pair of pairs) {
    numberOrNull(pair.probability, 1);
    if (pair.probability === null || (pair.observed !== 0 && pair.observed !== 1)) throw new EvaluationInputError('Brier 输入无效。');
    sum += (pair.probability - pair.observed) ** 2;
  }
  return ratio(sum, pairs.length);
}
export function brierSkillScore(model: number | null, baseline: number | null): number | null {
  numberOrNull(model, 1); numberOrNull(baseline, 1);
  if (model === null || baseline === null || baseline === 0) return null;
  const skill = 1 - model / baseline;
  return Number.isFinite(skill) ? skill : null;
}

/** At most 5 fixed equal-width bins; p=1 belongs to the last bin. */
export function reliabilityBins(pairs: readonly { probability: number; observed: 0 | 1 }[], binCount = 5): ReliabilityBin[] {
  if (!Number.isInteger(binCount) || binCount < 1 || binCount > 5) throw new EvaluationInputError('可靠性分箱数量须为 1–5。');
  brierScore(pairs); // shared probability and outcome validation
  const bins = Array.from({ length: binCount }, (_, i) => ({ n: 0, sum: 0, observed: 0,
    lower: i / binCount, upper: (i + 1) / binCount, upperInclusive: i === binCount - 1 }));
  for (const pair of pairs) {
    const bin = bins[Math.min(binCount - 1, Math.floor(pair.probability * binCount))]!;
    bin.n++; bin.sum += pair.probability; bin.observed += pair.observed;
  }
  return bins.map(bin => ({ lower: bin.lower, upper: bin.upper, upperInclusive: bin.upperInclusive, n: bin.n,
    meanProbability: ratio(bin.sum, bin.n), observedFrequency: ratio(bin.observed, bin.n) }));
}

/** Arithmetic on already admitted rows, one lead bucket at a time. No probability mapping is fitted here. */
export function evaluateGroup(rows: readonly MetricRow[], config: MetricConfig, bucket: LeadBucket) {
  if (!['near', 'same-day', 'one-day', 'three-day', 'unbucketed'].includes(bucket)) throw new EvaluationInputError('提前量分组无效。');
  numberOrNull(config.scoreThreshold, 100);
  for (const v of [config.thresholdVersion, config.calibrationVersion, config.baselineAVersion, config.baselineBVersion]) version(v);
  if ((config.scoreThreshold === null) !== (config.thresholdVersion === null)) throw new EvaluationInputError('评分阈值和冻结版本须同时提供或为空。');
  const confusion: ConfusionMatrix = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const counts = { rows: rows.length, unknownLabels: 0, knownLabels: 0, classifiable: 0,
    missingScore: 0, probabilistic: 0, missingProbability: 0, paired: 0, missingBaselineA: 0, missingBaselineB: 0 };
  const seen = new Set<string>();
  const pairs: { probability: number; observed: 0 | 1 }[] = [];
  const pairedModel: typeof pairs = []; const pairedA: typeof pairs = []; const pairedB: typeof pairs = [];
  for (const row of rows) {
    if (!row.eventId?.trim() || !row.weatherEpisodeId?.trim()) throw new EvaluationInputError('指标事件 ID 无效。');
    if (seen.has(row.eventId)) throw new EvaluationInputError('同事件重复，不能混合不同朝向或提前量计数。');
    seen.add(row.eventId);
    const hours = (evaluationUtcMs(row.eventAtUtc) - evaluationUtcMs(row.asOfUtc)) / 3_600_000;
    if (leadBucket(hours) !== bucket) throw new EvaluationInputError('不能将不同提前量桶合并成独立样本。');
    numberOrNull(row.observedGrade, 4);
    if (row.observedGrade !== null && !Number.isInteger(row.observedGrade)) throw new EvaluationInputError('实况等级必须是 0–4 整数或 null。');
    numberOrNull(row.score, 100);
    for (const p of [row.probability, row.baselineAProbability, row.baselineBProbability]) numberOrNull(p, 1);
    if ((row.probability !== null && config.calibrationVersion === null) ||
        (row.baselineAProbability !== null && config.baselineAVersion === null) ||
        (row.baselineBProbability !== null && config.baselineBVersion === null)) throw new EvaluationInputError('概率必须附冻结的校准/基线版本；不能直接使用 score/100。');
    if (row.observedGrade === null) { counts.unknownLabels++; continue; }
    counts.knownLabels++;
    const observed: 0 | 1 = row.observedGrade >= 2 ? 1 : 0;
    if (row.score === null) counts.missingScore++;
    else if (config.scoreThreshold !== null) {
      counts.classifiable++;
      const predicted = row.score >= config.scoreThreshold;
      if (predicted) { if (observed) confusion.tp++; else confusion.fp++; }
      else { if (observed) confusion.fn++; else confusion.tn++; }
    }
    if (row.probability === null) counts.missingProbability++;
    else { counts.probabilistic++; pairs.push({ probability: row.probability, observed }); }
    if (row.baselineAProbability === null) counts.missingBaselineA++;
    if (row.baselineBProbability === null) counts.missingBaselineB++;
    if (row.probability !== null && row.baselineAProbability !== null && row.baselineBProbability !== null) {
      counts.paired++;
      pairedModel.push({ probability: row.probability, observed });
      pairedA.push({ probability: row.baselineAProbability, observed });
      pairedB.push({ probability: row.baselineBProbability, observed });
    }
  }
  const rates = classificationRates(confusion);
  const brier = brierScore(pairs);
  const pairedBrier = { model: brierScore(pairedModel), baselineA: brierScore(pairedA), baselineB: brierScore(pairedB) };
  const skillScores = { baselineA: brierSkillScore(pairedBrier.model, pairedBrier.baselineA),
    baselineB: brierSkillScore(pairedBrier.model, pairedBrier.baselineB) };
  const reliability = reliabilityBins(pairs);
  return {
    leadBucket: bucket, counts, confusion, config: { ...config },
    research: { classification: rates, brier, pairedBrier, skillScores, reliability },
    publicSummary: {
      minimumEvents: PUBLIC_MIN_EVENTS,
      status: counts.classifiable < PUBLIC_MIN_EVENTS && counts.probabilistic < PUBLIC_MIN_EVENTS ? 'insufficient-data' : 'metrics-available',
      classification: counts.classifiable >= PUBLIC_MIN_EVENTS ? rates : noRates(),
      brier: counts.probabilistic >= PUBLIC_MIN_EVENTS ? brier : null,
      skillScores: counts.paired >= PUBLIC_MIN_EVENTS ? skillScores : { baselineA: null, baselineB: null },
      reliability: counts.probabilistic >= PUBLIC_MIN_EVENTS ? reliability : [],
      /** Statistical intervals and release evidence are evaluated separately. */
      baselineAdvantage: 'not-assessed',
    },
  };
}
