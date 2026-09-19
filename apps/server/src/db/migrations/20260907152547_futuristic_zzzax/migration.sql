CREATE TABLE `task_pull_requests` (
	`task_id` text PRIMARY KEY NOT NULL,
	`repository` text NOT NULL,
	`number` integer NOT NULL,
	`head_sha` text NOT NULL,
	`source_branch` text NOT NULL,
	`target_branch` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
