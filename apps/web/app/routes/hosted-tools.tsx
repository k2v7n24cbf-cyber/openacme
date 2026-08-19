import { useEffect, useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Plug } from "lucide-react";
import { z } from "zod";
import { Sidebar } from "@/app/components/Sidebar";
import { API_BASE } from "@/app/lib/api";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import {
  buildHostedIntegrationsAdminRows,
  hostedIntegrationRefreshActionAccessibleLabel,
  type HostedIntegrationAdminFamilyRow,
  type HostedIntegrationFailureBucket,
  type HostedIntegrationFamilyDetail,
  type HostedIntegrationFamilyLock,
  type HostedIntegrationFamilySummary,
  type HostedIntegrationGenerationSummary,
} from "@/app/lib/hosted-integrations-admin";
import type { HostedIntegrationEnvironmentConfig } from "@/app/lib/hosted-integration-agent-settings";
import {
  HostedIntegrationsSettingsTab,
  type HostedEditorSection,
  type HostedHelpSection,
} from "./settings";

const HOSTED_TOOL_TABS = [
  "overview",
  "code",
  "help",
  "config",
  "vocabularies",
  "agents",
  "files",
  "test",
  "debug",
  "version",
  "logs",
  "failures",
  "publish",
] as const satisfies readonly HostedEditorSection[];

const HOSTED_TOOL_HELP_SECTIONS = [
  "tool",
  "parameters",
] as const satisfies readonly HostedHelpSection[];

export const Route = createFileRoute("/hosted-tools")({
  validateSearch: z.object({
    family: z.string().optional().catch(undefined),
    tool: z.string().optional().catch(undefined),
    tab: z.enum(HOSTED_TOOL_TABS).optional().catch(undefined),
    help: z.enum(HOSTED_TOOL_HELP_SECTIONS).optional().catch(undefined),
  }),
  component: HostedToolsPage,
});

function HostedToolsPage() {
  const navigate = useNavigate({ from: "/hosted-tools" });
  const search = Route.useSearch();
  const [rows, setRows] = useState<HostedIntegrationAdminFamilyRow[]>([]);
  const [generations, setGenerations] = useState<
    HostedIntegrationGenerationSummary[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  usePublishCurrentView(
    useMemo(
      () => ({
        page: "/hosted-tools",
        entityType: "hostedTools" as const,
        entityId: null,
        tab: "families",
        content: rows,
      }),
      [rows],
    ),
  );

  useEffect(() => {
    const ctrl = new AbortController();
    void loadHostedTools(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadHostedTools(signal?: AbortSignal) {
    setLoading(true);
    setError(null);
    try {
      const [familiesRes, generationsRes, environmentConfigsRes, bucketsRes] =
        await Promise.all([
          fetch(`${API_BASE}/api/hosted-integrations/families`, { signal }),
          fetch(`${API_BASE}/api/hosted-integrations/generations`, { signal }),
          fetch(`${API_BASE}/api/hosted-integrations/environment-configs`, {
            signal,
          }),
          fetch(
            `${API_BASE}/api/hosted-integrations/failure-buckets?actorId=agent:tool-developer`,
            { signal },
          ),
        ]);
      if (!familiesRes.ok) throw new Error("Failed to load hosted tools");
      const families =
        (
          (await familiesRes.json()) as {
            families?: HostedIntegrationFamilySummary[];
          }
        ).families ?? [];
      const [familyDetails, locks] = await Promise.all([
        Promise.all(
          families.map(async (family) => {
            const res = await fetch(
              `${API_BASE}/api/hosted-integrations/families/${encodeURIComponent(family.id)}`,
              { signal },
            );
            if (!res.ok) return null;
            return (
              (await res.json()) as {
                family: HostedIntegrationFamilyDetail;
              }
            ).family;
          }),
        ),
        Promise.all(
          families.map(async (family) => {
            const res = await fetch(
              `${API_BASE}/api/hosted-integrations/families/${encodeURIComponent(family.id)}/lock`,
              { signal },
            );
            if (!res.ok) return null;
            return (
              (await res.json()) as {
                lock: HostedIntegrationFamilyLock | null;
              }
            ).lock;
          }),
        ),
      ]);
      const nextGenerations = generationsRes.ok
        ? ((
            (await generationsRes.json()) as {
              generations?: HostedIntegrationGenerationSummary[];
            }
          ).generations ?? [])
        : [];
      const environmentConfigs = environmentConfigsRes.ok
        ? ((
            (await environmentConfigsRes.json()) as {
              environmentConfigs?: HostedIntegrationEnvironmentConfig[];
            }
          ).environmentConfigs ?? [])
        : [];
      const failureBuckets = bucketsRes.ok
        ? ((
            (await bucketsRes.json()) as {
              buckets?: HostedIntegrationFailureBucket[];
            }
          ).buckets ?? [])
        : [];

      setGenerations(nextGenerations);
      setRows(
        buildHostedIntegrationsAdminRows({
          families,
          familyDetails: familyDetails.filter(
            (detail): detail is HostedIntegrationFamilyDetail =>
              detail !== null,
          ),
          generations: nextGenerations,
          environmentConfigs,
          failureBuckets,
          locks,
        }),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  function updateHostedToolViewState(patch: {
    familyId?: string;
    toolName?: string | null;
    editorSection?: HostedEditorSection;
    helpSection?: HostedHelpSection;
  }) {
    void navigate({
      replace: true,
      search: (current) => ({
        ...current,
        family: patch.familyId ?? current.family,
        tool:
          patch.toolName === null
            ? undefined
            : (patch.toolName ?? current.tool),
        tab: patch.editorSection ?? current.tab,
        help: patch.helpSection ?? current.help,
      }),
    });
  }

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />
      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-paper-rule px-3 md:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <Plug className="size-4 text-ink-soft" aria-hidden="true" />
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Hosted Tools
            </h1>
          </div>
          <button
            type="button"
            onClick={() => void loadHostedTools()}
            aria-label={hostedIntegrationRefreshActionAccessibleLabel(
              "hosted tools",
            )}
            className="border border-paper-rule px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-ink"
          >
            Refresh
          </button>
        </header>
        <div className="flex-1 overflow-y-auto scroll-pb-[calc(5.25rem+env(safe-area-inset-bottom))] pb-[calc(5.25rem+env(safe-area-inset-bottom))] md:scroll-pb-0 md:pb-0">
          <HostedIntegrationsSettingsTab
            rows={rows}
            generations={generations}
            loading={loading}
            error={error}
            onRefresh={() => void loadHostedTools()}
            viewState={{
              familyId: search.family,
              toolName: search.tool,
              editorSection: search.tab,
              helpSection: search.help,
            }}
            onViewStateChange={updateHostedToolViewState}
          />
        </div>
      </main>
    </div>
  );
}
