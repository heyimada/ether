ALTER TABLE `issue` ADD `merge_method` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `merged_base` text;--> statement-breakpoint
ALTER TABLE `issue` ADD `merged_head` text;--> statement-breakpoint
ALTER TABLE `repo` ADD `allow_merge_commit` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repo` ADD `allow_squash_merge` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `repo` ADD `allow_rebase_merge` integer DEFAULT true NOT NULL;