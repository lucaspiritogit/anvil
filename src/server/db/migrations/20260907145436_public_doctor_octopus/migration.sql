PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
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
	`base_branch` text,
	`branch_name` text,
	`base_commit` text,
	`head_commit` text,
	`worktree_path` text,
	`files_changed` integer DEFAULT 0 NOT NULL,
	`additions` integer DEFAULT 0 NOT NULL,
	`deletions` integer DEFAULT 0 NOT NULL,
	`delivery_error` text,
	`session_id` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_valid" CHECK("__new_tasks"."status" IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "tasks_delivery_status_valid" CHECK("__new_tasks"."delivery_status" IN ('preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'approved', 'no_changes', 'agent_failed', 'failed', 'unavailable'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "project_id", "agent_id", "agent_label", "model", "prompt", "title", "cwd", "status", "started_at", "ended_at", "reviewed_at", "settled_at", "exit_code", "error", "input_tokens", "output_tokens", "cached_tokens", "total_tokens", "cost_usd", "delivery_status", "base_branch", "branch_name", "base_commit", "head_commit", "worktree_path", "files_changed", "additions", "deletions", "delivery_error", "session_id") SELECT "id", "project_id", "agent_id", "agent_label", "model", "prompt", "title", "cwd", "status", "started_at", "ended_at", "reviewed_at", "settled_at", "exit_code", "error", "input_tokens", "output_tokens", "cached_tokens", "total_tokens", "cost_usd", "delivery_status", "base_branch", "branch_name", "base_commit", "head_commit", "worktree_path", "files_changed", "additions", "deletions", "delivery_error", "session_id" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_project_started_idx` ON `tasks` (`project_id`,`started_at`);