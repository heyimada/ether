CREATE TABLE `ci_runner` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`token_hash` text NOT NULL,
	`isolation` text DEFAULT 'container' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_runner_token_hash_unique` ON `ci_runner` (`token_hash`);--> statement-breakpoint
CREATE TABLE `ci_runner_registration` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_runner_registration_token_hash_unique` ON `ci_runner_registration` (`token_hash`);--> statement-breakpoint
ALTER TABLE `ci_job` ADD `runner` text;