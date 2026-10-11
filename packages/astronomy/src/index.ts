import { Body, Equator, Horizon, Observer, SearchAltitude, SearchRiseSet, type AstroTime } from 'astronomy-engine';
import { validatePoint, type AstroSite, type AstroProvider, type AstroPositions, type BodyPosition,
  type EpochSeconds, type LightDay, type LightWindow, type UtcInterval } from '../../domain/src/index.ts';
import { localDateAt, localDayRange, validateEpoch, validateTimezone } from './time.ts';
export * from './time.ts';
export * from './notice.ts';

export const ASTRO_VERSION = '0.0.1';
export const ENGINE_VERSION = '2.1.19';
export const LIGHT_CONVENTION_VERSION = 'solar-altitude/1';
export const LIGHT_ALTITUDES = Object.freeze({ goldenLow: -4, goldenHigh: 6, blueLow: -6, blueHigh: -4,
  civil: -6, nautical: -12, astronomical: -18 });

export function validateAstroSite(site: AstroSite): AstroSite {
  const point = validatePoint(site.point);
  validateTimezone(site.timezone);
  if (!Number.isFinite(site.elevationM) || site.elevationM < -500 || site.elevationM > 10000) {
    throw new RangeError('机位海拔必须是 -500..10000 米；未知时可用 0 米参考值。');
  }
  return { point, elevationM: site.elevationM, timezone: site.timezone };
}
function observerFor(site: AstroSite): Observer {
  return new Observer(site.point.latitude, site.point.longitude, site.elevationM);
}
function bodyPosition(body: Body, observer: Observer, atUtc: number): BodyPosition {
  const time = new Date(atUtc * 1000);
  const equator = Equator(body, time, observer, true, true);
  const geometric = Horizon(time, observer, equator.ra, equator.dec);
  const apparent = Horizon(time, observer, equator.ra, equator.dec, 'normal');
  return { azimuthDeg: geometric.azimuth, altitudeDeg: apparent.altitude, geometricAltitudeDeg: geometric.altitude };
}

function searchEvents(range: UtcInterval, search: (cursor: Date, days: number) => AstroTime | null): EpochSeconds[] {
  const events: number[] = [];
  let cursor = range.startUtc;
  while (cursor < range.endUtc) {
    const event = search(new Date(cursor * 1000), (range.endUtc - cursor) / 86400);
    if (!event) break;
    const instant = event.date.getTime() / 1000;
    if (instant >= range.endUtc) break;
    if (instant < cursor || events.length >= 12) throw new Error('天文事件搜索未前进。');
    events.push(instant);
    cursor = instant + 1;
  }
  return events;
}
function crossings(observer: Observer, range: UtcInterval, altitude: number, direction: 1 | -1): number[] {
  return searchEvents(range, (cursor, days) => SearchAltitude(Body.Sun, observer, direction, cursor, days, altitude));
}
function solarWindows(observer: Observer, range: UtcInterval, low: number, high: number): LightWindow[] {
  const boundaries = [range.startUtc, range.endUtc,
    ...crossings(observer, range, high, 1), ...crossings(observer, range, high, -1),
    ...(low === -90 ? [] : [...crossings(observer, range, low, 1), ...crossings(observer, range, low, -1)])];
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const windows: LightWindow[] = [];
  for (let index = 0; index < sorted.length - 1; index++) {
    const startUtc = sorted[index]!; const endUtc = sorted[index + 1]!;
    const altitude = bodyPosition(Body.Sun, observer, (startUtc + endUtc) / 2).geometricAltitudeDeg;
    if (altitude < low || altitude > high) continue;
    const previous = windows.at(-1);
    if (previous?.endUtc === startUtc) {
      previous.endUtc = endUtc; previous.clippedEnd = endUtc === range.endUtc;
    } else windows.push({ startUtc, endUtc, clippedStart: startUtc === range.startUtc, clippedEnd: endUtc === range.endUtc });
  }
  return windows;
}

export class AstronomyEngineProvider implements AstroProvider {
  readonly id = 'astronomy-engine';
  positions(input: AstroSite, atUtc: EpochSeconds): AstroPositions {
    const site = validateAstroSite(input); validateEpoch(atUtc);
    const observer = observerFor(site);
    return { atUtc, sun: bodyPosition(Body.Sun, observer, atUtc), moon: bodyPosition(Body.Moon, observer, atUtc) };
  }
  calculateDay(input: AstroSite, localDate: string): LightDay {
    const site = validateAstroSite(input); const observer = observerFor(site);
    const range = localDayRange(localDate, site.timezone);
    // Select the next actual local date, including a political date-line skip.
    const following = localDayRange(localDateAt(range.endUtc, site.timezone), site.timezone);
    const nightRange = { startUtc: range.startUtc, endUtc: following.endUtc };
    const riseSet = (direction: 1 | -1) => searchEvents(range,
      (cursor, days) => SearchRiseSet(Body.Sun, observer, direction, cursor, days, 0));
    return {
      site, localDate, range,
      events: {
        sunrise: riseSet(1), sunset: riseSet(-1),
        civilDawn: crossings(observer, range, -6, 1), civilDusk: crossings(observer, range, -6, -1),
        nauticalDawn: crossings(observer, range, -12, 1), nauticalDusk: crossings(observer, range, -12, -1),
        astronomicalDawn: crossings(observer, range, -18, 1), astronomicalDusk: crossings(observer, range, -18, -1),
      },
      golden: solarWindows(observer, range, -4, 6), blue: solarWindows(observer, range, -6, -4),
      astronomicalNight: { range: nightRange, windows: solarWindows(observer, nightRange, -90, -18) },
      source: { provider: 'Astronomy Engine', engineVersion: ENGINE_VERSION, adapterVersion: ASTRO_VERSION,
        conventionVersion: LIGHT_CONVENTION_VERSION },
    };
  }
}

/** Bounded search: polar days are not presented as an invented next sunrise. */
export function nextSunEvent(input: AstroSite, atUtc: EpochSeconds): { kind: 'sunrise' | 'sunset'; atUtc: number } | null {
  const site = validateAstroSite(input); validateEpoch(atUtc);
  const observer = observerFor(site);
  const range = { startUtc: atUtc + 0.001, endUtc: atUtc + 48 * 3600 };
  const sunrise = searchEvents(range, (cursor, days) => SearchRiseSet(Body.Sun, observer, 1, cursor, days, 0))[0];
  const sunset = searchEvents(range, (cursor, days) => SearchRiseSet(Body.Sun, observer, -1, cursor, days, 0))[0];
  if (sunrise === undefined && sunset === undefined) return null;
  return sunrise !== undefined && (sunset === undefined || sunrise < sunset)
    ? { kind: 'sunrise', atUtc: sunrise } : { kind: 'sunset', atUtc: sunset! };
}
