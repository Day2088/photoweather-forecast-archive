import { evaluationUtcMs } from './time.ts';

/**
 * 完整标注记录（labelRecordRef 指向的文件）。规则全部来自 eval/labeling-guide.md（草案 v0.1）。
 * 阈值是「项目初值，非公认标准」（指南 L3、L40）。记录中不含坐标、预测分数、等级预测或概率。
 */
export class LabelRecordError extends Error {
  constructor(message: string) { super(message); this.name = 'LabelRecordError'; }
}

export type AreaLevel = 0 | 1 | 2 | 3 | 4;
export type IntensityLevel = 0 | 1 | 2 | 3;
export type Grade = 0 | 1 | 2 | 3 | 4;
/** 取自指南 L58 的 source 字段。 */
export const LABEL_SOURCES = ['developer', 'volunteer', 'webcam', 'user-feedback'] as const;
export type LabelSource = typeof LABEL_SOURCES[number];
export interface LabelRights { kind: 'self-owned' | 'licensed' | 'internal-only'; ref: string }
export type EvidenceKind = 'photo' | 'video' | 'timelapse';
export type EvidenceRole = 'peak' | 'sequence' | 'reference';
export type DominantHue = 'orange' | 'red' | 'pink-purple' | 'mixed';
/** 取自指南 L46「证据不足不能算无」所列情形。 */
export const UNKNOWN_REASONS = ['single-photo-only', 'sequence-missing', 'lens-fogged', 'exposure-error', 'view-obstructed', 'unobserved-period'] as const;
export type UnknownReason = typeof UNKNOWN_REASONS[number];

export interface LabelMeasures {
  /** 指南 L15-23：A=霞光云体占有效天空 ROI 的可信峰值比例（%）；level 为映射档位。 */
  area: { peakPercent: number | null; level: AreaLevel | null };
  /** 指南 L25-30：I 直接为 0–3 分级。dominantHue 见指南 L42。 */
  intensity: { level: IntensityLevel | null; dominantHue: DominantHue | null };
  /** 指南 L32-38：D=颜色达到 I≥1 的持续秒数；capLevel 为允许的最高等级。 */
  duration: { seconds: number | null; capLevel: Grade | null };
}

export interface LabelEvidence {
  kind: EvidenceKind; sha256: string; capturedAtUtc: string | null; fileName: string; role?: EvidenceRole;
}
export interface LabelObservation {
  startUtc: string; endUtc: string;
  trueNorthAzimuthDeg: number | null; azimuthNullReason: string | null;
  horizontalFovDeg: number | null; horizonNote: string; cameraNote: string;
}
export interface LabelRecord {
  schemaVersion: 1; labelingGuideVersion: string; purpose: 'trial' | 'formal';
  eventId: string; siteId: string; eventType: 'sunrise' | 'sunset'; eventAtUtc: string;
  observation: LabelObservation; evidence: LabelEvidence[]; measures: LabelMeasures;
  grade: Grade | null; unknownReason: UnknownReason | null; source: LabelSource; rights: LabelRights;
  labelerId: string; labeledAtUtc: string; blind: boolean; sawForecastBeforeLabel: boolean;
  decidedToShootWithoutForecast: boolean; notes: string;
}

