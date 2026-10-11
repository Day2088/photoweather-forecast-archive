// Pure planning logic for the "as-published forecast" archive. No network, no clock, no file access.
import { weatherQueryPoint, validatePoint } from '../packages/domain/src/index.ts';
import { leadBucket } from '../packages/evaluation/src/time.ts';
import { localDateAt, nextCalendarDate } from '../packages/astronomy/src/time.ts';
import { sunwardSolarEvents } from '../packages/astronomy/src/solar-events.ts';

/** Each bucket needs at most 2 requests (single point + sunward path cloud batch). */
export const REQUESTS_PER_BUCKET = 2;
export const MAX_REQUESTS_PER_RUN = 16;
export const MIN_REQUEST_GAP_MS = 1000;
export const EVENT_HORIZON_HOURS = 80;
/** Capture slot width: a bucket is captured in the latest SLOT_HOURS of its window (hourly cron + one skipped run). */
export const SLOT_HOURS = 2;
/** Only capture when lead > lower bound + margin, so retrieval a little after planning stays inside the bucket. */
export const LOWER_MARGIN_MINUTES = 10;
/** Raw response size limit (engineering value); larger responses are failures and are not written. */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = 'photoweather-archive/0.0 (open-source app)';
/** Bounds copied from leadBucket() in packages/evaluation/src/time.ts; a test asserts they agree. */
export const BUCKET_WINDOWS = Object.freeze([
  { bucket: 'near', lowHours: 1, lowInclusive: true, highHours: 2 },
  { bucket: 'same-day', lowHours: 2, lowInclusive: false, highHours: 12 },
  { bucket: 'one-day', lowHours: 18, lowInclusive: true, highHours: 30 },
  { bucket: 'three-day', lowHours: 66, lowInclusive: true, highHours: 78 },
]);

export function parseFixedSites(value) {
  const sites = value?.sites;
  if (value?.schemaVersion !== 1 || !Array.isArray(sites) || !sites.length) throw new Error('机位配置无效。');
  return sites.map(site => {
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(site.siteId ?? '') || typeof site.timezone !== 'string') throw new Error('机位配置无效。');
    const point = validatePoint(site.requestPoint);
    const grid = weatherQueryPoint(point);
    if (grid.latitude !== point.latitude || grid.longitude !== point.longitude) throw new Error('机位请求点必须是 0.1° 量化格点中心。');
    return { siteId: site.siteId, name: String(site.name ?? site.siteId), timezone: site.timezone, requestPoint: grid };
  });
}

function pad(n, width = 2) { return String(n).padStart(width, '0'); }
export function eventId(kind, atUtcSeconds) {
  const d = new Date(Math.round(atUtcSeconds / 60) * 60000);
  return `${kind}-${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}Z`;
}
export const isoUtc = ms => new Date(ms).toISOString();

/** Sunrise/sunset events (UTC) with now < event <= now + horizon, computed at the grid centre. */
export function enumerateEvents(site, nowMs, horizonHours = EVENT_HORIZON_HOURS) {
  const astro = { point: site.requestPoint, elevationM: 0, timezone: site.timezone };
  const from = nowMs / 1000, to = from + horizonHours * 3600;
  const found = new Map();
  let date = localDateAt(from - 86400, site.timezone);
  const last = localDateAt(to + 86400, site.timezone);
  for (let guard = 0; guard < 12; guard++) {
    for (const kind of ['sunrise', 'sunset']) {
      for (const event of sunwardSolarEvents(astro, date, kind).events) {
        if (event.atUtc > from && event.atUtc <= to) found.set(`${kind}@${event.atUtc}`, { kind, atUtc: event.atUtc, azimuthDeg: event.sun.azimuthDeg, eventId: eventId(kind, event.atUtc) });
      }
    }
    if (date === last) break;
    date = nextCalendarDate(date);
  }
  return [...found.values()].sort((a, b) => a.atUtc - b.atUtc);
}

export function leadHoursAt(eventAtUtcSeconds, nowMs) { return (eventAtUtcSeconds * 1000 - nowMs) / 3_600_000; }

