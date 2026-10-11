import { weatherQueryPoint, type WeatherSnapshot, type Wgs84Point } from '../../domain/src/index.ts';
import { OPEN_METEO_ENDPOINT, OPEN_METEO_MODEL, parseOpenMeteoForecast, WeatherDataError, WeatherRequestError } from './open-meteo.ts';

export const CLOUD_BATCH_CONTRACT_VERSION = 'open-meteo-gfs-clouds-gmt/1';
/** Client engineering bounds, not upstream API or meteorological limits. */
export const CLOUD_BATCH_MAX_POINTS = 65;
export const CLOUD_BATCH_MAX_RESPONSE_CHARACTERS = 1_000_000;
export const CLOUD_BATCH_TIMEOUT_MS = 25_000;
export const CLOUD_BATCH_VARIABLES: readonly string[] = Object.freeze(['cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high']);
export type CloudForecastDays = 2 | 7;

export interface CloudBatchRequest {
  contractVersion: typeof CLOUD_BATCH_CONTRACT_VERSION;
  forecastDays: CloudForecastDays;
  queryPoints: Wgs84Point[];
  /** Each original input maps to the first occurrence of its client query cell. */
  inputQueryIndices: number[];
  requestUrl: string;
}
export interface CloudBatchAcquisition extends CloudBatchRequest {
  responseText: string;
  /** HTTP Date is transport metadata, never a forecast run/publication timestamp. */
  serverDate: string | null;
  snapshots: WeatherSnapshot[];
}
export interface CloudBatchOptions {
  signal?: AbortSignal;
  forecastDays?: CloudForecastDays;
  /** Received text for local accounting, not evidence of an accepted response. */
  onResponseText?: (text: string) => void;
}
export interface CloudBatchProvider {
  readonly id: string;
  fetchCloudForecastsWithRaw(points: readonly Wgs84Point[], options?: CloudBatchOptions): Promise<CloudBatchAcquisition>;
}

function abortFailure(): Error {
  const failure = new Error('路径云量请求已取消。'); failure.name = 'AbortError'; return failure;
}
export class CloudTransportError extends Error {
  readonly code: 'network' | 'timeout';
  constructor(code: 'network' | 'timeout') {
    super(code === 'timeout' ? '路径云量请求超时，请稍后重试。' : '暂时无法完成路径云量请求，请稍后重试。');
    this.name = 'CloudTransportError'; this.code = code;
  }
}
function validateDays(days: CloudForecastDays): void {
  if (days !== 2 && days !== 7) throw new WeatherDataError('路径云量只支持已验证的 2 天或 7 天请求。');
}
function samePoint(a: Wgs84Point, b: Wgs84Point): boolean {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

/** Pure request planning; precise site coordinates remain outside the weather request. */
export function cloudBatchRequest(points: readonly Wgs84Point[], forecastDays: CloudForecastDays = 7): CloudBatchRequest {
  validateDays(forecastDays);
  if (!Array.isArray(points) || points.length < 1 || points.length > CLOUD_BATCH_MAX_POINTS) {
    throw new WeatherDataError('路径云量需要 1..65 个输入坐标。');
  }
  const queryPoints: Wgs84Point[] = [];
  const inputQueryIndices: number[] = [];
  const indices = new Map<string, number>();
  for (const point of points) {
    let grid: Wgs84Point;
    try { grid = weatherQueryPoint(point); }
    catch { throw new WeatherDataError('路径采样坐标必须是有效 WGS-84 坐标。'); }
    const key = `${grid.latitude},${grid.longitude}`;
    let index = indices.get(key);
    if (index === undefined) {
      index = queryPoints.length; indices.set(key, index); queryPoints.push(grid);
    }
    inputQueryIndices.push(index);
  }
  const url = new URL(OPEN_METEO_ENDPOINT);
  url.search = new URLSearchParams({
    latitude: queryPoints.map(point => point.latitude).join(','),
    longitude: queryPoints.map(point => point.longitude).join(','),
    hourly: CLOUD_BATCH_VARIABLES.join(','), models: OPEN_METEO_MODEL,
    forecast_days: String(forecastDays), timezone: 'GMT', timeformat: 'unixtime',
  }).toString();
  return { contractVersion: CLOUD_BATCH_CONTRACT_VERSION, forecastDays, queryPoints, inputQueryIndices, requestUrl: url.toString() };
}

/** Parse only the verified cloud/GMT profile. Association follows the API's input order. */
export function parseOpenMeteoCloudBatch(
  raw: unknown, requestedPoints: readonly Wgs84Point[], retrievedAtUtc: string, forecastDays: CloudForecastDays = 7,
): WeatherSnapshot[] {
  const request = cloudBatchRequest(requestedPoints, forecastDays);
  if (request.queryPoints.length !== requestedPoints.length || request.queryPoints.some((point, index) => !samePoint(point, requestedPoints[index]!))) {
    throw new WeatherDataError('解析路径云量需要去重后的实际请求格点。');
  }
  const retrievedMs = Date.parse(retrievedAtUtc);
  if (!Number.isFinite(retrievedMs) || new Date(retrievedMs).toISOString() !== retrievedAtUtc) {
    throw new WeatherDataError('路径抓取时间必须是标准 UTC 毫秒时间。');
  }
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && 'error' in raw && raw.error === true) {
    throw new WeatherDataError('数据源拒绝了路径云量请求参数。');
  }
  const rows: unknown[] = Array.isArray(raw) ? Array.from(raw) : [raw];
  if (rows.length !== requestedPoints.length) throw new WeatherDataError('路径云量响应数量与请求格点不一致。');
  let commonTimes: number[] | null = null;
  return rows.map((row: unknown, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row) || !('timezone' in row) || row.timezone !== 'GMT' || !('utc_offset_seconds' in row) || row.utc_offset_seconds !== 0) {
      throw new WeatherDataError('路径云量必须使用 GMT 与零时区偏移。');
    }
    const snapshot = parseOpenMeteoForecast(row, requestedPoints[index]!, retrievedAtUtc);
    const times = snapshot.hourly.map(hour => hour.time);
    if (times.length !== forecastDays * 24 || times[0]! % 86_400 !== 0 || times.some((time, i) => !Number.isSafeInteger(time) || time % 3600 !== 0 || (i > 0 && time - times[i - 1]! !== 3600))) {
      throw new WeatherDataError('路径云量未提供完整的 UTC 整小时轴。');
    }
    if (commonTimes && times.some((time, i) => time !== commonTimes![i])) {
      throw new WeatherDataError('路径各格点的 UTC 有效时刻不同。');
    }
    commonTimes = times;
    return snapshot;
  });
}