/** 与 eval/replay/audit.mjs 的 idPattern 相同。 */
export const ID_PATTERN = /^[a-zA-Z0-9_.:/-]{1,160}$/;
const PAIR = /(-?\d{1,3}\.\d{2,})\s*[,，;；/\s]\s*(-?\d{1,3}\.\d{2,})/g;
const HEMISPHERE = [/[北南]纬\s*\d/, /[东西]经\s*\d/, /\b[NSEW]\s*-?\d{1,3}\.\d+/, /\d{1,3}\.\d+\s*°?\s*[NSEW](?![A-Za-z])/];
const DMS = [/\d{1,3}\s*°\s*\d{1,2}\s*[′'’]/, /\d{1,2}\s*[′'’]\s*\d{1,2}(?:\.\d+)?\s*[″"”]/];
/** 判断文本是否像经纬度：数字对（量级像纬度/经度）、带半球标记的十进制数、度分秒。 */
export function looksLikeCoordinate(text: string): boolean {
  for (const m of text.matchAll(PAIR)) {
    const a = Math.abs(Number(m[1])); const b = Math.abs(Number(m[2]));
    if ((a <= 90 && b <= 180) || (b <= 90 && a <= 180)) return true;
  }
  return HEMISPHERE.some(r => r.test(text)) || DMS.some(r => r.test(text));
}
const COORDINATE_PAIR = { test: looksLikeCoordinate };

/** 指南 L17-23 面积档位；边界：1%、10%、30%、60% 归入较高档。 */
export function areaLevelFromPercent(percent: number): AreaLevel {
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new LabelRecordError('面积比例须在 0–100 之间。');
  if (percent < 1) return 0;
  if (percent < 10) return 1;
  if (percent < 30) return 2;
  if (percent < 60) return 3;
  return 4;
}
/** 指南 L27-30：强度允许的最高等级。 */
export function intensityCap(level: IntensityLevel): Grade {
  return ([0, 2, 3, 4] as const)[level];
}
/** 指南 L34-38：持续时间允许的最高等级。0 秒视为确认无霞光。 */
export function durationCap(seconds: number): Grade {
  if (!Number.isFinite(seconds) || seconds < 0) throw new LabelRecordError('持续时间须为非负秒数。');
  if (seconds <= 0) return 0;
  if (seconds < 30) return 1;
  if (seconds < 120) return 2;
  if (seconds < 300) return 3;
  return 4;
}
/**
 * 指南 L40：最终等级 = min(面积等级, 强度上限, 持续上限)；任何一项未判定则为 null（指南 L46）。
 * 待试标确认的歧义：A=0（L19「没有可确认霞光云体」）而 I 或 D 为 null 时，是否可直接判 0？
 * 指南 L46 要求证据不足不能算无，故此处保守返回 null，不自行补全规则。
 */
export function computeGrade(measures: LabelMeasures): Grade | null {
  const a = measures.area.level; const i = measures.intensity.level; const d = measures.duration.capLevel;
  if (a === null || i === null || d === null) return null;
  return Math.min(a, intensityCap(i), d) as Grade;
}

function fail(message: string): never { throw new LabelRecordError(message); }
function obj(value: unknown, allowed: readonly string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} 须为对象。`);
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(`${name} 含未知字段：${key.slice(0, 40)}。`);
  for (const key of allowed) if (!(key in record) && !(name === '证据' && key === 'role')) fail(`${name} 缺少字段：${key}。`);
  return record;
}
function oneOf<T extends string>(value: unknown, set: readonly T[], name: string): T {
  if (typeof value !== 'string' || !(set as readonly string[]).includes(value)) fail(`${name} 取值无效。`);
  return value as T;
}
function str(value: unknown, name: string, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim())) fail(`${name} 须为不超过 ${max} 字符的文本。`);
  if (COORDINATE_PAIR.test(value as string)) fail(`${name} 疑似包含坐标，已拒绝。`);
  return value as string;
}
function idOf(value: unknown, name: string): string {
  if (typeof value !== 'string' || !ID_PATTERN.test(value)) fail(`${name} 须匹配 ${ID_PATTERN.source}。`);
  if (looksLikeCoordinate(value)) fail(`${name} 疑似包含坐标，已拒绝。`);
  return value as string;
}
function utc(value: unknown, name: string): number {
  try { return evaluationUtcMs(value); } catch { return fail(`${name} 须为含毫秒的 UTC ISO 时间。`); }
}
function bool(value: unknown, name: string): boolean { if (typeof value !== 'boolean') fail(`${name} 须为布尔值。`); return value as boolean; }
function nullableNumber(value: unknown, name: string, min: number, max: number): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${name} 须为 ${min}–${max} 的数字或 null。`);
  return value as number;
}
function nullableInt<T extends number>(value: unknown, name: string, max: number): T | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) fail(`${name} 须为 0–${max} 的整数或 null。`);
  return value as T;
}
function fileName(value: unknown): string {
  const name = str(value, '文件名', 255);
  if (/[\\/:\x00-\x1f]/.test(name) || name === '.' || name === '..') fail('文件名只能是文件名本身，不得含路径分隔符或盘符。');
  if (/[. ]$/.test(name) || /^\s/.test(name)) fail('文件名不得以点或空格结尾，或以空白开头。');
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name.split('.')[0]!)) fail('文件名不得使用 Windows 保留名。');
  return name;
}

/** 证据文件名规则（供本机标注工具复用）：纯文件名，不含路径分隔、盘符、保留名。 */
export function validateEvidenceFileName(value: unknown): string { return fileName(value); }

