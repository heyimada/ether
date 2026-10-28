CREATE TABLE `deployment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`environment_id` integer NOT NULL,
	`run_id` integer NOT NULL,
	`job_id` integer NOT NULL,
	`sha` text NOT NULL,
	`ref` text NOT NULL,
	`actor_id` text,
	`status` text NOT NULL,
	`url` text,
	`reviewed_by` text,
	`reviewed_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `ci_run`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `ci_job`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`reviewed_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `deployment_env_idx` ON `deployment` (`environment_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `deployment_job_idx` ON `deployment` (`job_id`);--> statement-breakpoint
CREATE TABLE `environment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`name` text NOT NULL,
	`branches` text DEFAULT '[]' NOT NULL,
	`wait_minutes` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_repo_name_idx` ON `environment` (`repo_id`,`name`);--> statement-breakpoint
CREATE TABLE `environment_reviewer` (
	`environment_id` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`environment_id`, `user_id`),
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `environment_secret` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`environment_id` integer NOT NULL,
	`name` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`environment_id`) REFERENCES `environment`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `environment_secret_env_name_idx` ON `environment_secret` (`environment_id`,`name`);--> statement-breakpoint
ALTER TABLE `ci_job` ADD `environment` text;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `url` text;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `not_before` integer;