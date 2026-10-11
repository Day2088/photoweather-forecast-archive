export class EvaluationInputError extends Error {
  constructor(message: string) { super(message); this.name = 'EvaluationInputError'; }
}

/** Canonical UTC only: reject offset timestamps, normalized invalid dates and leap seconds. */
export function evaluationUtcMs(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new EvaluationInputError('评测时间须为包含毫秒的 UTC ISO 字符串。');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value) {
    throw new EvaluationInputError('评测 UTC 时间无效。');
  }
  return ms;
}

export type LeadBucket = 'near' | 'same-day' | 'one-day' | 'three-day' | 'unbucketed';

/** Initial evaluation bins, not meteorological thresholds. Do not fill their gaps. */
export function leadBucket(hours: number): LeadBucket {
  if (!Number.isFinite(hours) || hours <= 0) throw new EvaluationInputError('预报提前量须为正数。');
  if (hours >= 1 && hours <= 2) return 'near';
  if (hours > 2 && hours <= 12) return 'same-day';
  if (hours >= 18 && hours <= 30) return 'one-day';
  if (hours >= 66 && hours <= 78) return 'three-day';
  return 'unbucketed';
}
