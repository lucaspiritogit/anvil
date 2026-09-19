ALTER TABLE `tasks` ADD `style` text DEFAULT 'work' NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY,
	`style` text DEFAULT 'work' NOT NULL,
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
	CONSTRAINT "tasks_style_valid" CHECK("style" IN ('work', 'ask', 'do')),
	CONSTRAINT "tasks_status_valid" CHECK("status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "tasks_delivery_status_valid" CHECK("delivery_status" IN ('preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'approved', 'no_changes', 'agent_failed', 'failed', 'unavailable'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`(`id`, `workspace_id`, `project_id`, `agent_id`, `agent_label`, `model`, `prompt`, `title`, `cwd`, `status`, `started_at`, `ended_at`, `working_time_ms`, `working_started_at`, `reviewed_at`, `settled_at`, `exit_code`, `error`, `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`, `cost_usd`, `delivery_status`, `parent_task_id`, `expected_files`, `restack_state`, `restack_target`, `stack_suggestion`, `base_branch`, `branch_name`, `base_commit`, `head_commit`, `files_changed`, `additions`, `deletions`, `delivery_error`, `context_used`, `context_size`, `context_compaction_error`, `session_id`) SELECT `id`, `workspace_id`, `project_id`, `agent_id`, `agent_label`, `model`, `prompt`, `title`, `cwd`, `status`, `started_at`, `ended_at`, `working_time_ms`, `working_started_at`, `reviewed_at`, `settled_at`, `exit_code`, `error`, `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`, `cost_usd`, `delivery_status`, `parent_task_id`, `expected_files`, `restack_state`, `restack_target`, `stack_suggestion`, `base_branch`, `branch_name`, `base_commit`, `head_commit`, `files_changed`, `additions`, `deletions`, `delivery_error`, `context_used`, `context_size`, `context_compaction_error`, `session_id` FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_workspace_started_idx` ON `tasks` (`workspace_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tasks_project_started_idx` ON `tasks` (`project_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `tasks_parent_idx` ON `tasks` (`parent_task_id`);