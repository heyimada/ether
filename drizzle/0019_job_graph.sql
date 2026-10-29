ALTER TABLE `ci_job` ADD `key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `needs` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `condition` text;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `matrix` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `fail_fast` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `max_parallel` integer;