/** 严格校验；错误信息为中文且不回显 notes。 */
export function validateLabelRecord(json: unknown): LabelRecord {
  const r = obj(json, ['schemaVersion', 'labelingGuideVersion', 'purpose', 'eventId', 'siteId', 'eventType', 'eventAtUtc', 'observation', 'evidence',
    'measures', 'grade', 'unknownReason', 'source', 'rights', 'labelerId', 'labeledAtUtc', 'blind', 'sawForecastBeforeLabel', 'decidedToShootWithoutForecast', 'notes'], '标注记录');
  if (r.schemaVersion !== 1) fail('schemaVersion 须为 1。');
  const eventAt = utc(r.eventAtUtc, 'eventAtUtc'); const labeledAt = utc(r.labeledAtUtc, 'labeledAtUtc');
  if (labeledAt < eventAt) fail('labeledAtUtc 不得早于 eventAtUtc。');

  const o = obj(r.observation, ['startUtc', 'endUtc', 'trueNorthAzimuthDeg', 'azimuthNullReason', 'horizontalFovDeg', 'horizonNote', 'cameraNote'], '观测范围');
  const startMs = utc(o.startUtc, 'observation.startUtc'); const endMs = utc(o.endUtc, 'observation.endUtc');
  if (startMs > endMs) fail('observation.startUtc 不得晚于 endUtc。');
  if (eventAt < startMs || eventAt > endMs) fail('eventAtUtc 须在观测窗口内。');
  if (labeledAt < endMs) fail('labeledAtUtc 不得早于观测结束时间。');
  const azimuth = nullableNumber(o.trueNorthAzimuthDeg, '真北方位', 0, 360);
  const azimuthReason = o.azimuthNullReason === null ? null : str(o.azimuthNullReason, '方位缺失原因', 500);
  if (azimuth === null && azimuthReason === null) fail('方位为 null 时须说明原因。');
  if (azimuth !== null && azimuthReason !== null) fail('方位已填写时不应有缺失原因。');
  const observation: LabelObservation = { startUtc: o.startUtc as string, endUtc: o.endUtc as string, trueNorthAzimuthDeg: azimuth, azimuthNullReason: azimuthReason,
    horizontalFovDeg: nullableNumber(o.horizontalFovDeg, '水平视场角', 0, 360), horizonNote: str(o.horizonNote, '地平线说明', 500, true), cameraNote: str(o.cameraNote, '相机说明', 500, true) };

  if (!Array.isArray(r.evidence) || r.evidence.length < 1 || r.evidence.length > 1000) fail('evidence 须至少包含 1 条证据。');
  const seen = new Set<string>();
  const evidence = (r.evidence as unknown[]).map((item): LabelEvidence => {
    const e = obj(item, ['kind', 'sha256', 'capturedAtUtc', 'fileName', 'role'], '证据');
    if (typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) fail('证据 sha256 须为 64 位小写十六进制。');
    if (seen.has(e.sha256 as string)) fail('证据 sha256 重复。'); seen.add(e.sha256 as string);
    if (e.capturedAtUtc !== null) {
      const t = utc(e.capturedAtUtc, '证据拍摄时间');
      if (t < startMs || t > endMs) fail('证据拍摄时间须在观测窗口内。');
    }
    const out: LabelEvidence = { kind: oneOf(e.kind, ['photo', 'video', 'timelapse'], '证据类型'), sha256: e.sha256 as string,
      capturedAtUtc: e.capturedAtUtc as string | null, fileName: fileName(e.fileName) };
    if (e.role !== undefined) out.role = oneOf(e.role, ['peak', 'sequence', 'reference'], '证据角色');
    return out;
  });

  const m = obj(r.measures, ['area', 'intensity', 'duration'], '分级测量');
  const a = obj(m.area, ['peakPercent', 'level'], '面积');
  const i = obj(m.intensity, ['level', 'dominantHue'], '强度');
  const d = obj(m.duration, ['seconds', 'capLevel'], '持续时间');
  const peak = nullableNumber(a.peakPercent, '面积比例', 0, 100);
  const areaLevel = nullableInt<AreaLevel>(a.level, '面积档位', 4);
  if ((peak === null) !== (areaLevel === null)) fail('面积比例与面积档位须同时填写或同时为 null。');
  if (peak !== null && areaLevel !== areaLevelFromPercent(peak)) fail('面积档位与面积比例按指南映射不一致。');
  const intensityLevel = nullableInt<IntensityLevel>(i.level, '强度 I', 3);
  const hue = i.dominantHue === null ? null : oneOf(i.dominantHue, ['orange', 'red', 'pink-purple', 'mixed'], '主色相');
  const seconds = nullableNumber(d.seconds, '持续秒数', 0, 86_400);
  const capLevel = nullableInt<Grade>(d.capLevel, '持续时间上限', 4);
  if ((seconds === null) !== (capLevel === null)) fail('持续秒数与持续上限须同时填写或同时为 null。');
  if (seconds !== null && capLevel !== durationCap(seconds)) fail('持续时间上限与秒数按指南映射不一致。');
  const measures: LabelMeasures = { area: { peakPercent: peak, level: areaLevel }, intensity: { level: intensityLevel, dominantHue: hue }, duration: { seconds, capLevel } };

  const expected = computeGrade(measures);
  const grade = nullableInt<Grade>(r.grade, '等级', 4);
  if (grade !== expected) fail('等级与按指南规则（三者取最小）计算的结果不一致。');
  const unknownReason = r.unknownReason === null ? null : oneOf(r.unknownReason, UNKNOWN_REASONS, '未判定原因');
  if (grade === null && unknownReason === null) fail('等级为 null 时须给出未判定原因。');
  if (grade !== null && unknownReason !== null) fail('等级已判定时不得有未判定原因。');

  const source = oneOf(r.source, LABEL_SOURCES, 'source');
  const rt = obj(r.rights, ['kind', 'ref'], '权利');
  const rights: LabelRights = { kind: oneOf(rt.kind, ['self-owned', 'licensed', 'internal-only'], '权利类型'), ref: str(rt.ref, '权利引用', 500) };
  const blind = bool(r.blind, 'blind'); const saw = bool(r.sawForecastBeforeLabel, 'sawForecastBeforeLabel');
  if (blind === saw) fail('blind 须与 sawForecastBeforeLabel 相反。');
  return {
    schemaVersion: 1, labelingGuideVersion: idOf(r.labelingGuideVersion, 'labelingGuideVersion'), purpose: oneOf(r.purpose, ['trial', 'formal'], 'purpose'),
    eventId: idOf(r.eventId, 'eventId'), siteId: idOf(r.siteId, 'siteId'), eventType: oneOf(r.eventType, ['sunrise', 'sunset'], 'eventType'), eventAtUtc: r.eventAtUtc as string,
    observation, evidence, measures, grade, unknownReason, source, rights, labelerId: idOf(r.labelerId, 'labelerId'), labeledAtUtc: r.labeledAtUtc as string, blind,
    sawForecastBeforeLabel: saw, decidedToShootWithoutForecast: bool(r.decidedToShootWithoutForecast, 'decidedToShootWithoutForecast'),
    notes: str(r.notes, 'notes', 2000, true),
  };
}

