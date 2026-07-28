ALTER TABLE `sessions` ADD `kind` text DEFAULT 'chat' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `turns_blocked_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `turns_blocked_at` integer;