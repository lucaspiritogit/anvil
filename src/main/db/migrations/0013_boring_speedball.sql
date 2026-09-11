ALTER TABLE `issues` ADD `expected_files` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_task_id` text REFERENCES tasks(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `expected_files` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `restack_state` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `restack_target` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `stack_suggestion` text;