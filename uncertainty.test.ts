import { expect, test } from "bun:test";
import { pairedTaskUncertainty, pairedUncertaintyByCohort, type PairedObservation } from "./uncertainty";

const pair = (task: string, id: string, difference: number | null): PairedObservation => ({ task_id: task,
  attempt_id: id, baseline: 1, treatment: difference === null ? null : 1 + difference, source: "fresh", schedule: "alternating" });

test("task bootstrap groups repeats and gives each task equal weight", () => {
  const observations = [pair("a", "1", 10), ...Array.from({ length: 20 }, (_, index) => pair("b", String(index), 0))];
  const result = pairedTaskUncertainty(observations);
  expect(result).toMatchObject({ planned_tasks: 2, matched_tasks: 2, matched_pairs: 21, mean_difference: 5 });
  expect(result.interval).toMatchObject({ confidence: 0.95, lower: 0, upper: 10, status: "unstable" });
  expect(result).toEqual(pairedTaskUncertainty([...observations].reverse()));
});

test("repeating one task cannot manufacture cross-task uncertainty", () => {
  const result = pairedTaskUncertainty(Array.from({ length: 100 }, (_, i) => pair("only", String(i), i % 2)));
  expect(result).toMatchObject({ matched_tasks: 1, matched_pairs: 100, mean_difference: 0.5 });
  expect(result.interval).toMatchObject({ status: "unavailable", lower: null, upper: null });
  expect(result.interval.caveat).toContain("repeats on one task");
});

test("missing pairs and entirely missing tasks are reported without zero-filling", () => {
  const result = pairedTaskUncertainty([pair("a", "1", 2), pair("a", "2", null), pair("b", "1", null)]);
  expect(result).toMatchObject({ planned_tasks: 2, matched_tasks: 1, planned_pairs: 3, matched_pairs: 1, mean_difference: 2 });
  expect(result.tasks[1]).toMatchObject({ task_id: "b", difference: null, matched_pairs: 0 });
  expect(pairedTaskUncertainty([]).mean_difference).toBeNull();
});

test("schedules and historical controls cannot be silently pooled", () => {
  const values = [pair("a", "1", 1), { ...pair("b", "1", 2), source: "historical" as const },
    { ...pair("c", "1", 3), schedule: "concurrent" }];
  expect(() => pairedTaskUncertainty(values)).toThrow("cannot pool");
  expect(pairedUncertaintyByCohort(values)).toHaveLength(3);
  expect(() => pairedTaskUncertainty([pair("a", "1", 1), pair("a", "1", 2)])).toThrow("duplicate paired");
});

test("bootstrap is deterministic and preserves fixed task-level effects", () => {
  const values = Array.from({ length: 8 }, (_, i) => pair(`task${i}`, "1", -3));
  expect(pairedTaskUncertainty(values, { samples: 1000, seed: 5 }).interval).toMatchObject({ lower: -3, upper: -3, status: "available", seed: 5, samples: 1000 });
  expect(() => pairedTaskUncertainty(values, { samples: 0 })).toThrow("invalid bootstrap");
});
