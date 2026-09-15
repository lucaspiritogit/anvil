CREATE TABLE `task_result_notices` (
	`id` text PRIMARY KEY,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`task_id` text NOT NULL,
	`result_version` integer NOT NULL,
	`kind` text NOT NULL,
	`head_commit` text,
	`created_at` integer NOT NULL,
	`seen_at` integer,
	`dismissed_at` integer,
	CONSTRAINT `fk_task_result_notices_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_task_result_notices_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `task_result_notices_task_ownership_fk` FOREIGN KEY (`workspace_id`,`project_id`,`task_id`) REFERENCES `tasks`(`workspace_id`,`project_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "task_result_notices_version_positive" CHECK("result_version" > 0),
	CONSTRAINT "task_result_notices_kind_valid" CHECK("kind" IN ('reviewable', 'no_changes', 'completed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_result_notices_task_version_unique` ON `task_result_notices` (`task_id`,`result_version`);--> statement-breakpoint
CREATE INDEX `task_result_notices_workspace_created_idx` ON `task_result_notices` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_result_notices_project_created_idx` ON `task_result_notices` (`project_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_ownership_unique` ON `tasks` (`workspace_id`,`project_id`,`id`);