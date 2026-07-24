import * as p from "@clack/prompts";
import { loadConfig } from "@openacme/config";
import { AgentManager, repairTaskSourceSessions } from "@openacme/server";

export interface TasksRepairSourceSessionsOptions {
  dataDir?: string;
  apply?: boolean;
  json?: boolean;
  limit?: number;
}

export async function tasksRepairSourceSessionsCommand(
  opts: TasksRepairSourceSessionsOptions,
): Promise<void> {
  const config = loadConfig(opts.dataDir);
  const manager = new AgentManager(config);
  try {
    const limit =
      typeof opts.limit === "number" &&
      Number.isFinite(opts.limit) &&
      opts.limit > 0
        ? Math.floor(opts.limit)
        : undefined;
    const result = await repairTaskSourceSessions({
      taskStore: manager.taskStore,
      messageStore: manager.messageStore,
      limit,
      dryRun: opts.apply !== true,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const header = result.dryRun
      ? "Task source-session repair (dry run)"
      : "Task source-session repair";
    const lines = [
      `data dir: ${config.dataDir}`,
      `scanned task-tool messages: ${result.scannedMessages}`,
      `tasks missing created_in_session_id before repair: ${result.missingBefore}`,
      `resolved from task_create evidence: ${result.resolved}`,
      `updated: ${result.updated}`,
      `unresolved: ${result.unresolved}`,
    ];
    if (result.changes.length > 0) {
      lines.push("");
      lines.push("changes:");
      for (const change of result.changes.slice(0, 25)) {
        lines.push(
          `  ${change.taskId.padStart(4)} -> ${change.sourceSessionId}  ${change.title}`,
        );
      }
      if (result.changes.length > 25) {
        lines.push(`  ... ${result.changes.length - 25} more`);
      }
    }
    if (result.dryRun) {
      lines.push("");
      lines.push("Run again with --apply to write the missing fields.");
    }

    p.note(lines.join("\n"), header);
  } catch (err) {
    p.cancel(
      `Task source-session repair failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exitCode = 1;
  } finally {
    await manager.close();
  }
}
