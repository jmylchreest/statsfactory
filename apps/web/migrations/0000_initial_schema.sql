CREATE TABLE `app_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`key_prefix` text NOT NULL,
	`raw_key` text,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE TABLE `apps` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`geo_precision` text DEFAULT 'country' NOT NULL,
	`retention_days` integer DEFAULT 90 NOT NULL,
	`enabled_dims` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL
);

CREATE TABLE `event_dimensions` (
	`event_id` text NOT NULL,
	`dim_key` text NOT NULL,
	`dim_value` text NOT NULL,
	`dim_type` text DEFAULT 'string' NOT NULL,
	PRIMARY KEY(`event_id`, `dim_key`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `idx_dims_key_value` ON `event_dimensions` (`dim_key`,`dim_value`);
CREATE INDEX `idx_dims_event` ON `event_dimensions` (`event_id`);
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`app_id` text NOT NULL,
	`event_name` text NOT NULL,
	`timestamp` text NOT NULL,
	`session_id` text,
	`distinct_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON UPDATE no action ON DELETE cascade
);

CREATE INDEX `idx_events_app_time` ON `events` (`app_id`,`timestamp`);
CREATE INDEX `idx_events_app_name_time` ON `events` (`app_id`,`event_name`,`timestamp`);
CREATE INDEX `idx_events_session` ON `events` (`app_id`,`session_id`);
