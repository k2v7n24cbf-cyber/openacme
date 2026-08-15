CREATE TABLE `hosted_integration_active_generations` (
	`family_id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`activated_at` text NOT NULL,
	`activated_by` text NOT NULL,
	`previous_generation_id` text,
	FOREIGN KEY (`generation_id`) REFERENCES `hosted_integration_generations`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_active_generation` ON `hosted_integration_active_generations` (`generation_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`target_json` text NOT NULL,
	`actor_json` text NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_approvals_family` ON `hosted_integration_approvals` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `hosted_integration_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`media_type` text,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_ref` text NOT NULL,
	`retention_state` text DEFAULT 'active' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `hosted_integration_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_artifacts_run` ON `hosted_integration_artifacts` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_hosted_artifacts_retention` ON `hosted_integration_artifacts` (`retention_state`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_artifacts_run_name` ON `hosted_integration_artifacts` (`run_id`,`name`);--> statement-breakpoint
CREATE TABLE `hosted_integration_environment_configs` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`environment` text NOT NULL,
	`revision` integer NOT NULL,
	`config_json` text NOT NULL,
	`secrets_metadata_json` text DEFAULT '{}' NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_environment_configs_family` ON `hosted_integration_environment_configs` (`family_id`,`environment`);--> statement-breakpoint
CREATE TABLE `hosted_integration_disablements` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text,
	`target_json` text NOT NULL,
	`reason` text,
	`disabled_by` text NOT NULL,
	`disabled_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_disablements_family` ON `hosted_integration_disablements` (`family_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_disablements_target` ON `hosted_integration_disablements` (`family_id`,`tool_name`);--> statement-breakpoint
CREATE TABLE `hosted_integration_draft_files` (
	`draft_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`media_type` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`draft_id`, `path`),
	FOREIGN KEY (`draft_id`) REFERENCES `hosted_integration_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_draft_files_draft` ON `hosted_integration_draft_files` (`draft_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_drafts` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`lock_id` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_drafts_family_status` ON `hosted_integration_drafts` (`family_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_hosted_drafts_lock` ON `hosted_integration_drafts` (`lock_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_examples` (
	`id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`category` text NOT NULL,
	`args_json` text NOT NULL,
	`expected_json` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`draft_id`) REFERENCES `hosted_integration_drafts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_examples_draft` ON `hosted_integration_examples` (`draft_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_examples_draft_id` ON `hosted_integration_examples` (`draft_id`,`id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_execution_logs` (
	`run_id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`generation_id` text NOT NULL,
	`actor_json` text NOT NULL,
	`status` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`duration_ms` integer,
	`request_sanitized_json` text NOT NULL,
	`result_envelope_ref_json` text,
	`result_metadata_json` text,
	`error_json` text,
	`trace_id` text,
	`span_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_execution_logs_family` ON `hosted_integration_execution_logs` (`family_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_hosted_execution_logs_trace` ON `hosted_integration_execution_logs` (`trace_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_failure_bucket_events` (
	`id` text PRIMARY KEY NOT NULL,
	`bucket_id` text NOT NULL,
	`event_type` text NOT NULL,
	`run_id` text,
	`actor` text,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`bucket_id`) REFERENCES `hosted_integration_failure_buckets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_failure_bucket_events_bucket` ON `hosted_integration_failure_bucket_events` (`bucket_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_failure_buckets` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`generation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`latest_run_id` text,
	`first_seen_at` text NOT NULL,
	`latest_seen_at` text NOT NULL,
	`assigned_to` text,
	`closed_at` text,
	`closed_by` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_failure_buckets_family` ON `hosted_integration_failure_buckets` (`family_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_failure_buckets_unique_open` ON `hosted_integration_failure_buckets` (`family_id`,`tool_name`,`generation_id`,`fingerprint`) WHERE "hosted_integration_failure_buckets"."status" = 'open';--> statement-breakpoint
CREATE TABLE `hosted_integration_families` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`manifest_json` text NOT NULL,
	`diagnostics_json` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_families_status` ON `hosted_integration_families` (`status`);--> statement-breakpoint
CREATE TABLE `hosted_integration_generation_files` (
	`generation_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`media_type` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`generation_id`, `path`),
	FOREIGN KEY (`generation_id`) REFERENCES `hosted_integration_generations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_generation_files_generation` ON `hosted_integration_generation_files` (`generation_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_generation_invocations` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`generation_id` text NOT NULL,
	`family_id` text NOT NULL,
	`started_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_generation_invocations_generation` ON `hosted_integration_generation_invocations` (`generation_id`,`completed_at`);--> statement-breakpoint
CREATE TABLE `hosted_integration_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`status` text NOT NULL,
	`promoted_at` text NOT NULL,
	`promoted_by` text NOT NULL,
	`manifest_json` text NOT NULL,
	`tool_names_json` text NOT NULL,
	`validation_json` text NOT NULL,
	`dependency_resolution_json` text,
	`provenance_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_generations_family` ON `hosted_integration_generations` (`family_id`,`promoted_at`);--> statement-breakpoint
CREATE INDEX `idx_hosted_generations_status` ON `hosted_integration_generations` (`status`);--> statement-breakpoint
CREATE TABLE `hosted_integration_idempotency` (
	`key` text PRIMARY KEY NOT NULL,
	`operation` text NOT NULL,
	`actor_id` text NOT NULL,
	`target_json` text NOT NULL,
	`request_hash` text NOT NULL,
	`status` text NOT NULL,
	`final_envelope_metadata_json` text,
	`created_at` text NOT NULL,
	`completed_at` text,
	`expires_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_idempotency_actor` ON `hosted_integration_idempotency` (`actor_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_hosted_idempotency_expires` ON `hosted_integration_idempotency` (`expires_at`);--> statement-breakpoint
CREATE TABLE `hosted_integration_job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`event_type` text NOT NULL,
	`payload_json` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`job_id`) REFERENCES `hosted_integration_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_job_events_job` ON `hosted_integration_job_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_job_events_job_sequence` ON `hosted_integration_job_events` (`job_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `hosted_integration_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`generation_id` text,
	`status` text NOT NULL,
	`actor_json` text NOT NULL,
	`args_hash` text NOT NULL,
	`result_json` text,
	`error_json` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`cancelled_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_jobs_family_status` ON `hosted_integration_jobs` (`family_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_hosted_jobs_generation` ON `hosted_integration_jobs` (`generation_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_locks` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`locked_by` text NOT NULL,
	`draft_id` text,
	`acquired_at` text NOT NULL,
	`renewed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`released_at` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_locks_family_expires` ON `hosted_integration_locks` (`family_id`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hosted_locks_active_family` ON `hosted_integration_locks` (`family_id`) WHERE "hosted_integration_locks"."released_at" IS NULL;--> statement-breakpoint
CREATE TABLE `hosted_integration_proposed_families` (
	`family_id` text PRIMARY KEY NOT NULL,
	`draft_id` text NOT NULL,
	`lock_id` text NOT NULL,
	`proposed_by` text NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_proposed_status` ON `hosted_integration_proposed_families` (`status`);--> statement-breakpoint
CREATE TABLE `hosted_integration_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`tool_name` text NOT NULL,
	`generation_id` text NOT NULL,
	`actor_json` text NOT NULL,
	`purpose` text NOT NULL,
	`status` text NOT NULL,
	`result_envelope_ref_json` text,
	`result_metadata_json` text,
	`error_json` text,
	`created_at` text NOT NULL,
	`ended_at` text,
	`retention_state` text DEFAULT 'active' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_runs_family_tool` ON `hosted_integration_runs` (`family_id`,`tool_name`);--> statement-breakpoint
CREATE INDEX `idx_hosted_runs_generation` ON `hosted_integration_runs` (`generation_id`);--> statement-breakpoint
CREATE INDEX `idx_hosted_runs_retention` ON `hosted_integration_runs` (`retention_state`,`created_at`);--> statement-breakpoint
CREATE TABLE `hosted_integration_secret_metadata` (
	`environment_config_id` text NOT NULL,
	`name` text NOT NULL,
	`configured` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	PRIMARY KEY(`environment_config_id`, `name`),
	FOREIGN KEY (`environment_config_id`) REFERENCES `hosted_integration_environment_configs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_secret_metadata_environment_config` ON `hosted_integration_secret_metadata` (`environment_config_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_source_files` (
	`source_revision_id` text NOT NULL,
	`path` text NOT NULL,
	`content` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`media_type` text,
	PRIMARY KEY(`source_revision_id`, `path`),
	FOREIGN KEY (`source_revision_id`) REFERENCES `hosted_integration_source_revisions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_source_files_revision` ON `hosted_integration_source_files` (`source_revision_id`);--> statement-breakpoint
CREATE TABLE `hosted_integration_source_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`family_id` text NOT NULL,
	`created_at` text NOT NULL,
	`created_by` text NOT NULL,
	`provenance_json` text
);
--> statement-breakpoint
CREATE INDEX `idx_hosted_source_revisions_family` ON `hosted_integration_source_revisions` (`family_id`,`created_at`);--> statement-breakpoint
CREATE TRIGGER `trg_hosted_generation_files_no_update`
BEFORE UPDATE ON `hosted_integration_generation_files`
BEGIN
	SELECT RAISE(ABORT, 'hosted integration generation files are immutable');
END;--> statement-breakpoint
CREATE TRIGGER `trg_hosted_generation_files_no_delete`
BEFORE DELETE ON `hosted_integration_generation_files`
BEGIN
	SELECT RAISE(ABORT, 'hosted integration generation files are immutable');
END;
