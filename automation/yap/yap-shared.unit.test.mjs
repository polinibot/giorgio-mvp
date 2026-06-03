import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireYapProfileLease,
  buildYapProfileLockPath,
  shouldBreakYapProfileLock,
  waitForAgendaEventPopulation,
} from "./lib/yap-shared.mjs";

test("shouldBreakYapProfileLock invalidates missing stale or dead locks", () => {
  assert.equal(shouldBreakYapProfileLock(null), true);
  assert.equal(shouldBreakYapProfileLock({ pid: 0, startedAt: "2026-01-01T00:00:00.000Z" }), true);
  assert.equal(
    shouldBreakYapProfileLock(
      { pid: 123, startedAt: "2026-01-01T00:00:00.000Z" },
      { nowMs: Date.parse("2026-01-01T00:30:00.000Z"), staleMs: 60_000, isPidAlive: () => true },
    ),
    true,
  );
  assert.equal(
    shouldBreakYapProfileLock(
      { pid: 123, startedAt: "2026-01-01T00:00:00.000Z" },
      { nowMs: Date.parse("2026-01-01T00:00:10.000Z"), staleMs: 60_000, isPidAlive: () => false },
    ),
    true,
  );
  assert.equal(
    shouldBreakYapProfileLock(
      { pid: 123, startedAt: "2026-01-01T00:00:00.000Z" },
      { nowMs: Date.parse("2026-01-01T00:00:10.000Z"), staleMs: 60_000, isPidAlive: () => true },
    ),
    false,
  );
});

test("acquireYapProfileLease serializes access and releases cleanly", async () => {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "yap-profile-lease-"));
  const first = await acquireYapProfileLease(profileDir, { waitMs: 50, pollMs: 10, staleMs: 5000 });
  assert.equal(first.acquired, true);
  const lockPath = buildYapProfileLockPath(profileDir);
  const lockExists = await fs.access(lockPath).then(() => true).catch(() => false);
  assert.equal(lockExists, true);

  const second = await acquireYapProfileLease(profileDir, { waitMs: 50, pollMs: 10, staleMs: 5000 });
  assert.equal(second.acquired, false);
  assert.equal(second.owner?.pid, process.pid);

  await first.release();
  const third = await acquireYapProfileLease(profileDir, { waitMs: 50, pollMs: 10, staleMs: 5000 });
  assert.equal(third.acquired, true);
  await third.release();

  await fs.rm(profileDir, { recursive: true, force: true });
});

test("waitForAgendaEventPopulation marks agenda as unstable when events appear after an empty first read", async () => {
  const page = {
    waitForTimeout: async () => {},
  };
  const states = [
    { visibleEventCount: 0, visibleEvents: [], centerDateLabel: "24 novembre 2026" },
    { visibleEventCount: 4, visibleEvents: [{ title: "Test", time: "09:00" }], centerDateLabel: "24 novembre 2026" },
  ];

  const settled = await waitForAgendaEventPopulation(page, {
    timeoutMs: 50,
    pollMs: 0,
    readState: async () => states.shift() || states[states.length - 1],
  });

  assert.equal(settled.visibleEventCount, 4);
  assert.equal(settled.agendaSettle.initialCount, 0);
  assert.equal(settled.agendaSettle.finalCount, 4);
  assert.equal(settled.agendaSettle.unstable, true);
  assert.equal(settled.agendaSettle.emptyConfirmed, false);
});

test("waitForAgendaEventPopulation confirms a truly empty agenda only after repeated empty reads", async () => {
  const page = {
    waitForTimeout: async () => {},
  };

  const settled = await waitForAgendaEventPopulation(page, {
    timeoutMs: 5,
    pollMs: 0,
    confirmEmptyReads: 2,
    readState: async () => ({
      visibleEventCount: 0,
      visibleEvents: [],
      centerDateLabel: "1 novembre 2026",
    }),
  });

  assert.equal(settled.visibleEventCount, 0);
  assert.equal(settled.agendaSettle.emptyConfirmed, true);
  assert.ok(settled.agendaSettle.polls >= 1);
});
