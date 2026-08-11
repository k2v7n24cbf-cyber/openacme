/**
 * Tools every agent has unconditionally, independent of the `tools` field on
 * its AgentDefinition. These are introspection / self-management tools —
 * turning them off would cripple basic platform capabilities (read your own
 * skills, manage your own tasks, save to your own memory, search prior
 * sessions). `AgentDefinition.tools` stays as the user-configurable surface
 * for environment-touching tools (shell, file IO, web, exec, process).
 *
 * Merged into the effective tool set in `AgentManager.createAgentFromDef`.
 */
export const SYSTEM_TOOLS = [
  "skill_view",
  "memory",
  "session_search",
  "task_list",
  "task_view",
  "task_create",
  "task_update",
  "task_comment",
  "task_comments",
  "objective_create",
  "objective_view",
  "objective_list",
  "objective_update",
  "objective_attach_task",
  "objective_detach_task",
  "objective_close",
  "objective_event",
  "agent_list",
  "agent_ask",
  "ping_user",
  "defer_session",
] as const;

export type SystemTool = (typeof SYSTEM_TOOLS)[number];
