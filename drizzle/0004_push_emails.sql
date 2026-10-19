CREATE TABLE `push_email` (
	`user_id` text NOT NULL,
	`email` text NOT NULL,
	`commits` integer DEFAULT 0 NOT NULL,
	`last_seen_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `email`),
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
