CREATE TABLE `issue_assignee` (
	`issue_id` integer NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `user_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_assignee_user_idx` ON `issue_assignee` (`user_id`);--> statement-breakpoint
CREATE TABLE `issue_label` (
	`issue_id` integer NOT NULL,
	`label_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`) REFERENCES `label`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `issue_label_label_idx` ON `issue_label` (`label_id`);--> statement-breakpoint
CREATE TABLE `label` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`repo_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repo`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `label_repo_name_idx` ON `label` (`repo_id`,`name`);--> statement-breakpoint
INSERT INTO `label` (`repo_id`, `name`, `color`, `description`) SELECT `id`, 'bug', '#d73a4a', 'Something isn''t working' FROM `repo`;--> statement-breakpoint
INSERT INTO `label` (`repo_id`, `name`, `color`, `description`) SELECT `id`, 'enhancement', '#a2eeef', 'New feature or request' FROM `repo`;--> statement-breakpoint
INSERT INTO `label` (`repo_id`, `name`, `color`, `description`) SELECT `id`, 'documentation', '#0075ca', 'Improvements or additions to documentation' FROM `repo`;--> statement-breakpoint
INSERT INTO `label` (`repo_id`, `name`, `color`, `description`) SELECT `id`, 'question', '#d876e3', 'Further information is requested' FROM `repo`;
