ALTER TABLE `ci_job` ADD `runs_on` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_runner` ADD `labels` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_runner` ADD `repo_id` integer REFERENCES repo(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `ci_runner` ADD `org_id` text REFERENCES user(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `ci_runner_registration` ADD `repo_id` integer REFERENCES repo(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `ci_runner_registration` ADD `org_id` text REFERENCES user(id) ON DELETE cascade;--> statement-breakpoint
ALTER TABLE `environment` ADD `runners` text DEFAULT '[]' NOT NULL;