CREATE TABLE `session_context_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`reason` text NOT NULL,
	`compressed` integer NOT NULL,
	`model_messages` text NOT NULL,
	`canonical_message_count` integer NOT NULL,
	`source_last_message_id` text,
	`summary_text` text,
	`summary_sha256` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_context_snapshots_session` ON `session_context_snapshots` (`session_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_context_snapshots_last_message` ON `session_context_snapshots` (`source_last_message_id`);