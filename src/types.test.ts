import { expect, test } from "bun:test";
import {
  assertActionQueueStatus,
  assertActionRunStatus,
  isTerminalActionQueueStatus,
  isTerminalActionStatus,
  type ActionQueueStatus,
  type ActionRunStatus,
} from "./types.js";

test("action run status runtime helpers validate and classify run statuses", () => {
  expect(assertActionRunStatus("planned")).toBe("planned");
  expect(assertActionRunStatus("succeeded")).toBe("succeeded");
  expect(() => assertActionRunStatus("unknown")).toThrow("unsupported action run status");

  const terminal: ActionRunStatus[] = ["denied", "succeeded", "failed", "rolled_back", "cancelled"];
  for (const status of terminal) expect(isTerminalActionStatus(status)).toBe(true);
  expect(isTerminalActionStatus("executing")).toBe(false);
});

test("action queue status runtime helpers validate and classify queue statuses", () => {
  expect(assertActionQueueStatus("queued")).toBe("queued");
  expect(assertActionQueueStatus("dead")).toBe("dead");
  expect(() => assertActionQueueStatus("planned")).toThrow("unsupported action queue status");

  const terminal: ActionQueueStatus[] = ["succeeded", "failed", "dead", "cancelled"];
  for (const status of terminal) expect(isTerminalActionQueueStatus(status)).toBe(true);
  expect(isTerminalActionQueueStatus("claimed")).toBe(false);
});
