CREATE TABLE `task_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`status` text NOT NULL,
	`assignee` text NOT NULL,
	`session_id` text,
	`created_by` text NOT NULL,
	`created_in_session_id` text,
	`parent_id` text,
	`depends_on_json` text DEFAULT '[]' NOT NULL,
	`start_at` text,
	`due_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`closed_at` text,
	`recurrence_json` text,
	`runs` integer DEFAULT 0 NOT NULL,
	`last_run_at` text,
	`team` text,
	`body` text DEFAULT '' NOT NULL,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" IN ('open', 'in_progress', 'blocked', 'system_blocked', 'done', 'canceled'))
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_assignee_status` ON `tasks` (`assignee`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_session_status` ON `tasks` (`session_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_created_by` ON `tasks` (`created_by`);--> statement-breakpoint
CREATE INDEX `idx_tasks_team` ON `tasks` (`team`);--> statement-breakpoint
CREATE INDEX `idx_tasks_parent` ON `tasks` (`parent_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_tasks_one_in_progress_per_session` ON `tasks` (`session_id`) WHERE "tasks"."session_id" IS NOT NULL AND "tasks"."status" = 'in_progress';