/** Bucket whose capture slot contains this lead, or null. Slot = latest SLOT_HOURS of the window, clipped to it. */
export function dueBucket(leadHours) {
  if (!Number.isFinite(leadHours) || leadHours <= 0) return null;
  for (const window of BUCKET_WINDOWS) {
    const aboveLow = leadHours > window.lowHours + LOWER_MARGIN_MINUTES / 60;
    const slotHigh = Math.min(window.highHours, window.lowHours + SLOT_HOURS);
    if (aboveLow && leadHours <= slotHigh && leadBucket(leadHours) === window.bucket) return window.bucket;
  }
  return null;
}

export function archiveBaseName(bucket, retrievedAtUtc) { return `${bucket}-${retrievedAtUtc.replace(/:/g, '-')}`; }
export function archiveDir(siteId, evId) { return `${siteId}/${evId}`; }
/** Name contains only bucket + retrieval time; never scores or conclusions. */
export function archivePaths(siteId, evId, bucket, retrievedAtUtc) {
  const base = `${archiveDir(siteId, evId)}/${archiveBaseName(bucket, retrievedAtUtc)}`;
  return { raw: `${base}.json`, manifest: `${base}.manifest.json`, planned: `${base}.planned.json`,
    pathRaw: `${base}.path.json`, pathManifest: `${base}.path.manifest.json`, pathPlan: `${base}.path-plan.json` };
}
/** existingNames: file names already present in the event directory. Qualified = a manifest for this bucket. */
export function alreadyArchived(existingNames, bucket) {
  return existingNames.some(name => name.startsWith(`${bucket}-`) && name.endsWith('.manifest.json') && !name.endsWith('.path.manifest.json'));
}
/** Path batch archived for this bucket = a path manifest exists. */
export function pathArchived(existingNames, bucket) {
  return existingNames.some(name => name.startsWith(`${bucket}-`) && name.endsWith('.path.manifest.json'));
}
/** A bucket is complete only when both the single-point and the path manifests exist. */
export function bucketNeeds(existingNames, bucket) {
  return { single: !alreadyArchived(existingNames, bucket), path: !pathArchived(existingNames, bucket) };
}

/**
 * Plan captures for one run. listArchived(siteId, eventId) -> file names (sync/pre-read by the caller).
 * Returns {tasks, skipped, deferred}: tasks capped at maxRequests; the rest are deferred to the next run.
 */
export function planCaptures(sites, nowMs, listArchived, { maxRequests = MAX_REQUESTS_PER_RUN } = {}) {
  const tasks = [], skipped = [], deferred = [];
  let requests = 0;
  for (const site of sites) {
    for (const event of enumerateEvents(site, nowMs)) {
      const bucket = dueBucket(leadHoursAt(event.atUtc, nowMs));
      if (!bucket) continue;
      const item = { site, siteId: site.siteId, eventId: event.eventId, kind: event.kind, eventAtUtc: isoUtc(event.atUtc * 1000), bucket,
        plannedAsOfUtc: isoUtc(nowMs) };
      const names = listArchived(site.siteId, event.eventId);
      const need = bucketNeeds(names, bucket);
      const cost = (need.single ? 1 : 0) + (need.path ? 1 : 0);
      if (cost === 0) skipped.push(item);
      else if (requests + cost <= maxRequests) { tasks.push({ ...item, azimuthDeg: event.azimuthDeg, need }); requests += cost; }
      else deferred.push(item);
    }
  }
  return { tasks, skipped, deferred };
}

export const EVENT_MATCH_TOLERANCE_SECONDS = 120;
/**
 * Link a registry event to an archived planned event: same siteId, same eventType, |dt| <= 120 s.
 * Returns the closest match or null. Never use the minute string in directory names for this.
 */
export function matchArchivedEvent(registryEvent, archivedEvents) {
  const at = Date.parse(registryEvent.eventAtUtc);
  if (!Number.isFinite(at)) return null;
  let best = null, bestDelta = Infinity;
  for (const archived of archivedEvents) {
    if (archived.siteId !== registryEvent.siteId || archived.eventType !== registryEvent.eventType) continue;
    const delta = Math.abs(Date.parse(archived.eventAtUtc) - at) / 1000;
    if (delta <= EVENT_MATCH_TOLERANCE_SECONDS && delta < bestDelta) { best = archived; bestDelta = delta; }
  }
  return best;
}