/** Abort also ends our await when an injected/native transport ignores its signal. */
function requestScope(external?: AbortSignal) {
  if (external?.aborted) throw abortFailure();
  const controller = new AbortController();
  let timedOut = false;
  let rejectStopped: (failure: Error) => void = () => undefined;
  const stopped = new Promise<never>((_, reject) => { rejectStopped = reject; });
  // Observe a synchronous cancellation even if calling the injected fetch itself throws.
  void stopped.catch(() => undefined);
  const cancel = () => { controller.abort(); rejectStopped(abortFailure()); };
  external?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => {
    timedOut = true; controller.abort(); rejectStopped(new CloudTransportError('timeout'));
  }, CLOUD_BATCH_TIMEOUT_MS);
  return {
    signal: controller.signal,
    wait: <T>(operation: Promise<T>) => Promise.race([operation, stopped]),
    check: () => { if (external?.aborted) throw abortFailure(); if (timedOut) throw new CloudTransportError('timeout'); },
    dispose: () => { clearTimeout(timer); external?.removeEventListener('abort', cancel); },
  };
}

/** One batch, no internal retry/cache/score. Provider id shares the ordinary source's rate limit. */
export class OpenMeteoCloudBatchProvider implements CloudBatchProvider {
  readonly id = 'open-meteo';
  private readonly request: typeof fetch;
  private readonly clock: () => Date;
  constructor(request: typeof fetch = fetch, clock: () => Date = () => new Date()) {
    this.request = request; this.clock = clock;
  }
  async fetchCloudForecastsWithRaw(points: readonly Wgs84Point[], options: CloudBatchOptions = {}): Promise<CloudBatchAcquisition> {
    if (options.signal?.aborted) throw abortFailure();
    const planned = cloudBatchRequest(points, options.forecastDays ?? 7);
    const scope = requestScope(options.signal);
    try {
      // Host fetch must have no instance receiver.
      const request = this.request;
      const response = await scope.wait(request(planned.requestUrl, { signal: scope.signal }));
      scope.check();
      if (!response.ok) throw new WeatherRequestError(response.status, response.headers.get('retry-after'));
      const responseText = await scope.wait(response.text());
      scope.check();
      options.onResponseText?.(responseText);
      scope.check();
      if (responseText.length > CLOUD_BATCH_MAX_RESPONSE_CHARACTERS) throw new WeatherDataError('路径云量响应超过当前容量限制，未采用本次数据。');
      let raw: unknown;
      try { raw = JSON.parse(responseText); }
      catch { throw new WeatherDataError('数据源未返回有效路径云量 JSON，未采用本次数据。'); }
      const retrievedAtUtc = this.clock().toISOString();
      const snapshots = parseOpenMeteoCloudBatch(raw, planned.queryPoints, retrievedAtUtc, planned.forecastDays);
      scope.check();
      return { ...planned, responseText, serverDate: response.headers.get('date'), snapshots };
    } catch (failure) {
      scope.check();
      if (failure instanceof WeatherDataError || failure instanceof WeatherRequestError || failure instanceof CloudTransportError) throw failure;
      throw new CloudTransportError('network');
    } finally { scope.dispose(); }
  }
}
