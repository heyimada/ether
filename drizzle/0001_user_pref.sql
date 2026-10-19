CREATE TABLE `user_pref` (
	`user_id` text PRIMARY KEY NOT NULL,
	`accent` text,
	`theme` text,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
