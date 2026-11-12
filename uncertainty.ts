export interface PairedObservation {
  task_id: string;
  attempt_id: string;
  baseline: number | null;
  treatment: number | null;
  source: "fresh" | "historical";
  schedule: string;
}
export interface BootstrapOptions { samples?: number; seed?: number }
const finite = (value: number | null): value is number => typeof value === "number" && Number.isFinite(value);
const mean = (values: number[]): number | null => {
  if (!values.length) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  return Number.isFinite(sum) ? sum / values.length : values.reduce((total, value) => total + value / values.length, 0);
};
function quantile(sorted: number[], probability: number): number {
  const position = (sorted.length - 1) * probability;
  const low = Math.floor(position), high = Math.ceil(position);
  const fraction = position - low;
  return sorted[low]! * (1 - fraction) + sorted[high]! * fraction;
}

/** Resample task means, retaining all matched repeats inside each sampled task. */
export function pairedTaskUncertainty(observations: PairedObservation[], options: BootstrapOptions = {}) {
  const samples = options.samples ?? 5000, seed = options.seed ?? 1101;
  if (!Number.isSafeInteger(samples) || samples < 100 || samples > 1000000
    || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("invalid bootstrap settings");
  const cohorts = new Set(observations.map(item => JSON.stringify([item.source, item.schedule])));
  if (cohorts.size > 1) throw new Error("paired uncertainty cannot pool historical/fresh runs or different schedules");
  const ids = new Set<string>();
  for (const item of observations) {
    if (!item.task_id || !item.attempt_id || !item.schedule || !["fresh", "historical"].includes(item.source)) throw new Error("invalid paired identity");
    const key = JSON.stringify([item.task_id, item.attempt_id]);
    if (ids.has(key)) throw new Error("duplicate paired task/attempt identity");
    ids.add(key);
  }
  const tasks = [...new Set(observations.map(item => item.task_id))].sort().map(task_id => {
    const planned = observations.filter(item => item.task_id === task_id);
    const matched = planned.filter(item => finite(item.baseline) && finite(item.treatment))
      .sort((a, b) => a.attempt_id.localeCompare(b.attempt_id));
    const differences = matched.map(item => item.treatment! - item.baseline!);
    if (differences.some(value => !Number.isFinite(value))) throw new Error("paired difference overflow");
    return { task_id, planned_pairs: planned.length, matched_pairs: matched.length,
      baseline_mean: mean(matched.map(item => item.baseline!)), treatment_mean: mean(matched.map(item => item.treatment!)),
      difference: mean(differences) };
  });
  const effects = tasks.flatMap(item => item.difference === null ? [] : [item.difference]);
  let state = seed;
  const random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
  const draws = effects.length < 2 ? [] : Array.from({ length: samples }, () => {
    let sum = 0;
    for (let i = 0; i < effects.length; i++) sum += effects[Math.floor(random() * effects.length)]! / effects.length;
    return sum;
  }).sort((a, b) => a - b);
  return {
    schema: "codex-ab.paired-uncertainty.v1" as const,
    source: observations[0]?.source ?? null, schedule: observations[0]?.schedule ?? null,
    weighting: "equal task; matched repeats averaged within task" as const,
    planned_tasks: tasks.length, matched_tasks: effects.length, planned_pairs: observations.length,
    matched_pairs: tasks.reduce((sum, task) => sum + task.matched_pairs, 0),
    mean_difference: mean(effects), tasks,
    interval: { method: "paired task bootstrap percentile" as const, confidence: 0.95, samples, seed,
      lower: draws.length ? quantile(draws, 0.025) : null, upper: draws.length ? quantile(draws, 0.975) : null,
      status: effects.length < 2 ? "unavailable" : effects.length < 5 ? "unstable" : "available",
      caveat: effects.length < 2 ? "At least two distinct matched tasks are required; repeats on one task do not identify cross-task uncertainty."
        : effects.length < 5 ? "Fewer than five matched tasks: percentile intervals are unstable and have limited resolution; this reporting threshold is a caution, not a validity guarantee."
        : "Task resampling describes the observed task set; it does not establish causal effects or generalization to other tasks.",
    },
  };
}

export function pairedUncertaintyByCohort(observations: PairedObservation[], options: BootstrapOptions = {}) {
  const keys = [...new Set(observations.map(item => JSON.stringify([item.source, item.schedule])))].sort();
  return keys.map(key => pairedTaskUncertainty(observations.filter(item => JSON.stringify([item.source, item.schedule]) === key), options));
}

export function uncertaintyMarkdown(groups: Record<string, ReturnType<typeof pairedUncertaintyByCohort>>): string {
  const n = (value: number | null) => value === null ? "unavailable" : Number(value.toFixed(6));
  return `## Paired uncertainty across tasks\n\nEach task has equal weight. Repeats are averaged within a task before a deterministic 95% task bootstrap; they do not increase the number of distinct tasks. Schedules and historical controls remain separate. Fewer than two tasks has no cross-task interval; fewer than five is marked unstable.\n\n| Metric / comparison | Source / schedule | Matched tasks | Matched pairs | Mean difference | 95% interval | Status |\n| --- | --- | ---: | ---: | ---: | --- | --- |\n${Object.entries(groups).flatMap(([metric, cohorts]) => cohorts.map(item => `| ${metric} | ${item.source} / ${item.schedule} | ${item.matched_tasks}/${item.planned_tasks} | ${item.matched_pairs}/${item.planned_pairs} | ${n(item.mean_difference)} | ${n(item.interval.lower)} to ${n(item.interval.upper)} | ${item.interval.status} |`)).join("\n")}\n`;
}
