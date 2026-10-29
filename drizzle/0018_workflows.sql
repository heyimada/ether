ALTER TABLE `ci_run` ADD `ref_type` text DEFAULT 'branch' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_run` ADD `workflow_path` text DEFAULT '.ether/ci.yml' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_run` ADD `workflow_name` text DEFAULT 'CI' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_run` ADD `event` text DEFAULT 'push' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_run` ADD `pull_number` integer;--> statement-breakpoint
ALTER TABLE `ci_run` ADD `inputs` text DEFAULT '{}' NOT NULL;