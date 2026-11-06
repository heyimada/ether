ALTER TABLE `ci_run` ADD `pull_draft` integer;--> statement-breakpoint
ALTER TABLE `issue` ADD `draft` integer DEFAULT false NOT NULL;