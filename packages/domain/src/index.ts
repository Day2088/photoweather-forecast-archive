export interface Wgs84Point { latitude: number; longitude: number }
export type EpochSeconds = number;
export type Level = '极佳' | '很好' | '一般' | '较差' | '不建议';

export function validatePoint(point: Wgs84Point): Wgs84Point {
  if (!Number.isFinite(point.latitude) || Math.abs(point.latitude) > 90 ||
      !Number.isFinite(point.longitude) || point.longitude < -180 || point.longitude >= 180) {
    throw new RangeError('坐标必须是 WGS-84：纬度 -90..90，经度 -180..<180。');
  }
  return { ...point };
}

/** 约0.1°格点中心；仅用于天气请求，精确机位仍在本地保留。 */
export function weatherQueryPoint(point: Wgs84Point): Wgs84Point {
  validatePoint(point);
  const latitudeCell = Math.min(899, Math.floor(point.latitude * 10));
  const longitudeCell = Math.floor(point.longitude * 10);
  return {
    latitude: Number(((latitudeCell + 0.5) / 10).toFixed(2)),
    longitude: Number(((longitudeCell + 0.5) / 10).toFixed(2)),
  };
}

export interface SourceProvenance {
  id: string;
  provider: string;
  endpointId: string;
  model: string;
  kind: 'operational-forecast' | 'observation' | 'hindcast' | 'reanalysis';
  runInitializedAtUtc: string | null;
  availableAtUtc: string | null;
  retrievedAtUtc: string;
  publicationEvidence: 'captured-live' | 'verified-archive' | 'estimated' | 'unknown';
  attribution: string;
}

export interface HourlyWeather {
  time: EpochSeconds;
  temperatureC: number | null;
  apparentTemperatureC: number | null;
  dewPointC: number | null;
  relativeHumidityPercent: number | null;
  cloudTotalPercent: number | null;
  cloudLowPercent: number | null;
  cloudMidPercent: number | null;
  cloudHighPercent: number | null;
  precipitationMm: number | null;
  precipitationProbabilityPercent: number | null;
  visibilityM: number | null;
  windSpeed10mMs: number | null;
  windDirection10mDeg: number | null;
  windGust10mMs: number | null;
  weatherCode: number | null;
}

export interface WeatherSnapshot {
  requestedPoint: Wgs84Point;
  modelPoint: Wgs84Point;
  providerElevationM: number;
  timezone: string;
  hourly: HourlyWeather[];
  source: SourceProvenance;
  missingFields: string[];
}

export interface WeatherProvider {
  readonly id: string;
  fetchForecast(point: Wgs84Point, options?: { signal?: AbortSignal }): Promise<WeatherSnapshot>;
}

export interface AstroSite {
  point: Wgs84Point;
  elevationM: number;
  timezone: string;
}
export interface SavedSite extends AstroSite {
  id: string;
  name: string;
  crs: 'WGS-84';
  azimuthDeg: number | null;
  obstructionNotes: string;
  photos: SitePhoto[];
  createdAtUtc: string;
  updatedAtUtc: string;
}
export interface SiteDocument {
  schemaVersion: 2;
  sites: SavedSite[];
  selectedSiteId: string | null;
}

export interface SitePhoto {
  id: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  bytes: number;
  width: number | null;
  height: number | null;
}
export interface UtcInterval { startUtc: EpochSeconds; endUtc: EpochSeconds }
export interface LightWindow extends UtcInterval { clippedStart: boolean; clippedEnd: boolean }
export interface BodyPosition {
  azimuthDeg: number;
  altitudeDeg: number;
  geometricAltitudeDeg: number;
}
export interface AstroPositions {
  atUtc: EpochSeconds;
  sun: BodyPosition;
  moon: BodyPosition;
}
export type SolarEventName = 'sunrise' | 'sunset' | 'civilDawn' | 'civilDusk' |
  'nauticalDawn' | 'nauticalDusk' | 'astronomicalDawn' | 'astronomicalDusk';
export interface LightDay {
  site: AstroSite;
  localDate: string;
  range: UtcInterval;
  events: Record<SolarEventName, EpochSeconds[]>;
  golden: LightWindow[];
  blue: LightWindow[];
  /** Darkness in this and the following local day; periods remain continuous across midnight. */
  astronomicalNight: { range: UtcInterval; windows: LightWindow[] };
  source: { provider: 'Astronomy Engine'; engineVersion: string; adapterVersion: string; conventionVersion: string };
}
export interface AstroProvider {
  readonly id: string;
  calculateDay(site: AstroSite, localDate: string): LightDay;
  positions(site: AstroSite, atUtc: EpochSeconds): AstroPositions;
}

export interface Factor {
  id: string;
  name: string;
  rawValue: number | readonly number[] | null;
  unit: string;
  contribution: number | null;
  plainExplanation: string;
  professionalExplanation: string;
  status: 'available' | 'missing' | 'proxy';
  sourceRefs: string[];
}

export interface ContributionResult {
  score: number;
  level: Level;
  baseScore: number;
  clampAdjustment: number;
  confidence: null;
  probability: null;
  missingFactorIds: string[];
}
