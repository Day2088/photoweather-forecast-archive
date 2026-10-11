import { EvaluationInputError, evaluationUtcMs } from './time.ts';

export interface EvaluationEvent { eventId: string; weatherEpisodeId: string; eventAtUtc: string }
export interface TemporalSplit<T> { train: T[]; test: T[]; cutoffUtc: string }

/** Events, not hourly rows/views/lead times. The cutoff is chosen and frozen before evaluation. */
export function splitEvents<T extends EvaluationEvent>(events: readonly T[], cutoffUtc: string): TemporalSplit<T> {
  const cutoff = evaluationUtcMs(cutoffUtc);
  const seen = new Set<string>();
  const episodes = new Map<string, 'train' | 'test'>();
  const result: TemporalSplit<T> = { train: [], test: [], cutoffUtc };
  const sorted = events.map(event => ({ event, at: evaluationUtcMs(event.eventAtUtc) })).sort((a, b) =>
    a.at - b.at || (a.event.eventId < b.event.eventId ? -1 : a.event.eventId > b.event.eventId ? 1 : 0));
  for (const { event, at } of sorted) {
    if (typeof event.eventId !== 'string' || !event.eventId.trim() ||
        typeof event.weatherEpisodeId !== 'string' || !event.weatherEpisodeId.trim()) {
      throw new EvaluationInputError('事件与天气过程 ID 不能为空。');
    }
    if (seen.has(event.eventId)) throw new EvaluationInputError('eventId 重复，不能把朝向/提前量行当独立事件。');
    seen.add(event.eventId);
    const side = at < cutoff ? 'train' : 'test';
    const earlierSide = episodes.get(event.weatherEpisodeId);
    if (earlierSide && earlierSide !== side) throw new EvaluationInputError('同一天气过程跨越切点；请在完整过程之间冻结切点。');
    episodes.set(event.weatherEpisodeId, side);
    result[side].push(event);
  }
  return result;
}
