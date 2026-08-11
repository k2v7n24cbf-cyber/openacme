import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  STATUS_ORDER,
  STATUS_LABEL,
  STATUS_VARIANT,
  formatDate,
  formatAbsoluteFromUnix,
  formatRelativeFromUnix,
  formatRelativeFromIso,
  describeCron,
  dueUrgencyClass,
  recurrenceTitle,
  type Recurrence,
  type Task,
} from "@/app/tasks/types";

const NOW = new Date("2026-06-12T12:00:00Z").getTime();
const NOW_SEC = Math.floor(NOW / 1000);
const isoAt = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// Minute precision — seconds are dropped at card/footer altitude.
const ISO_LOCAL_SHAPE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

describe("status constants", () => {
  it("STATUS_ORDER lists each status exactly once", () => {
    expect(new Set(STATUS_ORDER).size).toBe(STATUS_ORDER.length);
    expect(STATUS_ORDER).toHaveLength(6);
  });

  it("label and variant maps cover every status in STATUS_ORDER", () => {
    for (const status of STATUS_ORDER) {
      expect(STATUS_LABEL[status]).toBeTruthy();
      expect(STATUS_VARIANT[status]).toBeTruthy();
    }
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...STATUS_ORDER].sort());
    expect(Object.keys(STATUS_VARIANT).sort()).toEqual(
      [...STATUS_ORDER].sort()
    );
  });
});

describe("Task DTO mirror", () => {
  it("includes nullable objective_id from task frontmatter", () => {
    const task = {
      id: "1",
      title: "Linked task",
      status: "open",
      assignee: "agent-1",
      session_id: "session-1",
      objective_id: "objective-1",
      created_by: "agent-1",
      created_in_session_id: "session-1",
      parent_id: null,
      depends_on: [],
      start_at: null,
      due_at: null,
      created_at: "2026-08-11T00:00:00.000Z",
      updated_at: "2026-08-11T00:00:00.000Z",
      closed_at: null,
      recurrence: null,
      runs: 0,
      last_run_at: null,
      team: null,
    } satisfies Task;

    expect(task.objective_id).toBe("objective-1");
  });
});

describe("formatDate", () => {
  it("renders ISO-shape local time (sv-SE) at minute precision", () => {
    const iso = "2026-01-02T03:04:05.000Z";
    const out = formatDate(iso);
    expect(out).toMatch(ISO_LOCAL_SHAPE);
    // Round-trip at minute precision: parsing the local-time string back
    // yields the same instant minus the dropped seconds.
    const minutePrecision = Math.floor(new Date(iso).getTime() / 60000);
    expect(Math.floor(new Date(out.replace(" ", "T")).getTime() / 60000)).toBe(
      minutePrecision
    );
  });
});

describe("formatAbsoluteFromUnix", () => {
  it("renders full-precision local time for tooltips", () => {
    expect(formatAbsoluteFromUnix(NOW_SEC)).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    );
  });
});

describe("time-relative helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  describe("formatRelativeFromUnix", () => {
    it("humanizes past timestamps (date-fns strict)", () => {
      expect(formatRelativeFromUnix(NOW_SEC - 30)).toBe("30 seconds ago");
      expect(formatRelativeFromUnix(NOW_SEC - 5 * 3600)).toBe("5 hours ago");
      expect(formatRelativeFromUnix(NOW_SEC - 3 * 86400)).toBe("3 days ago");
    });
  });

  describe("formatRelativeFromIso", () => {
    it("humanizes past and future timestamps", () => {
      expect(formatRelativeFromIso(isoAt(-3 * 86400 * 1000))).toBe(
        "3 days ago"
      );
      expect(formatRelativeFromIso(isoAt(5 * 60 * 1000))).toBe(
        "in 5 minutes"
      );
      expect(formatRelativeFromIso(isoAt(2 * 86400 * 1000))).toBe("in 2 days");
    });

    it("returns the input verbatim when unparseable", () => {
      expect(formatRelativeFromIso("not-a-date")).toBe("not-a-date");
    });
  });

  describe("dueUrgencyClass", () => {
    it("returns undefined for missing values", () => {
      expect(dueUrgencyClass(null)).toBeUndefined();
      expect(dueUrgencyClass(undefined)).toBeUndefined();
      expect(dueUrgencyClass("")).toBeUndefined();
    });

    it("returns undefined for unparseable dates", () => {
      expect(dueUrgencyClass("not-a-date")).toBeUndefined();
    });

    it("flags overdue as destructive", () => {
      expect(dueUrgencyClass(isoAt(-1000))).toBe("text-destructive");
    });

    it("flags due-within-24h as warn-ochre", () => {
      expect(dueUrgencyClass(isoAt(60 * 60 * 1000))).toBe("text-warn-ochre");
      expect(dueUrgencyClass(isoAt(24 * 60 * 60 * 1000 - 1000))).toBe(
        "text-warn-ochre"
      );
    });

    it("leaves distant deadlines untinted", () => {
      expect(dueUrgencyClass(isoAt(25 * 60 * 60 * 1000))).toBeUndefined();
    });
  });
});

describe("describeCron", () => {
  it("humanizes common expressions", () => {
    expect(describeCron("0 9 * * 1-5")).toBe(
      "At 09:00, Monday through Friday"
    );
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("returns null for empty or unparseable input", () => {
    expect(describeCron("")).toBeNull();
    expect(describeCron("not a cron")).toBeNull();
  });
});

describe("recurrenceTitle", () => {
  it("carries humanized text, tz, and the raw expr for tooltips", () => {
    expect(
      recurrenceTitle({
        kind: "cron",
        expr: "0 9 * * 1",
        tz: "Asia/Kolkata",
        session: "fresh",
      })
    ).toBe("At 09:00, only on Monday (Asia/Kolkata) · 0 9 * * 1");
  });

  it("humanizes interval cadence across units", () => {
    const interval = (every_ms: number): Recurrence => ({
      kind: "interval",
      every_ms,
      session: "reuse",
    });
    expect(recurrenceTitle(interval(5 * 60 * 1000))).toBe("every 5m");
    expect(recurrenceTitle(interval(2 * 3600 * 1000))).toBe("every 2h");
    expect(recurrenceTitle(interval(3 * 86400 * 1000))).toBe("every 3d");
  });
});
