// One capture: fetch, contract check, write raw + manifest + sidecar, self-check; delete everything on failure.
import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { admitReplayInput, parseForecastArtifact } from '../packages/evaluation/src/index.ts';
import { FORECAST_VARIABLES, forecastUrl, parseOpenMeteoForecast } from '../packages/providers/src/open-meteo.ts';
import { CLOUD_BATCH_CONTRACT_VERSION, cloudBatchRequest, parseOpenMeteoCloudBatch } from '../packages/providers/src/cloud-batch.ts';
import { SUNWARD_PATH_VERSION, planSunwardPath } from '../packages/scoring/src/sunward-path.ts';
import { MAX_ARCHIVE_BYTES, MIN_REQUEST_GAP_MS, USER_AGENT, archivePaths } from './forecast-archive-plan.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchOnce(fetchImpl, url) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES) throw new Error(`响应超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new Error(`响应超过 ${MAX_ARCHIVE_BYTES} 字节上限`);
  return { bytes, serverDate: response.headers.get('date') };
}
async function fetchWithRetry(fetchImpl, url, gapMs) {
  try { return await fetchOnce(fetchImpl, url); }
  catch (first) { await sleep(gapMs); try { return await fetchOnce(fetchImpl, url); } catch { throw first; } }
}

/** Throws on any failure after removing files this call wrote. Returns a summary on success. */
export async function captureTask(task, { archiveRoot, rawPrefix, fetchImpl = fetch, nowIso = () => new Date().toISOString(), retryGapMs = MIN_REQUEST_GAP_MS }) {
  const written = [];
  try {
    const url = forecastUrl(task.site.requestPoint);
    const { bytes, serverDate } = await fetchWithRetry(fetchImpl, url, retryGapMs);
    const retrievedAtUtc = nowIso();
    parseOpenMeteoForecast(JSON.parse(bytes.toString('utf8')), task.site.requestPoint, retrievedAtUtc); // contract check before saving
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const paths = archivePaths(task.siteId, task.eventId, task.bucket, retrievedAtUtc);
    const rawPath = join(archiveRoot, paths.raw), manifestPath = join(archiveRoot, paths.manifest), plannedPath = join(archiveRoot, paths.planned);
    await mkdir(dirname(rawPath), { recursive: true });
    const manifest = {
      schemaVersion: 1, artifactId: `${task.siteId}-${task.eventId}-${task.bucket}`, rawFile: `${rawPrefix}/${paths.raw}`, sha256, requestUrl: url,
      source: { id: 'open-meteo-gfs', provider: 'Open-Meteo', endpointId: 'forecast-v1', model: 'gfs_global', kind: 'operational-forecast',
        runInitializedAtUtc: null, availableAtUtc: null, retrievedAtUtc, publicationEvidence: 'captured-live',
        attribution: 'Weather data by Open-Meteo / NOAA GFS · CC-BY 4.0；本应用组织字段并展示数据。' },
      sourceEvidenceRef: `captured-live by scripts/capture-forecast-archive.mjs; retrievedAtUtc=${retrievedAtUtc}; HTTP Date header=${serverDate ?? 'absent'}; model run time not provided by the response, left null.`,
    };
    // ForecastArtifact is strict (unknown keys rejected), so the planned event lives in a sidecar.
    const planned = { schemaVersion: 1, plannedEvent: { eventType: task.kind, eventAtUtc: task.eventAtUtc, siteId: task.siteId },
      note: 'Event time computed at the weather grid centre, not the exact site; match registry events within 120 s.' };
    await writeFile(rawPath, bytes, { flag: 'wx' }); written.push(rawPath);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); written.push(manifestPath);
    await writeFile(plannedPath, JSON.stringify(planned, null, 2) + '\n', { flag: 'wx' }); written.push(plannedPath);
    const onDisk = createHash('sha256').update(await readFile(rawPath)).digest('hex');
    const artifact = parseForecastArtifact(JSON.parse(await readFile(manifestPath, 'utf8')));
    const admission = admitReplayInput(artifact, onDisk, { asOfUtc: retrievedAtUtc, eventAtUtc: task.eventAtUtc });
    if (!admission.admitted) throw new Error(`准入自检未通过：${admission.reason}`);
    if (admission.leadBucket !== task.bucket) throw new Error(`实际提前量桶 ${admission.leadBucket} 与计划桶 ${task.bucket} 不符`);
    return { raw: paths.raw, sha256, leadHours: admission.leadHours, retrievedAtUtc };
  } catch (error) {
    for (const file of written) await unlink(file).catch(() => {});
    throw error;
  }
}

