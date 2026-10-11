import { admitReplayInput, parseForecastArtifact, type ForecastArtifact } from './admission.ts';
import { splitEvents, type EvaluationEvent } from './split.ts';
import { EvaluationInputError, evaluationUtcMs, type LeadBucket } from './time.ts';

export const BASELINES_VERSION = '0.0.1';
type EventType = 'sunrise' | 'sunset';
interface SourceProfile { provider: string; endpointId: string; model: string }
export interface BaselineForecast {
  asOfUtc: string;
  /** Extracted from the admitted original response, not from another forecast or a later row. */
  totalCloudPct: number | null;
  artifact: ForecastArtifact;
  /** The offline loader computes this from actual original bytes. */
  actualSha256: string;
}
export interface BaselineEvent extends EvaluationEvent {
  siteId: string; eventType: EventType; season: string;
  label: { observedGrade: number | null; blind: boolean; guideVersion: string; labeledAtUtc: string };
  forecast: BaselineForecast;
}
export interface BaselineConfig {
  fitId: string; configurationVersion: string; datasetKind: 'observed' | 'synthetic';
  cutoffUtc: string; siteId: string; eventType: EventType; leadBucket: LeadBucket;
  sourceProfile: SourceProfile; labelingGuideVersion: string; labelingGuideFrozen: boolean;
  /** Pre-register these choices; the fitter never optimizes them on held-out outcomes. */
  cloudBinEdges: readonly number[];
  minimumCloudBinEvents: number; minimumSeasonEvents: number; minimumOverallEvents: number;
}
interface Frequency { n: number; occurrences: number; probability: number | null }
interface CloudBin extends Frequency { lower: number; upper: number; upperInclusive: boolean }
export interface BaselineFit {
  schemaVersion: 1; toolVersion: string; config: BaselineConfig;
  status: 'unfitted' | 'partially-fitted' | 'fitted-for-research';
  verification: 'not-assessed';
  training: {
    events: number; knownLabels: number; unknownLabels: number; missingCloudForKnownLabels: number;
    inputs: { eventId: string; weatherEpisodeId: string; eventAtUtc: string; asOfUtc: string;
      artifactId: string; rawSha256: string; labeledAtUtc: string }[];
  };
  baselineA: { method: 'total-cloud-bin-empirical-frequency'; bins: CloudBin[] };
  baselineB: { method: 'site-season-empirical-frequency'; overall: Frequency; seasons: (Frequency & { season: string })[] };
}
export interface BaselinePredictionInput {
  siteId: string; eventType: EventType; season: string; eventAtUtc: string; forecast: BaselineForecast;
}

function invalid(message: string): never { throw new EvaluationInputError(message); }
function id(value: unknown): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(value)) invalid('基线标识或版本无效。');
}
function cloud(value: unknown): void {
  if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100)) {
    invalid('总云量须为 0–100 或 null，不能裁剪或填零。');
  }
}
function configCheck(config: BaselineConfig): number {
  for (const value of [config.fitId, config.configurationVersion, config.siteId, config.labelingGuideVersion]) id(value);
  for (const value of Object.values(config.sourceProfile)) id(value);
  if (!config.sourceProfile.provider || !config.sourceProfile.endpointId || !config.sourceProfile.model ||
      !['observed', 'synthetic'].includes(config.datasetKind) || !['sunrise', 'sunset'].includes(config.eventType) ||
      !['near', 'same-day', 'one-day', 'three-day', 'unbucketed'].includes(config.leadBucket) || config.labelingGuideFrozen !== true) {
    invalid('基线范围须明确，并使用已冻结的标注规范。');
  }
  const edges = config.cloudBinEdges;
  if (!Array.isArray(edges) || edges.length < 2 || edges[0] !== 0 || edges.at(-1) !== 100) invalid('基线云量边界须递增并完整覆盖 0–100。');
  for (let i = 0; i < edges.length; i++) {
    if (!Number.isFinite(edges[i]) || (i > 0 && edges[i]! <= edges[i - 1]!)) invalid('基线云量边界须递增并完整覆盖 0–100。');
  }
  for (const n of [config.minimumCloudBinEvents, config.minimumSeasonEvents, config.minimumOverallEvents]) {
    if (!Number.isSafeInteger(n) || n < 1) invalid('基线最小样本数须显式提供正整数。');
  }
  return evaluationUtcMs(config.cutoffUtc);
}
function forecastCheck(forecast: BaselineForecast, eventAtUtc: string, config: BaselineConfig): ForecastArtifact {
  cloud(forecast.totalCloudPct);
  const result = admitReplayInput(forecast.artifact, forecast.actualSha256, { asOfUtc: forecast.asOfUtc, eventAtUtc });
  if (!result.admitted) invalid(`基线预报未准入：${result.reason}。`);
  if (result.leadBucket !== config.leadBucket) invalid('基线不可混合提前量桶。');
  const artifact = parseForecastArtifact(forecast.artifact);
  if (artifact.source.provider !== config.sourceProfile.provider || artifact.source.endpointId !== config.sourceProfile.endpointId ||
      artifact.source.model !== config.sourceProfile.model) invalid('基线预报来源 profile 不匹配。');
  return artifact;
}
function emptyFrequency(): Frequency { return { n: 0, occurrences: 0, probability: null }; }
function finishFrequency(value: Frequency, minimum: number): void {
  value.probability = value.n >= minimum ? value.occurrences / value.n : null;
}
function binFor(bins: readonly CloudBin[], value: number): CloudBin {
  const result = bins.find(bin => value >= bin.lower && (value < bin.upper || (bin.upperInclusive && value === bin.upper)));
  if (!result) return invalid('基线云量分箱无效。');
  return result;
}

