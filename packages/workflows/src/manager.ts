import type { WorkflowExecutionPorts } from "./ports.js";
import {
  WorkflowDispatcher,
  type WorkflowScheduledDispatchOptions,
  type WorkflowScheduledDispatchResult,
} from "./dispatcher.js";

export interface WorkflowManagerOptions {
  ports?: WorkflowExecutionPorts;
}

export class WorkflowManager {
  readonly ports: WorkflowExecutionPorts;
  readonly dispatcher: WorkflowDispatcher;

  constructor(opts: WorkflowManagerOptions = {}) {
    this.ports = opts.ports ?? {};
    this.dispatcher = new WorkflowDispatcher();
  }

  async dispatchScheduledDue<T>(
    opts: WorkflowScheduledDispatchOptions<T>,
  ): Promise<WorkflowScheduledDispatchResult<T>> {
    return this.dispatcher.dispatchScheduledDue(opts);
  }

  async close(): Promise<void> {
    // Milestone 1 owns only construction/shutdown seams.
  }
}
