import geodesic from 'geographiclib-geodesic';
import { validatePoint, weatherQueryPoint, type Wgs84Point } from '../../domain/src/index.ts';

export const SUNWARD_PATH_VERSION = '0.0.1';
export const GEODESIC_ENGINE_VERSION = '2.2.0';
/** Existing design's uncalibrated sampling preset, not a radiative-transfer model. */
export const DEFAULT_SUNWARD_DISTANCES_M: readonly number[] = Object.freeze([
  50_000, 100_000, 150_000, 200_000, 250_000, 300_000, 350_000, 400_000,
]);
/** Engineering bounds for finite local request plans; not meteorological thresholds. */
export const MAX_SUNWARD_SAMPLES = 64;
export const MAX_SUNWARD_DISTANCE_M = 1_000_000;
const MAX_DIRECT_DISTANCE_M = 20_000_000;

function validateOrigin(point: Wgs84Point): Wgs84Point {
  const checked = validatePoint(point);
  if (Math.abs(checked.latitude) === 90) throw new RangeError('精确极点没有唯一真北方向，无法生成太阳侧采样。');
  return { latitude: checked.latitude, longitude: checked.longitude };
}
function validateAzimuth(azimuthDeg: number): void {
  if (!Number.isFinite(azimuthDeg) || azimuthDeg < 0 || azimuthDeg >= 360) {
    throw new RangeError('太阳方位必须是以真北为零、顺时针 0..<360° 的有限角度。');
  }
}

/** Direct surface geodesic. Distance is meters; output longitude is -180..<180. */
export function destinationWgs84(point: Wgs84Point, azimuthDeg: number, distanceM: number): Wgs84Point {
  const origin = validateOrigin(point);
  validateAzimuth(azimuthDeg);
  if (!Number.isFinite(distanceM) || distanceM < 0 || distanceM > MAX_DIRECT_DISTANCE_M) {
    throw new RangeError('测地距离必须是 0..20,000,000 m 的有限值。');
  }
  if (distanceM === 0) return origin;
  const result = geodesic.Geodesic.WGS84.Direct(origin.latitude, origin.longitude, azimuthDeg, distanceM);
  if (typeof result.lat2 !== 'number' || typeof result.lon2 !== 'number') {
    throw new Error('椭球正算未返回有效坐标。');
  }
  // GeographicLib returns [-180,180]; project storage uses [-180,180).
  const longitude = result.lon2 === 180 ? -180 : result.lon2 === 0 ? 0 : result.lon2;
  return validatePoint({ latitude: result.lat2 === 0 ? 0 : result.lat2, longitude });
}

export type PathQueryReference = { kind: 'origin' } | { kind: 'sample'; sampleIndex: number };
export interface SunwardPathSample {
  distanceM: number;
  point: Wgs84Point;
  requestedPoint: Wgs84Point;
  queryIndex: number;
}
export interface SunwardPathPlan {
  version: typeof SUNWARD_PATH_VERSION;
  geometry: { crs: 'WGS-84'; method: 'surface-geodesic'; engine: 'GeographicLib'; engineVersion: typeof GEODESIC_ENGINE_VERSION };
  sampling: { calibrationStatus: 'uncalibrated'; distancesM: number[] };
  solarAzimuthDegTrueNorth: number;
  origin: { point: Wgs84Point; requestedPoint: Wgs84Point; queryIndex: number };
  samples: SunwardPathSample[];
  /** These are client query cells, not the provider's actual model grid centers. */
  queries: { requestedPoint: Wgs84Point; references: PathQueryReference[] }[];
}

/** No clock, weather, solar-position calculation, I/O, opacity threshold, or score. */
export function planSunwardPath(
  point: Wgs84Point, solarAzimuthDegTrueNorth: number,
  distancesM: readonly number[] = DEFAULT_SUNWARD_DISTANCES_M,
): SunwardPathPlan {
  const origin = validateOrigin(point);
  validateAzimuth(solarAzimuthDegTrueNorth);
  if (!Array.isArray(distancesM) || distancesM.length === 0 || distancesM.length > MAX_SUNWARD_SAMPLES) {
    throw new RangeError('太阳侧采样必须有 1..64 个距离。');
  }
  let previousDistance = 0;
  for (const distance of distancesM) {
    if (!Number.isFinite(distance) || distance <= previousDistance || distance > MAX_SUNWARD_DISTANCE_M) {
      throw new RangeError('采样距离必须严格递增，范围 >0..1,000,000 m。');
    }
    previousDistance = distance;
  }
  const queries: SunwardPathPlan['queries'] = [];
  const indices = new Map<string, number>();
  function register(samplePoint: Wgs84Point, reference: PathQueryReference) {
    const requestedPoint = weatherQueryPoint(samplePoint);
    const key = `${requestedPoint.latitude},${requestedPoint.longitude}`;
    let queryIndex = indices.get(key);
    if (queryIndex === undefined) {
      queryIndex = queries.length;
      indices.set(key, queryIndex);
      queries.push({ requestedPoint: { ...requestedPoint }, references: [] });
    }
    const query = queries[queryIndex];
    if (!query) throw new Error('内部采样请求索引无效。');
    query.references.push(reference);
    return { requestedPoint, queryIndex };
  }
  const originQuery = register(origin, { kind: 'origin' });
  const samples = distancesM.map((distanceM, sampleIndex) => {
    const samplePoint = destinationWgs84(origin, solarAzimuthDegTrueNorth, distanceM);
    return { distanceM, point: samplePoint, ...register(samplePoint, { kind: 'sample', sampleIndex }) };
  });
  return {
    version: SUNWARD_PATH_VERSION,
    geometry: { crs: 'WGS-84', method: 'surface-geodesic', engine: 'GeographicLib', engineVersion: GEODESIC_ENGINE_VERSION },
    sampling: { calibrationStatus: 'uncalibrated', distancesM: [...distancesM] },
    solarAzimuthDegTrueNorth, origin: { point: origin, ...originQuery }, samples, queries,
  };
}
