CREATE TABLE "api_usage" (
	"usage_date" date NOT NULL,
	"source_id" text NOT NULL,
	"call_count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "api_usage_usage_date_source_id_pk" PRIMARY KEY("usage_date","source_id")
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone,
	"first_seen_at" timestamp with time zone NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"corp_name" text,
	"ticker" text,
	"market" text,
	"verdict" text NOT NULL,
	"tier" text,
	"rule" text NOT NULL,
	"raw" jsonb NOT NULL,
	CONSTRAINT "events_source_external_uq" UNIQUE("source_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"tier" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_error" text
);
--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE no action ON UPDATE no action;