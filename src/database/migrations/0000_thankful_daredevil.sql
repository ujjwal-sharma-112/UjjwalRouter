CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_api_keys_hash` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`timestamp` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`details` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_audit_timestamp` ON `audit_logs` (`timestamp`);--> statement-breakpoint
CREATE TABLE `daily_usage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date_key` text NOT NULL,
	`provider_id` text NOT NULL,
	`canonical_model_id` text NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	`success_count` integer DEFAULT 0 NOT NULL,
	`error_count` integer DEFAULT 0 NOT NULL,
	`failover_count` integer DEFAULT 0 NOT NULL,
	`rate_limit_count` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_latency_ms` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daily_usage_unique` ON `daily_usage` (`date_key`,`provider_id`,`canonical_model_id`);--> statement-breakpoint
CREATE TABLE `free_eligibility_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`canonical_model_id` text NOT NULL,
	`eligible` integer NOT NULL,
	`free_eligibility` text NOT NULL,
	`free_tier_type` text NOT NULL,
	`billing_required` integer NOT NULL,
	`promotional_credits` integer NOT NULL,
	`verification_source` text NOT NULL,
	`reason` text NOT NULL,
	`checked_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_eligibility_checked_at` ON `free_eligibility_checks` (`checked_at`);--> statement-breakpoint
CREATE TABLE `model_capabilities` (
	`canonical_id` text PRIMARY KEY NOT NULL,
	`supports_streaming` integer DEFAULT true NOT NULL,
	`supports_tools` integer DEFAULT false NOT NULL,
	`supports_vision` integer DEFAULT false NOT NULL,
	`supports_json_mode` integer DEFAULT false NOT NULL,
	`supports_reasoning` integer DEFAULT false NOT NULL,
	`coding_capability` text DEFAULT 'unknown' NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`canonical_id`) REFERENCES `models`(`canonical_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `models` (
	`canonical_id` text PRIMARY KEY NOT NULL,
	`model_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`display_name` text NOT NULL,
	`context_window` integer DEFAULT 0 NOT NULL,
	`provider_input_limit` integer,
	`account_free_input_limit` integer,
	`effective_context_window` integer DEFAULT 0 NOT NULL,
	`max_output_tokens` integer DEFAULT 0 NOT NULL,
	`input_price` real DEFAULT 0 NOT NULL,
	`output_price` real DEFAULT 0 NOT NULL,
	`request_price` real DEFAULT 0 NOT NULL,
	`image_price` real DEFAULT 0 NOT NULL,
	`free_eligibility` text NOT NULL,
	`free_tier_type` text NOT NULL,
	`billing_required` integer DEFAULT true NOT NULL,
	`promotional_credits` integer DEFAULT false NOT NULL,
	`free_verified_at` text,
	`verification_expires_at` text,
	`free_verification_source` text,
	`availability_status` text DEFAULT 'UNAVAILABLE' NOT NULL,
	`last_checked_at` text,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_models_provider` ON `models` (`provider_id`);--> statement-breakpoint
CREATE INDEX `idx_models_eligibility` ON `models` (`free_eligibility`);--> statement-breakpoint
CREATE TABLE `provider_health` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider_id` text NOT NULL,
	`healthy` integer NOT NULL,
	`status` text NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`message` text NOT NULL,
	`checked_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_provider_health_provider` ON `provider_health` (`provider_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `provider_quotas` (
	`provider_id` text PRIMARY KEY NOT NULL,
	`rpm_limit` integer,
	`rpd_limit` integer,
	`tpm_limit` integer,
	`monthly_limit` integer,
	`remaining_requests` integer,
	`remaining_tokens` integer,
	`reset_at` text,
	`notes` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`provider_id`) REFERENCES `providers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `providers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`endpoint_url` text NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`configured` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`free_tier_notes` text,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `request_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`provider_id` text NOT NULL,
	`model_id` text NOT NULL,
	`canonical_model_id` text NOT NULL,
	`outcome` text NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`error_category` text,
	`status_code` integer,
	`reason` text NOT NULL,
	`timestamp` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_attempts_request` ON `request_attempts` (`request_id`);--> statement-breakpoint
CREATE TABLE `requests` (
	`id` text PRIMARY KEY NOT NULL,
	`timestamp` text NOT NULL,
	`requested_model` text NOT NULL,
	`effective_profile` text NOT NULL,
	`selected_provider` text,
	`selected_model` text,
	`estimated_input_tokens` integer DEFAULT 0 NOT NULL,
	`actual_input_tokens` integer DEFAULT 0 NOT NULL,
	`actual_output_tokens` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer DEFAULT 0 NOT NULL,
	`failover_count` integer DEFAULT 0 NOT NULL,
	`stream` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`error_code` text,
	`error_message` text,
	`routing_explanation` text
);
--> statement-breakpoint
CREATE INDEX `idx_requests_timestamp` ON `requests` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_requests_status` ON `requests` (`status`);--> statement-breakpoint
CREATE INDEX `idx_requests_provider` ON `requests` (`selected_provider`);--> statement-breakpoint
CREATE TABLE `routing_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`description` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`provider_id` text,
	`weight` real DEFAULT 1 NOT NULL,
	`min_context_window` integer,
	`requires_tools` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `routing_profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`immutable` integer DEFAULT false NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `usage_records` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`canonical_model_id` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`recorded_at` text NOT NULL,
	FOREIGN KEY (`request_id`) REFERENCES `requests`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_usage_recorded_at` ON `usage_records` (`recorded_at`);