/** Variables extractSunsetFeatures reads from the local (origin) weather; API names per FORECAST_VARIABLES. */
export const LOCAL_WEATHER_API_VARIABLES = Object.freeze(['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high',
  'precipitation', 'relative_humidity_2m', 'visibility']);

/**
 * Sunward path cloud batch capture (contract open-meteo-gfs-clouds-gmt/1, same request as the App's cloudBatchRequest).
 * The path is planned from the grid centre and the grid-centre event azimuth only; no exact site coordinate is involved.
 * prefixRetrievedAtUtc names the files (shared with the single-point capture of the same run); singleRetrievedAtUtc is recorded in the sidecar.
 */
export async function capturePathTask(task, { archiveRoot, rawPrefix, prefixRetrievedAtUtc = null, singleRetrievedAtUtc = null, fetchImpl = fetch,
  nowIso = () => new Date().toISOString(), retryGapMs = MIN_REQUEST_GAP_MS }) {
  const written = [];
  try {
    const plan = planSunwardPath(task.site.requestPoint, task.azimuthDeg);
    const request = cloudBatchRequest(plan.queries.map(query => query.requestedPoint));
    const { bytes, serverDate } = await fetchWithRetry(fetchImpl, request.requestUrl, retryGapMs);
    const retrievedAtUtc = nowIso();
    parseOpenMeteoCloudBatch(JSON.parse(bytes.toString('utf8')), request.queryPoints, retrievedAtUtc, request.forecastDays); // contract check before saving
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const paths = archivePaths(task.siteId, task.eventId, task.bucket, prefixRetrievedAtUtc ?? retrievedAtUtc);
    const rawPath = join(archiveRoot, paths.pathRaw), manifestPath = join(archiveRoot, paths.pathManifest), planPath = join(archiveRoot, paths.pathPlan);
    await mkdir(dirname(rawPath), { recursive: true });
    const manifest = {
      schemaVersion: 1, artifactId: `${task.siteId}-${task.eventId}-${task.bucket}-path`, rawFile: `${rawPrefix}/${paths.pathRaw}`, sha256, requestUrl: request.requestUrl,
      source: { id: 'open-meteo-gfs', provider: 'Open-Meteo', endpointId: 'forecast-v1', model: 'gfs_global', kind: 'operational-forecast',
        runInitializedAtUtc: null, availableAtUtc: null, retrievedAtUtc, publicationEvidence: 'captured-live',
        attribution: 'Weather data by Open-Meteo / NOAA GFS · CC-BY 4.0；本应用组织字段并展示数据。' },
      sourceEvidenceRef: `captured-live by scripts/capture-forecast-archive.mjs; contract=${CLOUD_BATCH_CONTRACT_VERSION}; retrievedAtUtc=${retrievedAtUtc}; HTTP Date header=${serverDate ?? 'absent'}; model run time not provided by the response, left null.`,
    };
    const single = task.site.requestPoint, origin = plan.origin.requestedPoint;
    const sidecar = {
      schemaVersion: 1, contract: CLOUD_BATCH_CONTRACT_VERSION, forecastDays: request.forecastDays,
      plannedEvent: { eventType: task.kind, eventAtUtc: task.eventAtUtc, siteId: task.siteId },
      eventTimeBasis: 'grid-centre', gridCentreEventAtUtc: task.eventAtUtc, solarAzimuthDegTrueNorth: plan.solarAzimuthDegTrueNorth,
      pathAlgorithm: { sunwardPathVersion: SUNWARD_PATH_VERSION, geometry: plan.geometry, calibrationStatus: plan.sampling.calibrationStatus },
      distancesM: plan.sampling.distancesM, origin: { requestedPoint: origin, queryIndex: plan.origin.queryIndex },
      samples: plan.samples.map(sample => ({ distanceM: sample.distanceM, requestedPoint: sample.requestedPoint, queryIndex: sample.queryIndex })),
      queryPoints: request.queryPoints, inputQueryIndices: request.inputQueryIndices,
      retrieval: { singleRetrievedAtUtc, pathRetrievedAtUtc: retrievedAtUtc,
        gapSeconds: singleRetrievedAtUtc ? (Date.parse(retrievedAtUtc) - Date.parse(singleRetrievedAtUtc)) / 1000 : null },
      localWeather: { singleRequestPoint: single, pathOriginRequestPoint: origin,
        sameGrid: single.latitude === origin.latitude && single.longitude === origin.longitude,
        singleRequestHasLocalVariables: LOCAL_WEATHER_API_VARIABLES.every(name => FORECAST_VARIABLES.includes(name)) },
      note: 'All points are 0.1-degree query cells derived from the grid centre, not the exact site. Replay: local weather from the single-point raw; path cloud from this batch.',
    };
    await writeFile(rawPath, bytes, { flag: 'wx' }); written.push(rawPath);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); written.push(manifestPath);
    await writeFile(planPath, JSON.stringify(sidecar, null, 2) + '\n', { flag: 'wx' }); written.push(planPath);
    const onDisk = createHash('sha256').update(await readFile(rawPath)).digest('hex');
    const artifact = parseForecastArtifact(JSON.parse(await readFile(manifestPath, 'utf8')));
    const admission = admitReplayInput(artifact, onDisk, { asOfUtc: retrievedAtUtc, eventAtUtc: task.eventAtUtc });
    if (!admission.admitted) throw new Error(`路径准入自检未通过：${admission.reason}`);
    if (admission.leadBucket !== task.bucket) throw new Error(`路径实际提前量桶 ${admission.leadBucket} 与计划桶 ${task.bucket} 不符`);
    return { raw: paths.pathRaw, sha256, leadHours: admission.leadHours, retrievedAtUtc };
  } catch (error) {
    for (const file of written) await unlink(file).catch(() => {});
    throw error;
  }
}

/**
 * One bucket: single point first, then the path batch (>= gapMs apart). A failure of one does not remove the other.
 * Never throws; returns {single, path, incomplete} where each part is null (not needed), {ok:true,...} or {ok:false,error}.
 * readSingleRetrievedAt(task) supplies the existing single capture time for a path-only backfill.
 */
export async function captureBucket(task, options) {
  const gapMs = options.retryGapMs ?? MIN_REQUEST_GAP_MS;
  const need = task.need ?? { single: true, path: true };
  const result = { single: null, path: null, incomplete: false };
  const run = async fn => { try { return { ok: true, ...(await fn()) }; } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; } };
  if (need.single) result.single = await run(() => captureTask(task, options));
  let singleAt = result.single?.ok ? result.single.retrievedAtUtc : null;
  if (need.path) {
    if (need.single) await sleep(gapMs);
    if (!need.single && options.readSingleRetrievedAt) singleAt = await options.readSingleRetrievedAt(task).catch(() => null);
    result.path = await run(() => capturePathTask(task, { ...options, prefixRetrievedAtUtc: need.single ? singleAt : null, singleRetrievedAtUtc: singleAt }));
  }
  result.incomplete = [result.single, result.path].some(part => part && !part.ok);
  return result;
}
