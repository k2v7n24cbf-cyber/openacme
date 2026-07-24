import { useState } from "react";
import { ChevronsUpDown, Clock3 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/app/components/ui/popover";
import { cn } from "@/app/lib/utils";
import type { Task } from "./types";

export type ActivityPreset =
  | "all"
  | "30m"
  | "1h"
  | "6h"
  | "24h"
  | "7d"
  | "custom";

export interface ActivityWindow {
  preset: ActivityPreset;
  from: string | null;
  to: string | null;
}

export const EMPTY_ACTIVITY_WINDOW: ActivityWindow = {
  preset: "all",
  from: null,
  to: null,
};

const PRESETS: { value: ActivityPreset; label: string }[] = [
  { value: "all", label: "All" },
  { value: "30m", label: "30m" },
  { value: "1h", label: "1h" },
  { value: "6h", label: "6h" },
  { value: "24h", label: "24h" },
  { value: "7d", label: "7d" },
];

export function activityWindowActive(window: ActivityWindow): boolean {
  return window.preset !== "all" || !!window.from || !!window.to;
}

export function taskLastActivityMs(task: Task): number {
  if (typeof task.last_activity_at === "number" && task.last_activity_at > 0) {
    return task.last_activity_at * 1000;
  }
  const updated = Date.parse(task.updated_at);
  return Number.isFinite(updated) ? updated : 0;
}

export function taskInActivityWindow(
  task: Task,
  window: ActivityWindow,
  now: Date = new Date(),
): boolean {
  if (!activityWindowActive(window)) return true;
  const activity = taskLastActivityMs(task);
  if (!Number.isFinite(activity) || activity <= 0) return false;
  const bounds = activityBounds(window, now);
  if (bounds.from !== null && activity < bounds.from) return false;
  if (bounds.to !== null && activity > bounds.to) return false;
  return true;
}

export function ActivityWindowFilter({
  value,
  onChange,
  className,
}: {
  value: ActivityWindow;
  onChange: (value: ActivityWindow) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const active = activityWindowActive(value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1.5 border border-paper-rule bg-paper px-2.5 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors hover:bg-paper-sunk hover:text-ink",
            active ? "text-ink" : "text-ink-soft",
            className,
          )}
        >
          <Clock3 className="size-3 shrink-0 text-ink-faint" />
          <span className="max-w-[12rem] truncate normal-case">
            {triggerLabel(value)}
          </span>
          <ChevronsUpDown className="size-3 shrink-0 text-ink-faint" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="border-b border-paper-rule px-3 py-2">
          <div className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Last activity
          </div>
          <div className="grid grid-cols-6 border border-paper-rule">
            {PRESETS.map((preset, i) => (
              <button
                key={preset.value}
                type="button"
                onClick={() =>
                  onChange({
                    preset: preset.value,
                    from: null,
                    to: null,
                  })
                }
                className={cn(
                  "h-7 font-mono text-[10px] uppercase tracking-[0.04em] transition-colors",
                  i > 0 && "border-l border-paper-rule",
                  value.preset === preset.value && !value.from && !value.to
                    ? "bg-ink text-paper"
                    : "bg-paper text-ink-soft hover:bg-paper-sunk hover:text-ink",
                )}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 border-b border-paper-rule px-3 py-2">
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              From
            </span>
            <input
              type="datetime-local"
              value={toLocalInput(value.from)}
              max={toLocalInput(value.to) || undefined}
              onChange={(e) =>
                onChange({
                  ...value,
                  preset: "custom",
                  from: fromLocalInput(e.target.value),
                })
              }
              className="h-8 w-full border border-paper-rule bg-paper px-2 font-mono text-[11px] tabular-nums text-ink outline-none transition-colors focus:border-ink-soft"
            />
          </label>
          <label className="block">
            <span className="mb-1 block font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
              To
            </span>
            <input
              type="datetime-local"
              value={toLocalInput(value.to)}
              min={toLocalInput(value.from) || undefined}
              onChange={(e) =>
                onChange({
                  ...value,
                  preset: "custom",
                  to: fromLocalInput(e.target.value),
                })
              }
              className="h-8 w-full border border-paper-rule bg-paper px-2 font-mono text-[11px] tabular-nums text-ink outline-none transition-colors focus:border-ink-soft"
            />
          </label>
        </div>

        <div className="flex items-center justify-between px-3 py-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            Uses updates, comments, and task events
          </span>
          {active && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_ACTIVITY_WINDOW)}
              className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft transition-colors hover:text-plot-red"
            >
              Clear
            </button>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function triggerLabel(window: ActivityWindow): string {
  if (window.preset !== "custom") {
    return window.preset === "all" ? "Activity" : `Activity ${window.preset}`;
  }
  const from = window.from ? compactDateTime(window.from) : null;
  const to = window.to ? compactDateTime(window.to) : null;
  if (from && to) return `Activity ${from}-${to}`;
  if (from) return `Activity >= ${from}`;
  if (to) return `Activity <= ${to}`;
  return "Activity custom";
}

function activityBounds(
  window: ActivityWindow,
  now: Date,
): { from: number | null; to: number | null } {
  if (window.preset === "custom") {
    return {
      from: window.from ? Date.parse(window.from) : null,
      to: window.to ? Date.parse(window.to) : null,
    };
  }
  const minutes = presetMinutes(window.preset);
  if (minutes === null) return { from: null, to: null };
  return { from: now.getTime() - minutes * 60_000, to: null };
}

function presetMinutes(preset: ActivityPreset): number | null {
  switch (preset) {
    case "30m":
      return 30;
    case "1h":
      return 60;
    case "6h":
      return 6 * 60;
    case "24h":
      return 24 * 60;
    case "7d":
      return 7 * 24 * 60;
    case "all":
    case "custom":
      return null;
  }
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function compactDateTime(iso: string): string {
  return toLocalInput(iso).replace("T", " ");
}
