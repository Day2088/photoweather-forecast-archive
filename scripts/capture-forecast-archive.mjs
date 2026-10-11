// Scheduled capture of as-published Open-Meteo GFS single-point forecasts and sunward path cloud batches (ADR-0009). See eval/README.md.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureBucket } from './forecast-archive-capture.mjs';
import { MIN_REQUEST_GAP_MS, parseFixedSites, planCaptures } from './forecast-archive-plan.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const flag = name => args.includes(name);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dryRun = flag('--dry-run');
const nowOption = option('--now');
const nowMs = nowOption ? Date.parse(nowOption) : Date.now();
if (!Number.isFinite(nowMs)) { console.log('--now 不是有效的 ISO 时间。'); process.exit(2); }
const outOption = option('--out');
const archiveRoot = outOption ? outOption : join(root, 'eval', 'archive');
// rawFile is relative to the repository root for the default archive; for --out it is relative to the out dir's parent.
const rawPrefix = outOption ? 'archive' : 'eval/archive';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const sites = parseFixedSites(JSON.parse(await readFile(join(root, 'eval', 'sites', 'fixed-sites.json'), 'utf8')));
const listing = new Map();
for (const site of sites) {
  // Pre-read directory listings so planning stays synchronous and pure.
  let events = [];
  try { events = await readdir(join(archiveRoot, site.siteId)); } catch { /* none yet */ }
  for (const ev of events) {
    try { listing.set(`${site.siteId}/${ev}`, await readdir(join(archiveRoot, site.siteId, ev))); } catch { /* ignore */ }
  }
}
const plan = planCaptures(sites, nowMs, (siteId, eventId) => listing.get(`${siteId}/${eventId}`) ?? []);
console.log(`now=${new Date(nowMs).toISOString()} due=${plan.tasks.length} skipped(already archived)=${plan.skipped.length} deferred(request cap)=${plan.deferred.length}`);
for (const t of plan.tasks) console.log(`${dryRun ? 'would capture' : 'capture'}: ${t.siteId} ${t.eventId} bucket=${t.bucket}  need=${t.need.single ? "single" : ""}${t.need.single && t.need.path ? "+" : ""}${t.need.path ? "path" : ""} plannedAsOf=${t.plannedAsOfUtc}`);
for (const t of plan.skipped) console.log(`skip: ${t.siteId} ${t.eventId} bucket=${t.bucket}`);
for (const t of plan.deferred) console.log(`deferred: ${t.siteId} ${t.eventId} bucket=${t.bucket}`);
if (dryRun) process.exit(0);

let failures = 0, buckets = 0;
const readSingleRetrievedAt = async task => {
  const dir = join(archiveRoot, task.siteId, task.eventId);
  const name = (listing.get(`${task.siteId}/${task.eventId}`) ?? []).find(n => n.startsWith(`${task.bucket}-`) && n.endsWith('.manifest.json') && !n.endsWith('.path.manifest.json'));
  return name ? JSON.parse(await readFile(join(dir, name), 'utf8')).source.retrievedAtUtc : null;
};
for (const task of plan.tasks) {
  if (buckets > 0) await sleep(MIN_REQUEST_GAP_MS);
  buckets++;
  const label = `${task.siteId} ${task.eventId} ${task.bucket}`;
  const r = await captureBucket(task, { archiveRoot, rawPrefix, readSingleRetrievedAt });
  for (const [name, part] of [['single', r.single], ['path', r.path]]) {
    if (!part) continue;
    if (part.ok) console.log(`ok: ${label} ${name} -> ${part.raw} sha256=${part.sha256.slice(0, 12)} lead=${part.leadHours.toFixed(2)}h retrievedAt=${part.retrievedAtUtc}`);
    else console.log(`FAIL: ${label} ${name}: ${part.error}`);
  }
  if (r.incomplete) { failures++; console.log(`INCOMPLETE: ${label} 该桶不完整（缺失的部分只在桶窗口内补抓，超出窗口则留缺）`); }
}
process.exit(failures ? 1 : 0);
