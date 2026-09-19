CREATE TABLE `app_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `workspace_preferences` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`composer` text NOT NULL,
	`last_project_id` text,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`last_project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `workspace_preferences_project_idx` ON `workspace_preferences` (`last_project_id`);--> statement-breakpoint
CREATE TABLE `workspace_settings` (
	`workspace_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`workspace_id`, `key`),
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE TABLE `workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK(length("workspaces"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_name_key_unique` ON `workspaces` (`name_key`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `workspace_id` text DEFAULT 'default' NOT NULL REFERENCES workspaces(id);--> statement-breakpoint
CREATE INDEX `tasks_workspace_started_idx` ON `tasks` (`workspace_id`,`started_at`);