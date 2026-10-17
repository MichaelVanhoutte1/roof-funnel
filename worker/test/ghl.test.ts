import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeSlots } from "../src/ghl.ts";

test("normalizeSlots keeps date keys, sorts, drops traceId and junk", () => {
  const out = normalizeSlots({
    "2026-10-20": { slots: ["2026-10-20T15:00:00-04:00", "2026-10-20T09:00:00-04:00", 42] },
    "2026-10-21": { slots: [] },
    traceId: "abc",
    "not-a-date": { slots: ["x"] },
  });
  assert.deepEqual(out, {
    "2026-10-20": ["2026-10-20T09:00:00-04:00", "2026-10-20T15:00:00-04:00"],
    "2026-10-21": [],
  });
});
