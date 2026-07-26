ALTER TABLE `usage_events` ADD `trace_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `span_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `forensic_run_id` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `forensic_path` text;--> statement-breakpoint
ALTER TABLE `usage_events` ADD `provider_request_count` integer;--> statement-breakpoint
CREATE INDEX `idx_usage_trace` ON `usage_events` (`trace_id`);--> statement-breakpoint
CREATE INDEX `idx_usage_forensic_run` ON `usage_events` (`forensic_run_id`);