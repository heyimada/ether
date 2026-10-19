CREATE TABLE `ci_job` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`status` text NOT NULL,
	`log` text DEFAULT '' NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `ci_run`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ci_run` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`sha` text NOT NULL,
	`ref` text NOT NULL,
	`status` text NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ci_run_repo_sha_idx` ON `ci_run` (`repo_id`,`sha`);--> statement-breakpoint
ALTER TABLE `repo` ADD `ci_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `repo` ADD `require_checks` integer DEFAULT false NOT NULL;