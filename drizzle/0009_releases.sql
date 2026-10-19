CREATE TABLE `release` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`tag` text NOT NULL,
	`title` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`prerelease` integer DEFAULT false NOT NULL,
	`author_id` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_repo_tag_idx` ON `release` (`repo_id`,`tag`);--> statement-breakpoint
CREATE TABLE `release_asset` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`release_id` integer NOT NULL,
	`name` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`release_id`) REFERENCES `release`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `release_asset_name_idx` ON `release_asset` (`release_id`,`name`);