/** Only training payloads are read. The complete event index enforces episode separation. */
export function fitTrainingBaselines(events: readonly BaselineEvent[], config: BaselineConfig): BaselineFit {
  const cutoff = configCheck(config);
  const { train } = splitEvents(events, config.cutoffUtc);
  const bins: CloudBin[] = config.cloudBinEdges.slice(0, -1).map((lower, i) => ({ ...emptyFrequency(), lower,
    upper: config.cloudBinEdges[i + 1]!, upperInclusive: i === config.cloudBinEdges.length - 2 }));
  const overall = emptyFrequency(); const seasons = new Map<string, Frequency>();
  const training: BaselineFit['training'] = { events: train.length, knownLabels: 0, unknownLabels: 0, missingCloudForKnownLabels: 0, inputs: [] };
  for (const event of train) {
    if (event.siteId !== config.siteId || event.eventType !== config.eventType) invalid('训练基线不可混合机位或朝霞/晚霞题材。');
    id(event.season);
    const label = event.label;
    if (label.blind !== true || label.guideVersion !== config.labelingGuideVersion) invalid('训练标签须为指定冻结规范下的盲评。');
    const labeledAt = evaluationUtcMs(label.labeledAtUtc);
    if (labeledAt < evaluationUtcMs(event.eventAtUtc) || labeledAt > cutoff) invalid('训练标签在拟合切点之前尚不可用或时序无效。');
    const grade = label.observedGrade;
    if (grade !== null && (!Number.isInteger(grade) || grade < 0 || grade > 4)) invalid('训练实况等级须为 0–4 整数或 null。');
    const artifact = forecastCheck(event.forecast, event.eventAtUtc, config);
    training.inputs.push({ eventId: event.eventId, weatherEpisodeId: event.weatherEpisodeId, eventAtUtc: event.eventAtUtc,
      asOfUtc: event.forecast.asOfUtc, artifactId: artifact.artifactId, rawSha256: event.forecast.actualSha256, labeledAtUtc: label.labeledAtUtc });
    if (grade === null) { training.unknownLabels++; continue; }
    training.knownLabels++;
    const occurred = grade >= 2 ? 1 : 0;
    overall.n++; overall.occurrences += occurred;
    const seasonal = seasons.get(event.season) ?? emptyFrequency();
    seasonal.n++; seasonal.occurrences += occurred; seasons.set(event.season, seasonal);
    if (event.forecast.totalCloudPct === null) { training.missingCloudForKnownLabels++; continue; }
    const bin = binFor(bins, event.forecast.totalCloudPct); bin.n++; bin.occurrences += occurred;
  }
  for (const bin of bins) finishFrequency(bin, config.minimumCloudBinEvents);
  finishFrequency(overall, config.minimumOverallEvents);
  const seasonRows = [...seasons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([season, frequency]) => {
    finishFrequency(frequency, config.minimumSeasonEvents); return { season, ...frequency };
  });
  const hasA = bins.some(bin => bin.probability !== null); const hasB = overall.probability !== null || seasonRows.some(row => row.probability !== null);
  return { schemaVersion: 1, toolVersion: BASELINES_VERSION,
    config: { ...config, sourceProfile: { ...config.sourceProfile }, cloudBinEdges: [...config.cloudBinEdges] },
    status: hasA && hasB ? 'fitted-for-research' : hasA || hasB ? 'partially-fitted' : 'unfitted', verification: 'not-assessed', training,
    baselineA: { method: 'total-cloud-bin-empirical-frequency', bins },
    baselineB: { method: 'site-season-empirical-frequency', overall, seasons: seasonRows } };
}

