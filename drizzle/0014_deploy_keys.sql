CREATE TABLE `deploy_key` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`title` text NOT NULL,
	`key_type` text NOT NULL,
	`blob` text NOT NULL,
	`fingerprint` text NOT NULL,
	`read_only` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deploy_key_blob_unique` ON `deploy_key` (`blob`);--> statement-breakpoint
CREATE INDEX `deploy_key_repo_idx` ON `deploy_key` (`repo_id`);