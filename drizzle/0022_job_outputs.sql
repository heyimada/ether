ALTER TABLE `ci_job` ADD `outputs` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE `ci_job` ADD `output_values` text DEFAULT '{}' NOT NULL;