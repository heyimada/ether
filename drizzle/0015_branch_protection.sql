CREATE TABLE `branch_protection` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`pattern` text NOT NULL,
	`require_pull_request` integer DEFAULT false NOT NULL,
	`allow_force_push` integer DEFAULT false NOT NULL,
	`allow_deletion` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branch_protection_repo_pattern_idx` ON `branch_protection` (`repo_id`,`pattern`);