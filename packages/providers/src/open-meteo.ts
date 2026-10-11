import { validatePoint, weatherQueryPoint, type HourlyWeather, type WeatherProvider, type WeatherSnapshot, type Wgs84Point } from '../../domain/src/index.ts';

export const OPEN_METEO_ENDPOINT = 'https://api.open-meteo.com/v1/forecast';
export const OPEN_METEO_MODEL = 'gfs_global';
export const WEATHER_CONTRACT_VERSION = 'open-meteo-gfs/1';
export interface WeatherAcquisition {
  requestUrl: string;
  responseText: string;
  snapshot: WeatherSnapshot;
}
function rejectIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) { const failure = new Error('天气请求已取消。'); failure.name = 'AbortError'; throw failure; }
}

type WeatherValueKey = Exclude<keyof HourlyWeather, 'time'>;
interface FieldSpec { api: string; key: WeatherValueKey; unit: string; range?: readonly [number, number] }
const fields: readonly FieldSpec[] = [
  { api: 'temperature_2m', key: 'temperatureC', unit: '°C' },
  { api: 'apparent_temperature', key: 'apparentTemperatureC', unit: '°C' },
  { api: 'dew_point_2m', key: 'dewPointC', unit: '°C' },
  { api: 'relative_humidity_2m', key: 'relativeHumidityPercent', unit: '%', range: [0, 100] },
  { api: 'cloud_cover', key: 'cloudTotalPercent', unit: '%', range: [0, 100] },
  { api: 'cloud_cover_low', key: 'cloudLowPercent', unit: '%', range: [0, 100] },
  { api: 'cloud_cover_mid', key: 'cloudMidPercent', unit: '%', range: [0, 100] },
  { api: 'cloud_cover_high', key: 'cloudHighPercent', unit: '%', range: [0, 100] },
  { api: 'precipitation', key: 'precipitationMm', unit: 'mm', range: [0, Infinity] },
  { api: 'precipitation_probability', key: 'precipitationProbabilityPercent', unit: '%', range: [0, 100] },
  { api: 'visibility', key: 'visibilityM', unit: 'm', range: [0, Infinity] },
  { api: 'wind_speed_10m', key: 'windSpeed10mMs', unit: 'm/s', range: [0, Infinity] },
  { api: 'wind_direction_10m', key: 'windDirection10mDeg', unit: '°', range: [0, 360] },
  { api: 'wind_gusts_10m', key: 'windGust10mMs', unit: 'm/s', range: [0, Infinity] },
  { api: 'weather_code', key: 'weatherCode', unit: 'wmo code', range: [0, 99] },
];
export const FORECAST_VARIABLES = fields.map(field => field.api);

export class WeatherDataError extends Error {
  constructor(message: string) { super(message); this.name = 'WeatherDataError'; }
}
export class WeatherRequestError extends Error {
  constructor(readonly status: number, readonly retryAfter: string | null) {
    super(status === 429 ? '数据源暂时限流，请稍后再试。' : `天气请求失败（HTTP ${status}）。`);
    this.name = 'WeatherRequestError';
  }
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new WeatherDataError(`${name} 不是对象。`);
  return value as Record<string, unknown>;
}
function finite(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new WeatherDataError(`${name} 不是有限数值。`);
  return value;
}

export function forecastUrl(point: Wgs84Point): string {
  const queryPoint = weatherQueryPoint(point);
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.search = new URLSearchParams({
    latitude: String(queryPoint.latitude), longitude: String(queryPoint.longitude),
    hourly: FORECAST_VARIABLES.join(','), models: OPEN_METEO_MODEL,
    forecast_days: '7', timezone: 'auto', timeformat: 'unixtime',
    wind_speed_unit: 'ms', temperature_unit: 'celsius', precipitation_unit: 'mm',
  }).toString();
  return url.toString();
}

