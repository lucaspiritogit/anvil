ALTER TABLE `projects` ADD `auto_ship` integer DEFAULT false NOT NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY,
	`name` text NOT NULL,
	`path` text NOT NULL UNIQUE,
	`created_at` integer NOT NULL,
	`monthly_token_limit` integer,
	`monthly_cost_limit_usd` real,
	`finish_on_push` integer DEFAULT false NOT NULL,
	`ship_pushes` integer DEFAULT false NOT NULL,
	`check_command` text,
	`auto_ship` integer DEFAULT false NOT NULL,
	`git_platform` text DEFAULT 'github' NOT NULL,
	CONSTRAINT "projects_finish_on_push_bool" CHECK("finish_on_push" IN (0, 1)),
	CONSTRAINT "projects_ship_pushes_bool" CHECK("ship_pushes" IN (0, 1)),
	CONSTRAINT "projects_auto_ship_bool" CHECK("auto_ship" IN (0, 1)),
	CONSTRAINT "projects_git_platform_valid" CHECK("git_platform" IN ('github'))
);
--> statement-breakpoint
INSERT INTO `__new_projects`(`id`, `name`, `path`, `created_at`, `monthly_token_limit`, `monthly_cost_limit_usd`, `finish_on_push`, `ship_pushes`, `check_command`, `git_platform`) SELECT `id`, `name`, `path`, `created_at`, `monthly_token_limit`, `monthly_cost_limit_usd`, `finish_on_push`, `ship_pushes`, `check_command`, `git_platform` FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;