import type { EpochSeconds, UtcInterval } from '../../domain/src/index.ts';

const DAY = 86400;

export function validateTimezone(timezone: string): string {
  if (!timezone || /^[+-]/.test(timezone)) throw new RangeError('请填写有效的 IANA 机位时区，例如 Asia/Shanghai。');
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0); }
  catch { throw new RangeError('机位时区不可识别，请填写 IANA 时区，例如 Asia/Shanghai。'); }
  return timezone;
}

export function validateEpoch(epoch: EpochSeconds): EpochSeconds {
  if (!Number.isFinite(epoch) || !Number.isFinite(new Date(epoch * 1000).getTime())) {
    throw new RangeError('计算时间必须是有效的 UTC unix 秒。');
  }
  return epoch;
}

function dateFormatter(timezone: string): Intl.DateTimeFormat {
  validateTimezone(timezone);
  return new Intl.DateTimeFormat('en', {
    timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}
function dateAt(epoch: number, formatter: Intl.DateTimeFormat): string {
  const parts = formatter.formatToParts(new Date(epoch * 1000));
  const part = (type: string) => parts.find(item => item.type === type)!.value;
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
export function localDateAt(epoch: EpochSeconds, timezone: string): string {
  return dateAt(validateEpoch(epoch), dateFormatter(timezone));
}
function parseDate(localDate: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new RangeError('日期必须为 YYYY-MM-DD。');
  const epoch = Date.parse(`${localDate}T00:00:00Z`) / 1000;
  if (!Number.isFinite(epoch) || new Date(epoch * 1000).toISOString().slice(0, 10) !== localDate) {
    throw new RangeError('日期不存在。');
  }
  return epoch;
}
export function nextCalendarDate(localDate: string): string {
  return new Date((parseDate(localDate) + DAY) * 1000).toISOString().slice(0, 10);
}

/** First instant of the local date; midnight itself may be skipped by a clock change. */
export function localDayRange(localDate: string, timezone: string): UtcInterval {
  const approximate = parseDate(localDate);
  const formatter = dateFormatter(timezone);
  const lowerBound = (target: string): number => {
    let low = approximate - 2 * DAY;
    let high = approximate + 3 * DAY;
    // Guard historical changes that move the calendar backwards inside this range.
    let previous = dateAt(low, formatter);
    for (let cursor = low + 3600; cursor <= high; cursor += 3600) {
      const date = dateAt(cursor, formatter);
      if (date < previous) throw new RangeError('该历史时区日期发生倒退，暂无法可靠划分此日。');
      previous = date;
    }
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (dateAt(middle, formatter) < target) low = middle;
      else high = middle;
    }
    return high;
  };
  const startUtc = lowerBound(localDate);
  if (dateAt(startUtc, formatter) !== localDate) throw new RangeError('该机位时区跳过了此日期。');
  const endUtc = lowerBound(nextCalendarDate(localDate));
  return { startUtc, endUtc };
}

/**
 * Explicit timezone + offset disambiguate a repeated DST hour; never uses the phone timezone.
 * `locale` only changes the wording/ordering of the date part: Chinese tags keep the numeric `10/11 17:00 GMT+8`
 * layout; any other tag gets an abbreviated month name (`Oct 11, 17:00 GMT+8`) so day/month order is never ambiguous.
 * An unsupported locale tag falls back to the Chinese layout; the time zone semantics never change.
 */
export function formatSiteTime(epoch: EpochSeconds, timezone: string, locale = 'zh-CN'): string {
  validateEpoch(epoch); validateTimezone(timezone);
  const date = new Date(epoch * 1000);
  const base: Intl.DateTimeFormatOptions = { timeZone: timezone, calendar: 'iso8601', numberingSystem: 'latn', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZoneName: 'shortOffset' };
  const chinese = (): string => new Intl.DateTimeFormat('zh-CN', { ...base, month: 'numeric' }).format(date);
  if (/^zh(?:$|[-_])/i.test(locale.trim())) return chinese();
  // iso8601 日历没有月份名称（会输出空白），所以非中文路径改用公历。
  try { return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : locale, { ...base, calendar: 'gregory', month: 'short' }).format(date); } catch { return chinese(); }
}
