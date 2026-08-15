import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type UIEvent,
} from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import {
  Check,
  Key,
  Server,
  Cpu,
  Boxes,
  Trash2,
  FileText,
  Search,
  Globe2,
  Bell,
  Users,
  Mail,
  Plug,
  ChevronDown,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";
import { toast } from "sonner";
import { Sidebar } from "../components/Sidebar";
import { NotificationsTab } from "../components/NotificationsTab";
import { MembersTab } from "../components/MembersTab";
import { API_BASE } from "../lib/api";
import { docsUrl } from "../lib/links";
import { usePublishCurrentView } from "@/app/lib/CurrentViewContext";
import type { ModelDefaultsView, ModelDefaultsUpdate } from "../lib/types";
import {
  hostedIntegrationCodeActionAccessibleLabels,
  hostedIntegrationCodeEmptyStateText,
  buildHostedIntegrationAgentBindingMatrix,
  buildHostedIntegrationCodeActionState,
  hostedIntegrationConfigEmptyStateText,
  hostedIntegrationEnvironmentConfigAccessibleLabel,
  buildHostedIntegrationArtifactActionState,
  buildHostedIntegrationExecutionLogActionState,
  hostedIntegrationEditLockActionAccessibleLabels,
  buildHostedIntegrationExecutionLogRows,
  hostedIntegrationDebugActionAccessibleLabel,
  hostedIntegrationDebugArgumentsAccessibleLabel,
  buildHostedIntegrationDebugActionState,
  hostedIntegrationDraftFileActionAccessibleLabels,
  hostedIntegrationEditorModeLabel,
  hostedIntegrationEditorSectionAccessibleLabel,
  buildHostedIntegrationEditorModel,
  buildHostedIntegrationExampleActionState,
  hostedIntegrationExampleActionAccessibleLabels,
  hostedIntegrationExampleEmptyStateText,
  hostedIntegrationExamplePayloadAccessibleLabel,
  hostedIntegrationExampleResultAccessibleLabel,
  hostedIntegrationExampleSelectorAccessibleLabel,
  hostedIntegrationDebugEnvironmentConfigAccessibleLabel,
  hostedIntegrationDebugUnavailableReason,
  buildHostedIntegrationDraftFileActionState,
  hostedIntegrationExecutionLogDetailAccessibleLabels,
  hostedIntegrationExecutionLogRowAccessibleLabel,
  hostedIntegrationFamilyNavigationAccessibleLabel,
  hostedIntegrationFileEditorAccessibleLabel,
  hostedIntegrationFileEmptyStateText,
  hostedIntegrationFileModeAccessibleLabel,
  hostedIntegrationFileNavigationAccessibleLabel,
  hostedIntegrationFailureBucketActionAccessibleLabels,
  hostedIntegrationFailureBucketAccessibleLabel,
  hostedIntegrationFailureBucketHitLabel,
  hostedIntegrationLogScopeAccessibleLabel,
  hostedIntegrationPublishAccessibleLabels,
  hostedIntegrationRefreshLogsAccessibleLabel,
  hostedIntegrationSecretActionAccessibleLabel,
  hostedIntegrationSecretInputAccessibleLabel,
  hostedIntegrationSecretStatusLabel,
  buildHostedIntegrationToolHelpActionState,
  hostedIntegrationToolHelpActionAccessibleLabels,
  hostedIntegrationToolHelpEmptyStateText,
  hostedIntegrationToolHelpExampleAccessibleLabels,
  hostedIntegrationToolHelpFieldAccessibleLabels,
  hostedIntegrationToolHelpParameterRowAccessibleLabels,
  hostedIntegrationToolNavigationAccessibleLabel,
  hostedIntegrationVersionActionAccessibleLabels,
  hostedIntegrationVersionEmptyStateText,
  hostedIntegrationVersionRowAccessibleLabel,
  buildHostedIntegrationFailureBucketActionState,
  buildHostedIntegrationFailureSummaryState,
  hostedIntegrationDebugResultAccessibleLabel,
  buildHostedIntegrationPublishActionState,
  buildHostedIntegrationPublishViewState,
  buildHostedIntegrationVersionActionState,
  buildHostedIntegrationVersionRows,
  filterHostedIntegrationExecutionLogRows,
  hostedIntegrationExecutionLogPrimaryHeader,
  hostedIntegrationExecutionConfigLabel,
  hostedIntegrationExecutionConfigRevisionLabel,
  hostedIntegrationRequiresEnvironmentConfig,
  selectHostedIntegrationEditableSourcePath,
  shouldBlockHostedIntegrationFamilyNavigation,
  type HostedIntegrationAdminFamilyRow,
  type HostedIntegrationAgentBindingMatrix,
  type HostedIntegrationAgentBindingMatrixRowInput,
  type HostedIntegrationExecutionLogEntry,
  type HostedIntegrationExecutionLogScope,
  type HostedIntegrationFocusedSourceView,
  type HostedIntegrationFamilyLock,
  type HostedIntegrationGenerationSummary,
  type HostedIntegrationToolSpec,
} from "@/app/lib/hosted-integrations-admin";
import type { HostedIntegrationEnvironmentConfig } from "@/app/lib/hosted-integration-agent-settings";
import { McpManager } from "@/app/components/mcp/McpManager";
import { Button } from "@/app/components/ui/button";
import { Input } from "@/app/components/ui/input";
import { Label } from "@/app/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/app/components/ui/radio-group";
import { Textarea } from "@/app/components/ui/textarea";
import { LoadingHairline } from "@/app/components/ui/loading-hairline";
import { SectionEyebrow } from "@/app/components/ui/section-eyebrow";
import { Badge } from "@/app/components/ui/badge";
import { EmptyState } from "@/app/components/ui/empty-state";
import { cn } from "@/app/lib/utils";
import {
  GoogleIcon,
  MicrosoftIcon,
  ProviderBrandLogo,
  ToolBrandLogo,
} from "@/app/components/BrandIcons";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/app/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/app/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/app/components/ui/select";

interface ServerConfig {
  dataDir: string;
  // Mirrors `ConfigResponse.model` in @openacme/server/src/app.ts. Workforce
  // default — every agent without its own `model:` block inherits this.
  model: ModelDefaultsView;
  server: { port: number; host: string };
  skills: { directory: string; autoGenerate: boolean };
}

interface Provider {
  id: string;
  name: string;
  requiresApiKey: boolean;
  envVar?: string;
  defaultBaseUrl?: string;
  supportsOAuth?: boolean;
  apiKeyConfigured?: boolean;
  oauthConfigured?: boolean;
  models?: Array<{ id: string; label: string; hint?: string }>;
}

interface HostedIntegrationFileEntry {
  path: string;
  size: number;
}

interface HostedIntegrationDraft {
  id: string;
  familyId: string;
  sourceRevisionId: string;
  lockId: string;
  status: "open" | "promoted" | "cancelled";
  updatedAt: string;
}

interface HostedIntegrationExample {
  id: string;
  familyId: string;
  toolName: string;
  category: string;
  args: Record<string, unknown>;
  expected?: unknown;
}

export type HostedEditorSection =
  | "code"
  | "help"
  | "config"
  | "agents"
  | "files"
  | "test"
  | "debug"
  | "version"
  | "logs"
  | "failures"
  | "publish";

export type HostedHelpSection = "tool" | "parameters";

interface HostedIntegrationToolHelpEditorState {
  summary: string;
  full: string;
  whenToUse: string;
  whenNotToUse: string;
  parameters: HostedIntegrationToolHelpParameterEditorState[];
  examples: HostedIntegrationToolHelpExampleEditorState[];
  noExampleJustification: string;
}

interface HostedIntegrationToolHelpParameterEditorState {
  name: string;
  summary: string;
  full: string;
  shapeJson: string;
  rules: string;
  examples: HostedIntegrationToolHelpExampleEditorState[];
}

interface HostedIntegrationToolHelpExampleEditorState {
  valueJson: string;
}

const HOSTED_INTEGRATION_EDITOR_ACTOR = {
  id: "web-settings",
  kind: "human",
  roles: ["tool_developer"],
} as const;

const HOSTED_INTEGRATION_EDITOR_CAN_MANAGE =
  HOSTED_INTEGRATION_EDITOR_ACTOR.roles.includes("tool_developer");

const HOSTED_HELP_INPUT_CLASS =
  "border-0 border-b border-paper-rule bg-transparent px-0 shadow-none focus-visible:border-plot-red";
const HOSTED_HELP_TEXTAREA_CLASS =
  "field-sizing-fixed min-h-0 w-full max-w-none border-0 border-b border-paper-rule bg-transparent px-0 py-1 shadow-none focus-visible:border-plot-red";

const SETTINGS_TABS = [
  "api-keys",
  "server",
  "members",
  "providers",
  "mcp",
  "web-search",
  "browser",
  "email",
  "notifications",
  "context",
] as const;

export const Route = createFileRoute("/settings")({
  validateSearch: z.object({
    tab: z.enum(SETTINGS_TABS).optional().catch(undefined),
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const navigate = useNavigate();
  const activeTab = Route.useSearch().tab ?? "api-keys";
  const [config, setConfig] = useState<ServerConfig | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [configuredKeys, setConfiguredKeys] = useState<Record<string, boolean>>(
    {},
  );
  const [apiKeyInputs, setApiKeyInputs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  // Default-model editor — workforce-wide root config.yaml#model. `draft` is
  // hydrated from the loaded `config.model` and pushed via PUT
  // /api/config/model, which calls reloadConfig server-side so the change
  // applies live (cached Agents evicted) — no restart.
  const [modelDraft, setModelDraft] = useState<ModelDefaultsView | null>(null);
  const [modelSaving, setModelSaving] = useState(false);

  // Subscription paths: state shared by Anthropic Claude Code import + OpenAI
  // ChatGPT OAuth (both surfaced inline with the API-key field, below).
  const [claudeCodeAvailable, setClaudeCodeAvailable] = useState(false);
  const [subAction, setSubAction] = useState<string | null>(null);

  // MCP management lives in <McpManager scope="global" /> (self-contained).

  // AGENTS.md — shared context for every agent. null = file absent.
  const [agentsMd, setAgentsMd] = useState<string | null>(null);
  const [agentsMdDraft, setAgentsMdDraft] = useState("");
  const [agentsMdSaving, setAgentsMdSaving] = useState(false);

  // Web search — Tavily / Exa / Brave keys + active-provider override.
  interface WebSearchStatus {
    providers: string[];
    configured: Record<string, boolean>;
    override: string | null;
    active: string;
  }
  const [webSearch, setWebSearch] = useState<WebSearchStatus | null>(null);
  const [webKeyInputs, setWebKeyInputs] = useState<Record<string, string>>({});
  const [webSaving, setWebSaving] = useState<string | null>(null);
  const [webOverrideSaving, setWebOverrideSaving] = useState(false);

  // Browser — provider selection + per-cloud creds + local-only knobs.
  interface BrowserStatus {
    providers: string[];
    localBrowsers: string[];
    active: string;
    localBrowser: string;
    executablePath: string;
    headless: boolean;
    noSandbox: boolean;
    configured: Record<string, boolean>;
    localBrowserReady?: Record<string, boolean>;
    localBrowserFetching?: Record<string, boolean>;
  }
  const [browserCfg, setBrowserCfg] = useState<BrowserStatus | null>(null);
  const [browserExePath, setBrowserExePath] = useState("");
  const [browserShowCustom, setBrowserShowCustom] = useState(false);
  const [browserAdvancedOpen, setBrowserAdvancedOpen] = useState(false);
  const [browserKeyInputs, setBrowserKeyInputs] = useState<
    Record<string, string>
  >({});
  const [browserProjectIdInput, setBrowserProjectIdInput] = useState("");
  const [browserSaving, setBrowserSaving] = useState<string | null>(null);

  interface EmailConfigStatus {
    imap: {
      host?: string;
      port?: number;
      smtpHost?: string;
      smtpPort?: number;
      tls?: boolean;
    } | null;
    google: { clientId: string; configured: boolean };
    microsoft: { clientId: string; tenant: string; configured: boolean };
    redirectUriAuto?: string;
    redirectUriOverride?: string;
  }
  const blankEmailForm = {
    host: "",
    port: "",
    smtpHost: "",
    smtpPort: "",
    googleClientId: "",
    googleClientSecret: "",
    msClientId: "",
    msClientSecret: "",
    msTenant: "",
    redirectUri: "",
  };
  const [emailCfg, setEmailCfg] = useState<EmailConfigStatus | null>(null);
  const [emailForm, setEmailForm] = useState({ ...blankEmailForm });
  const [emailSaving, setEmailSaving] = useState(false);

  // Publish the active settings tab + its draft to the ambient Acme panel.
  usePublishCurrentView(
    useMemo(() => {
      const content =
        activeTab === "providers"
          ? modelDraft
          : activeTab === "mcp"
            ? null
            : activeTab === "context"
              ? { agentsMd: agentsMdDraft }
              : activeTab === "email"
                ? emailForm
                : activeTab === "browser"
                  ? browserCfg
                  : activeTab === "web-search"
                    ? webSearch
                    : null;
      return {
        page: "/settings",
        entityType: "settings" as const,
        entityId: null,
        tab: activeTab,
        content,
      };
    }, [
      activeTab,
      modelDraft,
      agentsMdDraft,
      emailForm,
      browserCfg,
      webSearch,
    ]),
  );
  // Redirect URI to register with the OAuth app: the typed override (verbatim)
  // or the bind-derived default, falling back to the current origin pre-load.
  const emailRedirect =
    emailForm.redirectUri.trim() ||
    emailCfg?.redirectUriAuto ||
    (typeof window !== "undefined"
      ? `${window.location.origin}/api/email/oauth/callback`
      : "/api/email/oauth/callback");

  const loadEmail = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/email/config`, { signal });
      if (!res.ok) return;
      const d = (await res.json()) as EmailConfigStatus;
      setEmailCfg(d);
      setEmailForm({
        host: d.imap?.host ?? "",
        port: d.imap?.port?.toString() ?? "",
        smtpHost: d.imap?.smtpHost ?? "",
        smtpPort: d.imap?.smtpPort?.toString() ?? "",
        googleClientId: d.google.clientId,
        googleClientSecret: "",
        msClientId: d.microsoft.clientId,
        msClientSecret: "",
        msTenant: d.microsoft.tenant,
        redirectUri: d.redirectUriOverride ?? "",
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
  };

  const saveEmail = async () => {
    setEmailSaving(true);
    try {
      const f = emailForm;
      const res = await fetch(`${API_BASE}/api/email/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imap: {
            host: f.host,
            port: f.port ? Number(f.port) : undefined,
            smtpHost: f.smtpHost,
            smtpPort: f.smtpPort ? Number(f.smtpPort) : undefined,
          },
          google: {
            clientId: f.googleClientId,
            ...(f.googleClientSecret
              ? { clientSecret: f.googleClientSecret }
              : {}),
          },
          microsoft: {
            clientId: f.msClientId,
            tenant: f.msTenant,
            ...(f.msClientSecret ? { clientSecret: f.msClientSecret } : {}),
          },
          redirectUri: f.redirectUri.trim(),
        }),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error("Failed to save email settings", { description: e.error });
        return;
      }
      toast.success("Email settings saved");
      await loadEmail();
    } catch (e) {
      toast.error("Failed to save email settings", {
        description: (e as Error).message,
      });
    } finally {
      setEmailSaving(false);
    }
  };

  useEffect(() => {
    const ctrl = new AbortController();
    loadConfig(ctrl.signal);
    loadProviders(ctrl.signal);
    loadConfiguredKeys(ctrl.signal);
    loadAgentsMd(ctrl.signal);
    loadWebSearch(ctrl.signal);
    loadBrowser(ctrl.signal);
    loadEmail(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll /api/browser while a local-browser binary is downloading so the
  // status banner clears as soon as it finishes. Quietly idle otherwise.
  useEffect(() => {
    const fetching = browserCfg?.localBrowserFetching;
    if (!fetching) return;
    const anyFetching = Object.values(fetching).some(Boolean);
    if (!anyFetching) return;
    const id = setInterval(() => {
      loadBrowser().catch(() => {});
    }, 2000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserCfg?.localBrowserFetching]);

  const loadConfig = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/config`, { signal });
      if (res.ok) {
        const cfg = (await res.json()) as ServerConfig;
        setConfig(cfg);
        setModelDraft(cfg.model);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to load server config");
    }
  };

  const saveModelDefaults = async (next: ModelDefaultsUpdate) => {
    setModelSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/config/model`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(err?.error ?? "Failed to save default model");
        return;
      }
      toast.success("Default model saved");
      // Re-fetch so the editor reflects disk truth (handles server-side
      // schema-strip of fields like apiKey that we never persist).
      await loadConfig();
    } finally {
      setModelSaving(false);
    }
  };

  const loadProviders = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/models`, { signal });
      if (res.ok) setProviders(await res.json());
    } catch {
      // /api/models may not exist on older servers — fail silently
    }
  };

  const loadConfiguredKeys = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/keys`, { signal });
      if (res.ok) {
        const data = await res.json();
        setConfiguredKeys(data.configured || {});
      }
    } catch {
      // /api/keys may not exist on older servers — fail silently
    }
  };

  // Probe whether the daemon can offer Claude Code keychain import. Cheap
  // file-existence check on the server, no Touch-ID prompt.
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/setup/claude-code-available`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!cancelled && data && typeof data.available === "boolean") {
          setClaudeCodeAvailable(data.available);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ChatGPT OAuth — long-polls until the daemon's loopback callback completes.
  const signInWithOpenAI = async () => {
    setSubAction("openai");
    toast.message("Opened your browser to sign in", {
      description: "Complete the flow there. This panel will update when done.",
    });
    try {
      const r = await fetch(`${API_BASE}/api/setup/oauth-start`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "openai" }),
      });
      const data = (await r.json().catch(() => ({}))) as {
        error?: string;
        email?: string | null;
      };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success(
        data.email
          ? `Signed in as ${data.email}`
          : "ChatGPT subscription linked",
      );
      setConfiguredKeys((prev) => ({ ...prev, openai: true }));
      // Refetch providers so the auth picker's "not signed in" flips.
      void loadProviders();
    } catch (e) {
      toast.error("Sign-in failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  // Anthropic — import the credentials Claude Code already wrote on this
  // machine. On macOS the OS prompts for Touch ID to unlock the keychain.
  const importClaudeCode = async () => {
    setSubAction("anthropic");
    try {
      const r = await fetch(
        `${API_BASE}/api/setup/anthropic-claude-code-import`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ importNow: true }),
        },
      );
      const data = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      toast.success("Imported from Claude Code");
      setConfiguredKeys((prev) => ({ ...prev, anthropic: true }));
      void loadProviders();
    } catch (e) {
      toast.error("Import failed", {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSubAction(null);
    }
  };

  const loadAgentsMd = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, { signal });
      if (!res.ok) return;
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // Fail silently; older servers may not have this endpoint.
    }
  };

  const saveAgentsMd = async () => {
    setAgentsMdSaving(true);
    try {
      const res = await fetch(`${API_BASE}/api/agents-md`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: agentsMdDraft }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error(data.error || "Failed to save AGENTS.md");
        return;
      }
      const data = (await res.json()) as { content: string | null };
      setAgentsMd(data.content);
      setAgentsMdDraft(data.content ?? "");
      toast.success(
        data.content === null ? "AGENTS.md cleared" : "AGENTS.md saved",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAgentsMdSaving(false);
    }
  };

  const saveApiKey = async (provider: string) => {
    const apiKey = apiKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    setSaving(provider);
    try {
      const res = await fetch(`${API_BASE}/api/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setApiKeyInputs({ ...apiKeyInputs, [provider]: "" });
        setConfiguredKeys({ ...configuredKeys, [provider]: true });
        void loadProviders();
      } else {
        const data = await res.json();
        toast.error("Failed to save API key", { description: data.error });
      }
    } catch {
      toast.error("Failed to save API key");
    } finally {
      setSaving(null);
    }
  };

  // ── Web search ──

  const loadWebSearch = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/web`, { signal });
      if (res.ok) setWebSearch(await res.json());
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // older servers may not have this endpoint — fail silently
    }
  };

  const saveWebKey = async (provider: string) => {
    const apiKey = webKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    setWebSaving(provider);
    try {
      const res = await fetch(`${API_BASE}/api/web/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: apiKey.trim() }),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setWebKeyInputs({ ...webKeyInputs, [provider]: "" });
        await loadWebSearch();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save key", { description: data.error });
      }
    } catch (e) {
      toast.error("Failed to save key", { description: (e as Error).message });
    } finally {
      setWebSaving(null);
    }
  };

  const removeWebKey = async (provider: string) => {
    if (!confirm(`Remove the ${provider} API key?`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/web/keys/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to remove key", { description: data.error });
        return;
      }
      toast.success(`${provider} key removed`);
      await loadWebSearch();
    } catch (e) {
      toast.error("Failed to remove key", {
        description: (e as Error).message,
      });
    }
  };

  const saveWebOverride = async (next: string) => {
    setWebOverrideSaving(true);
    try {
      const provider = next === "auto" ? null : next;
      const res = await fetch(`${API_BASE}/api/web/provider`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to update provider", { description: data.error });
        return;
      }
      toast.success(
        provider ? `Provider set to ${provider}` : "Provider set to auto",
      );
      await loadWebSearch();
    } catch (e) {
      toast.error("Failed to update provider", {
        description: (e as Error).message,
      });
    } finally {
      setWebOverrideSaving(false);
    }
  };

  // ── Browser ──

  const loadBrowser = async (signal?: AbortSignal) => {
    try {
      const res = await fetch(`${API_BASE}/api/browser`, { signal });
      if (res.ok) {
        const data = (await res.json()) as BrowserStatus;
        setBrowserCfg(data);
        setBrowserExePath(data.executablePath ?? "");
        setBrowserShowCustom(!!data.executablePath);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      // older servers may not have this endpoint — fail silently
    }
  };

  const saveBrowserConfig = async (
    patch: Record<string, unknown>,
    label: string,
  ) => {
    setBrowserSaving(label);
    try {
      const res = await fetch(`${API_BASE}/api/browser/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save browser settings", {
          description: data.error,
        });
        return;
      }
      toast.success("Browser settings saved");
      await loadBrowser();
    } catch (e) {
      toast.error("Failed to save browser settings", {
        description: (e as Error).message,
      });
    } finally {
      setBrowserSaving(null);
    }
  };

  const saveBrowserKey = async (provider: string) => {
    const apiKey = browserKeyInputs[provider];
    if (!apiKey?.trim()) {
      toast.error("Please enter an API key");
      return;
    }
    const payload: Record<string, string> = { provider, apiKey: apiKey.trim() };
    if (provider === "browserbase") {
      if (!browserProjectIdInput.trim()) {
        toast.error("Browserbase also needs a project ID");
        return;
      }
      payload.projectId = browserProjectIdInput.trim();
    }
    setBrowserSaving(`key:${provider}`);
    try {
      const res = await fetch(`${API_BASE}/api/browser/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        toast.success(`${provider} key saved`);
        setBrowserKeyInputs({ ...browserKeyInputs, [provider]: "" });
        if (provider === "browserbase") setBrowserProjectIdInput("");
        await loadBrowser();
      } else {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to save key", { description: data.error });
      }
    } catch (e) {
      toast.error("Failed to save key", { description: (e as Error).message });
    } finally {
      setBrowserSaving(null);
    }
  };

  const removeBrowserKey = async (provider: string) => {
    if (!confirm(`Remove the ${provider} credentials?`)) return;
    try {
      const res = await fetch(
        `${API_BASE}/api/browser/keys/${encodeURIComponent(provider)}`,
        { method: "DELETE" },
      );
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        toast.error("Failed to remove key", { description: data.error });
        return;
      }
      toast.success(`${provider} credentials removed`);
      await loadBrowser();
    } catch (e) {
      toast.error("Failed to remove key", {
        description: (e as Error).message,
      });
    }
  };

  const providersNeedingKeys = providers.filter(
    (p) => p.requiresApiKey && p.envVar,
  );

  return (
    <div className="flex h-[100dvh] w-full overflow-hidden pb-[calc(3.5rem+env(safe-area-inset-bottom))] md:pb-0">
      <Sidebar />

      <main className="flex flex-1 flex-col overflow-hidden bg-paper">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-paper-rule px-3 md:px-6">
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-[11px] uppercase tracking-[0.08em] text-ink-faint">
              Settings
            </h1>
          </div>
        </header>

        <Tabs
          value={activeTab}
          onValueChange={(tab) =>
            void navigate({
              to: "/settings",
              search: { tab: tab as (typeof SETTINGS_TABS)[number] },
              replace: true,
            })
          }
          orientation="vertical"
          className="flex flex-1 flex-col overflow-hidden md:flex-row"
        >
          {/* Section rail: vertical list on desktop (the primitive's 2px
              plot-red left marker = the sidebar active treatment),
              horizontal scroll row on mobile. The !-overrides beat the
              primitive's vertical-orientation w-fit/h-fit/flex-col. */}
          <TabsList className="flex-nowrap overflow-x-auto max-md:!w-full max-md:!flex-row md:!h-full md:!w-56 md:shrink-0 md:items-stretch md:overflow-x-hidden md:overflow-y-auto md:border-b-0 md:border-r md:py-2">
            <TabsTrigger
              value="api-keys"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Key className="size-3.5" />
              API Keys
            </TabsTrigger>
            <TabsTrigger
              value="server"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Server className="size-3.5" />
              Server
            </TabsTrigger>
            <TabsTrigger
              value="members"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Users className="size-3.5" />
              Members
            </TabsTrigger>
            <TabsTrigger
              value="providers"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Cpu className="size-3.5" />
              Providers
            </TabsTrigger>
            <TabsTrigger
              value="mcp"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Boxes className="size-3.5" />
              MCP
            </TabsTrigger>
            <TabsTrigger
              value="web-search"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Search className="size-3.5" />
              Web Search
            </TabsTrigger>
            <TabsTrigger
              value="browser"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Globe2 className="size-3.5" />
              Browser
            </TabsTrigger>
            <TabsTrigger
              value="email"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Mail className="size-3.5" />
              Email
            </TabsTrigger>
            <TabsTrigger
              value="notifications"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <Bell className="size-3.5" />
              Notifications
            </TabsTrigger>
            <TabsTrigger
              value="context"
              className="h-9 shrink-0 max-md:!w-auto md:px-4 data-[state=active]:bg-paper-sunk data-[state=active]:font-medium"
            >
              <FileText className="size-3.5" />
              Context
            </TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-y-auto px-3 pb-6 pt-1 md:px-6">
            <div className="mx-auto max-w-5xl">
              <TabsContent value="api-keys">
                <Card>
                  <CardHeader>
                    <CardTitle>API Keys</CardTitle>
                    <CardDescription>
                      Saved to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/.env
                      </code>{" "}
                      on the server. Both the CLI and web app use the same keys.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {providersNeedingKeys.length === 0 && (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading providers…
                      </p>
                    )}
                    {providersNeedingKeys.map((provider) => {
                      const subscriptionLabel =
                        provider.id === "openai"
                          ? "Sign in with ChatGPT"
                          : provider.id === "anthropic" && claudeCodeAvailable
                            ? "Import from Claude Code"
                            : null;
                      const subHandler =
                        provider.id === "openai"
                          ? signInWithOpenAI
                          : provider.id === "anthropic"
                            ? importClaudeCode
                            : null;
                      const subBusy = subAction === provider.id;
                      return (
                        <div key={provider.id} className="grid gap-2">
                          <div className="flex items-center gap-2">
                            <ProviderBrandLogo
                              provider={provider.id}
                              className="size-4 shrink-0"
                            />
                            <Label htmlFor={`key-${provider.id}`}>
                              {provider.name}
                            </Label>
                            <span className="font-mono text-[10px] text-ink-soft">
                              {provider.envVar}
                            </span>
                            {configuredKeys[provider.id] && (
                              <Badge
                                variant="secondary"
                                className="ml-auto gap-1"
                              >
                                <Check className="size-3" />
                                Configured
                              </Badge>
                            )}
                          </div>
                          <div className="flex gap-2">
                            <Input
                              id={`key-${provider.id}`}
                              type="password"
                              value={apiKeyInputs[provider.id] || ""}
                              onChange={(e) =>
                                setApiKeyInputs({
                                  ...apiKeyInputs,
                                  [provider.id]: e.target.value,
                                })
                              }
                              placeholder={
                                configuredKeys[provider.id]
                                  ? "Enter new key to update"
                                  : `Enter ${provider.envVar}`
                              }
                            />
                            <Button
                              onClick={() => saveApiKey(provider.id)}
                              disabled={
                                saving === provider.id ||
                                !apiKeyInputs[provider.id]?.trim()
                              }
                            >
                              {saving === provider.id && (
                                <LoadingHairline inline />
                              )}
                              Save
                            </Button>
                          </div>
                          {subscriptionLabel && subHandler && (
                            <div className="flex items-center justify-between gap-3 pt-1 font-mono text-[11px] text-ink-faint">
                              <span>
                                {provider.id === "anthropic"
                                  ? "Or use Claude Code keychain (Touch ID may prompt)"
                                  : "Or use your existing subscription"}
                              </span>
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={subHandler}
                                disabled={subBusy}
                              >
                                {subBusy && <LoadingHairline inline />}
                                {subscriptionLabel}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="server">
                <Card>
                  <CardHeader>
                    <CardTitle>Server configuration</CardTitle>
                    <CardDescription>
                      Read from{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        config.yaml
                      </code>
                      . Edit the file to change these.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {config ? (
                      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 font-mono text-[12px] tabular-nums">
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Data dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.dataDir}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Server
                        </dt>
                        <dd className="text-ink-soft">
                          {config.server.host}:{config.server.port}
                        </dd>
                        <dt className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Skills dir
                        </dt>
                        <dd className="text-ink-soft break-all">
                          {config.skills.directory}
                        </dd>
                      </dl>
                    ) : (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="providers" className="space-y-6">
                <Card>
                  <CardHeader>
                    <CardTitle>Default model</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {modelDraft === null ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <div className="space-y-5">
                        <div className="grid grid-cols-1 gap-5 md:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor="default-provider">Provider</Label>
                            <Select
                              value={modelDraft.provider ?? ""}
                              onValueChange={(v) => {
                                const nextProvider = providers.find(
                                  (p) => p.id === v,
                                );
                                const newPresets = nextProvider?.models ?? [];
                                const stillValid = newPresets.some(
                                  (m) => m.id === modelDraft.model,
                                );
                                // Auto-fallback to api_key if the user's prior
                                // OAuth selection isn't available on the new
                                // provider — saving an unsupported mode would
                                // fail at first turn.
                                const oauthOk =
                                  modelDraft.auth !== "oauth" ||
                                  nextProvider?.supportsOAuth === true;
                                setModelDraft({
                                  ...modelDraft,
                                  provider: v,
                                  model: stillValid
                                    ? modelDraft.model
                                    : (newPresets[0]?.id ?? ""),
                                  auth: oauthOk ? modelDraft.auth : "api_key",
                                });
                              }}
                            >
                              <SelectTrigger id="default-provider">
                                <SelectValue placeholder="Select a provider" />
                              </SelectTrigger>
                              <SelectContent>
                                {providers.map((p) => (
                                  <SelectItem key={p.id} value={p.id}>
                                    {p.name}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </div>

                          <div className="grid gap-2">
                            <Label htmlFor="default-model">Model</Label>
                            {(() => {
                              const presets =
                                providers.find(
                                  (p) => p.id === modelDraft.provider,
                                )?.models ?? [];
                              if (presets.length === 0) {
                                return (
                                  <Input
                                    id="default-model"
                                    value={modelDraft.model ?? ""}
                                    onChange={(e) =>
                                      setModelDraft({
                                        ...modelDraft,
                                        model: e.target.value,
                                      })
                                    }
                                    placeholder="Enter model id"
                                    className="font-mono text-xs"
                                  />
                                );
                              }
                              return (
                                <Select
                                  value={modelDraft.model ?? ""}
                                  onValueChange={(v) =>
                                    setModelDraft({ ...modelDraft, model: v })
                                  }
                                >
                                  <SelectTrigger id="default-model">
                                    <SelectValue placeholder="Select a model" />
                                  </SelectTrigger>
                                  <SelectContent>
                                    {presets.map((m) => (
                                      <SelectItem key={m.id} value={m.id}>
                                        {m.label}
                                      </SelectItem>
                                    ))}
                                  </SelectContent>
                                </Select>
                              );
                            })()}
                          </div>
                        </div>

                        {/* Authentication — radio group; OAuth hidden when
                            the provider doesn't support it. Inline action
                            offers to sign in / set up the missing side. */}
                        {(() => {
                          const p = providers.find(
                            (x) => x.id === modelDraft.provider,
                          );
                          if (!p) return null;
                          const supportsOAuth = p.supportsOAuth === true;
                          const apiKeyConfigured = p.apiKeyConfigured === true;
                          const oauthConfigured = p.oauthConfigured === true;
                          const auth = modelDraft.auth;
                          const subBusy = subAction === p.id;
                          const oauthAction =
                            p.id === "openai"
                              ? signInWithOpenAI
                              : p.id === "anthropic"
                                ? importClaudeCode
                                : null;
                          const oauthActionLabel =
                            p.id === "openai"
                              ? "Sign in with ChatGPT"
                              : p.id === "anthropic"
                                ? "Import from Claude Code"
                                : "Sign in";
                          return (
                            <div className="grid gap-2">
                              <Label>Authentication</Label>
                              <RadioGroup
                                value={auth}
                                onValueChange={(v) =>
                                  setModelDraft({
                                    ...modelDraft,
                                    auth: v as "api_key" | "oauth",
                                  })
                                }
                              >
                                <label
                                  htmlFor="default-auth-api_key"
                                  className="flex items-start gap-2 text-sm cursor-pointer"
                                >
                                  <RadioGroupItem
                                    value="api_key"
                                    id="default-auth-api_key"
                                    className="mt-1"
                                  />
                                  <span className="flex-1">
                                    <span className="text-ink">API key</span>
                                    <span className="ml-2 font-mono text-[11px] text-ink-faint">
                                      {apiKeyConfigured
                                        ? "configured"
                                        : p.envVar
                                          ? `not configured (set ${p.envVar})`
                                          : "no key needed"}
                                    </span>
                                  </span>
                                </label>
                                {supportsOAuth && (
                                  <label
                                    htmlFor="default-auth-oauth"
                                    className="flex items-start gap-2 text-sm cursor-pointer"
                                  >
                                    <RadioGroupItem
                                      value="oauth"
                                      id="default-auth-oauth"
                                      className="mt-1"
                                    />
                                    <span className="flex-1">
                                      <span className="text-ink">
                                        OAuth subscription
                                      </span>
                                      <span className="ml-2 font-mono text-[11px] text-ink-faint">
                                        {oauthConfigured
                                          ? "signed in"
                                          : "not signed in"}
                                      </span>
                                      {!oauthConfigured && oauthAction && (
                                        <button
                                          type="button"
                                          className="ml-2 text-[11px] text-plot-red underline hover:no-underline disabled:opacity-50"
                                          disabled={subBusy}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            void oauthAction();
                                          }}
                                        >
                                          {subBusy ? "…" : oauthActionLabel}
                                        </button>
                                      )}
                                    </span>
                                  </label>
                                )}
                              </RadioGroup>
                            </div>
                          );
                        })()}

                        {/* Cache TTL — Anthropic-only. Same gating as the per-agent form. */}
                        {(() => {
                          const m = (modelDraft.model ?? "").toLowerCase();
                          const isClaude =
                            modelDraft.provider === "anthropic" ||
                            (modelDraft.provider === "openrouter" &&
                              (m.startsWith("anthropic/") ||
                                m.includes("claude")));
                          if (!isClaude) return null;
                          return (
                            <div className="grid gap-2">
                              <Label htmlFor="default-cache-ttl">
                                Prompt cache TTL
                              </Label>
                              <Select
                                value={modelDraft.cacheTtl}
                                onValueChange={(v) =>
                                  setModelDraft({
                                    ...modelDraft,
                                    cacheTtl: v as "5m" | "1h",
                                  })
                                }
                              >
                                <SelectTrigger
                                  id="default-cache-ttl"
                                  className="md:max-w-xs"
                                >
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="5m">
                                    5 minutes (default)
                                  </SelectItem>
                                  <SelectItem value="1h">1 hour</SelectItem>
                                </SelectContent>
                              </Select>
                            </div>
                          );
                        })()}

                        <div className="flex items-center gap-3">
                          <Button
                            type="button"
                            disabled={
                              modelSaving ||
                              !modelDraft.provider ||
                              !modelDraft.model
                            }
                            onClick={() =>
                              saveModelDefaults({
                                provider: modelDraft.provider,
                                model: modelDraft.model,
                                cacheTtl: modelDraft.cacheTtl,
                                auth: modelDraft.auth,
                              })
                            }
                          >
                            {modelSaving ? "Saving…" : "Save default model"}
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>Available providers</CardTitle>
                    <CardDescription>
                      Models the platform can talk to. Configure API keys above.
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {providers.length === 0 ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <div className="grid grid-cols-2 gap-px bg-paper-rule sm:grid-cols-3">
                        {providers.map((provider) => (
                          <div key={provider.id} className="bg-paper p-3">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-ink">
                                {provider.name}
                              </span>
                              {configuredKeys[provider.id] && (
                                <Check className="size-3.5 text-plot-red" />
                              )}
                            </div>
                            <div className="mt-1 font-mono text-[11px] text-ink-faint">
                              {provider.requiresApiKey
                                ? provider.envVar
                                : "no key needed"}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="mcp">
                <McpManager scope="global" />
              </TabsContent>

              <TabsContent value="web-search">
                <Card>
                  <CardHeader>
                    <CardTitle>Web search</CardTitle>
                    <CardDescription>
                      Provider used by the web search tool. Add a key to use a
                      higher-limit provider or switch.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {!webSearch ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <>
                        <div className="grid gap-2">
                          <Label>Active provider</Label>
                          <div className="flex items-center gap-3">
                            <Select
                              value={webSearch.override ?? "auto"}
                              onValueChange={saveWebOverride}
                              disabled={webOverrideSaving}
                            >
                              <SelectTrigger className="w-48">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="auto">
                                  Auto ({webSearch.active})
                                </SelectItem>
                                <SelectItem value="tavily">Tavily</SelectItem>
                                <SelectItem value="exa">Exa</SelectItem>
                                <SelectItem value="brave">Brave</SelectItem>
                              </SelectContent>
                            </Select>
                            <span className="font-mono text-[11px] text-ink-faint">
                              OPENACME_SEARCH_PROVIDER
                            </span>
                          </div>
                          <p className="font-mono text-[11px] text-ink-faint">
                            Auto picks the first configured provider in order:
                            Tavily → Brave → Exa.
                          </p>
                        </div>

                        {[
                          {
                            id: "tavily",
                            name: "Tavily",
                            envVar: "TAVILY_API_KEY",
                            blurb: "1000 free searches/month — tavily.com",
                          },
                          {
                            id: "exa",
                            name: "Exa",
                            envVar: "EXA_API_KEY",
                            blurb:
                              "1000 free searches/month — exa.ai · key optional (free tier is unauthenticated, 150/day)",
                          },
                          {
                            id: "brave",
                            name: "Brave",
                            envVar: "BRAVE_API_KEY",
                            blurb: "brave.com/search/api",
                          },
                        ].map((p) => {
                          const isConfigured = !!webSearch.configured[p.id];
                          return (
                            <div key={p.id} className="grid gap-2">
                              <div className="flex items-center gap-2">
                                <ToolBrandLogo
                                  id={p.id}
                                  className="size-4 shrink-0"
                                />
                                <Label htmlFor={`web-key-${p.id}`}>
                                  {p.name}
                                </Label>
                                <span className="font-mono text-[10px] text-ink-soft">
                                  {p.envVar}
                                </span>
                                {isConfigured && (
                                  <Badge
                                    variant="secondary"
                                    className="ml-auto gap-1"
                                  >
                                    <Check className="size-3" />
                                    Configured
                                  </Badge>
                                )}
                              </div>
                              <div className="flex gap-2">
                                <Input
                                  id={`web-key-${p.id}`}
                                  type="password"
                                  value={webKeyInputs[p.id] || ""}
                                  onChange={(e) =>
                                    setWebKeyInputs({
                                      ...webKeyInputs,
                                      [p.id]: e.target.value,
                                    })
                                  }
                                  placeholder={
                                    isConfigured
                                      ? "Enter new key to update"
                                      : `Enter ${p.envVar}`
                                  }
                                />
                                <Button
                                  onClick={() => saveWebKey(p.id)}
                                  disabled={
                                    webSaving === p.id ||
                                    !webKeyInputs[p.id]?.trim()
                                  }
                                >
                                  {webSaving === p.id && (
                                    <LoadingHairline inline />
                                  )}
                                  Save
                                </Button>
                                {isConfigured && (
                                  <Button
                                    variant="ghost"
                                    onClick={() => removeWebKey(p.id)}
                                    title="Remove key"
                                  >
                                    <Trash2 className="size-4" />
                                  </Button>
                                )}
                              </div>
                              <p className="font-mono text-[11px] text-ink-faint">
                                {p.blurb}
                              </p>
                            </div>
                          );
                        })}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="browser">
                <Card>
                  <CardHeader>
                    <CardTitle>Browser</CardTitle>
                    <CardDescription>
                      One browser session per agent.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-5">
                    {!browserCfg ? (
                      <p className="font-mono text-[12px] text-ink-faint">
                        Loading…
                      </p>
                    ) : (
                      <>
                        <div className="grid gap-2">
                          <Label>Provider</Label>
                          <Select
                            value={browserCfg.active}
                            onValueChange={(v) =>
                              saveBrowserConfig({ provider: v }, "provider")
                            }
                            disabled={browserSaving === "provider"}
                          >
                            <SelectTrigger className="w-56">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="local">
                                <span className="flex items-center gap-2">
                                  <Boxes className="size-3.5 shrink-0" />
                                  Local
                                </span>
                              </SelectItem>
                              <SelectItem value="browserbase">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="browserbase"
                                    className="size-3.5 shrink-0"
                                  />
                                  Browserbase
                                </span>
                              </SelectItem>
                              <SelectItem value="browser-use">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="browser-use"
                                    className="size-3.5 shrink-0"
                                  />
                                  Browser Use
                                </span>
                              </SelectItem>
                              <SelectItem value="firecrawl">
                                <span className="flex items-center gap-2">
                                  <ToolBrandLogo
                                    id="firecrawl"
                                    className="size-3.5 shrink-0"
                                  />
                                  Firecrawl
                                </span>
                              </SelectItem>
                            </SelectContent>
                          </Select>
                        </div>

                        {browserCfg.active === "local" && (
                          <div className="space-y-4 border border-paper-rule bg-paper-sunk/40 p-4">
                            <div className="grid gap-2">
                              <Label>Browser</Label>
                              <Select
                                value={
                                  browserShowCustom
                                    ? "custom"
                                    : browserCfg.localBrowser
                                }
                                onValueChange={(v) => {
                                  if (v === "custom") {
                                    setBrowserShowCustom(true);
                                    return;
                                  }
                                  setBrowserShowCustom(false);
                                  saveBrowserConfig(
                                    { localBrowser: v, executablePath: "" },
                                    "localBrowser",
                                  );
                                }}
                                disabled={browserSaving === "localBrowser"}
                              >
                                <SelectTrigger className="w-72">
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  <SelectItem value="chromium">
                                    Chromium
                                  </SelectItem>
                                  <SelectItem value="camoufox">
                                    Camoufox (stealth)
                                  </SelectItem>
                                  <SelectItem value="custom">
                                    Custom binary…
                                  </SelectItem>
                                </SelectContent>
                              </Select>
                              {!browserShowCustom &&
                                browserCfg.localBrowserFetching?.[
                                  browserCfg.localBrowser
                                ] && (
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    Downloading {browserCfg.localBrowser}…
                                  </p>
                                )}
                              {!browserShowCustom &&
                                browserCfg.localBrowserReady?.[
                                  browserCfg.localBrowser
                                ] === false &&
                                !browserCfg.localBrowserFetching?.[
                                  browserCfg.localBrowser
                                ] && (
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    Will download on first use.
                                  </p>
                                )}
                            </div>

                            {browserShowCustom && (
                              <div className="grid gap-2">
                                <Label htmlFor="browser-exe">
                                  Path to a Chromium-family binary
                                </Label>
                                <div className="flex gap-2">
                                  <Input
                                    id="browser-exe"
                                    type="text"
                                    placeholder="/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
                                    value={browserExePath}
                                    onChange={(e) =>
                                      setBrowserExePath(e.target.value)
                                    }
                                    className="flex-1"
                                  />
                                  <Button
                                    onClick={() =>
                                      saveBrowserConfig(
                                        { executablePath: browserExePath },
                                        "exe",
                                      )
                                    }
                                    disabled={browserSaving === "exe"}
                                  >
                                    {browserSaving === "exe" && (
                                      <LoadingHairline inline />
                                    )}
                                    Save
                                  </Button>
                                </div>
                              </div>
                            )}

                            <div className="flex items-center gap-2">
                              <input
                                id="browser-headless"
                                type="checkbox"
                                checked={browserCfg.headless}
                                onChange={(e) =>
                                  saveBrowserConfig(
                                    { headless: e.target.checked },
                                    "headless",
                                  )
                                }
                                disabled={browserSaving === "headless"}
                              />
                              <Label htmlFor="browser-headless">Headless</Label>
                              <span className="font-mono text-[11px] text-ink-faint">
                                Don&apos;t show a window. Off so you can log in
                                per agent.
                              </span>
                            </div>

                            <div className="pt-2">
                              <button
                                type="button"
                                onClick={() =>
                                  setBrowserAdvancedOpen(!browserAdvancedOpen)
                                }
                                className="font-mono text-[11px] text-ink-faint hover:text-ink"
                              >
                                {browserAdvancedOpen
                                  ? "Hide advanced"
                                  : "Advanced"}
                              </button>
                              {browserAdvancedOpen && (
                                <div className="mt-3 flex items-center gap-2">
                                  <input
                                    id="browser-nosandbox"
                                    type="checkbox"
                                    checked={browserCfg.noSandbox}
                                    onChange={(e) =>
                                      saveBrowserConfig(
                                        { noSandbox: e.target.checked },
                                        "nosandbox",
                                      )
                                    }
                                    disabled={browserSaving === "nosandbox"}
                                  />
                                  <Label htmlFor="browser-nosandbox">
                                    No sandbox
                                  </Label>
                                  <span className="font-mono text-[11px] text-ink-faint">
                                    Only when running as root in Docker.
                                  </span>
                                </div>
                              )}
                            </div>
                          </div>
                        )}

                        {browserCfg.active !== "local" &&
                          [
                            {
                              id: "browserbase",
                              name: "Browserbase",
                              envVar: "BROWSERBASE_API_KEY",
                              needsProjectId: true,
                              blurb:
                                "browserbase.com — paid tier unlocks proxies + advanced stealth",
                            },
                            {
                              id: "browser-use",
                              name: "Browser Use",
                              envVar: "BROWSER_USE_API_KEY",
                              needsProjectId: false,
                              blurb:
                                "browser-use.com — best stealth pass rate (2026 benchmark)",
                            },
                            {
                              id: "firecrawl",
                              name: "Firecrawl",
                              envVar: "FIRECRAWL_API_KEY",
                              needsProjectId: false,
                              blurb: "firecrawl.dev",
                            },
                          ]
                            .filter((p) => p.id === browserCfg.active)
                            .map((p) => {
                              const isConfigured =
                                !!browserCfg.configured[p.id];
                              return (
                                <div
                                  key={p.id}
                                  className="space-y-3 border border-paper-rule bg-paper-sunk/40 p-4"
                                >
                                  <div className="flex items-center gap-2">
                                    <Label htmlFor={`browser-key-${p.id}`}>
                                      {p.name} API key
                                    </Label>
                                    <span className="font-mono text-[10px] text-ink-soft">
                                      {p.envVar}
                                    </span>
                                    {isConfigured && (
                                      <Badge
                                        variant="secondary"
                                        className="ml-auto gap-1"
                                      >
                                        <Check className="size-3" />
                                        Configured
                                      </Badge>
                                    )}
                                  </div>
                                  <div className="flex gap-2">
                                    <Input
                                      id={`browser-key-${p.id}`}
                                      type="password"
                                      placeholder={
                                        isConfigured
                                          ? "•••••••• (set; paste a new value to replace)"
                                          : "Paste API key"
                                      }
                                      value={browserKeyInputs[p.id] ?? ""}
                                      onChange={(e) =>
                                        setBrowserKeyInputs({
                                          ...browserKeyInputs,
                                          [p.id]: e.target.value,
                                        })
                                      }
                                      className="flex-1"
                                    />
                                    <Button
                                      onClick={() => saveBrowserKey(p.id)}
                                      disabled={browserSaving === `key:${p.id}`}
                                    >
                                      {browserSaving === `key:${p.id}` && (
                                        <LoadingHairline inline />
                                      )}
                                      Save
                                    </Button>
                                    {isConfigured && (
                                      <Button
                                        variant="ghost"
                                        size="icon"
                                        onClick={() => removeBrowserKey(p.id)}
                                        title="Remove credentials"
                                      >
                                        <Trash2 className="size-4" />
                                      </Button>
                                    )}
                                  </div>
                                  {p.needsProjectId && (
                                    <div className="flex gap-2">
                                      <Input
                                        type="text"
                                        placeholder="Project ID (BROWSERBASE_PROJECT_ID)"
                                        value={browserProjectIdInput}
                                        onChange={(e) =>
                                          setBrowserProjectIdInput(
                                            e.target.value,
                                          )
                                        }
                                        className="flex-1"
                                      />
                                    </div>
                                  )}
                                  <p className="font-mono text-[11px] text-ink-faint">
                                    {p.blurb}
                                  </p>
                                </div>
                              );
                            })}
                      </>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="context">
                <Card>
                  <CardHeader>
                    <CardTitle>Shared context (AGENTS.md)</CardTitle>
                    <CardDescription>
                      Optional. If set, prepended to every agent&apos;s system
                      prompt after its persona. Leave blank to remove the file.
                      Saves to{" "}
                      <code className="border border-paper-rule bg-paper-sunk px-1 py-0.5 font-mono text-[11px] text-ink">
                        {config?.dataDir || "~/.openacme"}/AGENTS.md
                      </code>
                      .
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <Textarea
                      value={agentsMdDraft}
                      onChange={(e) => setAgentsMdDraft(e.target.value)}
                      placeholder="Describe what this setup is, what it's for, anything every agent should know…"
                      rows={14}
                      className="font-mono text-[12px]"
                    />
                    <div className="flex items-center justify-between">
                      <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        {agentsMd === null ? "Not set" : "Saved"} ·{" "}
                        {agentsMdDraft.length} chars
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          onClick={() => setAgentsMdDraft(agentsMd ?? "")}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          Reset
                        </Button>
                        <Button
                          onClick={saveAgentsMd}
                          disabled={
                            agentsMdSaving || agentsMdDraft === (agentsMd ?? "")
                          }
                        >
                          {agentsMdSaving && <LoadingHairline inline />}
                          Save
                        </Button>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="email">
                <Card>
                  <CardHeader>
                    <CardTitle>Email</CardTitle>
                    <CardDescription>
                      Workforce-wide defaults. Each agent still binds its own
                      mailbox on its own page.{" "}
                      <a
                        href={docsUrl("/email")}
                        target="_blank"
                        rel="noreferrer"
                        className="text-plot-red underline-offset-2 hover:underline"
                      >
                        Setup guide →
                      </a>
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-6">
                    <section className="space-y-3">
                      <div className="flex items-center gap-2">
                        <Mail className="size-4 text-ink-soft" />
                        <span className="text-sm font-medium text-ink">
                          IMAP / SMTP connection defaults
                        </span>
                      </div>
                      <p className="text-[13px] text-ink-soft">
                        Agents on IMAP inherit these when left blank.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>IMAP host</Label>
                          <Input
                            value={emailForm.host}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                host: e.target.value,
                              }))
                            }
                            placeholder="imap.example.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>IMAP port</Label>
                          <Input
                            value={emailForm.port}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                port: e.target.value,
                              }))
                            }
                            placeholder="993"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>SMTP host</Label>
                          <Input
                            value={emailForm.smtpHost}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                smtpHost: e.target.value,
                              }))
                            }
                            placeholder="smtp.example.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>SMTP port</Label>
                          <Input
                            value={emailForm.smtpPort}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                smtpPort: e.target.value,
                              }))
                            }
                            placeholder="587"
                          />
                        </div>
                      </div>
                    </section>

                    <section className="space-y-3 border-t border-paper-rule pt-5">
                      <div className="flex items-center gap-2">
                        <GoogleIcon className="size-4" />
                        <span className="text-sm font-medium text-ink">
                          Gmail
                        </span>
                        {emailCfg?.google.configured && (
                          <Badge variant="secondary">Configured</Badge>
                        )}
                      </div>
                      <div className="grid gap-2">
                        <Label>Redirect URI</Label>
                        <div className="flex items-stretch gap-2">
                          <Input
                            value={emailForm.redirectUri}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                redirectUri: e.target.value,
                              }))
                            }
                            placeholder={emailCfg?.redirectUriAuto ?? ""}
                            className="flex-1 font-mono text-[12px]"
                          />
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              void navigator.clipboard.writeText(emailRedirect);
                              toast.success("Redirect URI copied");
                            }}
                          >
                            Copy
                          </Button>
                        </div>
                        <p className="text-[12px] text-ink-faint">
                          Add this exact URI to your OAuth app. Leave blank to
                          use the local address (shown); set it when you reach
                          OpenAcme through a tunnel or reverse proxy. The{" "}
                          <code>/api/email/oauth/callback</code> path stays the
                          same.
                        </p>
                      </div>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>Client ID</Label>
                          <Input
                            value={emailForm.googleClientId}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                googleClientId: e.target.value,
                              }))
                            }
                            placeholder="…apps.googleusercontent.com"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Client secret</Label>
                          <Input
                            type="password"
                            value={emailForm.googleClientSecret}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                googleClientSecret: e.target.value,
                              }))
                            }
                            placeholder={
                              emailCfg?.google.configured
                                ? "•••••• (unchanged)"
                                : "GOCSPX-…"
                            }
                          />
                        </div>
                      </div>
                    </section>

                    <section className="space-y-3 border-t border-paper-rule pt-5">
                      <div className="flex items-center gap-2">
                        <MicrosoftIcon className="size-4" />
                        <span className="text-sm font-medium text-ink">
                          Outlook / Microsoft 365
                        </span>
                        {emailCfg?.microsoft.configured && (
                          <Badge variant="secondary">Configured</Badge>
                        )}
                      </div>
                      <p className="text-[13px] text-ink-soft">
                        Your Microsoft Entra app — same redirect URI, under Web.
                      </p>
                      <div className="grid gap-3 md:grid-cols-2">
                        <div className="grid gap-2">
                          <Label>Client ID</Label>
                          <Input
                            value={emailForm.msClientId}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                msClientId: e.target.value,
                              }))
                            }
                            placeholder="application (client) id"
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Client secret</Label>
                          <Input
                            type="password"
                            value={emailForm.msClientSecret}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                msClientSecret: e.target.value,
                              }))
                            }
                            placeholder={
                              emailCfg?.microsoft.configured
                                ? "•••••• (unchanged)"
                                : "client secret"
                            }
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Tenant (optional)</Label>
                          <Input
                            value={emailForm.msTenant}
                            onChange={(e) =>
                              setEmailForm((s) => ({
                                ...s,
                                msTenant: e.target.value,
                              }))
                            }
                            placeholder="common"
                          />
                        </div>
                      </div>
                    </section>

                    <div className="flex justify-end border-t border-paper-rule pt-5">
                      <Button onClick={saveEmail} disabled={emailSaving}>
                        {emailSaving ? "Saving…" : "Save email settings"}
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="notifications">
                <NotificationsTab />
              </TabsContent>

              <TabsContent value="members">
                <MembersTab />
              </TabsContent>
            </div>
          </div>
        </Tabs>
      </main>
    </div>
  );
}

