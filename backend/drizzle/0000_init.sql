CREATE TABLE "admob_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_name" text NOT NULL,
	"publisher_id" text NOT NULL,
	"currency_code" text,
	"reporting_time_zone" text,
	"is_selected" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_data_date" date,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admob_accounts_resource_name_unique" UNIQUE("resource_name")
);
--> statement-breakpoint
CREATE TABLE "admob_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"admob_account_id" uuid NOT NULL,
	"app_id" text NOT NULL,
	"resource_name" text NOT NULL,
	"display_name" text,
	"platform" text,
	"store_id" text,
	"approval_state" text,
	"ad_units" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admob_apps_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE "admob_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"admob_account_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"app_id" text NOT NULL,
	"app_label" text,
	"country" text NOT NULL,
	"format" text NOT NULL,
	"estimated_earnings_micros" bigint,
	"impressions" integer,
	"clicks" integer,
	"ad_requests" integer,
	"matched_requests" integer,
	"currency" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"entity_label" text,
	"title" text NOT NULL,
	"problem" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommended_action" text NOT NULL,
	"priority" text NOT NULL,
	"potential_impact" text,
	"category" text,
	"generated_for_date" date NOT NULL,
	"model" text,
	"is_dismissed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "analytics_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"ga4_property_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"active_users" integer,
	"new_users" integer,
	"total_users" integer,
	"sessions" integer,
	"engaged_sessions" integer,
	"engagement_rate" double precision,
	"user_engagement_duration" double precision,
	"screen_page_views" integer,
	"event_count" integer,
	"key_events" double precision,
	"total_revenue" double precision,
	"currency" text,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "android_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"package_name" text NOT NULL,
	"platform" text DEFAULT 'ANDROID' NOT NULL,
	"play_console_app_id" uuid,
	"admob_app_id" uuid,
	"ga4_property_id" uuid,
	"source" text DEFAULT 'manual' NOT NULL,
	"is_monitored" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "android_apps_package_name_unique" UNIQUE("package_name")
);
--> statement-breakpoint
CREATE TABLE "app_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"android_app_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"metric" text NOT NULL,
	"value" double precision NOT NULL,
	"source" text NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_vitals" (
	"id" serial PRIMARY KEY NOT NULL,
	"play_console_app_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"metric_set" text NOT NULL,
	"metric" text NOT NULL,
	"slice" text DEFAULT '' NOT NULL,
	"value" double precision,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "application_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connected_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"status" text DEFAULT 'not_configured' NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"encrypted_secret" text,
	"last_checked_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connected_services_service_unique" UNIQUE("service")
);
--> statement-breakpoint
CREATE TABLE "country_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"property_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"dimension" text DEFAULT 'country' NOT NULL,
	"dimension_value" text NOT NULL,
	"clicks" integer,
	"impressions" integer,
	"ctr" double precision,
	"position" double precision,
	"active_users" integer,
	"new_users" integer,
	"sessions" integer,
	"engaged_sessions" integer,
	"screen_page_views" integer,
	"key_events" double precision,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "daily_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_date" date NOT NULL,
	"content" jsonb NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"emailed_at" timestamp with time zone,
	"email_error" text,
	CONSTRAINT "daily_reports_report_date_unique" UNIQUE("report_date")
);
--> statement-breakpoint
CREATE TABLE "fx_rates" (
	"id" serial PRIMARY KEY NOT NULL,
	"base" text NOT NULL,
	"quote" text NOT NULL,
	"rate" double precision NOT NULL,
	"source" text NOT NULL,
	"rate_date" date NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ga4_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"property_name" text NOT NULL,
	"display_name" text NOT NULL,
	"account_name" text,
	"account_display_name" text,
	"property_type" text,
	"time_zone" text,
	"currency_code" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"is_accessible" boolean DEFAULT true NOT NULL,
	"source" text DEFAULT 'discovered' NOT NULL,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_data_date" date,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ga4_properties_property_name_unique" UNIQUE("property_name")
);
--> statement-breakpoint
CREATE TABLE "google_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"google_sub" text NOT NULL,
	"email" text,
	"granted_scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "google_accounts_google_sub_unique" UNIQUE("google_sub")
);
--> statement-breakpoint
CREATE TABLE "keyword_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_console_property_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"query" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	"data_state" text DEFAULT 'final' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"recommended_action" text,
	"entity_type" text,
	"entity_id" text,
	"entity_label" text,
	"dedupe_key" text NOT NULL,
	"is_read" boolean DEFAULT false NOT NULL,
	"emailed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "oauth_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_account_id" uuid NOT NULL,
	"encrypted_refresh_token" text NOT NULL,
	"encrypted_access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_credentials_google_account_id_unique" UNIQUE("google_account_id")
);
--> statement-breakpoint
CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_verifier" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_console_property_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"page" text NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	"data_state" text DEFAULT 'final' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "play_console_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"resource_name" text NOT NULL,
	"package_name" text NOT NULL,
	"display_name" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"freshness" jsonb,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_console_apps_resource_name_unique" UNIQUE("resource_name"),
	CONSTRAINT "play_console_apps_package_name_unique" UNIQUE("package_name")
);
--> statement-breakpoint
CREATE TABLE "report_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_type" text NOT NULL,
	"format" text NOT NULL,
	"title" text NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "search_console_properties" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_url" text NOT NULL,
	"property_type" text NOT NULL,
	"permission_level" text,
	"is_selected" boolean DEFAULT false NOT NULL,
	"is_accessible" boolean DEFAULT true NOT NULL,
	"sync_status" text DEFAULT 'never' NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_data_date" date,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_console_properties_site_url_unique" UNIQUE("site_url")
);
--> statement-breakpoint
CREATE TABLE "sitemap_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_console_property_id" uuid NOT NULL,
	"path" text NOT NULL,
	"type" text,
	"is_pending" boolean,
	"is_sitemaps_index" boolean,
	"last_submitted" timestamp with time zone,
	"last_downloaded" timestamp with time zone,
	"warnings" integer,
	"errors" integer,
	"contents" jsonb,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"target_id" text DEFAULT '' NOT NULL,
	"trigger" text DEFAULT 'scheduled' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sync_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_id" uuid,
	"level" text NOT NULL,
	"message" text NOT NULL,
	"context" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "url_inspections" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_console_property_id" uuid NOT NULL,
	"url" text NOT NULL,
	"verdict" text,
	"coverage_state" text,
	"robots_txt_state" text,
	"indexing_state" text,
	"page_fetch_state" text,
	"google_canonical" text,
	"user_canonical" text,
	"last_crawl_time" timestamp with time zone,
	"crawled_as" text,
	"mobile_usability_verdict" text,
	"inspection_result_link" text,
	"raw" jsonb,
	"inspected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"csrf_token" text NOT NULL,
	"ip" text,
	"user_agent" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"role" text DEFAULT 'admin' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "website_daily_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"search_console_property_id" uuid NOT NULL,
	"metric_date" date NOT NULL,
	"clicks" integer NOT NULL,
	"impressions" integer NOT NULL,
	"ctr" double precision NOT NULL,
	"position" double precision NOT NULL,
	"data_state" text DEFAULT 'final' NOT NULL,
	"retrieved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "websites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"search_console_property_id" uuid,
	"ga4_property_id" uuid,
	"is_monitored" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "websites_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "admob_apps" ADD CONSTRAINT "admob_apps_admob_account_id_admob_accounts_id_fk" FOREIGN KEY ("admob_account_id") REFERENCES "public"."admob_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admob_daily_metrics" ADD CONSTRAINT "admob_daily_metrics_admob_account_id_admob_accounts_id_fk" FOREIGN KEY ("admob_account_id") REFERENCES "public"."admob_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily_metrics" ADD CONSTRAINT "analytics_daily_metrics_ga4_property_id_ga4_properties_id_fk" FOREIGN KEY ("ga4_property_id") REFERENCES "public"."ga4_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "android_apps" ADD CONSTRAINT "android_apps_play_console_app_id_play_console_apps_id_fk" FOREIGN KEY ("play_console_app_id") REFERENCES "public"."play_console_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "android_apps" ADD CONSTRAINT "android_apps_admob_app_id_admob_apps_id_fk" FOREIGN KEY ("admob_app_id") REFERENCES "public"."admob_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "android_apps" ADD CONSTRAINT "android_apps_ga4_property_id_ga4_properties_id_fk" FOREIGN KEY ("ga4_property_id") REFERENCES "public"."ga4_properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_daily_metrics" ADD CONSTRAINT "app_daily_metrics_android_app_id_android_apps_id_fk" FOREIGN KEY ("android_app_id") REFERENCES "public"."android_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_vitals" ADD CONSTRAINT "app_vitals_play_console_app_id_play_console_apps_id_fk" FOREIGN KEY ("play_console_app_id") REFERENCES "public"."play_console_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_accounts" ADD CONSTRAINT "google_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "keyword_daily_metrics" ADD CONSTRAINT "keyword_daily_metrics_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_credentials" ADD CONSTRAINT "oauth_credentials_google_account_id_google_accounts_id_fk" FOREIGN KEY ("google_account_id") REFERENCES "public"."google_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_daily_metrics" ADD CONSTRAINT "page_daily_metrics_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_records" ADD CONSTRAINT "sitemap_records_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_job_id_sync_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."sync_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "url_inspections" ADD CONSTRAINT "url_inspections_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "website_daily_metrics" ADD CONSTRAINT "website_daily_metrics_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_search_console_property_id_search_console_properties_id_fk" FOREIGN KEY ("search_console_property_id") REFERENCES "public"."search_console_properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "websites" ADD CONSTRAINT "websites_ga4_property_id_ga4_properties_id_fk" FOREIGN KEY ("ga4_property_id") REFERENCES "public"."ga4_properties"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admob_apps_account_idx" ON "admob_apps" USING btree ("admob_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "admob_dm_uq" ON "admob_daily_metrics" USING btree ("admob_account_id","metric_date","app_id","country","format");--> statement-breakpoint
CREATE INDEX "admob_dm_date_idx" ON "admob_daily_metrics" USING btree ("metric_date");--> statement-breakpoint
CREATE INDEX "admob_dm_app_idx" ON "admob_daily_metrics" USING btree ("app_id","metric_date");--> statement-breakpoint
CREATE INDEX "ai_insights_date_idx" ON "ai_insights" USING btree ("generated_for_date");--> statement-breakpoint
CREATE INDEX "ai_insights_entity_idx" ON "ai_insights" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adm_prop_date_uq" ON "analytics_daily_metrics" USING btree ("ga4_property_id","metric_date");--> statement-breakpoint
CREATE UNIQUE INDEX "appdm_uq" ON "app_daily_metrics" USING btree ("android_app_id","metric_date","metric","source");--> statement-breakpoint
CREATE UNIQUE INDEX "vitals_uq" ON "app_vitals" USING btree ("play_console_app_id","metric_date","metric_set","metric","slice");--> statement-breakpoint
CREATE INDEX "vitals_lookup_idx" ON "app_vitals" USING btree ("play_console_app_id","metric","metric_date");--> statement-breakpoint
CREATE UNIQUE INDEX "cdm_uq" ON "country_daily_metrics" USING btree ("source","property_id","metric_date","dimension","dimension_value");--> statement-breakpoint
CREATE INDEX "cdm_lookup_idx" ON "country_daily_metrics" USING btree ("source","property_id","dimension","metric_date");--> statement-breakpoint
CREATE UNIQUE INDEX "fx_uq" ON "fx_rates" USING btree ("base","quote","rate_date");--> statement-breakpoint
CREATE UNIQUE INDEX "kdm_prop_date_query_uq" ON "keyword_daily_metrics" USING btree ("search_console_property_id","metric_date","query");--> statement-breakpoint
CREATE INDEX "kdm_prop_date_idx" ON "keyword_daily_metrics" USING btree ("search_console_property_id","metric_date");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "notifications_unread_idx" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE UNIQUE INDEX "pdm_prop_date_page_uq" ON "page_daily_metrics" USING btree ("search_console_property_id","metric_date","page");--> statement-breakpoint
CREATE INDEX "pdm_prop_date_idx" ON "page_daily_metrics" USING btree ("search_console_property_id","metric_date");--> statement-breakpoint
CREATE INDEX "report_files_created_idx" ON "report_files" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sitemap_uq" ON "sitemap_records" USING btree ("search_console_property_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "sync_jobs_active_uq" ON "sync_jobs" USING btree ("service","target_id") WHERE status in ('pending','running');--> statement-breakpoint
CREATE INDEX "sync_jobs_status_idx" ON "sync_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE INDEX "sync_jobs_created_idx" ON "sync_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sync_logs_job_idx" ON "sync_logs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "url_insp_prop_url_idx" ON "url_inspections" USING btree ("search_console_property_id","url","inspected_at");--> statement-breakpoint
CREATE INDEX "user_sessions_user_idx" ON "user_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_sessions_expires_idx" ON "user_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wdm_prop_date_uq" ON "website_daily_metrics" USING btree ("search_console_property_id","metric_date");--> statement-breakpoint
CREATE INDEX "websites_sc_idx" ON "websites" USING btree ("search_console_property_id");--> statement-breakpoint
CREATE INDEX "websites_ga4_idx" ON "websites" USING btree ("ga4_property_id");