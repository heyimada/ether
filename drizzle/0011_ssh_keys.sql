CREATE TABLE `ssh_key` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`user_id` text NOT NULL,
	`title` text NOT NULL,
	`key_type` text NOT NULL,
	`blob` text NOT NULL,
	`fingerprint` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ssh_key_blob_unique` ON `ssh_key` (`blob`);--> statement-breakpoint
CREATE INDEX `ssh_key_user_idx` ON `ssh_key` (`user_id`);