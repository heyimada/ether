CREATE TABLE `team_review_request` (
	`issue_id` integer NOT NULL,
	`team_id` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `team_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`team_id`) REFERENCES `team`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `team_review_request_team_idx` ON `team_review_request` (`team_id`);--> statement-breakpoint
ALTER TABLE `repo` ADD `require_code_owner_review` integer DEFAULT false NOT NULL;