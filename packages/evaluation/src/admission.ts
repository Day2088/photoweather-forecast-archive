import type { SourceProvenance } from '../../domain/src/index.ts';
import { EvaluationInputError, evaluationUtcMs, leadBucket, type LeadBucket } from './time.ts';

export interface ForecastArtifact {
  schemaVersion: 1;
  artifactId: string;
  rawFile: string;
  sha256: string;
  requestUrl: string;
  source: SourceProvenance;
  /** A capture log or reviewed publication record; a run timestamp alone is insufficient. */
  sourceEvidenceRef: string;
}
export interface ReplayWindow { asOfUtc: string; eventAtUtc: string }
export type AdmissionReason = 'invalid-window' | 'invalid-metadata' | 'hash-mismatch' |
  'non-operational' | 'time-order' | 'late-live-capture' | 'late-publication' | 'unproven-availability';
export type AdmissionResult =
  { admitted: true; availabilityUpperBoundUtc: string; leadHours: number; leadBucket: LeadBucket } |
  { admitted: false; reason: AdmissionReason };

const hashPattern = /^[a-f0-9]{64}$/;
function invalid(): never { throw new EvaluationInputError('预报档案元数据无效。'); }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some(key => !keys.includes(key))) invalid();
  return result;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 5000) return invalid();
  return value;
}
function nullableUtc(value: unknown): string | null {
  if (value === null) return null;
  evaluationUtcMs(value);
  return value as string;
}

/** Strict metadata parsing; file access and actual byte hashing belong to the offline loader. */
export function parseForecastArtifact(value: unknown): ForecastArtifact {
  const raw = object(value, ['schemaVersion', 'artifactId', 'rawFile', 'sha256', 'requestUrl', 'source', 'sourceEvidenceRef']);
  if (raw.schemaVersion !== 1 || typeof raw.sha256 !== 'string' || !hashPattern.test(raw.sha256)) invalid();
  const requestUrl = text(raw.requestUrl);
  let url: URL;
  try { url = new URL(requestUrl); } catch { return invalid(); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash ||
      [...url.searchParams.keys()].some(key => /key|token|secret|password/i.test(key))) invalid();
  const source = object(raw.source, ['id', 'provider', 'endpointId', 'model', 'kind', 'runInitializedAtUtc',
    'availableAtUtc', 'retrievedAtUtc', 'publicationEvidence', 'attribution']);
  if (!['operational-forecast', 'observation', 'hindcast', 'reanalysis'].includes(text(source.kind)) ||
      !['captured-live', 'verified-archive', 'estimated', 'unknown'].includes(text(source.publicationEvidence))) invalid();
  const runInitializedAtUtc = nullableUtc(source.runInitializedAtUtc);
  const availableAtUtc = nullableUtc(source.availableAtUtc);
  evaluationUtcMs(source.retrievedAtUtc);
  return {
    schemaVersion: 1, artifactId: text(raw.artifactId), rawFile: text(raw.rawFile), sha256: raw.sha256,
    requestUrl, sourceEvidenceRef: text(raw.sourceEvidenceRef),
    source: {
      id: text(source.id), provider: text(source.provider), endpointId: text(source.endpointId), model: text(source.model),
      kind: source.kind as SourceProvenance['kind'], runInitializedAtUtc, availableAtUtc,
      retrievedAtUtc: source.retrievedAtUtc as string,
      publicationEvidence: source.publicationEvidence as SourceProvenance['publicationEvidence'], attribution: text(source.attribution),
    },
  };
}

/** Pure policy. actualSha256 must be computed from the original file bytes by the caller. */
export function admitReplayInput(value: unknown, actualSha256: string, window: ReplayWindow): AdmissionResult {
  let asOf: number; let event: number;
  try { asOf = evaluationUtcMs(window.asOfUtc); event = evaluationUtcMs(window.eventAtUtc); }
  catch { return { admitted: false, reason: 'invalid-window' }; }
  if (asOf >= event) return { admitted: false, reason: 'invalid-window' };
  let artifact: ForecastArtifact;
  try { artifact = parseForecastArtifact(value); }
  catch { return { admitted: false, reason: 'invalid-metadata' }; }
  if (!hashPattern.test(actualSha256) || artifact.sha256 !== actualSha256) return { admitted: false, reason: 'hash-mismatch' };
  const { source } = artifact;
  if (source.kind !== 'operational-forecast') return { admitted: false, reason: 'non-operational' };
  const retrieved = evaluationUtcMs(source.retrievedAtUtc);
  const run = source.runInitializedAtUtc === null ? null : evaluationUtcMs(source.runInitializedAtUtc);
  const available = source.availableAtUtc === null ? null : evaluationUtcMs(source.availableAtUtc);
  if ((run !== null && (run > retrieved || run > asOf || (available !== null && run > available))) ||
      (available !== null && available > retrieved)) return { admitted: false, reason: 'time-order' };
  if (available !== null && available > asOf) return { admitted: false, reason: 'late-publication' };
  let availabilityUpperBoundUtc: string;
  if (source.publicationEvidence === 'captured-live') {
    if (retrieved > asOf) return { admitted: false, reason: 'late-live-capture' };
    availabilityUpperBoundUtc = source.retrievedAtUtc;
  } else if (source.publicationEvidence === 'verified-archive' && available !== null) {
    availabilityUpperBoundUtc = source.availableAtUtc!;
  } else return { admitted: false, reason: 'unproven-availability' };
  const leadHours = (event - asOf) / 3_600_000;
  return { admitted: true, availabilityUpperBoundUtc, leadHours, leadBucket: leadBucket(leadHours) };
}
