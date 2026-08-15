export interface ToolCatalogNotice {
  id?: string;
  ts?: number;
  agentId: string;
  previousGeneration: number | null;
  currentGeneration: number;
  addedToolNames: string[];
  removedToolNames: string[];
  addedHostedTools: Array<{
    toolName: string;
    grantStatus: "granted";
  }>;
  responseMessageId?: string;
  taskId?: string;
}

export function isToolCatalogNotice(value: unknown): value is ToolCatalogNotice {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.agentId === "string" &&
    typeof obj.currentGeneration === "number" &&
    (typeof obj.previousGeneration === "number" ||
      obj.previousGeneration === null) &&
    Array.isArray(obj.addedToolNames) &&
    Array.isArray(obj.removedToolNames) &&
    Array.isArray(obj.addedHostedTools)
  );
}

export function catalogNoticeKey(notice: ToolCatalogNotice): string {
  return [
    notice.id,
    notice.responseMessageId,
    notice.taskId,
    notice.agentId,
    notice.previousGeneration,
    notice.currentGeneration,
    notice.addedToolNames.join(","),
    notice.removedToolNames.join(","),
  ]
    .filter((part) => part !== undefined && part !== null && part !== "")
    .join("|");
}

export function mergeCatalogNotices(
  prev: ToolCatalogNotice[],
  incoming: ToolCatalogNotice[],
): ToolCatalogNotice[] {
  if (incoming.length === 0) return prev;
  const byKey = new Map(prev.map((notice) => [catalogNoticeKey(notice), notice]));
  for (const notice of incoming) byKey.set(catalogNoticeKey(notice), notice);
  return [...byKey.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
}

export function catalogNoticesFromTimeline(events: unknown): ToolCatalogNotice[] {
  if (!Array.isArray(events)) return [];
  const notices: ToolCatalogNotice[] = [];
  for (const event of events) {
    if (!event || typeof event !== "object") continue;
    const row = event as Record<string, unknown>;
    if (row.eventType !== "session.tool_catalog.changed") continue;
    const payload = row.payload;
    if (!isToolCatalogNotice(payload)) continue;
    notices.push({
      ...payload,
      id: typeof row.id === "string" ? row.id : payload.id,
      ts: typeof row.createdAtMs === "number" ? row.createdAtMs : payload.ts,
    });
  }
  return notices;
}