export function HostedIntegrationsSettingsTab({
  rows,
  generations,
  loading,
  error,
  onRefresh,
  viewState,
  onViewStateChange,
}: {
  rows: HostedIntegrationAdminFamilyRow[];
  generations: HostedIntegrationGenerationSummary[];
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
  viewState?: {
    familyId?: string;
    toolName?: string;
    editorSection?: HostedEditorSection;
    helpSection?: HostedHelpSection;
  };
  onViewStateChange?: (patch: {
    familyId?: string;
    toolName?: string;
    editorSection?: HostedEditorSection;
    helpSection?: HostedHelpSection;
  }) => void;
}) {
  const [editorFamilyId, setEditorFamilyId] = useState<string | null>(
    viewState?.familyId ?? null,
  );
  const [selectedToolByFamily, setSelectedToolByFamily] = useState<
    Record<string, string>
  >({});
  const [expandedFamilyIds, setExpandedFamilyIds] = useState<
    Record<string, boolean>
  >({});
  const [editorSection, setEditorSection] = useState<HostedEditorSection>(
    viewState?.editorSection ?? "code",
  );
  const [editingFamilyId, setEditingFamilyId] = useState<string | null>(null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const shouldScrollEditorRef = useRef(false);
  const editorRow =
    rows.find((row) => row.id === editorFamilyId) ?? rows[0] ?? null;
  const selectedToolName = editorRow
    ? (selectedToolByFamily[editorRow.id] ??
      editorRow.tools.find((tool) => tool.lifecycle !== "removed")?.name ??
      "")
    : "";
  const totalToolCount = rows.reduce(
    (total, row) => total + row.tools.length,
    0,
  );
  const familyNameCounts = rows.reduce<Record<string, number>>(
    (counts, row) => {
      counts[row.name] = (counts[row.name] ?? 0) + 1;
      return counts;
    },
    {},
  );

  useEffect(() => {
    if (viewState?.familyId === undefined) return;
    setEditorFamilyId(viewState.familyId);
    setExpandedFamilyIds((current) =>
      viewState.familyId ? { ...current, [viewState.familyId]: true } : current,
    );
  }, [viewState?.familyId]);

  useEffect(() => {
    if (!viewState?.editorSection) return;
    setEditorSection(viewState.editorSection);
  }, [viewState?.editorSection]);

  useEffect(() => {
    const familyId = viewState?.familyId;
    const toolName = viewState?.toolName;
    if (!familyId || !toolName) return;
    setSelectedToolByFamily((current) =>
      current[familyId] === toolName
        ? current
        : { ...current, [familyId]: toolName },
    );
    setExpandedFamilyIds((current) => ({
      ...current,
      [familyId]: true,
    }));
  }, [viewState?.familyId, viewState?.toolName]);

  useEffect(() => {
    if (!editorRow || !shouldScrollEditorRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      shouldScrollEditorRef.current = false;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [editorRow?.id]);

  useEffect(() => {
    if (!editorRow) return;
    let secondFrame: number | null = null;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        alignEditorToTaskStart("auto");
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      if (secondFrame !== null) window.cancelAnimationFrame(secondFrame);
    };
  }, [editorSection, editorRow?.id]);

  function alignEditorToTaskStart(behavior: ScrollBehavior) {
    const editor = editorRef.current;
    if (!editor) return;
    editor.scrollIntoView({ behavior, block: "start" });
    let parent = editor.parentElement;
    while (parent) {
      const overflowY = window.getComputedStyle(parent).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") {
        const delta =
          editor.getBoundingClientRect().top -
          parent.getBoundingClientRect().top;
        if (Math.abs(delta) > 0.5) parent.scrollTop += delta;
        return;
      }
      parent = parent.parentElement;
    }
  }

  function selectFamily(familyId: string) {
    if (
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId,
        targetFamilyId: familyId,
      })
    ) {
      toast.info("Unlock the current family before opening another family.");
      return;
    }
    shouldScrollEditorRef.current = true;
    setEditorFamilyId(familyId);
    setExpandedFamilyIds((current) => ({ ...current, [familyId]: true }));
    const row = rows.find((family) => family.id === familyId);
    onViewStateChange?.({
      familyId,
      toolName:
        selectedToolByFamily[familyId] ??
        row?.tools.find((tool) => tool.lifecycle !== "removed")?.name,
      editorSection,
    });
    if (editorRow?.id === familyId) {
      window.requestAnimationFrame(() => {
        editorRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        shouldScrollEditorRef.current = false;
      });
    }
  }

  function toggleFamily(familyId: string) {
    if (
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId,
        targetFamilyId: familyId,
      })
    ) {
      toast.info("Unlock the current family before opening another family.");
      return;
    }
    setEditorFamilyId(familyId);
    setExpandedFamilyIds((current) => ({
      ...current,
      [familyId]: !(current[familyId] ?? editorRow?.id === familyId),
    }));
    const row = rows.find((family) => family.id === familyId);
    onViewStateChange?.({
      familyId,
      toolName:
        selectedToolByFamily[familyId] ??
        row?.tools.find((tool) => tool.lifecycle !== "removed")?.name,
      editorSection,
    });
  }

  function selectTool(familyId: string, toolName: string) {
    if (
      shouldBlockHostedIntegrationFamilyNavigation({
        editingFamilyId,
        targetFamilyId: familyId,
      })
    ) {
      toast.info("Unlock the current family before opening another family.");
      return;
    }
    shouldScrollEditorRef.current = true;
    setEditorFamilyId(familyId);
    setSelectedToolByFamily((current) => ({
      ...current,
      [familyId]: toolName,
    }));
    setExpandedFamilyIds((current) => ({ ...current, [familyId]: true }));
    onViewStateChange?.({
      familyId,
      toolName,
      editorSection,
    });
  }

  function changeEditorSection(section: HostedEditorSection) {
    setEditorSection(section);
    onViewStateChange?.({
      familyId: editorRow?.id,
      toolName: selectedToolName,
      editorSection: section,
    });
    window.requestAnimationFrame(() => {
      alignEditorToTaskStart("auto");
    });
  }

  function changeHelpSection(section: HostedHelpSection) {
    onViewStateChange?.({
      familyId: editorRow?.id,
      toolName: selectedToolName,
      editorSection,
      helpSection: section,
    });
  }

  const handleEditSessionChange = useCallback(
    (familyId: string, editing: boolean) => {
      setEditingFamilyId((current) => {
        if (editing) return familyId;
        return current === familyId ? null : current;
      });
    },
    [],
  );

  return (
    <div className="flex min-h-full flex-col">
      {loading && rows.length > 0 && <LoadingHairline inline />}

      {loading && rows.length === 0 ? (
        <p className="m-4 border border-paper-rule bg-paper px-3 py-2 font-mono text-[12px] text-ink-faint">
          Loading…
        </p>
      ) : error ? (
        <p className="m-4 border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
          {error}
        </p>
      ) : rows.length === 0 ? (
        <p className="m-4 border border-dashed border-paper-rule px-4 py-10 text-center font-mono text-[12px] text-ink-soft">
          No hosted tool families registered.
        </p>
      ) : (
        <div className="grid flex-1 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="max-h-[24dvh] overflow-y-auto border-b border-paper-rule sm:max-h-[30dvh] lg:max-h-none lg:overflow-visible lg:border-b-0 lg:border-r">
            <div className="border-b border-paper-rule px-4 py-3">
              <SectionEyebrow meta={`${totalToolCount} tools`}>
                Tool navigation
              </SectionEyebrow>
            </div>
            <div>
              {rows.map((row) => {
                const selected = editorRow?.id === row.id;
                const expanded =
                  expandedFamilyIds[row.id] ?? editorRow?.id === row.id;
                const visibleTools = row.tools.filter(
                  (tool) => tool.lifecycle !== "removed",
                );
                return (
                  <div key={row.id} className="border-b border-paper-rule">
                    <div className="flex items-center border-b border-paper-rule/60 bg-paper-sunk">
                      <button
                        type="button"
                        onClick={() => toggleFamily(row.id)}
                        aria-expanded={expanded}
                        title={`${expanded ? "Collapse" : "Expand"} ${row.name}`}
                        className="flex h-full shrink-0 items-center px-2 py-2 text-ink-faint hover:text-ink"
                      >
                        {expanded ? (
                          <ChevronDown className="size-3.5" aria-hidden />
                        ) : (
                          <ChevronRight className="size-3.5" aria-hidden />
                        )}
                        <span className="sr-only">
                          {expanded ? "Collapse" : "Expand"} {row.name}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => selectFamily(row.id)}
                        aria-current={selected ? "page" : undefined}
                        aria-label={hostedIntegrationFamilyNavigationAccessibleLabel(
                          {
                            familyName: row.name,
                            familyId: row.id,
                            status: row.activeGeneration ? "active" : "idle",
                            includeFamilyId:
                              (familyNameCounts[row.name] ?? 0) > 1,
                          },
                        )}
                        className={cn(
                          "min-w-0 flex-1 px-2 py-2 text-left transition-colors",
                          selected
                            ? "text-ink"
                            : "text-ink-soft hover:text-ink",
                        )}
                      >
                        <div className="flex min-w-0 items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                              {row.name}
                            </div>
                            {(familyNameCounts[row.name] ?? 0) > 1 ? (
                              <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                                {row.id}
                              </div>
                            ) : null}
                          </div>
                          <span
                            className={cn(
                              "inline-flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em]",
                              row.activeGeneration
                                ? "text-plot-red"
                                : "text-ink-faint",
                            )}
                          >
                            <span
                              className={cn(
                                "status-dot",
                                row.activeGeneration
                                  ? "bg-plot-red"
                                  : "bg-ink-faint",
                              )}
                              aria-hidden
                            />
                            {row.activeGeneration ? "Active" : "Idle"}
                          </span>
                        </div>
                      </button>
                    </div>
                    {expanded && (
                      <div>
                        {visibleTools.map((tool) => {
                          const toolSelected =
                            editorRow?.id === row.id &&
                            selectedToolName === tool.name;
                          return (
                            <button
                              key={tool.name}
                              type="button"
                              onClick={() => selectTool(row.id, tool.name)}
                              aria-current={toolSelected ? "page" : undefined}
                              aria-label={hostedIntegrationToolNavigationAccessibleLabel(
                                {
                                  toolName: tool.name,
                                  familyName: row.name,
                                },
                              )}
                              className={cn(
                                "relative block w-full border-t border-paper-rule/40 py-2 pl-8 pr-3 text-left transition-colors",
                                toolSelected
                                  ? "bg-paper text-ink"
                                  : "text-ink-soft hover:bg-paper-sunk hover:text-ink",
                              )}
                            >
                              {toolSelected && (
                                <span
                                  className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
                                  aria-hidden
                                />
                              )}
                              <div className="truncate font-mono text-[12px]">
                                {tool.name}
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </aside>

          <section ref={editorRef} data-hosted-editor-root className="min-w-0">
            {editorRow && (
              <HostedIntegrationDraftEditor
                row={editorRow}
                selectedToolName={selectedToolName}
                generations={generations.filter(
                  (generation) => generation.familyId === editorRow.id,
                )}
                editorSection={editorSection}
                onEditorSectionChange={changeEditorSection}
                helpSection={viewState?.helpSection}
                onHelpSectionChange={changeHelpSection}
                onEditSessionChange={handleEditSessionChange}
                onRefresh={onRefresh}
              />
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function HostedIntegrationDraftEditor({
  row,
  selectedToolName,
  generations,
  editorSection,
  onEditorSectionChange,
  helpSection: controlledHelpSection,
  onHelpSectionChange,
  onEditSessionChange,
  onRefresh,
}: {
  row: HostedIntegrationAdminFamilyRow;
  selectedToolName: string;
  generations: HostedIntegrationGenerationSummary[];
  editorSection: HostedEditorSection;
  onEditorSectionChange: (section: HostedEditorSection) => void;
  helpSection?: HostedHelpSection;
  onHelpSectionChange?: (section: HostedHelpSection) => void;
  onEditSessionChange: (familyId: string, editing: boolean) => void;
  onRefresh: () => void;
}) {
  const [sourceFiles, setSourceFiles] = useState<HostedIntegrationFileEntry[]>(
    [],
  );
  const [sourcePath, setSourcePath] = useState("");
  const [sourceContent, setSourceContent] = useState("");
  const [lock, setLock] = useState<HostedIntegrationFamilyLock | null>(
    row.lock,
  );
  const [draft, setDraft] = useState<HostedIntegrationDraft | null>(null);
  const [draftFiles, setDraftFiles] = useState<HostedIntegrationFileEntry[]>(
    [],
  );
  const [draftPath, setDraftPath] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [publishedExamples, setPublishedExamples] = useState<
    HostedIntegrationExample[]
  >([]);
  const [publishedExampleId, setPublishedExampleId] = useState("");
  const [examples, setExamples] = useState<HostedIntegrationExample[]>([]);
  const [exampleId, setExampleId] = useState("");
  const [exampleDraft, setExampleDraft] = useState(
    JSON.stringify(defaultExampleForRow(row), null, 2),
  );
  const [validation, setValidation] = useState<unknown>(null);
  const [publishReadiness, setPublishReadiness] = useState<unknown>(null);
  const [runResult, setRunResult] = useState<unknown>(null);
  const [publishResult, setPublishResult] = useState<unknown>(null);
  const [helpDraft, setHelpDraft] =
    useState<HostedIntegrationToolHelpEditorState>(() =>
      helpEditorStateFromTool(
        row.tools.find((tool) => tool.name === selectedToolName) ?? null,
      ),
    );
  const [localHelpSection, setLocalHelpSection] =
    useState<HostedHelpSection>("tool");
  const helpSection = controlledHelpSection ?? localHelpSection;
  const [helpParameterIndex, setHelpParameterIndex] = useState(0);
  const [sourceView, setSourceView] =
    useState<HostedIntegrationFocusedSourceView | null>(null);
  const [fullFamilyMode, setFullFamilyMode] = useState(false);
  const [compareGenerationId, setCompareGenerationId] = useState("");
  const [generationDiff, setGenerationDiff] = useState<unknown>(null);
  const [rollbackResult, setRollbackResult] = useState<unknown>(null);
  const [debugEnvironmentConfigId, setDebugEnvironmentConfigId] = useState(
    row.environmentConfigs[0]?.id ?? "",
  );
  const [agentBindingMatrix, setAgentBindingMatrix] =
    useState<HostedIntegrationAgentBindingMatrix | null>(null);
  const [agentBindingMatrixLoading, setAgentBindingMatrixLoading] =
    useState(false);
  const [agentBindingMatrixError, setAgentBindingMatrixError] = useState<
    string | null
  >(null);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  const [debugArgsDraft, setDebugArgsDraft] = useState("{}");
  const [debugResult, setDebugResult] = useState<unknown>(null);
  const [runLogs, setRunLogs] = useState<HostedIntegrationExecutionLogEntry[]>(
    [],
  );
  const [logsLoaded, setLogsLoaded] = useState(false);
  const [logScope, setLogScope] =
    useState<HostedIntegrationExecutionLogScope>("selected_tool");
  const [expandedRunId, setExpandedRunId] = useState("");
  const [expandedFailureBucketId, setExpandedFailureBucketId] = useState("");
  const [artifactPreview, setArtifactPreview] = useState<{
    runId: string;
    name: string;
    content: unknown;
  } | null>(null);
  const [fileMode, setFileMode] = useState<"published" | "draft">("published");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editorTabListRef = useRef<HTMLDivElement | null>(null);

  function changeHelpSection(section: HostedHelpSection) {
    setLocalHelpSection(section);
    onHelpSectionChange?.(section);
  }

  const editorModel = buildHostedIntegrationEditorModel({
    row,
    selectedToolName,
    sourceView,
    lock,
    actorId: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
    actorCanManage: HOSTED_INTEGRATION_EDITOR_CAN_MANAGE,
  });
  const canManage = editorModel.canManage;
  const canEdit = Boolean(draft && editorModel.canEdit);
  const selectedTool = editorModel.selectedTool;
  const selectedToolHelpKey = JSON.stringify(selectedTool?.help ?? null);
  const selectedHelpParameter =
    helpDraft.parameters[helpParameterIndex] ?? null;
  const hasToolHelpExamples = helpDraft.examples.length > 0;
  const selectedDebugEnvironmentConfig = row.environmentConfigs.find(
    (scope) => scope.id === debugEnvironmentConfigId,
  );
  const debugRequiresEnvironmentConfig =
    hostedIntegrationRequiresEnvironmentConfig(row);
  const editableSourcePath =
    selectHostedIntegrationEditableSourcePath(draftFiles);
  const debugArgsParse = useMemo(() => {
    try {
      return {
        args: JSON.parse(debugArgsDraft) as Record<string, unknown>,
        error: null,
      };
    } catch (error) {
      return {
        args: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [debugArgsDraft]);
  const promotionNeedsHumanApproval = row.tools.some(
    (tool) => tool.classification.operation === "destructive",
  );
  const versionRows = buildHostedIntegrationVersionRows({ row, generations });
  const previousVersionRows = versionRows.filter(
    (versionRow) => versionRow.canRollback,
  );
  const selectedVersionRow =
    versionRows.find(
      (versionRow) => versionRow.generation.id === compareGenerationId,
    ) ?? null;
  const rollbackTarget = selectedVersionRow?.canRollback
    ? selectedVersionRow
    : null;
  const versionActionState = buildHostedIntegrationVersionActionState({
    selectedVersionRow,
    canManage,
    activeGenerationId: row.activeGeneration?.id,
  });
  const rollbackTargetPublishedLabel = rollbackTarget
    ? formatTimestamp(rollbackTarget.generation.promotedAt)
    : null;
  const versionActionAccessibleLabels =
    hostedIntegrationVersionActionAccessibleLabels({
      selectedVersionRow: rollbackTarget,
      promotedLabel: rollbackTargetPublishedLabel,
    });

  useEffect(() => {
    setSourceFiles([]);
    setSourcePath("");
    setSourceContent("");
    setLock(row.lock);
    setDraft(null);
    setDraftFiles([]);
    setDraftPath("");
    setDraftContent("");
    setPublishedExamples([]);
    setPublishedExampleId("");
    setExamples([]);
    setExampleId("");
    setExampleDraft(JSON.stringify(defaultExampleForRow(row), null, 2));
    setValidation(null);
    setPublishReadiness(null);
    setRunResult(null);
    setPublishResult(null);
    setHelpDraft(
      helpEditorStateFromTool(
        row.tools.find((tool) => tool.name === selectedToolName) ?? null,
      ),
    );
    setSourceView(null);
    setFullFamilyMode(false);
    setCompareGenerationId("");
    setGenerationDiff(null);
    setRollbackResult(null);
    setDebugEnvironmentConfigId(row.environmentConfigs[0]?.id ?? "");
    setAgentBindingMatrix(null);
    setAgentBindingMatrixError(null);
    setSecretDrafts({});
    setDebugArgsDraft("{}");
    setDebugResult(null);
    setRunLogs([]);
    setLogsLoaded(false);
    setExpandedRunId("");
    setExpandedFailureBucketId("");
    setArtifactPreview(null);
    setFileMode("published");
    setMessage(null);
    setError(null);
    void refreshEditor();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id]);

  useEffect(() => {
    void loadPublishedExamples();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, row.activeGeneration?.id, selectedToolName]);

  useEffect(() => {
    if (!selectedToolName) {
      setSourceView(null);
      return;
    }
    void loadSourceView();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    row.id,
    selectedToolName,
    fullFamilyMode,
    draft?.id,
    row.activeGeneration?.id,
  ]);

  useEffect(() => {
    setHelpDraft(helpEditorStateFromTool(selectedTool));
    setHelpParameterIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, selectedToolName, selectedToolHelpKey]);

  useEffect(() => {
    setHelpParameterIndex((current) =>
      helpDraft.parameters.length === 0
        ? 0
        : Math.min(current, helpDraft.parameters.length - 1),
    );
  }, [helpDraft.parameters.length]);

  useEffect(() => {
    setExpandedRunId("");
    setArtifactPreview(null);
  }, [logScope, selectedToolName]);

  useEffect(() => {
    setRunResult(null);
    setDebugResult(null);
    setGenerationDiff(null);
    setRollbackResult(null);
    setArtifactPreview(null);
  }, [selectedToolName]);

  useEffect(() => {
    const ctrl = new AbortController();
    void loadAgentBindingMatrix(ctrl.signal);
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.id, selectedToolName]);

  useEffect(() => {
    if (editorSection === "publish" && (!draft || !canEdit)) {
      onEditorSectionChange("code");
    }
  }, [canEdit, draft, editorSection, onEditorSectionChange]);

  useEffect(() => {
    if (editorSection === "failures" && row.failureBuckets.length === 0) {
      onEditorSectionChange("code");
    }
  }, [editorSection, onEditorSectionChange, row.failureBuckets.length]);

  useEffect(() => {
    if (fileMode === "draft" && !draft) {
      setFileMode("published");
    }
  }, [draft, fileMode]);

  useEffect(() => {
    if (editorSection === "logs") {
      void loadRunLogs();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editorSection, row.id]);

  async function refreshEditor() {
    await withBusy("load", async () => {
      const [filesBody, lockBody] = await Promise.all([
        hostedApiJson<{ files: HostedIntegrationFileEntry[] }>(
          `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/source/files`,
        ),
        hostedApiJson<{ lock: HostedIntegrationFamilyLock | null }>(
          `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/lock`,
        ),
      ]);
      setSourceFiles(filesBody.files);
      const nextSourcePath = selectHostedIntegrationEditableSourcePath(
        filesBody.files,
      );
      setSourcePath(nextSourcePath);
      setLock(lockBody.lock);
      if (nextSourcePath) await readSourceFile(nextSourcePath);
      const editorOwnsLock =
        lockBody.lock?.lockedBy === HOSTED_INTEGRATION_EDITOR_ACTOR.id;
      if (lockBody.lock?.draftId) {
        await loadDraft(lockBody.lock.draftId);
        await loadSourceView(lockBody.lock.draftId);
        if (editorOwnsLock) setFileMode("draft");
      } else if (lockBody.lock && editorOwnsLock) {
        await createDraftForLock(lockBody.lock);
        setFileMode("draft");
      }
    });
  }

  async function readSourceFile(pathValue: string) {
    const body = await hostedApiJson<{ content: string }>(
      `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/source/files/${encodeHostedPath(pathValue)}`,
    );
    setSourcePath(pathValue);
    setSourceContent(body.content);
  }

  async function loadPublishedExamples() {
    if (!row.activeGeneration || !selectedToolName) {
      setPublishedExamples([]);
      setPublishedExampleId("");
      return;
    }
    try {
      const body = await hostedApiJson<{
        examples: HostedIntegrationExample[];
      }>(
        `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/examples?toolName=${encodeURIComponent(selectedToolName)}`,
      );
      setPublishedExamples(body.examples);
      setPublishedExampleId((current) =>
        body.examples.some((example) => example.id === current)
          ? current
          : (body.examples[0]?.id ?? ""),
      );
    } catch {
      setPublishedExamples([]);
      setPublishedExampleId("");
    }
  }

  async function loadSourceView(targetDraftId = draft?.id) {
    if (!canManage) {
      setSourceView(null);
      return;
    }
    const target =
      targetDraftId || row.activeGeneration?.id
        ? {
            ...(targetDraftId
              ? { draftId: targetDraftId }
              : { generationId: row.activeGeneration?.id }),
          }
        : null;
    if (!target) {
      setSourceView(null);
      return;
    }
    try {
      const body = await hostedApiJson<{
        ok: true;
        view: HostedIntegrationFocusedSourceView;
      }>("/api/hosted-integrations/source-view", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actor: HOSTED_INTEGRATION_EDITOR_ACTOR,
          familyId: row.id,
          toolName: selectedToolName,
          includeSharedHelpers: !fullFamilyMode,
          includeHooks: !fullFamilyMode,
          includeAllTools: fullFamilyMode,
          ...target,
        }),
      });
      setSourceView(body.view);
    } catch (e) {
      setSourceView(null);
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function startEditing() {
    if (!canManage) return;
    await withBusy("lock", async () => {
      const body = await hostedApiJson<{ lock: HostedIntegrationFamilyLock }>(
        `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/lock`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
            ttlMs: 30 * 60 * 1000,
          }),
        },
      );
      setLock(body.lock);
      if (body.lock.draftId) {
        await loadDraft(body.lock.draftId);
        await loadSourceView(body.lock.draftId);
      } else {
        await createDraftForLock(body.lock);
      }
      setFileMode("draft");
      onRefresh();
    });
  }

  async function releaseLock() {
    if (!canManage || !lock) return;
    await withBusy("lock", async () => {
      try {
        await hostedApiJson<{ ok: true }>(
          `/api/hosted-integrations/locks/${encodeURIComponent(lock.id)}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
            }),
          },
        );
      } catch (error) {
        if ((error as Error).message !== "not_found") throw error;
      }
      setLock(null);
      setDraft(null);
      setDraftFiles([]);
      setDraftPath("");
      setDraftContent("");
      setFileMode("published");
      setExamples([]);
      setExampleId("");
      setExampleDraft(JSON.stringify(defaultExampleForRow(row), null, 2));
      onRefresh();
    });
  }

  async function toggleEditingLock() {
    const ownsLock = lock?.lockedBy === HOSTED_INTEGRATION_EDITOR_ACTOR.id;
    if (ownsLock) {
      await releaseLock();
    } else {
      await startEditing();
    }
  }

  async function createDraftForLock(activeLock: HostedIntegrationFamilyLock) {
    const body = await hostedApiJson<{ draft: HostedIntegrationDraft }>(
      `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/drafts`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lockId: activeLock.id }),
      },
    );
    await loadDraft(body.draft.id);
    await loadSourceView(body.draft.id);
  }

  async function loadDraft(draftId: string) {
    const [draftBody, filesBody, examplesBody] = await Promise.all([
      hostedApiJson<{ draft: HostedIntegrationDraft }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}`,
      ),
      hostedApiJson<{ files: HostedIntegrationFileEntry[] }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/files`,
      ),
      hostedApiJson<{ examples: HostedIntegrationExample[] }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/examples`,
      ),
    ]);
    setDraft(draftBody.draft);
    setDraftFiles(filesBody.files);
    setExamples(examplesBody.examples);
    const nextExample = examplesBody.examples[0];
    if (nextExample) {
      setExampleId(nextExample.id);
      setExampleDraft(JSON.stringify(nextExample, null, 2));
    }
    const nextPath = selectHostedIntegrationEditableSourcePath(filesBody.files);
    setDraftPath(nextPath);
    if (nextPath) await readDraftFile(draftId, nextPath);
  }

  async function readDraftFile(draftId: string, pathValue: string) {
    const body = await hostedApiJson<{ content: string }>(
      `/api/hosted-integrations/drafts/${encodeURIComponent(draftId)}/files/${encodeHostedPath(pathValue)}`,
    );
    setDraftPath(pathValue);
    setDraftContent(body.content);
  }

  async function editSelectedSourceFile() {
    if (!canEdit || !draft) return;
    const nextPath =
      selectHostedIntegrationEditableSourcePath(draftFiles) || draftPath;
    if (nextPath) await readDraftFile(draft.id, nextPath);
    setFileMode("draft");
    onEditorSectionChange("files");
  }

  async function saveDraftFile() {
    if (!canEdit || !draft || !lock || !draftPath) return;
    await withBusy("file", async () => {
      await hostedApiJson<{ ok: true }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/files/${encodeHostedPath(draftPath)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lockId: lock.id,
            lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
            content: draftContent,
          }),
        },
      );
      await loadDraft(draft.id);
      setMessage("Draft file saved");
    });
  }

  async function saveToolHelp() {
    if (!canEdit || !draft || !lock || !selectedTool) return;
    await withBusy("help", async () => {
      const help = helpPayloadFromEditorState(helpDraft);
      await hostedApiJson<{ ok: true }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/tools/${encodeURIComponent(selectedTool.name)}/help`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lockId: lock.id,
            lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
            help,
          }),
        },
      );
      await loadDraft(draft.id);
      await loadSourceView();
      setMessage("Tool help saved");
    });
  }

  async function assignFailureBucket(bucketId: string) {
    if (!canManage) return;
    await withBusy("failure", async () => {
      const body = await hostedApiJson<{
        ok: true;
        bucket: { assignedTo?: string };
      }>(
        `/api/hosted-integrations/failure-buckets/${encodeURIComponent(bucketId)}/assign`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: HOSTED_INTEGRATION_EDITOR_ACTOR,
            assignedTo: "tool-developer",
          }),
        },
      );
      setMessage(
        `Repair assigned to ${body.bucket.assignedTo ?? "tool-developer"}`,
      );
      onRefresh();
    });
  }

  async function deleteDraftFile() {
    if (!canEdit || !draft || !lock || !draftPath) return;
    if (!confirm(`Delete ${draftPath}?`)) return;
    await withBusy("file", async () => {
      await hostedApiJson<{ ok: true }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/files/${encodeHostedPath(draftPath)}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lockId: lock.id,
            lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
          }),
        },
      );
      await loadDraft(draft.id);
      setMessage("Draft file deleted");
    });
  }

  async function validateDraft() {
    if (!canEdit || !draft) return;
    await withBusy("validate", async () => {
      const body = await hostedApiJson<unknown>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/validate`,
        { method: "POST" },
      );
      setValidation(body);
      setPublishResult(null);
      if (isHostedIntegrationValidationOk(body)) {
        await loadPublishReadiness(draft.id);
      } else {
        setPublishReadiness(null);
      }
    });
  }

  async function loadPublishReadiness(targetDraftId: string) {
    const body = await hostedApiJson<{
      ok: true;
      readiness: unknown;
    }>(
      `/api/hosted-integrations/readiness/drafts/${encodeURIComponent(targetDraftId)}/publish`,
    );
    setPublishReadiness(body.readiness);
  }

  async function upsertExample() {
    if (!canEdit || !draft || !lock) return;
    await withBusy("example", async () => {
      const example = JSON.parse(exampleDraft) as HostedIntegrationExample;
      await hostedApiJson<{ ok: true }>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/examples`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            lockId: lock.id,
            lockedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
            example,
          }),
        },
      );
      await loadDraft(draft.id);
      setMessage("Example saved");
    });
  }

  async function runExample() {
    if (!canEdit || !draft || !exampleId) return;
    await withBusy("run", async () => {
      const body = await hostedApiJson<unknown>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/run-example`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: HOSTED_INTEGRATION_EDITOR_ACTOR,
            exampleId,
          }),
        },
      );
      setRunResult(body);
    });
  }

  async function promoteDraft() {
    if (!canEdit || !draft || !lock) return;
    await withBusy("promote", async () => {
      const body = await hostedApiJson<unknown>(
        `/api/hosted-integrations/drafts/${encodeURIComponent(draft.id)}/promote`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: HOSTED_INTEGRATION_EDITOR_ACTOR,
            lockId: lock.id,
          }),
        },
      );
      setPublishResult(body);
      setMessage("Changes published");
      onRefresh();
    });
  }

  async function loadGenerationDiff() {
    if (!canManage || !row.activeGeneration || !rollbackTarget) return;
    const activeGenerationId = row.activeGeneration.id;
    await withBusy("diff", async () => {
      const params = new URLSearchParams({
        actorId: "agent:tool-developer",
        mode: selectedToolName ? "tool_focused" : "summary",
      });
      if (selectedToolName) params.set("toolName", selectedToolName);
      const body = await hostedApiJson<unknown>(
        `/api/hosted-integrations/generations/${encodeURIComponent(rollbackTarget.generation.id)}/diff/${encodeURIComponent(activeGenerationId)}?${params.toString()}`,
      );
      setGenerationDiff(body);
      requestHostedEditorRootAlignment();
    });
  }

  async function rollbackGeneration() {
    if (!canManage || !rollbackTarget) return;
    await withBusy("rollback", async () => {
      const body = await hostedApiJson<unknown>(
        `/api/hosted-integrations/generations/${encodeURIComponent(rollbackTarget.generation.id)}/rollback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actor: HOSTED_INTEGRATION_EDITOR_ACTOR }),
        },
      );
      setRollbackResult(body);
      setGenerationDiff(null);
      setMessage("Version rolled back");
      onRefresh();
      requestHostedEditorRootAlignment();
    });
  }

  async function saveSecretValue(
    scope: { id: string; familyId: string; environment: string },
    secretName: string,
  ) {
    if (!canManage) return;
    const draftKey = hostedSecretDraftKey(scope.id, secretName);
    const value = secretDrafts[draftKey] ?? "";
    if (!value) return;
    await withBusy("secret", async () => {
      await hostedApiJson<unknown>(
        `/api/hosted-integrations/environment-configs/${encodeURIComponent(scope.familyId)}/${encodeURIComponent(scope.environment)}/secrets`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secrets: { [secretName]: value },
            updatedBy: HOSTED_INTEGRATION_EDITOR_ACTOR.id,
          }),
        },
      );
      setSecretDrafts((current) => {
        const next = { ...current };
        delete next[draftKey];
        return next;
      });
      setMessage(`Secret ${secretName} saved`);
      onRefresh();
    });
  }

  function requestHostedEditorRootAlignment() {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const editor = document.querySelector<HTMLElement>(
          "[data-hosted-editor-root]",
        );
        if (!editor) return;
        editor.scrollIntoView({ behavior: "auto", block: "start" });
        let parent = editor.parentElement;
        while (parent) {
          const overflowY = window.getComputedStyle(parent).overflowY;
          if (overflowY === "auto" || overflowY === "scroll") {
            const delta =
              editor.getBoundingClientRect().top -
              parent.getBoundingClientRect().top;
            if (Math.abs(delta) > 0.5) parent.scrollTop += delta;
            return;
          }
          parent = parent.parentElement;
        }
      });
    });
  }

  async function debugReadSafeCall() {
    const selectedTool = editorModel.selectedTool;
    const environmentConfig = selectedDebugEnvironmentConfig;
    if (
      !canManage ||
      !editorModel.canRunReadSafeDebug ||
      !selectedTool ||
      (debugRequiresEnvironmentConfig && !environmentConfig) ||
      debugArgsParse.error ||
      !debugArgsParse.args
    ) {
      return;
    }
    await withBusy("debug", async () => {
      const body = await hostedApiJson<unknown>(
        "/api/hosted-integrations/debug-runs",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            actor: HOSTED_INTEGRATION_EDITOR_ACTOR,
            familyId: row.id,
            toolName: selectedTool.name,
            environment: environmentConfig?.environment ?? "test_debug",
            environmentConfigId: environmentConfig?.id,
            args: debugArgsParse.args,
            generationId: row.activeGeneration?.id,
            operationClass: selectedTool.classification.operation,
          }),
        },
      );
      setDebugResult(body);
      if (editorSection === "logs") await fetchRunLogs();
    });
  }

  async function loadRunLogs() {
    if (!canManage) return;
    await withBusy("logs", fetchRunLogs);
  }

  async function loadAgentBindingMatrix(signal?: AbortSignal) {
    if (!selectedToolName) {
      setAgentBindingMatrix(null);
      setAgentBindingMatrixError(null);
      return;
    }
    setAgentBindingMatrixLoading(true);
    setAgentBindingMatrixError(null);
    try {
      const body = await hostedApiJson<{
        ok: true;
        familyId: string;
        toolName: string;
        managedToolName: string;
        bindings: HostedIntegrationAgentBindingMatrixRowInput[];
      }>(
        `/api/hosted-integrations/families/${encodeURIComponent(row.id)}/tools/${encodeURIComponent(selectedToolName)}/agent-bindings`,
        signal ? { signal } : undefined,
      );
      setAgentBindingMatrix(
        buildHostedIntegrationAgentBindingMatrix({
          familyId: body.familyId,
          toolName: body.toolName,
          managedToolName: body.managedToolName,
          bindings: body.bindings,
        }),
      );
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setAgentBindingMatrix(null);
      setAgentBindingMatrixError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setAgentBindingMatrixLoading(false);
    }
  }

  async function fetchRunLogs() {
    const params = new URLSearchParams({
      actorId: "agent:tool-developer",
      familyId: row.id,
      limit: "25",
    });
    const body = await hostedApiJson<{
      runs: HostedIntegrationExecutionLogEntry[];
    }>(`/api/hosted-integrations/runs?${params.toString()}`);
    setRunLogs(body.runs);
    setLogsLoaded(true);
  }

  async function loadRunArtifact(runId: string, name: string) {
    if (!canManage) return;
    await withBusy("artifact", async () => {
      const body = await hostedApiJson<{
        runId: string;
        name: string;
        content: unknown;
      }>(
        `/api/hosted-integrations/runs/${encodeURIComponent(runId)}/artifacts/${encodeHostedPath(name)}?actorId=agent:tool-developer`,
      );
      setArtifactPreview(body);
    });
  }

  useEffect(() => {
    if (!window.matchMedia("(max-width: 767px)").matches) return;
    const timeout = window.setTimeout(() => {
      requestHostedEditorRootAlignment();
    }, 0);
    return () => window.clearTimeout(timeout);
  }, [
    editorSection,
    generationDiff,
    logsLoaded,
    runLogs.length,
    row.failureBuckets.length,
    expandedRunId,
  ]);

  function updateHelpParameter(
    index: number,
    patch: Partial<HostedIntegrationToolHelpParameterEditorState>,
  ) {
    setHelpDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, candidateIndex) =>
        candidateIndex === index ? { ...parameter, ...patch } : parameter,
      ),
    }));
  }

  function addHelpParameter() {
    setHelpParameterIndex(helpDraft.parameters.length);
    setHelpDraft((current) => ({
      ...current,
      parameters: [
        ...current.parameters,
        {
          name: "",
          summary: "",
          full: "",
          shapeJson: "",
          rules: "",
          examples: [],
        },
      ],
    }));
  }

  function removeHelpParameter(index: number) {
    setHelpParameterIndex((current) =>
      current > index ? current - 1 : Math.max(0, current - 1),
    );
    setHelpDraft((current) => ({
      ...current,
      parameters: current.parameters.filter((_, candidateIndex) => {
        return candidateIndex !== index;
      }),
    }));
  }

  function updateHelpParameterExample(
    parameterIndex: number,
    exampleIndex: number,
    valueJson: string,
  ) {
    setHelpDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, candidateIndex) =>
        candidateIndex === parameterIndex
          ? {
              ...parameter,
              examples: parameter.examples.map((example, index) =>
                index === exampleIndex ? { valueJson } : example,
              ),
            }
          : parameter,
      ),
    }));
  }

  function addHelpParameterExample(parameterIndex: number) {
    setHelpDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, candidateIndex) =>
        candidateIndex === parameterIndex
          ? {
              ...parameter,
              examples: [...parameter.examples, { valueJson: "{}" }],
            }
          : parameter,
      ),
    }));
  }

  function removeHelpParameterExample(
    parameterIndex: number,
    exampleIndex: number,
  ) {
    setHelpDraft((current) => ({
      ...current,
      parameters: current.parameters.map((parameter, candidateIndex) =>
        candidateIndex === parameterIndex
          ? {
              ...parameter,
              examples: parameter.examples.filter((_, index) => {
                return index !== exampleIndex;
              }),
            }
          : parameter,
      ),
    }));
  }

  function updateHelpExample(index: number, valueJson: string) {
    setHelpDraft((current) => ({
      ...current,
      examples: current.examples.map((example, candidateIndex) =>
        candidateIndex === index ? { valueJson } : example,
      ),
    }));
  }

  function addHelpExample() {
    setHelpDraft((current) => ({
      ...current,
      examples: [...current.examples, { valueJson: "{}" }],
    }));
  }

  function removeHelpExample(index: number) {
    setHelpDraft((current) => ({
      ...current,
      examples: current.examples.filter((_, candidateIndex) => {
        return candidateIndex !== index;
      }),
    }));
  }

  async function withBusy(name: string, fn: () => Promise<void>) {
    setBusy(name);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  const lockOwnedByEditor =
    lock?.lockedBy === HOSTED_INTEGRATION_EDITOR_ACTOR.id;
  const lockActionDisabled =
    busy !== null || !canManage || Boolean(lock && !lockOwnedByEditor);
  const lockActionLabel = lockOwnedByEditor
    ? "Unlock"
    : lock
      ? "Locked by another editor"
      : "Edit";
  const lockActionAccessibleLabels =
    hostedIntegrationEditLockActionAccessibleLabels(row.name);
  const lockActionAccessibleLabel = lockOwnedByEditor
    ? lockActionAccessibleLabels.unlock
    : lock
      ? lockActionAccessibleLabels.lockedByAnotherEditor
      : lockActionAccessibleLabels.edit;
  const editStatusLabel = lock
    ? lockOwnedByEditor
      ? "editing"
      : `locked by ${lock.lockedBy}`
    : "read only";

  useEffect(() => {
    onEditSessionChange(row.id, lockOwnedByEditor);
    return () => onEditSessionChange(row.id, false);
  }, [lockOwnedByEditor, onEditSessionChange, row.id]);

  const publishViewState = buildHostedIntegrationPublishViewState({
    validation,
    publishReadiness,
    publishResult,
  });
  const publishAccessibleLabels = hostedIntegrationPublishAccessibleLabels({
    familyName: row.name,
    viewState: publishViewState,
  });
  const publishActionState = buildHostedIntegrationPublishActionState({
    canEdit,
    draftId: draft?.id,
    validationOk: publishViewState.validationOk,
    publishReady: publishViewState.publishReady,
    busy: busy !== null,
    promotionNeedsHumanApproval,
  });
  const editorSections: Array<[HostedEditorSection, string]> = [
    ["code", "Code"],
    ["help", "Help"],
    ["config", "Config"],
    ["agents", "Agents"],
    ["files", "Files"],
    ["test", "Test"],
    ["debug", "Debug"],
    ["version", "Version"],
    ["logs", "Logs"],
    ...(row.failureBuckets.length > 0
      ? ([["failures", "Failures"]] as Array<[HostedEditorSection, string]>)
      : []),
    ...(publishActionState.showLane
      ? ([["publish", publishViewState.tabLabel]] as Array<
          [HostedEditorSection, string]
        >)
      : []),
  ];

  useEffect(() => {
    const tabList = editorTabListRef.current;
    if (!tabList || !window.matchMedia("(max-width: 767px)").matches) return;
    const selectedTab = tabList.querySelector<HTMLElement>(
      `[data-editor-section="${editorSection}"]`,
    );
    if (!selectedTab) return;
    tabList.scrollLeft = Math.max(selectedTab.offsetLeft - 16, 0);
  }, [editorSection, editorSections.length]);

  const openFailureBuckets = row.failureBuckets.filter(
    (bucket) => bucket.status === "open",
  );
  const failureSummaryState = buildHostedIntegrationFailureSummaryState(
    row.failureBuckets,
  );
  const runLogRows = buildHostedIntegrationExecutionLogRows({
    row,
    runs: runLogs,
  });
  const scopedRunLogRows = filterHostedIntegrationExecutionLogRows({
    rows: runLogRows,
    selectedToolName: editorModel.selectedToolName,
    scope: logScope,
  });
  const logScopeLabel =
    logScope === "family"
      ? "family"
      : (editorModel.selectedToolName ?? "selected tool");
  const logActionState = buildHostedIntegrationExecutionLogActionState({
    scope: logScope,
    selectedToolName: editorModel.selectedToolName,
    familyId: row.id,
    canManage,
  });
  const logPrimaryHeader = hostedIntegrationExecutionLogPrimaryHeader(logScope);
  const publishPrimaryDisabled = publishActionState.primaryDisabled;
  const selectedExample = examples.find((example) => example.id === exampleId);
  const selectedPublishedExample = publishedExamples.find(
    (example) => example.id === publishedExampleId,
  );
  const testExamples = draft ? examples : publishedExamples;
  const selectedTestExample = draft
    ? selectedExample
    : selectedPublishedExample;
  const testExampleId = draft ? exampleId : publishedExampleId;
  const exampleActionState = buildHostedIntegrationExampleActionState({
    canEdit,
    draftId: draft?.id,
    selectedExampleId: selectedExample?.id,
  });
  const exampleActionLabels =
    hostedIntegrationExampleActionAccessibleLabels(testExampleId);
  const toolHelpActionLabels = hostedIntegrationToolHelpActionAccessibleLabels(
    editorModel.selectedToolName,
  );
  const toolHelpFieldLabels = hostedIntegrationToolHelpFieldAccessibleLabels({
    toolName: editorModel.selectedToolName,
    parameterName: selectedHelpParameter?.name,
  });
  const codeActionLabels = hostedIntegrationCodeActionAccessibleLabels({
    toolName: editorModel.selectedToolName,
    handlerName: editorModel.selectedHandlerName,
  });
  const debugUnavailableReasonText = hostedIntegrationDebugUnavailableReason({
    canManage,
    toolName: editorModel.selectedToolName,
    operation: editorModel.selectedTool?.classification.operation ?? null,
    environmentConfigCount: row.environmentConfigs.length,
    requiresEnvironmentConfig: debugRequiresEnvironmentConfig,
    familyName: row.name,
  });
  const debugActionState = buildHostedIntegrationDebugActionState({
    canManage,
    toolName: editorModel.selectedToolName,
    environmentConfigId: selectedDebugEnvironmentConfig?.id,
    requiresEnvironmentConfig: debugRequiresEnvironmentConfig,
    operation: editorModel.selectedTool?.classification.operation ?? null,
    hasLocalArgumentError: Boolean(debugArgsParse.error),
    busy: busy !== null,
  });
  const debugActionLabel = hostedIntegrationDebugActionAccessibleLabel({
    toolName: editorModel.selectedToolName,
    environmentConfigId: selectedDebugEnvironmentConfig?.id,
  });
  const draftFileActionLabels =
    hostedIntegrationDraftFileActionAccessibleLabels(draftPath);
  const draftFileActionState = buildHostedIntegrationDraftFileActionState({
    canEdit,
    draftId: draft?.id,
    path: draftPath,
  });
  const codeActionState = buildHostedIntegrationCodeActionState({
    canEdit,
    draftId: draft?.id,
    path: editableSourcePath,
  });
  const toolHelpActionState = buildHostedIntegrationToolHelpActionState({
    canEdit,
    draftId: draft?.id,
    toolName: editorModel.selectedToolName,
  });
  const schemaPropertyRows = hostedInputSchemaRows(editorModel.inputSchema);
  const sourceViewDiagnostics = sourceView?.diagnostics ?? [];
  const sourceViewDiagnosticRows = hostedSourceViewDiagnosticRows(
    sourceViewDiagnostics,
  );
  const helpParameterGroups = hostedHelpParameterGroups(helpDraft.parameters);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-rule px-4 py-3 md:px-5">
        <div className="min-w-0">
          <div className="truncate font-mono text-[12px] text-ink">
            {selectedTool?.name ?? selectedToolName}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
            <span>v{row.version}</span>
            <span
              title={
                row.activeGeneration
                  ? `Generation ${row.activeGeneration.id}`
                  : undefined
              }
            >
              {row.activeGeneration ? "current version" : "no current version"}
            </span>
            <span>
              {hostedIntegrationEditorModeLabel({ hasDraft: Boolean(draft) })}
            </span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant={lock ? "outline" : "secondary"}
            className="font-mono text-[10px]"
            title={lock ? `Expires ${formatTimestamp(lock.expiresAt)}` : ""}
          >
            {editStatusLabel}
          </Badge>
          {row.openFailureBucketCount > 0 && (
            <Badge variant="destructive" className="font-mono text-[10px]">
              {row.openFailureBucketCount} failure buckets
            </Badge>
          )}
          <Button
            size="sm"
            variant={lockOwnedByEditor ? "outline" : "default"}
            aria-label={lockActionAccessibleLabel}
            disabled={lockActionDisabled}
            onClick={toggleEditingLock}
          >
            {lockActionLabel}
          </Button>
        </div>
      </div>
      <div className="grid gap-5 px-4 py-4 md:px-5">
        {message && (
          <p className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
            {message}
          </p>
        )}
        {error && (
          <p className="border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
            {error}
          </p>
        )}
        {!canManage && (
          <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
            Hosted integration management permission is required to edit, debug,
            diff, or publish this family.
          </p>
        )}

        <div className="grid gap-4">
          <div
            ref={editorTabListRef}
            className="flex flex-nowrap overflow-x-auto scroll-px-4 border-b border-paper-rule md:flex-wrap md:overflow-visible"
          >
            {editorSections.map(([value, label]) => (
              <button
                key={value}
                data-editor-section={value}
                type="button"
                onClick={() => {
                  const tabList = editorTabListRef.current;
                  const selectedTab = tabList?.querySelector<HTMLElement>(
                    `[data-editor-section="${value}"]`,
                  );
                  if (
                    tabList &&
                    selectedTab &&
                    window.matchMedia("(max-width: 767px)").matches
                  ) {
                    tabList.scrollLeft = Math.max(
                      selectedTab.offsetLeft - 16,
                      0,
                    );
                  }
                  onEditorSectionChange(value as HostedEditorSection);
                }}
                aria-pressed={editorSection === value}
                aria-label={hostedIntegrationEditorSectionAccessibleLabel({
                  sectionLabel: label,
                  toolName: editorModel.selectedToolName,
                })}
                className={`relative shrink-0 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.08em] transition-colors ${
                  editorSection === value
                    ? "text-ink after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:bg-plot-red"
                    : "text-ink-soft hover:text-ink"
                }`}
              >
                {label}
              </button>
            ))}
            <span
              aria-hidden="true"
              className="block h-px w-[calc(100vw-2rem)] shrink-0 md:hidden"
            />
          </div>
          {editorSection === "help" && (
            <div className="-mt-4 border-b border-paper-rule bg-paper-sunk px-3">
              <div
                role="tablist"
                aria-label={`Help sections for ${editorModel.selectedToolName}`}
                className="flex min-w-0 flex-wrap items-end gap-5 font-mono text-[10px] uppercase tracking-[0.08em]"
              >
                {(
                  [
                    ["tool", "Tool details"],
                    ["parameters", "Parameters"],
                  ] as Array<[HostedHelpSection, string]>
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={helpSection === value}
                    onClick={() => changeHelpSection(value)}
                    className={cn(
                      "relative py-2.5 transition-colors after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px]",
                      helpSection === value
                        ? "text-ink after:bg-plot-red"
                        : "text-ink-soft after:bg-transparent hover:text-ink",
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {editorSection === "code" && (
            <section className="grid min-w-0 gap-3">
              {editorModel.helpSummary && (
                <p className="border-b border-paper-rule px-3 pb-3 text-[12px] text-ink-soft">
                  {editorModel.helpSummary}
                </p>
              )}
              <HostedCodeEditor
                label="Handler source"
                textareaLabel={codeActionLabels.handlerSource}
                path={editorModel.selectedHandlerName ?? undefined}
                language="python"
                readOnly
                minHeightClassName="h-[min(58dvh,680px)] min-h-[320px]"
                actions={
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {codeActionState.canEditSourceFile ? (
                      <Button
                        variant="default"
                        size="sm"
                        aria-label={codeActionLabels.editSource}
                        disabled={busy !== null}
                        onClick={editSelectedSourceFile}
                      >
                        Edit source
                      </Button>
                    ) : null}
                    <div className="inline-flex border border-paper-rule font-mono text-[10px] uppercase tracking-[0.08em]">
                      {[
                        ["focused", "Focused"],
                        ["full", "Family"],
                      ].map(([value, label]) => {
                        const active =
                          value === "full" ? fullFamilyMode : !fullFamilyMode;
                        return (
                          <button
                            key={value}
                            type="button"
                            disabled={busy !== null || !selectedToolName}
                            className={cn(
                              "border-r border-paper-rule px-2 py-1 last:border-r-0 disabled:text-ink-faint",
                              active
                                ? "bg-ink text-paper"
                                : "text-ink-soft hover:bg-paper-sunk",
                            )}
                            aria-pressed={active}
                            aria-label={
                              value === "full"
                                ? codeActionLabels.fullFamily
                                : codeActionLabels.focusedHandler
                            }
                            onClick={() => setFullFamilyMode(value === "full")}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                }
                value={
                  editorModel.focusedHandlerCode ||
                  hostedIntegrationCodeEmptyStateText({
                    toolName: editorModel.selectedToolName,
                    handlerName: editorModel.selectedHandlerName,
                  })
                }
              />

              <section className="grid gap-4 bg-paper-sunk px-3 py-3">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
                  <div className="grid min-w-0 content-start gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="label-faceplate text-ink-soft">
                        Contract
                      </span>
                      <span className="rounded-sm bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
                        {editorModel.selectedTool?.classification.operation ??
                          "operation n/a"}
                      </span>
                      <span className="rounded-sm bg-paper px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft">
                        {editorModel.selectedTool?.classification.execution ??
                          "execution n/a"}
                      </span>
                    </div>
                    {schemaPropertyRows.length === 0 ? (
                      <p className="text-[12px] leading-6 text-ink-faint">
                        No input schema properties documented.
                      </p>
                    ) : (
                      <div className="grid overflow-hidden border border-paper-rule bg-paper">
                        <div className="grid grid-cols-[minmax(160px,0.7fr)_minmax(90px,0.35fr)_minmax(0,1fr)] border-b border-paper-rule px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          <span>Parameter</span>
                          <span>Type</span>
                          <span>Details</span>
                        </div>
                        {schemaPropertyRows.map((row) => (
                          <div
                            key={row.name}
                            className="grid grid-cols-[minmax(160px,0.7fr)_minmax(90px,0.35fr)_minmax(0,1fr)] gap-3 border-b border-paper-rule/60 px-3 py-2 last:border-b-0"
                          >
                            <div className="min-w-0">
                              <div className="truncate font-mono text-[12px] text-ink">
                                {row.name}
                              </div>
                              {row.required ? (
                                <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-plot-red">
                                  required
                                </div>
                              ) : null}
                            </div>
                            <div className="font-mono text-[11px] text-ink-soft">
                              {row.type}
                            </div>
                            <div className="min-w-0 text-[12px] leading-5 text-ink-soft">
                              {row.details}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="grid min-w-0 content-start gap-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="label-faceplate text-ink-soft">
                        Diagnostics
                      </span>
                      <span
                        className={cn(
                          "rounded-sm px-2 py-1 font-mono text-[10px] uppercase tracking-[0.08em]",
                          sourceViewDiagnostics.length === 0
                            ? "bg-emerald-50 text-emerald-900"
                            : "bg-amber-50 text-amber-900",
                        )}
                      >
                        {sourceViewDiagnostics.length === 0
                          ? "clean"
                          : `${sourceViewDiagnostics.length} found`}
                      </span>
                    </div>
                    {sourceViewDiagnosticRows.length === 0 ? (
                      <p className="text-[12px] leading-6 text-ink-faint">
                        No source-view diagnostics for this handler.
                      </p>
                    ) : (
                      <div className="grid gap-px overflow-hidden border border-paper-rule bg-paper-rule">
                        {sourceViewDiagnosticRows.map((diagnostic) => (
                          <div
                            key={diagnostic.key}
                            className="grid gap-1 bg-paper px-3 py-2"
                          >
                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                              <span
                                className={cn(
                                  "font-mono text-[10px] uppercase tracking-[0.08em]",
                                  diagnostic.severity === "error"
                                    ? "text-red-700"
                                    : "text-amber-700",
                                )}
                              >
                                {diagnostic.severity}
                              </span>
                              <span className="truncate font-mono text-[11px] text-ink-faint">
                                {diagnostic.code}
                              </span>
                              {diagnostic.count > 1 ? (
                                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                                  x{diagnostic.count}
                                </span>
                              ) : null}
                            </div>
                            <p className="text-[12px] leading-5 text-ink-soft">
                              {diagnostic.message}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <details>
                  <summary
                    aria-label={codeActionLabels.schemaDisclosure}
                    className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint hover:text-ink"
                  >
                    Raw schema and source metadata
                  </summary>
                  <pre
                    aria-label={codeActionLabels.schemaDetails}
                    className="mt-2 overflow-x-auto bg-paper px-3 py-3 font-mono text-[11px] leading-5 text-ink-soft"
                  >
                    {jsonPreview({
                      schema: editorModel.inputSchema,
                      classification: editorModel.selectedTool?.classification,
                      collapsedHandlers: editorModel.collapsedHandlerNames,
                      diagnostics: sourceViewDiagnostics,
                    })}
                  </pre>
                </details>
              </section>
            </section>
          )}

          {editorSection === "help" && (
            <div>
              <div className="grid gap-5 p-3">
                {toolHelpActionState.canSaveHelp ? (
                  <div className="flex justify-end border-b border-paper-rule pb-3">
                    <Button
                      size="sm"
                      aria-label={toolHelpActionLabels.save}
                      disabled={busy !== null}
                      onClick={saveToolHelp}
                    >
                      {busy === "help" ? "Saving..." : "Save help"}
                    </Button>
                  </div>
                ) : null}

                {helpSection === "tool" && (
                  <>
                    <div className="grid gap-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Label
                          htmlFor={
                            canEdit ? "hosted-tool-help-summary" : undefined
                          }
                        >
                          Summary
                        </Label>
                      </div>
                      {canEdit ? (
                        <Textarea
                          id="hosted-tool-help-summary"
                          aria-label={toolHelpFieldLabels.summary}
                          value={helpDraft.summary}
                          rows={2}
                          className={HOSTED_HELP_TEXTAREA_CLASS}
                          onChange={(event) =>
                            setHelpDraft((current) => ({
                              ...current,
                              summary: event.target.value,
                            }))
                          }
                        />
                      ) : (
                        <p className="text-sm leading-6 text-ink-soft">
                          {helpDraft.summary ||
                            hostedIntegrationToolHelpEmptyStateText({
                              state: "summary_empty",
                              toolName: editorModel.selectedToolName,
                            })}
                        </p>
                      )}
                    </div>
                  </>
                )}

                {helpSection === "parameters" && (
                  <>
                    <section className="grid gap-3">
                      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-rule pb-2">
                        <SectionEyebrow
                          rule={false}
                          meta={`${helpParameterGroups.topLevel.length} inputs · ${helpParameterGroups.nested.length} nested details`}
                        >
                          Parameter help
                        </SectionEyebrow>
                        {canEdit && (
                          <Button
                            size="sm"
                            variant="outline"
                            aria-label={toolHelpActionLabels.addParameter}
                            onClick={addHelpParameter}
                          >
                            Add parameter
                          </Button>
                        )}
                      </div>
                      {helpDraft.parameters.length === 0 ? (
                        <p className="border border-dashed border-paper-rule px-3 py-6 text-center font-mono text-[12px] text-ink-faint">
                          {hostedIntegrationToolHelpEmptyStateText({
                            state: "parameters_empty",
                            toolName: editorModel.selectedToolName,
                          })}
                        </p>
                      ) : (
                        <div className="grid border-t border-paper-rule">
                          <div
                            className={cn(
                              "hidden gap-3 border-b border-paper-rule py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid",
                              canEdit
                                ? "grid-cols-[220px_minmax(0,1fr)_2rem]"
                                : "grid-cols-[220px_minmax(0,1fr)]",
                            )}
                          >
                            <span>Parameter</span>
                            <span>Summary</span>
                            {canEdit && <span />}
                          </div>
                          {helpParameterGroups.ordered.map(
                            ({ parameter, index }) => {
                              const nested = parameter.name.includes(".");
                              return (
                                <div
                                  key={`${parameter.name}-${index}`}
                                  role="button"
                                  tabIndex={0}
                                  onClick={() => setHelpParameterIndex(index)}
                                  onKeyDown={(
                                    event: KeyboardEvent<HTMLDivElement>,
                                  ) => {
                                    if (
                                      event.key === "Enter" ||
                                      event.key === " "
                                    ) {
                                      event.preventDefault();
                                      setHelpParameterIndex(index);
                                    }
                                  }}
                                  className={cn(
                                    "grid cursor-pointer gap-2 border-b border-paper-rule/50 py-2 last:border-b-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-plot-red md:gap-3",
                                    canEdit
                                      ? "grid-cols-[minmax(0,1fr)_2.25rem] items-start md:grid-cols-[220px_minmax(0,1fr)_2rem] md:items-end"
                                      : "md:grid-cols-[220px_minmax(0,1fr)]",
                                    helpParameterIndex === index
                                      ? "bg-paper-sunk text-ink"
                                      : "text-ink-soft",
                                  )}
                                >
                                  {canEdit ? (
                                    <>
                                      <div
                                        className={cn(
                                          "flex min-w-0 items-end gap-1.5",
                                          nested && "ml-1",
                                        )}
                                      >
                                        {nested ? (
                                          <span
                                            className="mb-1 font-mono text-[12px] text-ink-faint"
                                            aria-hidden
                                          >
                                            ↳
                                          </span>
                                        ) : null}
                                        <Input
                                          aria-label={
                                            hostedIntegrationToolHelpParameterRowAccessibleLabels(
                                              {
                                                toolName:
                                                  editorModel.selectedToolName,
                                                parameterName: parameter.name,
                                                parameterIndex: index,
                                              },
                                            ).name
                                          }
                                          value={parameter.name}
                                          className={cn(
                                            HOSTED_HELP_INPUT_CLASS,
                                            "min-w-0 font-mono text-[12px]",
                                          )}
                                          onFocus={() =>
                                            setHelpParameterIndex(index)
                                          }
                                          onChange={(event) =>
                                            updateHelpParameter(index, {
                                              name: event.target.value,
                                            })
                                          }
                                        />
                                      </div>
                                      <Textarea
                                        aria-label={
                                          hostedIntegrationToolHelpParameterRowAccessibleLabels(
                                            {
                                              toolName:
                                                editorModel.selectedToolName,
                                              parameterName: parameter.name,
                                              parameterIndex: index,
                                            },
                                          ).summary
                                        }
                                        value={parameter.summary}
                                        rows={2}
                                        className={cn(
                                          HOSTED_HELP_TEXTAREA_CLASS,
                                          "order-3 col-span-2 md:order-none md:col-span-1",
                                        )}
                                        onFocus={() =>
                                          setHelpParameterIndex(index)
                                        }
                                        onChange={(event) =>
                                          updateHelpParameter(index, {
                                            summary: event.target.value,
                                          })
                                        }
                                      />
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        className="order-2 md:order-none"
                                        onClick={() =>
                                          removeHelpParameter(index)
                                        }
                                        aria-label={
                                          hostedIntegrationToolHelpParameterRowAccessibleLabels(
                                            {
                                              toolName:
                                                editorModel.selectedToolName,
                                              parameterName: parameter.name,
                                              parameterIndex: index,
                                            },
                                          ).remove
                                        }
                                      >
                                        <Trash2
                                          className="size-4"
                                          aria-hidden
                                        />
                                      </Button>
                                    </>
                                  ) : (
                                    <>
                                      <div
                                        className={cn(
                                          "flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-ink",
                                          nested && "ml-1",
                                        )}
                                      >
                                        {nested ? (
                                          <span
                                            className="font-mono text-[12px] text-ink-faint"
                                            aria-hidden
                                          >
                                            ↳
                                          </span>
                                        ) : null}
                                        <span className="min-w-0 truncate">
                                          {parameter.name}
                                        </span>
                                      </div>
                                      <div className="text-sm leading-6 text-ink-soft">
                                        {parameter.summary ||
                                          hostedIntegrationToolHelpEmptyStateText(
                                            {
                                              state: "parameter_summary_empty",
                                              toolName:
                                                editorModel.selectedToolName,
                                              parameterName: parameter.name,
                                            },
                                          )}
                                      </div>
                                    </>
                                  )}
                                </div>
                              );
                            },
                          )}
                        </div>
                      )}
                    </section>

                    {selectedHelpParameter && (
                      <section className="grid gap-3 border-t border-paper-rule pt-3">
                        <SectionEyebrow
                          rule={false}
                          meta={selectedHelpParameter.name || "unnamed"}
                        >
                          Selected parameter detail
                        </SectionEyebrow>
                        <div className="grid gap-3 lg:grid-cols-2">
                          <div className="grid gap-2">
                            <Label htmlFor="help-param-full">Full detail</Label>
                            <Textarea
                              id="help-param-full"
                              aria-label={toolHelpFieldLabels.parameterFull}
                              value={selectedHelpParameter.full}
                              readOnly={!canEdit}
                              rows={4}
                              placeholder="No full detail documented."
                              className={cn(
                                HOSTED_HELP_TEXTAREA_CLASS,
                                "font-mono text-[12px]",
                              )}
                              onChange={(event) =>
                                updateHelpParameter(helpParameterIndex, {
                                  full: event.target.value,
                                })
                              }
                            />
                          </div>
                          <div className="grid gap-2">
                            <Label htmlFor="help-param-rules">Rules</Label>
                            <Textarea
                              id="help-param-rules"
                              aria-label={toolHelpFieldLabels.parameterRules}
                              value={selectedHelpParameter.rules}
                              readOnly={!canEdit}
                              rows={4}
                              placeholder="No rules documented."
                              className={cn(
                                HOSTED_HELP_TEXTAREA_CLASS,
                                "font-mono text-[12px]",
                              )}
                              onChange={(event) =>
                                updateHelpParameter(helpParameterIndex, {
                                  rules: event.target.value,
                                })
                              }
                            />
                          </div>
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="help-param-shape">
                            Shape override
                          </Label>
                          <Textarea
                            id="help-param-shape"
                            aria-label={toolHelpFieldLabels.parameterShape}
                            value={selectedHelpParameter.shapeJson}
                            readOnly={!canEdit}
                            rows={3}
                            placeholder="No shape override documented."
                            className={cn(
                              HOSTED_HELP_TEXTAREA_CLASS,
                              "font-mono text-[12px]",
                            )}
                            onChange={(event) =>
                              updateHelpParameter(helpParameterIndex, {
                                shapeJson: event.target.value,
                              })
                            }
                          />
                        </div>
                        <div className="grid gap-3">
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-rule pb-2">
                            <SectionEyebrow
                              rule={false}
                              meta={`${selectedHelpParameter.examples.length} entries`}
                            >
                              Parameter examples
                            </SectionEyebrow>
                            {canEdit && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  addHelpParameterExample(helpParameterIndex)
                                }
                                aria-label={`Add example for ${selectedHelpParameter.name}`}
                              >
                                Add example
                              </Button>
                            )}
                          </div>
                          {selectedHelpParameter.examples.length === 0 ? (
                            <p className="border border-dashed border-paper-rule px-3 py-6 text-center font-mono text-[12px] text-ink-faint">
                              No parameter examples documented.
                            </p>
                          ) : (
                            <div className="grid border-t border-paper-rule">
                              <div
                                className={cn(
                                  "hidden gap-3 border-b border-paper-rule py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid",
                                  canEdit
                                    ? "grid-cols-[4rem_180px_minmax(0,1fr)_2rem]"
                                    : "grid-cols-[4rem_180px_minmax(0,1fr)]",
                                )}
                              >
                                <span>No</span>
                                <span>Payload shape</span>
                                <span>Payload</span>
                                {canEdit && <span />}
                              </div>
                              {selectedHelpParameter.examples.map(
                                (example, exampleIndex) => (
                                  <div
                                    key={exampleIndex}
                                    className={cn(
                                      "grid gap-3 border-b border-paper-rule/50 py-3 last:border-b-0",
                                      canEdit
                                        ? "md:grid-cols-[4rem_180px_minmax(0,1fr)_2rem]"
                                        : "md:grid-cols-[4rem_180px_minmax(0,1fr)]",
                                    )}
                                  >
                                    <div className="font-mono text-[12px] text-ink">
                                      <span className="md:hidden">
                                        Example{" "}
                                      </span>
                                      {exampleIndex + 1}
                                    </div>
                                    <div className="font-mono text-[11px] leading-5 text-ink-soft">
                                      <span className="block text-[10px] uppercase tracking-[0.08em] text-ink-faint md:hidden">
                                        Payload shape
                                      </span>
                                      {helpExamplePayloadShape(
                                        example.valueJson,
                                      )}
                                    </div>
                                    <div className="grid gap-2">
                                      <Label
                                        htmlFor={`help-param-example-${exampleIndex}`}
                                        className="md:sr-only"
                                      >
                                        Payload
                                      </Label>
                                      {canEdit ? (
                                        <Textarea
                                          id={`help-param-example-${exampleIndex}`}
                                          aria-label={`Example ${exampleIndex + 1} for parameter ${selectedHelpParameter.name}`}
                                          value={example.valueJson}
                                          rows={6}
                                          className={cn(
                                            HOSTED_HELP_TEXTAREA_CLASS,
                                            "font-mono text-[12px]",
                                          )}
                                          onChange={(event) =>
                                            updateHelpParameterExample(
                                              helpParameterIndex,
                                              exampleIndex,
                                              event.target.value,
                                            )
                                          }
                                        />
                                      ) : (
                                        <pre
                                          id={`help-param-example-${exampleIndex}`}
                                          aria-label={`Example ${exampleIndex + 1} for parameter ${selectedHelpParameter.name}`}
                                          className="w-full whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink"
                                        >
                                          {example.valueJson}
                                        </pre>
                                      )}
                                    </div>
                                    {canEdit && (
                                      <Button
                                        size="icon"
                                        variant="ghost"
                                        onClick={() =>
                                          removeHelpParameterExample(
                                            helpParameterIndex,
                                            exampleIndex,
                                          )
                                        }
                                        aria-label={`Remove example ${exampleIndex + 1} for ${selectedHelpParameter.name}`}
                                      >
                                        <Trash2
                                          className="size-4"
                                          aria-hidden
                                        />
                                      </Button>
                                    )}
                                  </div>
                                ),
                              )}
                            </div>
                          )}
                        </div>
                      </section>
                    )}
                  </>
                )}

                {helpSection === "tool" && (
                  <>
                    <div className="grid gap-4">
                      <div className="grid gap-2">
                        <Label htmlFor="hosted-tool-help-full">
                          Full detail
                        </Label>
                        {canEdit ? (
                          <Textarea
                            id="hosted-tool-help-full"
                            aria-label={toolHelpFieldLabels.full}
                            value={helpDraft.full}
                            rows={4}
                            className={cn(
                              HOSTED_HELP_TEXTAREA_CLASS,
                              "font-mono text-[12px]",
                            )}
                            onChange={(event) =>
                              setHelpDraft((current) => ({
                                ...current,
                                full: event.target.value,
                              }))
                            }
                          />
                        ) : (
                          <p
                            id="hosted-tool-help-full"
                            className="w-full whitespace-normal border-b border-paper-rule pb-2 text-[13px] leading-6 text-ink"
                          >
                            {helpDraft.full ||
                              hostedIntegrationToolHelpEmptyStateText({
                                state: "summary_empty",
                                toolName: editorModel.selectedToolName,
                              })}
                          </p>
                        )}
                      </div>

                      <div className="grid gap-3 lg:grid-cols-2">
                        <div className="grid gap-2">
                          <Label htmlFor="hosted-tool-help-when-to-use">
                            When to use
                          </Label>
                          {canEdit ? (
                            <Textarea
                              id="hosted-tool-help-when-to-use"
                              aria-label={toolHelpFieldLabels.whenToUse}
                              value={helpDraft.whenToUse}
                              rows={3}
                              className={cn(
                                HOSTED_HELP_TEXTAREA_CLASS,
                                "font-mono text-[12px]",
                              )}
                              onChange={(event) =>
                                setHelpDraft((current) => ({
                                  ...current,
                                  whenToUse: event.target.value,
                                }))
                              }
                            />
                          ) : (
                            <p
                              id="hosted-tool-help-when-to-use"
                              className="w-full whitespace-normal border-b border-paper-rule pb-2 text-[13px] leading-6 text-ink"
                            >
                              {helpDraft.whenToUse || "Not documented."}
                            </p>
                          )}
                        </div>
                        <div className="grid gap-2">
                          <Label htmlFor="hosted-tool-help-when-not-to-use">
                            When not to use
                          </Label>
                          {canEdit ? (
                            <Textarea
                              id="hosted-tool-help-when-not-to-use"
                              aria-label={toolHelpFieldLabels.whenNotToUse}
                              value={helpDraft.whenNotToUse}
                              rows={3}
                              className={cn(
                                HOSTED_HELP_TEXTAREA_CLASS,
                                "font-mono text-[12px]",
                              )}
                              onChange={(event) =>
                                setHelpDraft((current) => ({
                                  ...current,
                                  whenNotToUse: event.target.value,
                                }))
                              }
                            />
                          ) : (
                            <p
                              id="hosted-tool-help-when-not-to-use"
                              className="w-full whitespace-normal border-b border-paper-rule pb-2 text-[13px] leading-6 text-ink"
                            >
                              {helpDraft.whenNotToUse || "Not documented."}
                            </p>
                          )}
                        </div>
                      </div>

                      {!hasToolHelpExamples && (
                        <div className="grid gap-2">
                          <Label htmlFor="hosted-tool-help-no-example">
                            No example justification
                          </Label>
                          <Input
                            id="hosted-tool-help-no-example"
                            aria-label={
                              toolHelpFieldLabels.noExampleJustification
                            }
                            value={helpDraft.noExampleJustification}
                            readOnly={!canEdit}
                            className={HOSTED_HELP_INPUT_CLASS}
                            onChange={(event) =>
                              setHelpDraft((current) => ({
                                ...current,
                                noExampleJustification: event.target.value,
                              }))
                            }
                          />
                        </div>
                      )}

                      <div className="grid gap-3 pt-1">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            Examples
                          </div>
                          {canEdit && (
                            <Button
                              size="sm"
                              variant="outline"
                              aria-label={toolHelpActionLabels.addExample}
                              onClick={addHelpExample}
                            >
                              Add example
                            </Button>
                          )}
                        </div>
                        {helpDraft.examples.length === 0 ? (
                          <p className="border border-dashed border-paper-rule px-3 py-6 text-center font-mono text-[12px] text-ink-faint">
                            {hostedIntegrationToolHelpEmptyStateText({
                              state: "examples_empty",
                              toolName: editorModel.selectedToolName,
                            })}
                          </p>
                        ) : (
                          <div className="grid border-t border-paper-rule">
                            <div
                              className={cn(
                                "hidden gap-3 border-b border-paper-rule py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid",
                                canEdit
                                  ? "grid-cols-[4rem_180px_minmax(0,1fr)_2rem]"
                                  : "grid-cols-[4rem_180px_minmax(0,1fr)]",
                              )}
                            >
                              <span>No</span>
                              <span>Payload shape</span>
                              <span>Payload</span>
                              {canEdit && <span />}
                            </div>
                            {helpDraft.examples.map((example, index) => {
                              const helpExampleLabels =
                                hostedIntegrationToolHelpExampleAccessibleLabels(
                                  {
                                    toolName: editorModel.selectedToolName,
                                    exampleIndex: index,
                                  },
                                );
                              return (
                                <div
                                  key={index}
                                  className={cn(
                                    "grid gap-3 border-b border-paper-rule/50 py-3 last:border-b-0",
                                    canEdit
                                      ? "md:grid-cols-[4rem_180px_minmax(0,1fr)_2rem]"
                                      : "md:grid-cols-[4rem_180px_minmax(0,1fr)]",
                                  )}
                                >
                                  <div className="font-mono text-[12px] text-ink">
                                    <span className="md:hidden">Example </span>
                                    {index + 1}
                                  </div>
                                  <div className="font-mono text-[11px] leading-5 text-ink-soft">
                                    <span className="block text-[10px] uppercase tracking-[0.08em] text-ink-faint md:hidden">
                                      Payload shape
                                    </span>
                                    {helpExamplePayloadShape(example.valueJson)}
                                  </div>
                                  <div className="grid gap-2">
                                    <Label
                                      htmlFor={`help-example-${index}`}
                                      className="md:sr-only"
                                    >
                                      Payload
                                    </Label>
                                    {canEdit ? (
                                      <Textarea
                                        id={`help-example-${index}`}
                                        aria-label={helpExampleLabels.payload}
                                        value={example.valueJson}
                                        rows={6}
                                        className={cn(
                                          HOSTED_HELP_TEXTAREA_CLASS,
                                          "font-mono text-[12px]",
                                        )}
                                        onChange={(event) =>
                                          updateHelpExample(
                                            index,
                                            event.target.value,
                                          )
                                        }
                                      />
                                    ) : (
                                      <pre
                                        id={`help-example-${index}`}
                                        aria-label={helpExampleLabels.payload}
                                        className="w-full whitespace-pre-wrap font-mono text-[12px] leading-5 text-ink"
                                      >
                                        {example.valueJson}
                                      </pre>
                                    )}
                                  </div>
                                  {canEdit && (
                                    <Button
                                      size="icon"
                                      variant="ghost"
                                      onClick={() => removeHelpExample(index)}
                                      aria-label={helpExampleLabels.remove}
                                    >
                                      <Trash2 className="size-4" aria-hidden />
                                    </Button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {editorSection === "config" && (
            <section className="grid gap-4 pt-3">
              {row.environmentConfigs.length === 0 ? (
                <EmptyState icon={Server} className="py-10">
                  {hostedIntegrationConfigEmptyStateText({
                    familyName: row.name,
                  })}
                </EmptyState>
              ) : (
                row.environmentConfigs.map((scope) => {
                  const missingSecretCount = Math.max(
                    scope.secretKeys.length - scope.configuredSecretCount,
                    0,
                  );
                  return (
                    <section
                      key={scope.id}
                      aria-label={hostedIntegrationEnvironmentConfigAccessibleLabel(
                        {
                          environmentConfigId: scope.id,
                          environment: scope.environment,
                          configKeyCount: scope.configKeyCount,
                          configuredSecretCount: scope.configuredSecretCount,
                          secretKeyCount: scope.secretKeys.length,
                        },
                      )}
                      className="grid gap-4 border-b border-paper-rule pb-4 last:border-b-0"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-mono text-[12px] text-ink">
                            {scope.id}
                          </div>
                          <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            {scope.environment} · revision {scope.revision}
                          </div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge
                            variant="outline"
                            className="font-mono text-[10px]"
                          >
                            {scope.configKeyCount} config
                          </Badge>
                          <Badge
                            variant={
                              missingSecretCount > 0 ? "destructive" : "outline"
                            }
                            className="font-mono text-[10px]"
                          >
                            {missingSecretCount} missing secrets
                          </Badge>
                        </div>
                      </div>

                      <div className="grid gap-5 lg:grid-cols-2">
                        <div className="grid content-start gap-2">
                          <SectionEyebrow
                            rule={false}
                            meta={`${scope.configKeys.length} keys`}
                          >
                            Config env
                          </SectionEyebrow>
                          {scope.configKeys.length === 0 ? (
                            <p className="border-y border-paper-rule px-3 py-4 text-[12px] text-ink-soft">
                              No non-secret config keys defined.
                            </p>
                          ) : (
                            <div className="grid border-t border-paper-rule">
                              {scope.configKeys.map((key) => (
                                <div
                                  key={key.name}
                                  className="border-b border-paper-rule/60 py-2 font-mono text-[12px] text-ink"
                                >
                                  {key.name}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        <div className="grid content-start gap-2">
                          <SectionEyebrow
                            rule={false}
                            meta={`${scope.secretKeys.length} keys`}
                          >
                            Secret env
                          </SectionEyebrow>
                          {scope.secretKeys.length === 0 ? (
                            <p className="border-y border-paper-rule px-3 py-4 text-[12px] text-ink-soft">
                              No secret env vars required.
                            </p>
                          ) : (
                            <div className="grid border-t border-paper-rule">
                              {scope.secretKeys.map((secret) => {
                                const draftKey = hostedSecretDraftKey(
                                  scope.id,
                                  secret.name,
                                );
                                const draftValue = secretDrafts[draftKey] ?? "";
                                return (
                                  <div
                                    key={secret.name}
                                    className="grid gap-2 border-b border-paper-rule/60 py-2 md:grid-cols-[minmax(0,1fr)_7rem_minmax(10rem,14rem)_auto] md:items-center"
                                  >
                                    <div className="min-w-0 font-mono text-[12px] text-ink">
                                      {secret.name}
                                    </div>
                                    <Badge
                                      variant={
                                        secret.configured
                                          ? "outline"
                                          : "destructive"
                                      }
                                      className="w-fit font-mono text-[10px]"
                                    >
                                      {hostedIntegrationSecretStatusLabel(
                                        secret.configured,
                                      )}
                                    </Badge>
                                    <Input
                                      type="password"
                                      autoComplete="new-password"
                                      value={draftValue}
                                      disabled={!canManage}
                                      placeholder={
                                        secret.configured
                                          ? "Rotate value"
                                          : "Set value"
                                      }
                                      aria-label={hostedIntegrationSecretInputAccessibleLabel(
                                        {
                                          environmentConfigId: scope.id,
                                          secretName: secret.name,
                                        },
                                      )}
                                      className="font-mono text-[12px]"
                                      onChange={(event) =>
                                        setSecretDrafts((current) => ({
                                          ...current,
                                          [draftKey]: event.target.value,
                                        }))
                                      }
                                    />
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      disabled={
                                        !canManage ||
                                        busy !== null ||
                                        draftValue.length === 0
                                      }
                                      aria-label={hostedIntegrationSecretActionAccessibleLabel(
                                        {
                                          environmentConfigId: scope.id,
                                          secretName: secret.name,
                                        },
                                      )}
                                      onClick={() =>
                                        void saveSecretValue(scope, secret.name)
                                      }
                                    >
                                      Save
                                    </Button>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    </section>
                  );
                })
              )}
            </section>
          )}

          {editorSection === "agents" && (
            <section className="grid gap-4 pt-3">
              {agentBindingMatrixLoading ? (
                <p className="border-y border-paper-rule px-3 py-4 font-mono text-[12px] text-ink-faint">
                  Loading agent bindings…
                </p>
              ) : agentBindingMatrixError ? (
                <p className="border-y border-red-200 bg-red-50 px-3 py-4 text-[12px] text-red-900">
                  {agentBindingMatrixError}
                </p>
              ) : !agentBindingMatrix || agentBindingMatrix.totalCount === 0 ? (
                <EmptyState icon={Users} className="py-10">
                  No agents currently allow this hosted tool.
                </EmptyState>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-rule pb-3">
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[12px] text-ink">
                        {agentBindingMatrix.managedToolName}
                      </div>
                      <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        {agentBindingMatrix.agentCount} agents ·{" "}
                        {agentBindingMatrix.internalCount} internal
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={agentBindingMatrixLoading}
                      onClick={() => void loadAgentBindingMatrix()}
                    >
                      Refresh
                    </Button>
                  </div>
                  {agentBindingMatrix.groups
                    .filter((group) => group.rows.length > 0)
                    .map((group) => (
                      <section key={group.kind} className="grid gap-2">
                        <SectionEyebrow
                          rule={false}
                          meta={`${group.rows.length} bindings`}
                        >
                          {group.label}
                        </SectionEyebrow>
                        <div className="grid overflow-hidden border-y border-paper-rule">
                          <div className="grid gap-3 border-b border-paper-rule px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid-cols-[minmax(150px,0.8fr)_7.5rem_9rem_minmax(140px,0.65fr)_minmax(160px,1fr)]">
                            <span>Agent</span>
                            <span>Default env</span>
                            <span>Allowed envs</span>
                            <span>Generation</span>
                            <span>Note</span>
                          </div>
                          {group.rows.map((binding) => (
                            <div
                              key={`${binding.bindingKind}:${binding.agentId}:${binding.toolName}`}
                              className="grid gap-3 border-b border-paper-rule/60 px-3 py-3 last:border-b-0 md:grid-cols-[minmax(150px,0.8fr)_7.5rem_9rem_minmax(140px,0.65fr)_minmax(160px,1fr)]"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-[13px] text-ink">
                                  {binding.agentName}
                                </div>
                                <div className="mt-0.5 truncate font-mono text-[10px] text-ink-faint">
                                  {binding.agentId}
                                </div>
                              </div>
                              <div className="font-mono text-[12px] text-ink-soft">
                                {binding.defaultEnvironment}
                              </div>
                              <div className="font-mono text-[12px] text-ink-soft">
                                {binding.allowedEnvironments.join(", ")}
                              </div>
                              <div className="font-mono text-[12px] text-ink-soft">
                                {binding.generationLabel}
                              </div>
                              <div className="min-w-0 text-[12px] leading-5 text-ink-soft">
                                {binding.noteLabel || "—"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                </>
              )}
            </section>
          )}

          {editorSection === "files" && (
            <div className="grid min-h-[620px] min-w-0 border border-paper-rule lg:grid-cols-[280px_minmax(0,1fr)]">
              <aside className="min-w-0 border-b border-paper-rule bg-paper-sunk lg:border-b-0 lg:border-r">
                {draft && (
                  <div className="flex border-b border-paper-rule">
                    {[
                      ["published", "Current"],
                      ["draft", "Changes"],
                    ].map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() =>
                          setFileMode(value as "published" | "draft")
                        }
                        aria-pressed={fileMode === value}
                        aria-label={hostedIntegrationFileModeAccessibleLabel({
                          mode: value === "published" ? "current" : "changes",
                          familyName: row.name,
                        })}
                        className={cn(
                          "relative flex-1 px-3 py-2 text-left font-mono text-[10px] uppercase tracking-[0.08em] transition-colors",
                          fileMode === value
                            ? "bg-paper text-ink after:absolute after:inset-x-0 after:bottom-[-1px] after:h-[2px] after:bg-plot-red"
                            : "text-ink-soft hover:bg-paper hover:text-ink",
                        )}
                      >
                        {label}
                      </button>
                    ))}
                    <span
                      aria-hidden="true"
                      className="block shrink-0 basis-[45vw] md:hidden"
                    />
                  </div>
                )}

                <div className="flex w-full min-w-0 overflow-x-auto overflow-y-hidden lg:block lg:max-h-[520px] lg:overflow-y-auto">
                  {fileMode === "published" ? (
                    sourceFiles.length === 0 ? (
                      <div className="px-3 py-4 font-mono text-[11px] text-ink-faint">
                        {hostedIntegrationFileEmptyStateText({
                          state: "current_empty",
                          familyName: row.name,
                        })}
                      </div>
                    ) : (
                      selectedFirstHostedFiles(sourceFiles, sourcePath).map(
                        (file) => (
                          <button
                            key={file.path}
                            type="button"
                            onClick={() => void readSourceFile(file.path)}
                            aria-current={
                              sourcePath === file.path ? "page" : undefined
                            }
                            aria-label={hostedIntegrationFileNavigationAccessibleLabel(
                              {
                                path: file.path,
                                sizeBytes: file.size,
                                mode: "current",
                              },
                            )}
                            className={cn(
                              "relative block min-w-[13rem] shrink-0 border-r border-paper-rule/50 px-3 py-2 text-left last:border-r-0 lg:w-full lg:border-b lg:border-r-0 lg:last:border-b-0",
                              sourcePath === file.path
                                ? "bg-paper text-ink"
                                : "text-ink-soft hover:bg-paper hover:text-ink",
                            )}
                          >
                            {sourcePath === file.path && (
                              <span
                                className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
                                aria-hidden
                              />
                            )}
                            <div className="truncate font-mono text-[12px]">
                              {file.path}
                            </div>
                            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
                              {file.size} bytes
                            </div>
                          </button>
                        ),
                      )
                    )
                  ) : !draft ? (
                    <div className="px-3 py-4 font-mono text-[11px] text-ink-faint">
                      {hostedIntegrationFileEmptyStateText({
                        state: "changes_locked",
                        familyName: row.name,
                      })}
                    </div>
                  ) : draftFiles.length === 0 ? (
                    <div className="px-3 py-4 font-mono text-[11px] text-ink-faint">
                      {hostedIntegrationFileEmptyStateText({
                        state: "changes_empty",
                        familyName: row.name,
                      })}
                    </div>
                  ) : (
                    selectedFirstHostedFiles(draftFiles, draftPath).map(
                      (file) => (
                        <button
                          key={file.path}
                          type="button"
                          onClick={() =>
                            void readDraftFile(draft.id, file.path)
                          }
                          aria-current={
                            draftPath === file.path ? "page" : undefined
                          }
                          aria-label={hostedIntegrationFileNavigationAccessibleLabel(
                            {
                              path: file.path,
                              sizeBytes: file.size,
                              mode: "changes",
                            },
                          )}
                          className={cn(
                            "relative block min-w-[13rem] shrink-0 border-r border-paper-rule/50 px-3 py-2 text-left last:border-r-0 lg:w-full lg:border-b lg:border-r-0 lg:last:border-b-0",
                            draftPath === file.path
                              ? "bg-paper text-ink"
                              : "text-ink-soft hover:bg-paper hover:text-ink",
                          )}
                        >
                          {draftPath === file.path && (
                            <span
                              className="absolute inset-y-0 left-0 w-[2px] bg-plot-red"
                              aria-hidden
                            />
                          )}
                          <div className="truncate font-mono text-[12px]">
                            {file.path}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
                            {file.size} bytes
                          </div>
                        </button>
                      ),
                    )
                  )}
                </div>
              </aside>

              <section className="min-w-0">
                {fileMode === "published" ? (
                  <HostedCodeEditor
                    label="Current source"
                    textareaLabel={hostedIntegrationFileEditorAccessibleLabel({
                      mode: "current",
                      path: sourcePath,
                    })}
                    path={sourcePath}
                    language={languageForHostedPath(sourcePath)}
                    readOnly
                    value={sourceContent}
                    minHeightClassName="h-[min(70vh,760px)] min-h-[360px]"
                  />
                ) : !draft ? (
                  <div className="flex min-h-[620px] items-center justify-center p-6">
                    <div className="max-w-md border border-dashed border-paper-rule px-4 py-8 text-center">
                      <div className="label-faceplate mb-2 text-ink-soft">
                        Read-only view
                      </div>
                      <p className="text-sm text-ink-soft">
                        {hostedIntegrationFileEmptyStateText({
                          state: "changes_locked",
                          familyName: row.name,
                        })}
                      </p>
                    </div>
                  </div>
                ) : (
                  <div className="grid min-w-0 gap-3">
                    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-paper-rule bg-paper-sunk px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <Label htmlFor="hosted-draft-file-path">Path</Label>
                        <Input
                          id="hosted-draft-file-path"
                          value={draftPath}
                          onChange={(e) => setDraftPath(e.target.value)}
                          disabled={!canEdit}
                          className="mt-1 font-mono text-[12px]"
                        />
                      </div>
                      <div className="flex gap-2 self-end">
                        {draftFileActionState.canDeleteFile ? (
                          <Button
                            variant="outline"
                            size="sm"
                            aria-label={draftFileActionLabels.delete}
                            disabled={busy !== null}
                            onClick={deleteDraftFile}
                          >
                            Delete file
                          </Button>
                        ) : null}
                        {draftFileActionState.canSaveFile ? (
                          <Button
                            size="sm"
                            aria-label={draftFileActionLabels.save}
                            disabled={busy !== null}
                            onClick={saveDraftFile}
                          >
                            Save
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    <HostedCodeEditor
                      label="Changed source"
                      textareaLabel={hostedIntegrationFileEditorAccessibleLabel(
                        {
                          mode: "changes",
                          path: draftPath,
                        },
                      )}
                      path={draftPath}
                      language={languageForHostedPath(draftPath)}
                      value={draftContent}
                      onChange={setDraftContent}
                      disabled={!canEdit}
                      minHeightClassName="h-[min(70vh,760px)] min-h-[360px]"
                    />
                  </div>
                )}
              </section>
            </div>
          )}

          {editorSection === "test" && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <Label htmlFor="hosted-test-example">Examples</Label>
                <div className="flex w-full flex-wrap items-center justify-end gap-2 sm:w-auto">
                  {testExamples.length > 0 ? (
                    <Select
                      value={testExampleId}
                      onValueChange={(id) => {
                        if (draft) {
                          setExampleId(id);
                          const selected = examples.find(
                            (example) => example.id === id,
                          );
                          if (selected)
                            setExampleDraft(JSON.stringify(selected, null, 2));
                        } else {
                          setPublishedExampleId(id);
                        }
                      }}
                    >
                      <SelectTrigger
                        id="hosted-test-example"
                        aria-label={hostedIntegrationExampleSelectorAccessibleLabel(
                          editorModel.selectedToolName,
                        )}
                        className="w-full sm:w-80 md:w-96"
                      >
                        <SelectValue placeholder="Select example" />
                      </SelectTrigger>
                      <SelectContent>
                        {testExamples.map((example) => (
                          <SelectItem key={example.id} value={example.id}>
                            {example.id}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className="font-mono text-[12px] text-ink-faint">
                      {hostedIntegrationExampleEmptyStateText({
                        mode: draft ? "saved" : "published",
                        toolName: editorModel.selectedToolName,
                      })}
                    </span>
                  )}
                  {draft && exampleActionState.canSaveExample ? (
                    <Button
                      variant={selectedExample ? "outline" : "default"}
                      size="sm"
                      aria-label={exampleActionLabels.save}
                      disabled={busy !== null}
                      onClick={upsertExample}
                    >
                      Save example
                    </Button>
                  ) : null}
                  {draft && exampleActionState.canRunExample ? (
                    <Button
                      size="sm"
                      aria-label={exampleActionLabels.run}
                      disabled={busy !== null}
                      onClick={runExample}
                    >
                      Run test
                    </Button>
                  ) : null}
                </div>
              </div>

              {!draft && selectedPublishedExample ? (
                <HostedCodeEditor
                  label="Published example payload"
                  textareaLabel={hostedIntegrationExamplePayloadAccessibleLabel(
                    {
                      exampleId: selectedPublishedExample.id,
                      mode: "published",
                    },
                  )}
                  language="json"
                  readOnly
                  minHeightClassName="min-h-[360px]"
                  value={jsonPreview(selectedPublishedExample)}
                />
              ) : null}

              {draft ? (
                <>
                  <HostedCodeEditor
                    label={
                      selectedExample
                        ? "Example payload"
                        : "New example payload"
                    }
                    textareaLabel={hostedIntegrationExamplePayloadAccessibleLabel(
                      {
                        exampleId: selectedExample?.id ?? exampleId,
                        mode: selectedExample ? "saved" : "new",
                      },
                    )}
                    language="json"
                    value={exampleDraft}
                    onChange={setExampleDraft}
                    disabled={!canEdit}
                    minHeightClassName="min-h-[360px]"
                  />
                </>
              ) : null}
              {runResult ? (
                <HostedCodeEditor
                  label="Test result"
                  textareaLabel={hostedIntegrationExampleResultAccessibleLabel(
                    testExampleId,
                  )}
                  language="json"
                  readOnly
                  minHeightClassName="min-h-[260px]"
                  value={jsonPreview(runResult)}
                />
              ) : null}
            </section>
          )}

          {editorSection === "debug" && (
            <section className="grid gap-3">
              {debugUnavailableReasonText ? (
                <HostedRequirementNotice
                  icon={Cpu}
                  title="Debug setup required"
                >
                  {debugUnavailableReasonText}
                </HostedRequirementNotice>
              ) : (
                <>
                  <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_auto] sm:items-end">
                    {debugRequiresEnvironmentConfig ? (
                      <div className="grid gap-1">
                        <Label
                          htmlFor="hosted-debug-environment-config"
                          className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
                        >
                          Environment config
                        </Label>
                        <Select
                          value={debugEnvironmentConfigId}
                          onValueChange={setDebugEnvironmentConfigId}
                          disabled={!canManage}
                        >
                          <SelectTrigger
                            id="hosted-debug-environment-config"
                            aria-label={hostedIntegrationDebugEnvironmentConfigAccessibleLabel(
                              editorModel.selectedToolName,
                            )}
                            className="w-full"
                          >
                            <SelectValue placeholder="Select environment config" />
                          </SelectTrigger>
                          <SelectContent>
                            {row.environmentConfigs.map((scope) => (
                              <SelectItem key={scope.id} value={scope.id}>
                                {scope.environment} · {scope.id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : (
                      <div className="grid gap-1">
                        <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                          Runtime config
                        </Label>
                        <Badge
                          variant="outline"
                          className="h-9 justify-center font-mono text-[10px]"
                        >
                          Config-free
                        </Badge>
                      </div>
                    )}
                    <div className="grid gap-1">
                      <Label className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                        Operation
                      </Label>
                      <Badge
                        variant="outline"
                        className="h-9 justify-center font-mono text-[10px]"
                      >
                        {editorModel.selectedTool?.classification.operation ??
                          "none"}
                      </Badge>
                    </div>
                  </div>
                  <HostedCodeEditor
                    label="Arguments"
                    textareaLabel={hostedIntegrationDebugArgumentsAccessibleLabel(
                      editorModel.selectedToolName,
                    )}
                    path={editorModel.selectedTool?.name ?? undefined}
                    language="json"
                    value={debugArgsDraft}
                    onChange={setDebugArgsDraft}
                    disabled={!canManage}
                    minHeightClassName="min-h-[220px]"
                  />
                  {debugArgsParse.error ? (
                    <p className="border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
                      Invalid JSON arguments: {debugArgsParse.error}
                    </p>
                  ) : null}
                  {debugActionState.canRunDebug ? (
                    <div className="flex justify-end">
                      <Button
                        size="sm"
                        className="w-full sm:w-auto"
                        aria-label={debugActionLabel}
                        disabled={debugActionState.primaryDisabled}
                        onClick={debugReadSafeCall}
                      >
                        Run debug
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
              {debugResult ? (
                <HostedCodeEditor
                  label="Debug result"
                  textareaLabel={hostedIntegrationDebugResultAccessibleLabel({
                    toolName: editorModel.selectedToolName,
                    environmentConfigId: debugEnvironmentConfigId,
                  })}
                  language="json"
                  readOnly
                  minHeightClassName="min-h-[260px]"
                  value={jsonPreview(debugResult)}
                />
              ) : null}
            </section>
          )}

          {editorSection === "version" && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[12px] text-ink-faint">
                <span>
                  {versionRows.length === 1
                    ? "1 version"
                    : `${versionRows.length} versions`}
                </span>
                {previousVersionRows.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {versionActionState.hasSelectedTarget ? (
                      <>
                        <span className="font-mono text-[12px] text-ink-soft">
                          Selected ·{" "}
                          {rollbackTargetPublishedLabel ?? "previous version"}
                        </span>
                        {versionActionState.canCompare ? (
                          <Button
                            size="sm"
                            aria-label={versionActionAccessibleLabels.compare}
                            disabled={busy !== null}
                            onClick={loadGenerationDiff}
                          >
                            Compare
                          </Button>
                        ) : null}
                        {versionActionState.canRollback ? (
                          <Button
                            size="sm"
                            variant="ghost-destructive"
                            aria-label={versionActionAccessibleLabels.rollback}
                            disabled={busy !== null}
                            onClick={rollbackGeneration}
                          >
                            Rollback
                          </Button>
                        ) : null}
                      </>
                    ) : (
                      <span>
                        {hostedIntegrationVersionEmptyStateText({
                          state: "no_selected_previous_version",
                          familyName: row.name,
                        })}
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
              {generationDiff ? (
                <div className="grid gap-3">
                  <div className="grid gap-2 border-y border-paper-rule py-2 md:grid-cols-4">
                    {hostedVersionDiffSummary(generationDiff).map((item) => (
                      <div
                        key={item.label}
                        className="px-3 font-mono text-[11px]"
                      >
                        <div className="uppercase tracking-[0.08em] text-ink-faint">
                          {item.label}
                        </div>
                        <div className="mt-1 truncate text-ink">
                          {item.value}
                        </div>
                      </div>
                    ))}
                  </div>
                  <details>
                    <summary
                      aria-label={versionActionAccessibleLabels.diff}
                      className="cursor-pointer border-y border-paper-rule px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-ink"
                    >
                      Raw version diff
                    </summary>
                    <div className="pt-3">
                      <HostedCodeEditor
                        label="Version diff"
                        textareaLabel={versionActionAccessibleLabels.diff}
                        language="json"
                        readOnly
                        minHeightClassName="min-h-[320px]"
                        value={jsonPreview(generationDiff)}
                      />
                    </div>
                  </details>
                </div>
              ) : null}
              {rollbackResult ? (
                <HostedCodeEditor
                  label="Rollback result"
                  textareaLabel={versionActionAccessibleLabels.rollbackResult}
                  language="json"
                  readOnly
                  minHeightClassName="min-h-[220px]"
                  value={jsonPreview(rollbackResult)}
                />
              ) : null}
              {versionRows.length === 0 ? (
                <EmptyState icon={FileText} className="py-10">
                  {hostedIntegrationVersionEmptyStateText({
                    state: "no_versions",
                    familyName: row.name,
                  })}
                </EmptyState>
              ) : (
                <div className="border-y border-paper-rule">
                  <div className="hidden grid-cols-[minmax(0,1fr)_150px_180px] gap-3 border-b border-paper-rule/60 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid">
                    <span>Version</span>
                    <span>State</span>
                    <span>Published</span>
                  </div>
                  {versionRows.map((versionRow) => {
                    const selected =
                      versionRow.generation.id === compareGenerationId;
                    const promotedLabel = formatTimestamp(
                      versionRow.generation.promotedAt,
                    );
                    const rowClassName = cn(
                      "grid w-full gap-2 border-b border-paper-rule/60 px-3 py-2 text-left last:border-b-0 md:grid-cols-[minmax(0,1fr)_150px_180px] md:gap-3 md:py-3",
                      versionRow.canRollback ? "hover:bg-paper-sunk" : "",
                      selected ? "bg-paper-sunk" : "",
                    );
                    const versionRowContent = (
                      <>
                        <div className="min-w-0">
                          <div
                            className="truncate font-mono text-[12px] text-ink"
                            title={`Generation ${versionRow.generation.id}`}
                          >
                            {versionRow.relation === "current version"
                              ? "Current version"
                              : "Previous version"}
                          </div>
                          <div
                            className="mt-1 truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
                            title={`Source revision ${versionRow.generation.sourceRevisionId}`}
                          >
                            {versionRow.generation.promotedBy}
                          </div>
                          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-soft md:hidden">
                            <span>{versionRow.stateLabel}</span>
                            <span>{promotedLabel}</span>
                          </div>
                        </div>
                        <div className="hidden font-mono text-[12px] text-ink-soft md:block">
                          {versionRow.stateLabel}
                        </div>
                        <div className="hidden font-mono text-[12px] text-ink-soft md:block">
                          <div>{promotedLabel}</div>
                        </div>
                      </>
                    );
                    if (!versionRow.canRollback) {
                      return (
                        <div
                          key={versionRow.generation.id}
                          className={rowClassName}
                        >
                          {versionRowContent}
                        </div>
                      );
                    }
                    return (
                      <button
                        key={versionRow.generation.id}
                        type="button"
                        aria-pressed={selected}
                        aria-label={hostedIntegrationVersionRowAccessibleLabel({
                          row: versionRow,
                          promotedLabel,
                        })}
                        onClick={() => {
                          setCompareGenerationId(versionRow.generation.id);
                          setGenerationDiff(null);
                          setRollbackResult(null);
                        }}
                        className={rowClassName}
                      >
                        {versionRowContent}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {editorSection === "logs" && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[12px] text-ink-faint">
                <span>
                  {logsLoaded
                    ? `${scopedRunLogRows.length} ${logScopeLabel} logs`
                    : "Execution logs are loaded on demand"}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex border border-paper-rule font-mono text-[11px]">
                    {[
                      ["selected_tool", "Selected tool"],
                      ["family", "Family"],
                    ].map(([value, label]) => {
                      const active = logScope === value;
                      return (
                        <button
                          key={value}
                          type="button"
                          className={cn(
                            "border-r border-paper-rule px-2 py-1 last:border-r-0",
                            active
                              ? "bg-ink text-paper"
                              : "text-ink-soft hover:bg-paper-sunk",
                          )}
                          aria-pressed={active}
                          aria-label={hostedIntegrationLogScopeAccessibleLabel({
                            scope: value as HostedIntegrationExecutionLogScope,
                            toolName: editorModel.selectedToolName,
                            familyName: row.name,
                          })}
                          onClick={() =>
                            setLogScope(
                              value as HostedIntegrationExecutionLogScope,
                            )
                          }
                        >
                          {label}
                        </button>
                      );
                    })}
                  </div>
                  {logActionState.canRefreshLogs ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      aria-label={hostedIntegrationRefreshLogsAccessibleLabel({
                        scope: logScope,
                        toolName: editorModel.selectedToolName,
                        familyName: row.name,
                      })}
                      onClick={loadRunLogs}
                    >
                      Refresh logs
                    </Button>
                  ) : null}
                </div>
              </div>
              {scopedRunLogRows.length === 0 ? (
                <EmptyState icon={FileText} className="py-10">
                  {logsLoaded
                    ? `No execution logs recorded for ${logScopeLabel} yet.`
                    : `Refresh to inspect recent sanitized tool calls for ${logScopeLabel}.`}
                </EmptyState>
              ) : (
                <div className="border-y border-paper-rule">
                  <div className="hidden grid-cols-[minmax(0,1.4fr)_120px_140px_120px] gap-3 border-b border-paper-rule/60 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint md:grid">
                    <span>{logPrimaryHeader}</span>
                    <span>Status</span>
                    <span>Result</span>
                    <span className="text-right">Duration</span>
                  </div>
                  {scopedRunLogRows.map((entry) => {
                    const expanded = expandedRunId === entry.run.runId;
                    const logPrimaryLabel =
                      logScope === "selected_tool"
                        ? entry.versionRelation
                        : entry.run.toolName;
                    const logDetailLabels =
                      hostedIntegrationExecutionLogDetailAccessibleLabels({
                        runId: entry.run.runId,
                        artifactName: entry.artifactName,
                      });
                    const artifactActionState =
                      buildHostedIntegrationArtifactActionState({
                        runId: entry.run.runId,
                        artifactName: entry.artifactName,
                        canManage,
                      });
                    return (
                      <div
                        key={entry.run.runId}
                        className="border-b border-paper-rule/60 last:border-b-0"
                      >
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={hostedIntegrationExecutionLogRowAccessibleLabel(
                            {
                              row: entry,
                              primaryLabel: logPrimaryLabel,
                              completedLabel: formatTimestamp(
                                entry.completedAt,
                              ),
                            },
                          )}
                          onClick={() =>
                            setExpandedRunId((current) =>
                              current === entry.run.runId
                                ? ""
                                : entry.run.runId,
                            )
                          }
                          className="grid w-full gap-2 px-3 py-2 text-left hover:bg-paper-sunk md:grid-cols-[minmax(0,1.4fr)_120px_140px_120px] md:gap-3 md:py-3"
                        >
                          <div className="min-w-0">
                            <div className="truncate font-mono text-[12px] text-ink">
                              {logPrimaryLabel}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                              {logScope === "family" ? (
                                <span title={`Run ${entry.run.runId}`}>
                                  {entry.versionRelation}
                                </span>
                              ) : null}
                              <span>
                                {hostedIntegrationExecutionConfigLabel(
                                  entry.run,
                                )}
                              </span>
                              <span>{formatTimestamp(entry.completedAt)}</span>
                            </div>
                            <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-soft md:hidden">
                              <span className="text-ink">
                                {entry.run.status}
                              </span>
                              <span>
                                {entry.errorCode ?? entry.resultLabel}
                              </span>
                              <span>{entry.durationLabel}</span>
                            </div>
                          </div>
                          <div className="hidden font-mono text-[12px] text-ink md:block">
                            {entry.run.status}
                          </div>
                          <div className="hidden font-mono text-[12px] text-ink-soft md:block">
                            {entry.errorCode ?? entry.resultLabel}
                          </div>
                          <div className="hidden text-right font-mono text-[12px] text-ink-soft md:block">
                            {entry.durationLabel}
                          </div>
                        </button>
                        {expanded && (
                          <div className="grid gap-3 border-t border-paper-rule/50 px-3 pb-3 pt-3">
                            <div className="grid gap-2 font-mono text-[11px] text-ink-soft md:grid-cols-2">
                              <div>
                                Actor{" "}
                                <span className="text-ink">
                                  {entry.run.actorId}
                                </span>
                              </div>
                              <div>
                                {entry.run.configRevision === null
                                  ? "Execution purpose"
                                  : "Config revision"}{" "}
                                <span className="text-ink">
                                  {hostedIntegrationExecutionConfigRevisionLabel(
                                    entry.run,
                                  )}
                                </span>
                              </div>
                              {entry.artifactName ? (
                                <div className="md:col-span-2">
                                  Artifact{" "}
                                  {artifactActionState.canLoadArtifact ? (
                                    <button
                                      type="button"
                                      aria-label={logDetailLabels.loadArtifact}
                                      disabled={busy !== null}
                                      onClick={() =>
                                        loadRunArtifact(
                                          entry.run.runId,
                                          entry.artifactName!,
                                        )
                                      }
                                      className="text-plot-red underline-offset-2 hover:underline disabled:text-ink-faint"
                                    >
                                      {entry.artifactName}
                                    </button>
                                  ) : (
                                    <span className="text-ink">
                                      {entry.artifactName}
                                    </span>
                                  )}
                                </div>
                              ) : null}
                            </div>
                            <HostedCodeEditor
                              label="Sanitized arguments"
                              textareaLabel={logDetailLabels.sanitizedArguments}
                              language="json"
                              readOnly
                              minHeightClassName="min-h-[160px]"
                              value={jsonPreview(entry.run.sanitizedArgs)}
                            />
                            {entry.run.error ? (
                              <HostedCodeEditor
                                label="Error"
                                textareaLabel={logDetailLabels.error}
                                language="json"
                                readOnly
                                minHeightClassName="min-h-[160px]"
                                value={jsonPreview(entry.run.error)}
                              />
                            ) : null}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {artifactPreview ? (
                <HostedCodeEditor
                  label="Artifact"
                  textareaLabel={
                    hostedIntegrationExecutionLogDetailAccessibleLabels({
                      runId: artifactPreview.runId,
                      artifactName: artifactPreview.name,
                    }).artifact
                  }
                  path={`${artifactPreview.runId}/${artifactPreview.name}`}
                  language="json"
                  readOnly
                  minHeightClassName="min-h-[260px]"
                  value={jsonPreview(artifactPreview.content)}
                />
              ) : null}
            </section>
          )}

          {editorSection === "failures" && row.failureBuckets.length > 0 && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 font-mono text-[12px] text-ink-faint">
                <span>
                  {failureSummaryState.openCount} open ·{" "}
                  {failureSummaryState.assignedOpenCount} assigned
                </span>
                <span>{failureSummaryState.guidance}</span>
              </div>
              <div className="border-y border-paper-rule">
                {row.failureBuckets.map((bucket) => {
                  const isCurrentVersion =
                    row.activeGeneration?.id === bucket.generationId;
                  const assigned = bucket.assignedTo ?? "unassigned";
                  const expanded = expandedFailureBucketId === bucket.id;
                  const versionRelation = isCurrentVersion
                    ? "current version"
                    : "previous version";
                  const failureBucketActionLabels =
                    hostedIntegrationFailureBucketActionAccessibleLabels({
                      bucket,
                      versionRelation,
                    });
                  const failureBucketActionState =
                    buildHostedIntegrationFailureBucketActionState({
                      bucket,
                      canManage,
                      assignedRepairActor: "tool-developer",
                    });
                  return (
                    <div
                      key={bucket.id}
                      className="border-b border-paper-rule/60 last:border-b-0"
                    >
                      <div className="grid gap-2 px-3 py-2 md:grid-cols-[minmax(0,1.4fr)_120px_180px_auto] md:gap-3 md:py-3">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={hostedIntegrationFailureBucketAccessibleLabel(
                            {
                              bucket,
                              versionRelation,
                              assignedLabel: assigned,
                              latestSeenLabel: formatTimestamp(
                                bucket.latestSeenAt,
                              ),
                            },
                          )}
                          onClick={() =>
                            setExpandedFailureBucketId((current) =>
                              current === bucket.id ? "" : bucket.id,
                            )
                          }
                          className="flex min-w-0 items-start gap-2 text-left"
                        >
                          {expanded ? (
                            <ChevronDown
                              className="mt-0.5 size-3.5 shrink-0 text-ink-faint"
                              aria-hidden
                            />
                          ) : (
                            <ChevronRight
                              className="mt-0.5 size-3.5 shrink-0 text-ink-faint"
                              aria-hidden
                            />
                          )}
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-[12px] text-ink">
                              {bucket.toolName}
                            </span>
                            <span
                              className="mt-1 block truncate font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint"
                              title={`Generation ${bucket.generationId}`}
                            >
                              {versionRelation}
                            </span>
                            <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[11px] text-ink-soft md:hidden">
                              <span className="text-ink">
                                {hostedIntegrationFailureBucketHitLabel(
                                  bucket.count,
                                )}
                              </span>
                              <span>{assigned}</span>
                              <span>
                                {formatTimestamp(bucket.latestSeenAt)}
                              </span>
                              <span className="uppercase">
                                {bucket.status === "closed"
                                  ? "closed"
                                  : bucket.assignedTo
                                    ? "assigned"
                                    : "open"}
                              </span>
                            </span>
                          </span>
                        </button>
                        <div className="hidden font-mono text-[12px] text-ink md:block">
                          {hostedIntegrationFailureBucketHitLabel(bucket.count)}
                        </div>
                        <div className="hidden font-mono text-[12px] text-ink-soft md:block">
                          <div>{assigned}</div>
                          <div className="mt-1 text-[10px] uppercase tracking-[0.08em] text-ink-faint">
                            {formatTimestamp(bucket.latestSeenAt)}
                          </div>
                        </div>
                        <div
                          className={cn(
                            "items-center justify-end",
                            failureBucketActionState.canAssignRepair
                              ? "flex"
                              : "hidden md:flex",
                          )}
                        >
                          {failureBucketActionState.canAssignRepair ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={busy !== null}
                              aria-label={
                                failureBucketActionLabels.assignRepair
                              }
                              onClick={() => assignFailureBucket(bucket.id)}
                            >
                              Assign repair
                            </Button>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="font-mono text-[10px]"
                            >
                              {bucket.status === "closed"
                                ? "closed"
                                : "assigned"}
                            </Badge>
                          )}
                        </div>
                      </div>
                      {expanded ? (
                        <div className="grid gap-2 border-t border-paper-rule/50 px-3 pb-3 pt-3 font-mono text-[11px] text-ink-soft md:grid-cols-2">
                          <div>
                            Status{" "}
                            <span className="text-ink">{bucket.status}</span>
                          </div>
                          <div>
                            Generation{" "}
                            <span className="text-ink">{versionRelation}</span>
                          </div>
                          {bucket.firstSeenAt ? (
                            <div>
                              First seen{" "}
                              <span className="text-ink">
                                {formatTimestamp(bucket.firstSeenAt)}
                              </span>
                            </div>
                          ) : null}
                          <div>
                            Latest seen{" "}
                            <span className="text-ink">
                              {formatTimestamp(bucket.latestSeenAt)}
                            </span>
                          </div>
                          {bucket.fingerprint ? (
                            <div className="md:col-span-2">
                              Fingerprint{" "}
                              <span className="break-all text-ink">
                                {bucket.fingerprint}
                              </span>
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {editorSection === "publish" && publishActionState.showLane && (
            <section className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-mono text-[12px] text-ink-faint">
                  {publishViewState.publishBlocked
                    ? "Production readiness is blocked."
                    : publishViewState.publishReady
                      ? "Validation passed. Pending changes can be published."
                      : "Validate pending changes before publishing."}
                </p>
                <Button
                  size="sm"
                  disabled={publishPrimaryDisabled}
                  aria-label={publishAccessibleLabels.primary}
                  onClick={
                    publishViewState.publishReady ? promoteDraft : validateDraft
                  }
                >
                  {publishViewState.primaryLabel}
                </Button>
              </div>
              {publishViewState.blockerLabel ? (
                <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  {publishViewState.blockerLabel}
                </p>
              ) : null}
              {promotionNeedsHumanApproval && (
                <p className="border border-amber-300 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
                  Human approval is required for destructive publishing.
                </p>
              )}
              {validation ? (
                <div className="grid gap-2 border-y border-paper-rule py-2 md:grid-cols-3">
                  {hostedValidationSummary(validation).map((item) => (
                    <div
                      key={item.label}
                      className="px-3 font-mono text-[11px]"
                    >
                      <div className="uppercase tracking-[0.08em] text-ink-faint">
                        {item.label}
                      </div>
                      <div className="mt-1 truncate text-ink">{item.value}</div>
                    </div>
                  ))}
                </div>
              ) : null}
              {validation || publishReadiness || publishResult ? (
                <details className="border-y border-paper-rule">
                  <summary
                    aria-label={publishAccessibleLabels.rawResult}
                    className="cursor-pointer px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft hover:text-ink"
                  >
                    Raw result
                  </summary>
                  <div className="border-t border-paper-rule bg-paper-sunk p-3">
                    <HostedCodeEditor
                      label={
                        publishViewState.resultLabel ?? "Validation result"
                      }
                      textareaLabel={publishAccessibleLabels.result}
                      language="json"
                      readOnly
                      minHeightClassName="min-h-[260px]"
                      value={jsonPreview({
                        validation,
                        readiness: publishReadiness,
                        publish: publishResult,
                      })}
                    />
                  </div>
                </details>
              ) : null}
            </section>
          )}
        </div>
        {busy && <LoadingHairline inline />}
      </div>
    </div>
  );
}

function HostedRequirementNotice({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex max-w-2xl items-start gap-3 border-l-2 border-warn-ochre bg-warn-ochre/[0.06] px-3 py-4">
      <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center bg-warn-ochre/[0.14] text-warn-ochre">
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="font-mono text-[11px] uppercase tracking-[0.08em] text-warn-ochre">
          {title}
        </div>
        <p className="mt-1 text-[13px] leading-6 text-ink">{children}</p>
      </div>
    </div>
  );
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString();
}

function HostedCodeEditor({
  value,
  onChange,
  label,
  textareaLabel,
  path,
  language,
  actions,
  readOnly = false,
  disabled = false,
  minHeightClassName = "min-h-[420px]",
}: {
  value: string;
  onChange?: (value: string) => void;
  label: string;
  textareaLabel?: string;
  path?: string;
  language: string;
  actions?: React.ReactNode;
  readOnly?: boolean;
  disabled?: boolean;
  minHeightClassName?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const lineCount = Math.max(1, value.split("\n").length);

  function updateCursor() {
    const el = textareaRef.current;
    if (!el) return;
    const beforeCursor = el.value.slice(0, el.selectionStart);
    const lines = beforeCursor.split("\n");
    setCursor({
      line: lines.length,
      column: (lines[lines.length - 1]?.length ?? 0) + 1,
    });
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Tab" || readOnly || disabled || !onChange) return;
    event.preventDefault();
    const el = event.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    onChange(next);
    window.requestAnimationFrame(() => {
      el.selectionStart = start + 2;
      el.selectionEnd = start + 2;
      updateCursor();
    });
  }

  return (
    <div className="min-w-0 overflow-hidden border border-paper-rule bg-paper">
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-paper-rule bg-paper-sunk px-3 py-2">
        <div className="min-w-0">
          <div className="label-faceplate text-ink-soft">{label}</div>
          {path && (
            <div className="mt-0.5 truncate font-mono text-[11px] text-ink-faint">
              {path}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-3">
          {actions}
          <div className="flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
            <span>{language}</span>
            <span>{readOnly || disabled ? "read only" : "editable"}</span>
          </div>
        </div>
      </div>
      <div className={cn("flex min-h-0 overflow-hidden", minHeightClassName)}>
        <textarea
          ref={textareaRef}
          value={value}
          readOnly={readOnly}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange?.(event.target.value)}
          onKeyDown={handleKeyDown}
          onClick={updateCursor}
          onKeyUp={updateCursor}
          onSelect={updateCursor}
          aria-label={textareaLabel ?? label}
          className="min-w-0 flex-1 resize-none border-0 bg-paper px-3 py-3 font-mono text-[12px] leading-5 text-ink outline-none selection:bg-plot-red/20 disabled:cursor-not-allowed disabled:text-ink-faint"
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-paper-rule bg-paper-sunk px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint tabular-nums">
        <span>
          {lineCount} lines · {value.length} chars
        </span>
        <span>
          ln {cursor.line}, col {cursor.column}
        </span>
      </div>
    </div>
  );
}

function languageForHostedPath(pathValue: string): string {
  const lower = pathValue.toLowerCase();
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "source";
}

function selectedFirstHostedFiles(
  files: HostedIntegrationFileEntry[],
  selectedPath: string,
): HostedIntegrationFileEntry[] {
  if (!selectedPath) return files;
  const selected = files.find((file) => file.path === selectedPath);
  if (!selected) return files;
  return [selected, ...files.filter((file) => file.path !== selectedPath)];
}

function defaultExampleForRow(
  row: HostedIntegrationAdminFamilyRow,
): HostedIntegrationExample {
  const toolName = row.tools[0]?.name ?? `${row.id}_tool`;
  return {
    id: "smoke_example",
    familyId: row.id,
    toolName,
    category: "smoke",
    args: {},
    expected: {},
  };
}

function helpEditorStateFromTool(
  tool: HostedIntegrationToolSpec | null,
): HostedIntegrationToolHelpEditorState {
  const help = tool?.help;
  const parameters = helpParametersFromTool(tool);
  return {
    summary: help?.summary ?? "",
    full: help?.full ?? "",
    whenToUse: (help?.whenToUse ?? []).join("\n"),
    whenNotToUse: (help?.whenNotToUse ?? []).join("\n"),
    parameters,
    examples: (help?.examples ?? []).map((example) => ({
      valueJson: JSON.stringify(example, null, 2),
    })),
    noExampleJustification: help?.noExampleJustification ?? "",
  };
}

function helpPayloadFromEditorState(
  state: HostedIntegrationToolHelpEditorState,
): Record<string, unknown> {
  const parameters = Object.fromEntries(
    state.parameters
      .map((parameter) => {
        const name = parameter.name.trim();
        if (!name) return null;
        const shape = parseOptionalJsonObject(
          parameter.shapeJson,
          `help.parameters.${name}.shape`,
        );
        const examples = parameter.examples.map((example, index) =>
          parseJsonValue(
            example.valueJson,
            `help.parameters.${name}.examples.${index}`,
          ),
        );
        const payload = dropEmptyObjectFields({
          summary: optionalTrimmedString(parameter.summary),
          full: optionalTrimmedString(parameter.full),
          shape,
          rules: linesFromTextarea(parameter.rules),
          examples,
        });
        if (Object.keys(payload).length === 0) return null;
        return [name, payload] as const;
      })
      .filter((entry): entry is readonly [string, Record<string, unknown>] => {
        return entry !== null;
      }),
  );
  const examples = state.examples.map((example, index) =>
    parseJsonValue(example.valueJson, `help.examples.${index}`),
  );
  return dropEmptyObjectFields({
    summary: optionalTrimmedString(state.summary),
    full: optionalTrimmedString(state.full),
    whenToUse: linesFromTextarea(state.whenToUse),
    whenNotToUse: linesFromTextarea(state.whenNotToUse),
    parameters,
    examples,
    noExampleJustification: optionalTrimmedString(state.noExampleJustification),
  });
}

function helpParametersFromTool(
  tool: HostedIntegrationToolSpec | null,
): HostedIntegrationToolHelpParameterEditorState[] {
  const parameterHelp = tool?.help?.parameters ?? {};
  const parameterNames = new Set<string>([
    ...inputSchemaPropertyNames(tool?.inputSchema),
    ...Object.keys(parameterHelp),
  ]);
  return [...parameterNames].map((name) => {
    const help = parameterHelp[name] as
      | {
          summary?: unknown;
          full?: unknown;
          shape?: unknown;
          rules?: unknown;
          examples?: unknown;
        }
      | undefined;
    return {
      name,
      summary: typeof help?.summary === "string" ? help.summary : "",
      full: typeof help?.full === "string" ? help.full : "",
      shapeJson:
        help?.shape && typeof help.shape === "object"
          ? JSON.stringify(help.shape, null, 2)
          : "",
      rules: Array.isArray(help?.rules)
        ? help.rules.filter((rule) => typeof rule === "string").join("\n")
        : "",
      examples: Array.isArray(help?.examples)
        ? help.examples.map((example) => ({
            valueJson: JSON.stringify(example, null, 2),
          }))
        : [],
    };
  });
}

function inputSchemaPropertyNames(
  schema: Record<string, unknown> | undefined,
): string[] {
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return [];
  }
  return Object.keys(properties);
}

function hostedInputSchemaRows(
  schema: Record<string, unknown> | null | undefined,
): Array<{ name: string; type: string; required: boolean; details: string }> {
  const properties = schema?.properties;
  if (
    !properties ||
    typeof properties !== "object" ||
    Array.isArray(properties)
  ) {
    return [];
  }
  const required = new Set(
    Array.isArray(schema?.required)
      ? schema.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  return Object.entries(properties).map(([name, value]) => {
    const property = objectValue(value) ?? {};
    return {
      name,
      required: required.has(name),
      type: hostedInputSchemaTypeLabel(property),
      details: hostedInputSchemaDetails(property),
    };
  });
}

function hostedInputSchemaTypeLabel(property: Record<string, unknown>): string {
  const type = property.type;
  if (Array.isArray(type)) {
    return (
      type.filter((value) => typeof value === "string").join(" | ") || "any"
    );
  }
  if (typeof type === "string" && type.length > 0) return type;
  if (property.enum) return "enum";
  if (property.properties) return "object";
  if (property.items) return "array";
  return "any";
}

function hostedInputSchemaDetails(property: Record<string, unknown>): string {
  const parts: string[] = [];
  if (typeof property.description === "string" && property.description.trim()) {
    parts.push(property.description.trim());
  }
  if (Array.isArray(property.enum) && property.enum.length > 0) {
    parts.push(`enum: ${property.enum.map(String).join(", ")}`);
  }
  if (typeof property.default !== "undefined") {
    parts.push(`default: ${String(property.default)}`);
  }
  if (typeof property.minimum !== "undefined") {
    parts.push(`min: ${String(property.minimum)}`);
  }
  if (typeof property.maximum !== "undefined") {
    parts.push(`max: ${String(property.maximum)}`);
  }
  return parts.join(" · ") || "No additional schema detail.";
}

function hostedHelpParameterGroups(
  parameters: HostedIntegrationToolHelpParameterEditorState[],
): {
  ordered: Array<{
    parameter: HostedIntegrationToolHelpParameterEditorState;
    index: number;
  }>;
  topLevel: Array<{
    parameter: HostedIntegrationToolHelpParameterEditorState;
    index: number;
  }>;
  nested: Array<{
    parameter: HostedIntegrationToolHelpParameterEditorState;
    index: number;
  }>;
} {
  const topLevel: Array<{
    parameter: HostedIntegrationToolHelpParameterEditorState;
    index: number;
  }> = [];
  const nested: Array<{
    parameter: HostedIntegrationToolHelpParameterEditorState;
    index: number;
  }> = [];
  parameters.forEach((parameter, index) => {
    const target = parameter.name.includes(".") ? nested : topLevel;
    target.push({ parameter, index });
  });
  const ordered = topLevel.flatMap((parent) => [
    parent,
    ...nested.filter((child) =>
      child.parameter.name.startsWith(`${parent.parameter.name}.`),
    ),
  ]);
  const attached = new Set(ordered.map((row) => row.index));
  ordered.push(...nested.filter((row) => !attached.has(row.index)));
  return { ordered, topLevel, nested };
}

function hostedSourceViewDiagnosticRows(
  diagnostics: HostedIntegrationFocusedSourceView["diagnostics"],
): Array<{
  key: string;
  severity: string;
  code: string;
  message: string;
  count: number;
}> {
  const rows = new Map<
    string,
    {
      key: string;
      severity: string;
      code: string;
      message: string;
      count: number;
    }
  >();
  for (const diagnostic of diagnostics) {
    const key = [diagnostic.severity, diagnostic.code, diagnostic.message].join(
      ":",
    );
    const existing = rows.get(key);
    if (existing) {
      existing.count += 1;
      continue;
    }
    rows.set(key, {
      key,
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
      count: 1,
    });
  }
  return [...rows.values()];
}

function parseOptionalJsonObject(
  value: string,
  label: string,
): Record<string, unknown> | undefined {
  if (!value.trim()) return undefined;
  const parsed = parseJsonValue(value, label);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseJsonValue(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} contains invalid JSON: ${message}`);
  }
}

function helpExamplePayloadShape(valueJson: string): string {
  try {
    const value = JSON.parse(valueJson) as unknown;
    if (Array.isArray(value)) return `array · ${value.length} items`;
    if (value && typeof value === "object") {
      const keys = Object.keys(value as Record<string, unknown>);
      return keys.length > 0 ? keys.slice(0, 3).join(", ") : "object";
    }
    if (value === null) return "null";
    return typeof value;
  } catch {
    return "invalid JSON";
  }
}

function linesFromTextarea(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function optionalTrimmedString(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function dropEmptyObjectFields(
  input: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined) return false;
      if (Array.isArray(value)) return value.length > 0;
      if (value && typeof value === "object") {
        return Object.keys(value).length > 0;
      }
      return true;
    }),
  );
}

function hostedSecretDraftKey(
  environmentConfigId: string,
  secretName: string,
): string {
  return `${environmentConfigId}:${secretName}`;
}

function encodeHostedPath(pathValue: string): string {
  return pathValue.split("/").map(encodeURIComponent).join("/");
}

async function hostedApiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(hostedApiErrorMessage(body, res.statusText));
  return body as T;
}

function hostedApiErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && "code" in error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string") return code;
    }
  }
  return fallback;
}

