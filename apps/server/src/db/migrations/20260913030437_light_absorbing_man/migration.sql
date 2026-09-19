PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issues` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`parent_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`expected_files` text,
	`checklist` text NOT NULL,
	`validation` text NOT NULL,
	`labels` text NOT NULL,
	`priority` text NOT NULL,
	`status` text NOT NULL,
	`evidence` text,
	`started_at` integer,
	`completed_at` integer,
	`reviewed_at` integer,
	`base_commit` text,
	`head_commit` text,
	CONSTRAINT `issues_parent_id_parent_issues_id_fk` FOREIGN KEY (`parent_id`) REFERENCES `parent_issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT "issues_priority_valid" CHECK("priority" IN ('urgent', 'high', 'medium', 'low')),
	CONSTRAINT "issues_status_valid" CHECK("status" IN ('queued', 'working', 'blocked', 'review', 'complete'))
);
--> statement-breakpoint
INSERT INTO `__new_issues`(`sequence`, `id`, `parent_id`, `title`, `description`, `expected_files`, `checklist`, `validation`, `labels`, `priority`, `status`, `evidence`, `started_at`, `completed_at`, `reviewed_at`, `base_commit`, `head_commit`) SELECT `sequence`, `id`, `parent_id`, `title`, `description`, `expected_files`, `checklist`, `validation`, `labels`, `priority`, `status`, `evidence`, `started_at`, `completed_at`, `reviewed_at`, `base_commit`, `head_commit` FROM `issues`;--> statement-breakpoint
DROP TABLE `issues`;--> statement-breakpoint
ALTER TABLE `__new_issues` RENAME TO `issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_parent_issues` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`anvil_task_id` text NOT NULL UNIQUE,
	`title` text NOT NULL,
	`description` text NOT NULL,
	CONSTRAINT `parent_issues_anvil_task_id_tasks_id_fk` FOREIGN KEY (`anvil_task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_parent_issues`(`sequence`, `id`, `anvil_task_id`, `title`, `description`) SELECT `sequence`, `id`, `anvil_task_id`, `title`, `description` FROM `parent_issues`;--> statement-breakpoint
DROP TABLE `parent_issues`;--> statement-breakpoint
ALTER TABLE `__new_parent_issues` RENAME TO `parent_issues`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`monthly_token_limit` integer,
	`monthly_cost_limit_usd` real,
	`finish_on_push` integer DEFAULT false NOT NULL,
	`git_platform` text DEFAULT 'github' NOT NULL,
	CONSTRAINT "projects_finish_on_push_bool" CHECK("finish_on_push" IN (0, 1)),
	CONSTRAINT "projects_git_platform_valid" CHECK("git_platform" IN ('github'))
);
--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `name`, `path`, `created_at`, `monthly_token_limit`, `monthly_cost_limit_usd`, `finish_on_push`, `git_platform`) SELECT `id`, `name`, `path`, `created_at`, `monthly_token_limit`, `monthly_cost_limit_usd`, `finish_on_push`, `git_platform` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`task_id` text NOT NULL,
	`issue_id` text,
	`ts` integer NOT NULL,
	`stream` text NOT NULL,
	`kind` text DEFAULT 'output' NOT NULL,
	`category` text DEFAULT 'message' NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `task_events_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_events_stream_valid" CHECK("stream" IN ('stdout', 'stderr', 'system')),
	CONSTRAINT "task_events_kind_valid" CHECK("kind" IN ('output', 'did_not_commit', 'delivery')),
	CONSTRAINT "task_events_category_valid" CHECK("category" IN ('message', 'thinking', 'tool_use', 'tool_result', 'system', 'error'))
);
--> statement-breakpoint
INSERT INTO `__new_task_events`(`sequence`, `id`, `task_id`, `issue_id`, `ts`, `stream`, `kind`, `category`, `text`) SELECT `sequence`, `id`, `task_id`, `issue_id`, `ts`, `stream`, `kind`, `category`, `text` FROM `task_events`;--> statement-breakpoint
DROP TABLE `task_events`;--> statement-breakpoint
ALTER TABLE `__new_task_events` RENAME TO `task_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_issue_dependencies` (
	`issue_id` text NOT NULL,
	`dependency_id` text NOT NULL,
	`position` integer NOT NULL,
	CONSTRAINT `issue_dependencies_issue_id_dependency_id_pk` PRIMARY KEY(`issue_id`, `dependency_id`),
	CONSTRAINT `issue_dependencies_issue_id_issues_id_fk` FOREIGN KEY (`issue_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT `issue_dependencies_dependency_id_issues_id_fk` FOREIGN KEY (`dependency_id`) REFERENCES `issues`(`id`) ON DELETE CASCADE,
	CONSTRAINT "issue_dependencies_position_valid" CHECK("position" >= 0),
	CONSTRAINT "issue_dependencies_not_self" CHECK("issue_id" <> "dependency_id")
);
--> statement-breakpoint
INSERT INTO `__new_issue_dependencies`(`issue_id`, `dependency_id`, `position`) SELECT `issue_id`, `dependency_id`, `position` FROM `issue_dependencies`;--> statement-breakpoint
DROP TABLE `issue_dependencies`;--> statement-breakpoint
ALTER TABLE `__new_issue_dependencies` RENAME TO `issue_dependencies`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_comments` (
	`id` text PRIMARY KEY,
	`task_id` text NOT NULL,
	`file` text NOT NULL,
	`side` text NOT NULL,
	`line_number` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	CONSTRAINT `task_comments_task_id_tasks_id_fk` FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE CASCADE,
	CONSTRAINT "task_comments_side_valid" CHECK("side" IN ('additions', 'deletions'))
);
--> statement-breakpoint
INSERT INTO `__new_task_comments`(`id`, `task_id`, `file`, `side`, `line_number`, `body`, `created_at`, `sent_at`) SELECT `id`, `task_id`, `file`, `side`, `line_number`, `body`, `created_at`, `sent_at` FROM `task_comments`;--> statement-breakpoint
DROP TABLE `task_comments`;--> statement-breakpoint
ALTER TABLE `__new_task_comments` RENAME TO `task_comments`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY,
	`workspace_id` text DEFAULT 'default' NOT NULL,
	`project_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`agent_label` text NOT NULL,
	`model` text,
	`prompt` text NOT NULL,
	`title` text NOT NULL,
	`cwd` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`working_time_ms` integer DEFAULT 0 NOT NULL,
	`working_started_at` integer,
	`reviewed_at` integer,
	`settled_at` integer,
	`exit_code` integer,
	`error` text,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`total_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`delivery_status` text DEFAULT 'unavailable' NOT NULL,
	`parent_task_id` text,
	`expected_files` text,
	`restack_state` text,
	`restack_target` text,
	`stack_suggestion` text,
	`base_branch` text,
	`branch_name` text,
	`base_commit` text,
	`head_commit` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`delivery_error` text,
	`context_used` integer,
	`context_size` integer,
	`context_compaction_error` text,
	`session_id` text,
	CONSTRAINT `tasks_workspace_id_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `tasks_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `tasks_parent_task_id_tasks_id_fk` FOREIGN KEY (`parent_task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
	CONSTRAINT "tasks_restack_state_valid" CHECK("restack_state" IN ('pending', 'conflict')),
	CONSTRAINT "tasks_status_valid" CHECK("status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "tasks_delivery_status_valid" CHECK("delivery_status" IN ('preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'approved', 'no_changes', 'agent_failed', 'failed', 'unavailable'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `workspace_id`, `project_id`, `agent_id`, `agent_label`, `model`, `prompt`, `title`, `cwd`, `status`, `started_at`, `ended_at`, `working_time_ms`, `working_started_at`, `reviewed_at`, `settled_at`, `exit_code`, `error`, `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`, `cost_usd`, `delivery_status`, `parent_task_id`, `expected_files`, `restack_state`, `restack_target`, `stack_suggestion`, `base_branch`, `branch_name`, `base_commit`, `head_commit`, `files_changed`, `additions`, `deletions`, `delivery_error`, `context_used`, `context_size`, `context_compaction_error`, `session_id`) SELECT `id`, `workspace_id`, `project_id`, `agent_id`, `agent_label`, `model`, `prompt`, `title`, `cwd`, `status`, `started_at`, `ended_at`, `working_time_ms`, `working_started_at`, `reviewed_at`, `settled_at`, `exit_code`, `error`, `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`, `cost_usd`, `delivery_status`, `parent_task_id`, `expected_files`, `restack_state`, `restack_target`, `stack_suggestion`, `base_branch`, `branch_name`, `base_commit`, `head_commit`, `files_changed`, `additions`, `deletions`, `delivery_error`, `context_used`, `context_size`, `context_compaction_error`, `session_id` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspaces` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "workspaces_name_length" CHECK(length("name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
INSERT INTO `__new_workspaces`(`id`, `name`, `name_key`, `created_at`) SELECT `id`, `name`, `name_key`, `created_at` FROM `workspaces`;--> statement-breakpoint
DROP TABLE `workspaces`;--> statement-breakpoint
ALTER TABLE `__new_workspaces` RENAME TO `workspaces`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
DROP INDEX IF EXISTS `issues_id_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `parent_issues_id_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `parent_issues_anvil_task_id_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `projects_path_unique`;--> statement-breakpoint
DROP INDEX IF EXISTS `task_events_id_unique`;--> statement-breakpoint
CREATE INDEX `issues_parent_sequence_idx` ON `issues` (`parent_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `task_events_task_sequence_idx` ON `task_events` (`task_id`,`sequence`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_dependencies_position_idx` ON `issue_dependencies` (`issue_id`,`position`);--> statement-breakpoint
CREATE INDEX `issue_dependencies_target_idx` ON `issue_dependencies` (`dependency_id`);--> statement-breakpoint
CREATE INDEX `task_comments_task_idx` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `tasks_workspace_started_idx` ON `tasks` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tasks_project_started_idx` ON `tasks` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `workspaces_name_key_unique` ON `workspaces` (`name_key`);