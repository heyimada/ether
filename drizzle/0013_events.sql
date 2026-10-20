CREATE TABLE `event` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`actor_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_repo_idx` ON `event` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `event_actor_idx` ON `event` (`actor_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `ci_run` ADD `actor_id` text REFERENCES user(id) ON DELETE set null;--> statement-breakpoint
-- Backfill the feed from what is already recorded elsewhere. Pushes, closes and wiki edits
-- were never recorded, so history starts with what can be reconstructed.
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT `id`, `owner_id`, 'create', '{}', `created_at` FROM `repo`;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT `repo_id`, `author_id`, CASE WHEN `is_pull` THEN 'pull_opened' ELSE 'issue_opened' END,
  CASE WHEN `is_pull` THEN json_object('number', `number`, 'title', `title`, 'base', `base_ref`, 'head', `head_ref`) ELSE json_object('number', `number`, 'title', `title`) END,
  `created_at`
FROM `issue`;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT `repo_id`, `merged_by`, 'pull_merged', json_object('number', `number`, 'title', `title`, 'base', `base_ref`, 'head', `head_ref`), `updated_at`
FROM `issue` WHERE `state` = 'merged' AND `merged_by` IS NOT NULL;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT i.`repo_id`, c.`author_id`, 'comment', json_object('number', i.`number`, 'title', i.`title`, 'isPull', json(CASE WHEN i.`is_pull` THEN 'true' ELSE 'false' END), 'excerpt', substr(c.`body`, 1, 240)), c.`created_at`
FROM `comment` c JOIN `issue` i ON i.`id` = c.`issue_id`;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT i.`repo_id`, r.`author_id`, 'review', json_object('number', i.`number`, 'title', i.`title`, 'state', r.`state`), r.`created_at`
FROM `review` r JOIN `issue` i ON i.`id` = r.`issue_id`;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT `repo_id`, `author_id`, 'release', json_object('tag', `tag`, 'title', `title`, 'prerelease', json(CASE WHEN `prerelease` THEN 'true' ELSE 'false' END)), `created_at`
FROM `release`;--> statement-breakpoint
INSERT INTO `event` (`repo_id`, `actor_id`, `kind`, `payload`, `created_at`)
SELECT `repo_id`, `user_id`, 'star', '{}', `created_at` FROM `star`;