function jsonPreview(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function isHostedIntegrationValidationOk(value: unknown): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    "ok" in value &&
    (value as { ok?: unknown }).ok === true,
  );
}

function hostedVersionDiffSummary(
  value: unknown,
): Array<{ label: string; value: string }> {
  const body = objectValue(value);
  const diff = objectValue(body?.diff);
  const summary = objectValue(diff?.summary);
  const toolFocused = objectValue(diff?.toolFocused);
  const changedFiles = arrayValue(summary?.changedFiles);
  const changedTools = arrayValue(summary?.changedTools);
  const handlerPatch =
    typeof toolFocused?.handlerPatch === "string" &&
    toolFocused.handlerPatch.trim().length > 0;
  return [
    { label: "Mode", value: stringSummary(diff?.mode) },
    { label: "Tool", value: stringSummary(diff?.toolName) },
    {
      label: "Files",
      value: changedFiles ? `${changedFiles.length} changed` : "focused",
    },
    {
      label: "Handlers",
      value: changedTools
        ? `${changedTools.length} changed`
        : handlerPatch
          ? "patch available"
          : "no patch",
    },
  ];
}

function hostedValidationSummary(
  value: unknown,
): Array<{ label: string; value: string }> {
  const body = objectValue(value);
  const diagnostics = arrayValue(body?.diagnostics);
  const examples = arrayValue(body?.examples);
  return [
    { label: "Status", value: body?.ok === true ? "passed" : "failed" },
    {
      label: "Diagnostics",
      value: diagnostics ? String(diagnostics.length) : "n/a",
    },
    {
      label: "Examples",
      value: examples ? String(examples.length) : "n/a",
    },
  ];
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function arrayValue(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function stringSummary(value: unknown): string {
  return typeof value === "string" && value.length > 0 ? value : "n/a";
}
