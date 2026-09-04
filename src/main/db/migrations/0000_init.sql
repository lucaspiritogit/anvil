CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`created_at` integer NOT NULL,
	`monthly_token_limit` integer,
	`monthly_cost_limit_usd` real,
	`finish_on_push` integer DEFAULT false NOT NULL,
	`git_platform` text DEFAULT 'github' NOT NULL,
	CONSTRAINT "projects_finish_on_push_bool" CHECK("projects"."finish_on_push" IN (0, 1)),
	CONSTRAINT "projects_git_platform_valid" CHECK("projects"."git_platform" IN ('github'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_path_unique` ON `projects` (`path`);--> statement-breakpoint
CREATE TABLE `run_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file` text NOT NULL,
	`side` text NOT NULL,
	`line_number` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_comments_side_valid" CHECK("run_comments"."side" IN ('additions', 'deletions'))
);
--> statement-breakpoint
CREATE INDEX `run_comments_run_idx` ON `run_comments` (`run_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`run_id` text NOT NULL,
	`ts` integer NOT NULL,
	`stream` text NOT NULL,
	`kind` text DEFAULT 'output' NOT NULL,
	`category` text DEFAULT 'message' NOT NULL,
	`text` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "run_events_stream_valid" CHECK("run_events"."stream" IN ('stdout', 'stderr', 'system')),
	CONSTRAINT "run_events_kind_valid" CHECK("run_events"."kind" IN ('output', 'did_not_commit', 'delivery')),
	CONSTRAINT "run_events_category_valid" CHECK("run_events"."category" IN ('message', 'thinking', 'tool_use', 'tool_result', 'system', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `run_events_id_unique` ON `run_events` (`id`);--> statement-breakpoint
CREATE INDEX `run_events_run_sequence_idx` ON `run_events` (`run_id`,`sequence`);--> statement-breakpoint
CREATE TABLE `runs` (
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
	CONSTRAINT "runs_status_valid" CHECK("runs"."status" IN ('running', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "runs_delivery_status_valid" CHECK("runs"."delivery_status" IN ('preparing', 'working', 'finalizing', 'did_not_commit', 'reviewable', 'no_changes', 'agent_failed', 'failed', 'unavailable'))
);
--> statement-breakpoint
CREATE INDEX `runs_project_started_idx` ON `runs` (`project_id`,"started_at" DESC);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
