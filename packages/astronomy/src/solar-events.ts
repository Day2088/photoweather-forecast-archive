import type { AstroSite, BodyPosition, EpochSeconds, LightDay, UtcInterval } from '../../domain/src/index.ts';
import { AstronomyEngineProvider, validateAstroSite, validateEpoch } from './index.ts';

export const SOLAR_EVENT_INPUT_VERSION = '0.0.1';
export type SunwardEventKind = 'sunrise' | 'sunset';
export interface UtcHourBracket {
  method: 'utc-hour-bracket-only';
  interpolation: 'none';
  validTimesUtc: [number] | [number, number];
  exactHour: boolean;
  secondsAfterBefore: number;
  secondsUntilAfter: number;
}
export interface SunwardSolarEvent {
  kind: SunwardEventKind;
  atUtc: EpochSeconds;
  sun: BodyPosition;
  azimuthReference: 'true-north-clockwise';
  cloudTimes: UtcHourBracket;
}
export interface SunwardSolarEventDay {
  version: typeof SOLAR_EVENT_INPUT_VERSION;
  kind: SunwardEventKind;
  localDate: string;
  site: AstroSite;
  localDay: UtcInterval;
  status: 'events' | 'no-event';
  events: SunwardSolarEvent[];
  source: LightDay['source'];
}

/** Query planning only: hourly rows are not event-minute weather or interpolation. */
export function utcHourBracket(atUtc: EpochSeconds): UtcHourBracket {
  validateEpoch(atUtc);
  const before = Math.floor(atUtc / 3600) * 3600;
  const exactHour = atUtc === before;
  const after = exactHour ? before : before + 3600;
  // Same four-digit UTC representation as forecast/cache contracts; no extended years.
  for (const time of [before, after]) {
    if (!Number.isSafeInteger(time) || !Number.isFinite(new Date(time * 1000).getTime()) ||
        !/^\d{4}-/.test(new Date(time * 1000).toISOString())) {
      throw new RangeError('相邻天气小时超出支持的 UTC 年份范围。');
    }
  }
  return { method: 'utc-hour-bracket-only', interpolation: 'none', validTimesUtc: exactHour ? [before] : [before, after],
    exactHour, secondsAfterBefore: atUtc - before, secondsUntilAfter: after - atUtc };
}

/** Pure, explicit site-day computation; use each event's sun azimuth for path planning. */
export function sunwardSolarEvents(input: AstroSite, localDate: string, kind: SunwardEventKind): SunwardSolarEventDay {
  if (kind !== 'sunrise' && kind !== 'sunset') throw new RangeError('太阳侧事件只支持日出或日落。');
  const site = validateAstroSite(input);
  const provider = new AstronomyEngineProvider();
  const day = provider.calculateDay(site, localDate);
  const events = day.events[kind].map(atUtc => ({ kind, atUtc, sun: provider.positions(site, atUtc).sun,
    azimuthReference: 'true-north-clockwise' as const, cloudTimes: utcHourBracket(atUtc) }));
  return { version: SOLAR_EVENT_INPUT_VERSION, kind, localDate, site, localDay: day.range,
    status: events.length ? 'events' : 'no-event', events, source: day.source };
}