/** 不补云底、起报或发布时间；只解析经文档和真实样例验证的字段。 */
export function parseOpenMeteoForecast(raw: unknown, requestedPoint: Wgs84Point, retrievedAtUtc: string): WeatherSnapshot {
  validatePoint(requestedPoint);
  if (!Number.isFinite(Date.parse(retrievedAtUtc)) || !retrievedAtUtc.endsWith('Z')) throw new WeatherDataError('抓取时间必须是 UTC。');
  const root = record(raw, '响应');
  if (root.error === true) throw new WeatherDataError('数据源拒绝了请求参数。');
  const hourly = record(root.hourly, 'hourly');
  const units = record(root.hourly_units, 'hourly_units');
  if (units.time !== 'unixtime' || !Array.isArray(hourly.time) || hourly.time.length === 0) {
    throw new WeatherDataError('时间必须为非空 UTC unix 秒数组。');
  }
  const time = hourly.time.map((value, index) => {
    const parsed = finite(value, `time[${index}]`);
    if (!Number.isInteger(parsed)) throw new WeatherDataError('时间必须是整数 unix 秒。');
    return parsed;
  });
  for (let index = 1; index < time.length; index++) {
    if (time[index]! <= time[index - 1]!) throw new WeatherDataError('时间轴不是严格递增。');
  }
  if (typeof root.timezone !== 'string') throw new WeatherDataError('未提供机位时区。');
  try { new Intl.DateTimeFormat('en', { timeZone: root.timezone }).format(0); }
  catch { throw new WeatherDataError('机位时区不可识别。'); }
  const missingFields: string[] = [];
  const values = new Map<WeatherValueKey, (number | null)[]>();
  for (const field of fields) {
    const list = hourly[field.api];
    if (list === undefined) {
      missingFields.push(field.api);
      values.set(field.key, time.map(() => null));
      continue;
    }
    if (!Array.isArray(list) || list.length !== time.length) throw new WeatherDataError(`${field.api} 长度与时间轴不一致。`);
    if (units[field.api] !== field.unit) throw new WeatherDataError(`${field.api} 单位不匹配：要求 ${field.unit}。`);
    const parsed = list.map((value, index) => {
      if (value === null) return null;
      const number = finite(value, `${field.api}[${index}]`);
      if (field.range && (number < field.range[0] || number > field.range[1])) throw new WeatherDataError(`${field.api} 数值越界。`);
      if (field.key === 'weatherCode' && !Number.isInteger(number)) throw new WeatherDataError('天气码必须是整数。');
      return field.key === 'windDirection10mDeg' && number === 360 ? 0 : number;
    });
    if (parsed.some(value => value === null)) missingFields.push(field.api);
    values.set(field.key, parsed);
  }
  const rows = time.map((epoch, index) => {
    const row = { time: epoch } as HourlyWeather;
    for (const field of fields) row[field.key] = values.get(field.key)![index] ?? null;
    return row;
  });
  const modelPoint = validatePoint({ latitude: finite(root.latitude, 'latitude'), longitude: finite(root.longitude, 'longitude') });
  return {
    requestedPoint: { ...requestedPoint }, modelPoint,
    providerElevationM: finite(root.elevation, 'elevation'), timezone: root.timezone,
    hourly: rows, missingFields,
    source: {
      id: 'open-meteo-gfs', provider: 'Open-Meteo', endpointId: 'forecast-v1', model: OPEN_METEO_MODEL,
      kind: 'operational-forecast', runInitializedAtUtc: null, availableAtUtc: null,
      retrievedAtUtc, publicationEvidence: 'captured-live',
      attribution: 'Weather data by Open-Meteo / NOAA GFS · CC-BY 4.0；本应用组织字段并展示数据。',
    },
  };
}

export class OpenMeteoProvider implements WeatherProvider {
  readonly id = 'open-meteo';
  constructor(private readonly request: typeof fetch = fetch, private readonly clock: () => Date = () => new Date()) {}
  async fetchForecast(point: Wgs84Point, options: { signal?: AbortSignal } = {}): Promise<WeatherSnapshot> {
    return (await this.fetchForecastWithRaw(point, options)).snapshot;
  }
  async fetchForecastWithRaw(point: Wgs84Point, options: { signal?: AbortSignal; onResponseText?: (text: string) => void } = {}): Promise<WeatherAcquisition> {
    rejectIfAborted(options.signal);
    // Browser fetch is a host function; calling it as a provider method changes its receiver.
    const request = this.request;
    const requestUrl = forecastUrl(point);
    const response = await request(requestUrl, options.signal ? { signal: options.signal } : {});
    if (!response.ok) throw new WeatherRequestError(response.status, response.headers.get('retry-after'));
    const responseText = await response.text();
    options.onResponseText?.(responseText);
    rejectIfAborted(options.signal);
    if (responseText.length > 1_000_000) throw new WeatherDataError('数据源响应超过当前容量限制，未采用本次数据。');
    let raw: unknown;
    try { raw = JSON.parse(responseText); } catch { throw new WeatherDataError('数据源未返回有效 JSON，未采用本次数据。'); }
    // Provenance records the actual HTTP grid, while astronomy keeps the precise site.
    const snapshot = parseOpenMeteoForecast(raw, weatherQueryPoint(point), this.clock().toISOString());
    return { requestUrl, responseText, snapshot };
  }
}
