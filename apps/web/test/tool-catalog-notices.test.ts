import { describe, expect, it } from "vitest";
import {
  catalogNoticesFromTimeline,
  mergeCatalogNotices,
} from "../app/lib/toolCatalogNotices";

describe("tool catalog notices", () => {
  it("parses only catalog timeline events and merges duplicates", () => {
    const notice = {
      agentId: "helper",
      previousGeneration: 1,
      currentGeneration: 2,
      addedToolNames: ["hosted_demo__count"],
      removedToolNames: [],
      addedHostedTools: [
        { toolName: "hosted_demo__count", grantStatus: "granted" },
      ],
      responseMessageId: "assistant-1",
    };

    const parsed = catalogNoticesFromTimeline([
      {
        id: "event-ignored",
        createdAtMs: 10,
        eventType: "session.user_message.received",
        payload: notice,
      },
      {
        id: "event-catalog",
        createdAtMs: 20,
        eventType: "session.tool_catalog.changed",
        payload: notice,
      },
    ]);

    expect(parsed).toEqual([{ ...notice, id: "event-catalog", ts: 20 }]);
    expect(mergeCatalogNotices(parsed, parsed)).toHaveLength(1);
  });
});
