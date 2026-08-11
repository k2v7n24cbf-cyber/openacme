CREATE TABLE `objective_events` (
	`id` text PRIMARY KEY NOT NULL,
	`objective_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor` text NOT NULL,
	`summary` text NOT NULL,
	`details_json` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`objective_id`) REFERENCES `objectives`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_objective_events_objective` ON `objective_events` (`objective_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `objectives` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text NOT NULL,
	`owner_agent_id` text NOT NULL,
	`owner_session_id` text,
	`created_by` text NOT NULL,
	`created_in_session_id` text,
	`closeout_prompt` text DEFAULT '' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text,
	`completion_summary` text,
	`last_closeout_fingerprint` text,
	`last_closeout_brief_json` text,
	`last_closeout_brief_at` text,
	CONSTRAINT "objectives_status_check" CHECK("objectives"."status" IN ('active', 'waiting_on_tasks', 'ready_for_closeout', 'completed', 'failed', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX `idx_objectives_status` ON `objectives` (`status`);--> statement-breakpoint
CREATE INDEX `idx_objectives_owner` ON `objectives` (`owner_agent_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_objectives_owner_session` ON `objectives` (`owner_session_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `objective_id` text;--> statement-breakpoint
CREATE INDEX `idx_tasks_objective` ON `tasks` (`objective_id`);