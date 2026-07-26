CREATE TABLE `session_timeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at_ms` integer NOT NULL,
	`session_id` text NOT NULL,
	`agent_id` text,
	`message_id` text,
	`task_id` text,
	`event_type` text NOT NULL,
	`source` text NOT NULL,
	`status` text,
	`trace_id` text,
	`span_id` text,
	`forensic_run_id` text,
	`usage_event_id` text,
	`duration_ms` integer,
	`payload` text
);
--> statement-breakpoint
CREATE INDEX `idx_session_timeline_session` ON `session_timeline_events` (`session_id`,`created_at_ms`);--> statement-breakpoint
CREATE INDEX `idx_session_timeline_trace` ON `session_timeline_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_session_timeline_forensic_run` ON `session_timeline_events` (`forensic_run_id`);--> statement-breakpoint
CREATE INDEX `idx_session_timeline_usage` ON `session_timeline_events` (`usage_event_id`);