function frequencyCheck(value: Frequency, minimum: number): void {
  if (!Number.isSafeInteger(value.n) || value.n < 0 || !Number.isSafeInteger(value.occurrences) ||
      value.occurrences < 0 || value.occurrences > value.n ||
      value.probability !== (value.n >= minimum ? value.occurrences / value.n : null)) invalid('基线频率或分母无效。');
}
/** Structural validation is not a signature or original-byte integrity check of a stored fit. */
function fitCheck(fit: BaselineFit): number {
  const cutoff = configCheck(fit.config);
  if (fit.schemaVersion !== 1 || fit.toolVersion !== BASELINES_VERSION || fit.verification !== 'not-assessed' ||
      fit.baselineA.method !== 'total-cloud-bin-empirical-frequency' || fit.baselineB.method !== 'site-season-empirical-frequency' ||
      fit.baselineA.bins.length !== fit.config.cloudBinEdges.length - 1) invalid('基线产物版本或方法无效。');
  fit.baselineA.bins.forEach((bin, i) => {
    if (bin.lower !== fit.config.cloudBinEdges[i] || bin.upper !== fit.config.cloudBinEdges[i + 1] ||
        bin.upperInclusive !== (i === fit.baselineA.bins.length - 1)) invalid('基线产物分箱无效。');
    frequencyCheck(bin, fit.config.minimumCloudBinEvents);
  });
  frequencyCheck(fit.baselineB.overall, fit.config.minimumOverallEvents);
  const seen = new Set<string>();
  for (const value of fit.baselineB.seasons) {
    id(value.season); if (seen.has(value.season)) invalid('基线季节重复。'); seen.add(value.season);
    frequencyCheck(value, fit.config.minimumSeasonEvents);
  }
  const sum = fit.baselineB.seasons.reduce((result, row) => ({ n: result.n + row.n, occurrences: result.occurrences + row.occurrences }), { n: 0, occurrences: 0 });
  if (sum.n !== fit.baselineB.overall.n || sum.occurrences !== fit.baselineB.overall.occurrences) invalid('季节分母与整体不一致。');
  const training = fit.training;
  for (const value of [training.events, training.knownLabels, training.unknownLabels, training.missingCloudForKnownLabels]) {
    if (!Number.isSafeInteger(value) || value < 0) invalid('训练事件分母无效。');
  }
  const cloudSum = fit.baselineA.bins.reduce((result, row) => ({ n: result.n + row.n, occurrences: result.occurrences + row.occurrences }), { n: 0, occurrences: 0 });
  if (training.knownLabels + training.unknownLabels !== training.events || training.inputs.length !== training.events ||
      sum.n !== training.knownLabels || cloudSum.n + training.missingCloudForKnownLabels !== training.knownLabels ||
      cloudSum.occurrences > sum.occurrences || cloudSum.n - cloudSum.occurrences > sum.n - sum.occurrences) invalid('训练、云量与季节分母不一致。');
  const hasA = fit.baselineA.bins.some(bin => bin.probability !== null);
  const hasB = fit.baselineB.overall.probability !== null || fit.baselineB.seasons.some(row => row.probability !== null);
  if (fit.status !== (hasA && hasB ? 'fitted-for-research' : hasA || hasB ? 'partially-fitted' : 'unfitted')) invalid('基线拟合状态与样本支持不一致。');
  const eventIds = new Set<string>();
  for (const input of training.inputs) {
    for (const value of [input.eventId, input.weatherEpisodeId, input.artifactId]) id(value);
    const eventAt = evaluationUtcMs(input.eventAtUtc); const labeledAt = evaluationUtcMs(input.labeledAtUtc);
    if (eventIds.has(input.eventId) || eventAt >= cutoff || evaluationUtcMs(input.asOfUtc) >= eventAt ||
        labeledAt < eventAt || labeledAt > cutoff || !/^[a-f0-9]{64}$/.test(input.rawSha256)) invalid('训练输入引用或时序无效。');
    eventIds.add(input.eventId);
  }
  return cutoff;
}

/** Post-fit inference never consumes an observed outcome, nor uses a fit created after asOf. */
export function predictTrainingBaselines(fit: BaselineFit, input: BaselinePredictionInput) {
  const cutoff = fitCheck(fit);
  if (input.siteId !== fit.config.siteId || input.eventType !== fit.config.eventType) invalid('预测机位或题材与训练基线不一致。');
  id(input.season);
  if (evaluationUtcMs(input.eventAtUtc) < cutoff || evaluationUtcMs(input.forecast.asOfUtc) < cutoff) {
    invalid('决策早于基线拟合切点，不能使用后来拟合的资料。');
  }
  forecastCheck(input.forecast, input.eventAtUtc, fit.config);
  const bin = input.forecast.totalCloudPct === null ? null : binFor(fit.baselineA.bins, input.forecast.totalCloudPct);
  const seasonal = fit.baselineB.seasons.find(row => row.season === input.season);
  const selected = seasonal && seasonal.probability !== null ? seasonal : fit.baselineB.overall;
  return { fitId: fit.config.fitId, datasetKind: fit.config.datasetKind, verification: 'not-assessed' as const,
    versions: { baselineAVersion: `${fit.config.fitId}/A`, baselineBVersion: `${fit.config.fitId}/B` },
    baselineA: { probability: bin?.probability ?? null, trainingEvents: bin?.n ?? 0, occurrences: bin?.occurrences ?? 0,
      reason: bin === null ? 'missing-total-cloud' : bin.probability === null ? 'insufficient-bin-events' : 'total-cloud-bin-frequency' },
    baselineB: { probability: selected.probability, trainingEvents: selected.n, occurrences: selected.occurrences,
      reason: selected.probability === null ? 'insufficient-training-events' : selected === seasonal ? 'same-site-season-frequency' : 'same-site-overall-fallback',
      interpretation: 'empirical-training-frequency-not-multiyear-climatology' as const } };
}
