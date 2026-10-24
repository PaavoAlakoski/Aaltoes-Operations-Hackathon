CREATE TABLE "addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"managed_site_id" text,
	"order_id" text,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"severity" text NOT NULL,
	"signal" text NOT NULL,
	"status" text NOT NULL,
	"summary" text NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"category" text NOT NULL,
	"channel" text NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"country" text NOT NULL,
	"account_tier" text NOT NULL,
	"import_buyer" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dataset_metadata" (
	"id" text PRIMARY KEY NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"release_status" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"home_city" text NOT NULL,
	"home_country" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"author_type" text NOT NULL,
	"body" text NOT NULL,
	"authored_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational_events" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"command" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" text PRIMARY KEY NOT NULL,
	"order_id" text NOT NULL,
	"vehicle_id" text NOT NULL,
	"role" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" text PRIMARY KEY NOT NULL,
	"reference" text NOT NULL,
	"customer_id" text NOT NULL,
	"pickup_site_id" text,
	"delivery_site_id" text,
	"pickup_address_id" text NOT NULL,
	"delivery_address_id" text NOT NULL,
	"display_lane" text NOT NULL,
	"status" text NOT NULL,
	"route_kind" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"details" jsonb NOT NULL,
	CONSTRAINT "orders_reference_unique" UNIQUE("reference")
);
--> statement-breakpoint
CREATE TABLE "related_records" (
	"collection" text NOT NULL,
	"id" text NOT NULL,
	"order_id" text,
	"details" jsonb NOT NULL,
	CONSTRAINT "related_records_collection_id_pk" PRIMARY KEY("collection","id")
);
--> statement-breakpoint
CREATE TABLE "sites" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text,
	"name" text NOT NULL,
	"city" text NOT NULL,
	"country" text NOT NULL,
	"kind" text NOT NULL,
	"details" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vehicles" (
	"id" text PRIMARY KEY NOT NULL,
	"make" text NOT NULL,
	"model" text NOT NULL,
	"model_year" integer NOT NULL,
	"fuel" text NOT NULL,
	"registration" text,
	"synthetic_vin" text
);
--> statement-breakpoint
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_managed_site_id_sites_id_fk" FOREIGN KEY ("managed_site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational_events" ADD CONSTRAINT "operational_events_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_vehicle_id_vehicles_id_fk" FOREIGN KEY ("vehicle_id") REFERENCES "public"."vehicles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_site_id_sites_id_fk" FOREIGN KEY ("pickup_site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_site_id_sites_id_fk" FOREIGN KEY ("delivery_site_id") REFERENCES "public"."sites"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_pickup_address_id_addresses_id_fk" FOREIGN KEY ("pickup_address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_address_id_addresses_id_fk" FOREIGN KEY ("delivery_address_id") REFERENCES "public"."addresses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "related_records" ADD CONSTRAINT "related_records_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sites" ADD CONSTRAINT "sites_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_order_idx" ON "alerts" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "conversations_order_idx" ON "conversations" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","authored_at");--> statement-breakpoint
CREATE INDEX "events_order_time_idx" ON "operational_events" USING btree ("order_id","recorded_at");--> statement-breakpoint
CREATE INDEX "order_items_order_idx" ON "order_items" USING btree ("order_id");--> statement-breakpoint
CREATE INDEX "orders_lane_updated_idx" ON "orders" USING btree ("display_lane","updated_at");--> statement-breakpoint
CREATE INDEX "related_records_order_idx" ON "related_records" USING btree ("order_id","collection");