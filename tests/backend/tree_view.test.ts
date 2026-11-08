import { expect, test } from "bun:test";
import { IDLE_LIVE, TreeView } from "../../src/agents/tree_view";
import {
  logger,
  type RuntimeLogRecord,
} from "../../src/observability/runtime_logging";

function newView(records: RuntimeLogRecord[] = []): TreeView {
  return new TreeView({
    skills: {
      contextForWorkdirLoopSafe: (w) => (w === null ? null : `loop:${w}`),
      renderer: () => async (w) => (w === null ? null : `full:${w}`),
    },
    logger: logger("agents", { write: (r) => records.push(r) }),
  });
}

test("refresh failure logs tree_view_refresh_failed and keeps the old row", () => {
  const records: RuntimeLogRecord[] = [];
  const view = newView(records);
  view.refresh({
    record: { id: "a", updated: 1 },
    live: IDLE_LIVE,
    workdir: null,
  });
  view.refresh({
    record: { id: "a", last: 5 },
    live: IDLE_LIVE,
    workdir: null,
  });

  expect(JSON.stringify(records)).toContain("tree_view_refresh_failed");
});

test("a taken-over agent shows work beneath it; its own turn marks no parent", () => {
  const view = newView();
  const running = { ...IDLE_LIVE, status: "running" };
  for (const [record, live] of [
    [{ id: "boss" }, IDLE_LIVE],
    [{ id: "held", parent: "boss", taken_over: true }, IDLE_LIVE],
    [{ id: "child", parent: "held" }, running],
    [{ id: "lead" }, IDLE_LIVE],
    [{ id: "solo", parent: "lead", taken_over: true }, running],
  ] as const)
    view.refresh({
      record: { ...record, status: "idle", updated: 1 },
      live,
      workdir: null,
    });
  const statuses = Object.fromEntries(
    view.serve().map((row) => [row.id, row.status]),
  );
  expect(statuses).toEqual({
    boss: "working",
    held: "working",
    child: "running",
    lead: "idle",
    solo: "running",
  });
});
