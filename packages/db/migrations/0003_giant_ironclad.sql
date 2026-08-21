ALTER TABLE "runs" ADD COLUMN "budget_breach" text;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "budget_max_turns" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "budget_max_cost_usd" double precision DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "settings" ADD COLUMN "budget_wall_clock_ms" integer DEFAULT 1200000 NOT NULL;