import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  acquireYapProfileLease,
  buildYapProfileLockPath,
  isYapTimeOutsideVisibleRange,
  shouldBreakYapProfileLock,
  waitForAgendaEventPopulation,
  evalWithTimeout,
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

test("isYapTimeOutsideVisibleRange recognizes the default visible window", () => {
  assert.equal(isYapTimeOutsideVisibleRange("00.40"), true);
  assert.equal(isYapTimeOutsideVisibleRange("07:59"), true);
  assert.equal(isYapTimeOutsideVisibleRange("08:00"), false);
  assert.equal(isYapTimeOutsideVisibleRange("18:00"), false);
  assert.equal(isYapTimeOutsideVisibleRange("18:01"), true);
});


// Regressione crash "Timeout automazione YAP" (last_phase openAgenda:recovery1_nav_done):
// durante il redirect-loop di login un page.evaluate non si risolveva MAI, bloccando
// il worker fino al kill a 210s. evalWithTimeout deve restituire il fallback entro `ms`
// invece di restare appeso, anche se l'evaluate non si risolve mai.
test("evalWithTimeout falls back when page.evaluate never settles (anti-hang)", async () => {
  const hangingPage = {
    evaluate: () => new Promise(() => {}),
  };
  const started = Date.now();
  const result = await evalWithTimeout(hangingPage, () => "real", undefined, 120, "unknown", "regression");
  const elapsed = Date.now() - started;
  assert.equal(result, "unknown");
  assert.ok(elapsed < 1000, `evalWithTimeout deve sbloccarsi presto, invece ha impiegato ${elapsed}ms`);
});

test("evalWithTimeout returns the real value when evaluate resolves in time", async () => {
  const okPage = { evaluate: async () => "agenda" };
  const result = await evalWithTimeout(okPage, () => "agenda", undefined, 1000, "unknown", "regression");
  assert.equal(result, "agenda");
});

test("evalWithTimeout falls back when page.evaluate rejects", async () => {
  const errPage = { evaluate: async () => { throw new Error("Execution context was destroyed"); } };
  const result = await evalWithTimeout(errPage, () => "x", undefined, 500, "unknown", "regression");
  assert.equal(result, "unknown");
});
