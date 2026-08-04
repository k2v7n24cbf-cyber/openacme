PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workflow_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_run_id` text,
	`sequence` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_workflow_run_events`("id", "run_id", "step_run_id", "sequence", "level", "kind", "message", "payload_json", "created_at") SELECT "id", "run_id", "step_run_id", "sequence", "level", "kind", "message", "payload_json", "created_at" FROM `workflow_run_events`;--> statement-breakpoint
DROP TABLE `workflow_run_events`;--> statement-breakpoint
ALTER TABLE `__new_workflow_run_events` RENAME TO `workflow_run_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_workflow_events_run` ON `workflow_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_events_run_sequence` ON `workflow_run_events` (`run_id`,`sequence`);