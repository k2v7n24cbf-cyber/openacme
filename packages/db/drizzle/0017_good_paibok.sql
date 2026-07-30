CREATE TABLE `workflow_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_run_id` text,
	`kind` text NOT NULL,
	`path` text NOT NULL,
	`preview` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_run_id`) REFERENCES `workflow_step_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_artifacts_run` ON `workflow_artifacts` (`run_id`);--> statement-breakpoint
CREATE TABLE `workflow_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`input_schema_json` text,
	`triggers_json` text NOT NULL,
	`nodes_json` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workflow_run_events` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`step_run_id` text,
	`sequence` integer NOT NULL,
	`level` text NOT NULL,
	`kind` text NOT NULL,
	`message` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`step_run_id`) REFERENCES `workflow_step_attempts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_events_run` ON `workflow_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_events_run_sequence` ON `workflow_run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_version` integer NOT NULL,
	`definition_source` text NOT NULL,
	`mode` text NOT NULL,
	`trigger_json` text NOT NULL,
	`status` text NOT NULL,
	`input_json` text NOT NULL,
	`context_json` text NOT NULL,
	`current_node_id` text,
	`waiting_reason` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_workflow` ON `workflow_runs` (`workflow_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_status` ON `workflow_runs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_workflow_runs_mode` ON `workflow_runs` (`mode`,`created_at`);--> statement-breakpoint
CREATE TABLE `workflow_step_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`node_id` text NOT NULL,
	`attempt` integer NOT NULL,
	`status` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`duration_ms` integer,
	`input_json` text,
	`output_json` text,
	`error_json` text,
	`logs_summary_json` text,
	`context_diff_json` text,
	FOREIGN KEY (`run_id`) REFERENCES `workflow_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_steps_run` ON `workflow_step_attempts` (`run_id`,`node_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_workflow_steps_run_node_attempt` ON `workflow_step_attempts` (`run_id`,`node_id`,`attempt`);--> statement-breakpoint
CREATE TABLE `workflow_versions` (
	`workflow_id` text NOT NULL,
	`version` integer NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`input_schema_json` text,
	`triggers_json` text NOT NULL,
	`nodes_json` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`workflow_id`, `version`),
	FOREIGN KEY (`workflow_id`) REFERENCES `workflow_definitions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_versions_workflow` ON `workflow_versions` (`workflow_id`,`version`);
