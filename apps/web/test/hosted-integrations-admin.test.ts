import { describe, expect, it } from "vitest";
import { buildHostedIntegrationsAdminRows } from "@/app/lib/hosted-integrations-admin";

describe("hosted integrations admin view model", () => {
  it("aggregates families with active generation, scopes, locks, and open bucket counts", () => {
    const rows = buildHostedIntegrationsAdminRows({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          version: 2,
          toolNames: ["qualys_count_assets"],
          status: "active",
        },
      ],
      familyDetails: [
        {
          summary: {
            id: "qualys",
            name: "Qualys",
            version: 2,
            toolNames: ["qualys_count_assets"],
            status: "active",
          },
          manifest: {
            id: "qualys",
            name: "Qualys",
            version: 2,
            tools: [
              {
                name: "qualys_count_assets",
                title: "Count assets",
                description: "Count assets.",
                lifecycle: "active",
                classification: {
                  operation: "read",
                  freshness: "live",
                  idempotency: "idempotent",
                  execution: "sync",
                  approval: "none",
                },
              },
            ],
          },
        },
      ],
      generations: [
        {
          id: "gen_1",
          familyId: "qualys",
          sourceRevisionId: "source_rev_1",
          status: "active",
          promotedAt: "2026-08-12T00:00:00.000Z",
          promotedBy: "agent:tool-developer",
        },
      ],
      configScopes: [
        {
          id: "qualys-prod",
          familyId: "qualys",
          revision: 1,
          environment: "prod",
          config: { QUALYS_BASE_URL: "https://qualys.example" },
          secrets: {
            QUALYS_TOKEN: { configured: true },
            QUALYS_UNUSED: { configured: false },
          },
          updatedAt: "2026-08-12T00:00:00.000Z",
          updatedBy: "human:alen",
        },
      ],
      failureBuckets: [
        {
          id: "bucket_open",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_1",
          status: "open",
          count: 2,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
        },
        {
          id: "bucket_closed",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          generationId: "gen_1",
          status: "closed",
          count: 1,
          latestSeenAt: "2026-08-12T00:00:00.000Z",
        },
      ],
      locks: [
        {
          id: "lock_1",
          familyId: "qualys",
          lockedBy: "agent:tool-developer",
          expiresAt: "2026-08-12T01:00:00.000Z",
        },
      ],
    });

    expect(rows).toEqual([
      expect.objectContaining({
        id: "qualys",
        activeGeneration: expect.objectContaining({ id: "gen_1" }),
        openFailureBucketCount: 1,
        lock: expect.objectContaining({ id: "lock_1" }),
        configScopes: [
          {
            id: "qualys-prod",
            environment: "prod",
            revision: 1,
            configKeyCount: 1,
            configuredSecretCount: 1,
          },
        ],
      }),
    ]);
    expect(JSON.stringify(rows)).not.toContain("secret-value");
  });
});
