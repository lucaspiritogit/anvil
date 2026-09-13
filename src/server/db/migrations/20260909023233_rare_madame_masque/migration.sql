CREATE TABLE `issue_dependencies` (
	`issue_id` text NOT NULL,
	`dependency_id` text NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`issue_id`, `dependency_id`),
	FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`dependency_id`) REFERENCES `issues`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issue_dependencies_position_valid" CHECK("issue_dependencies"."position" >= 0),
	CONSTRAINT "issue_dependencies_not_self" CHECK("issue_dependencies"."issue_id" <> "issue_dependencies"."dependency_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependencies_position_idx` ON `issue_dependencies` (`issue_id`,`position`);--> statement-breakpoint
CREATE INDEX `issue_dependencies_target_idx` ON `issue_dependencies` (`dependency_id`);--> statement-breakpoint
CREATE TABLE `issues` (
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
	FOREIGN KEY (`parent_id`) REFERENCES `parent_issues`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "issues_priority_valid" CHECK("issues"."priority" IN ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "issues_status_valid" CHECK("issues"."status" IN ('queued', 'working', 'blocked', 'complete'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `issues_id_unique` ON `issues` (`id`);--> statement-breakpoint
CREATE INDEX `issues_parent_sequence_idx` ON `issues` (`parent_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `parent_issues` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`anvil_task_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	FOREIGN KEY (`anvil_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `parent_issues_id_unique` ON `parent_issues` (`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `parent_issues_anvil_task_id_unique` ON `parent_issues` (`anvil_task_id`);