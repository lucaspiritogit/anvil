ALTER TABLE `task_boards` RENAME TO `task_issue_trackers`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_issue_trackers` (
	`run_id` text PRIMARY KEY NOT NULL,
	`state` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_issue_trackers`("run_id", "state") SELECT "run_id", "state" FROM `task_issue_trackers`;--> statement-breakpoint
DROP TABLE `task_issue_trackers`;--> statement-breakpoint
ALTER TABLE `__new_task_issue_trackers` RENAME TO `task_issue_trackers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;