CREATE TABLE "project_memories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"source_run_id" text NOT NULL,
	"kind" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_memories_kind_valid" CHECK ("project_memories"."kind" IN ('task_result'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "project_memories_project_run_idx" ON "project_memories" USING btree ("project_id","source_run_id");--> statement-breakpoint
CREATE INDEX "project_memories_project_idx" ON "project_memories" USING btree ("project_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "project_memories_embedding_hnsw_idx" ON "project_memories" USING hnsw ("embedding" vector_cosine_ops);