export interface RegistryEventOptions {
  /** 相对路径，如 eval/labels/trial/<eventId>.json（相对 eval/ 之外的约定见 eval/labels/README.md）。 */
  labelRecordRef: string; weatherEpisodeId: string; climateZone: string; season: string; evidenceRefPrefix?: string; allowTrial?: boolean;
}
/** 生成 audit.mjs parseAuditDataset 所需的 event；climateZone/season/weatherEpisodeId 由调用方给出，不在此编造。 */
export function toRegistryEvent(record: LabelRecord, options: RegistryEventOptions) {
  if (record.purpose === 'trial' && !options.allowTrial) fail('试标记录不进入正式数据集。');
  if (record.source === 'user-feedback') fail('审计注册表没有 user-feedback 对应的 observationSource，无法入库。');
  const observationSource = record.source === 'webcam' ? 'authorized-webcam' as const : 'manual' as const;
  const ref = options.labelRecordRef;
  if (!ref.trim() || /^[a-zA-Z]:|^[\\/]|\\|\x00/.test(ref) || ref.split('/').some(p => !p || p === '..' || p === '.')) fail('labelRecordRef 须为相对路径。');
  for (const [name, v] of [['weatherEpisodeId', options.weatherEpisodeId], ['climateZone', options.climateZone], ['season', options.season]] as const) idOf(v, name);
  return {
    eventId: record.eventId, weatherEpisodeId: options.weatherEpisodeId, eventAtUtc: record.eventAtUtc, eventType: record.eventType, siteId: record.siteId,
    climateZone: options.climateZone, season: options.season, observedGrade: record.grade, unknownReason: record.unknownReason,
    observationSource, evidenceRefs: record.evidence.map(e => `${options.evidenceRefPrefix ?? ''}sha256:${e.sha256}`),
    rightsRef: record.rights.ref, labelRecordRef: ref, labelerId: record.labelerId, labeledAtUtc: record.labeledAtUtc, blind: record.blind,
  };
}
