import { AsyncLocalStorage } from "node:async_hooks";

export interface AIForensicContext {
  forensicRunId: string;
  parentForensicRunId?: string;
  agentId?: string;
  sessionId?: string;
  taskId?: string;
  messageId?: string;
  kind?: string;
  provider?: string;
  model?: string;
  authMode?: string;
  dataDir?: string;
}

const aiForensicContext = new AsyncLocalStorage<AIForensicContext>();

export function enterAIForensicContext<T>(
  context: AIForensicContext,
  fn: () => T
): T {
  return aiForensicContext.run(context, fn);
}

export function setAIForensicContext(context: AIForensicContext): void {
  aiForensicContext.enterWith(context);
}

export function getAIForensicContext(): AIForensicContext | undefined {
  return aiForensicContext.getStore();
}
