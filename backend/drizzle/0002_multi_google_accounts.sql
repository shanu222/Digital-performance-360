ALTER TABLE "admob_accounts" ADD COLUMN "google_account_id" uuid;--> statement-breakpoint
ALTER TABLE "ga4_properties" ADD COLUMN "google_account_id" uuid;--> statement-breakpoint
ALTER TABLE "search_console_properties" ADD COLUMN "google_account_id" uuid;--> statement-breakpoint
ALTER TABLE "admob_accounts" ADD CONSTRAINT "admob_accounts_google_account_id_google_accounts_id_fk" FOREIGN KEY ("google_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ga4_properties" ADD CONSTRAINT "ga4_properties_google_account_id_google_accounts_id_fk" FOREIGN KEY ("google_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_console_properties" ADD CONSTRAINT "search_console_properties_google_account_id_google_accounts_id_fk" FOREIGN KEY ("google_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
UPDATE "search_console_properties" SET "google_account_id" = (SELECT "id" FROM "google_accounts" ORDER BY "created_at" LIMIT 1) WHERE "google_account_id" IS NULL;--> statement-breakpoint
UPDATE "ga4_properties" SET "google_account_id" = (SELECT "id" FROM "google_accounts" ORDER BY "created_at" LIMIT 1) WHERE "google_account_id" IS NULL;--> statement-breakpoint
UPDATE "admob_accounts" SET "google_account_id" = (SELECT "id" FROM "google_accounts" ORDER BY "created_at" LIMIT 1) WHERE "google_account_id" IS NULL;
