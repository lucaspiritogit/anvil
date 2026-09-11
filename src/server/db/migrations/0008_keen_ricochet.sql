PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`parent_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`checklist` text NOT NULL,
	`validation` text NOT NULL,
	`labels` text NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`evidence` text,
	`completed_at` integer,
	`reviewed_at` integer,
	FOREIGN KEY (`parent_id`) REFERENCES `parent_issues`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issues_priority_valid" CHECK("__new_issues"."priority" IN ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "issues_status_valid" CHECK("__new_issues"."status" IN ('queued', 'working', 'blocked', 'review', 'complete'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`("sequence", "id", "parent_id", "title", "description", "checklist", "validation", "labels", "priority", "status", "evidence", "completed_at", "reviewed_at") SELECT "sequence", "id", "parent_id", "title", "description", "checklist", "validation", "labels", "priority", "status", "evidence", "completed_at", "reviewed_at" FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `issues_id_unique` ON `issues` (`id`);--> statement-breakpoint
CREATE INDEX `issues_parent_sequence_idx` ON `issues` (`parent_id`,`sequence`);