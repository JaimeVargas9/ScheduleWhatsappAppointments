CREATE TABLE `appointments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`phone` text NOT NULL,
	`client_name` text NOT NULL,
	`service_id` text NOT NULL,
	`service_name` text NOT NULL,
	`professional_id` text,
	`professional_name` text,
	`location_id` text NOT NULL,
	`location_name` text NOT NULL,
	`address` text DEFAULT '' NOT NULL,
	`start` text NOT NULL,
	`end` text NOT NULL,
	`status` text DEFAULT 'confirmada' NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`calendar_event_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `appointments_tenant_start` ON `appointments` (`tenant_id`,`start`);--> statement-breakpoint
CREATE INDEX `appointments_phone` ON `appointments` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`phone` text NOT NULL,
	`jid` text NOT NULL,
	`client_name` text,
	`summary` text DEFAULT '' NOT NULL,
	`summarized_up_to` integer DEFAULT 0 NOT NULL,
	`handoff` integer DEFAULT false NOT NULL,
	`handoff_reason` text,
	`handoff_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_tenant_phone` ON `conversations` (`tenant_id`,`phone`);--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text,
	`level` text NOT NULL,
	`event` text NOT NULL,
	`data` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_created` ON `logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`conversation_id` integer NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`tool_calls` text,
	`tool_name` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversation_id`);--> statement-breakpoint
CREATE TABLE `processed_messages` (
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`tenant_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `sent_messages` (
	`tenant_id` text NOT NULL,
	`message_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	PRIMARY KEY(`tenant_id`, `message_id`)
);
--> statement-breakpoint
CREATE TABLE `tenants` (
	`id` text PRIMARY KEY NOT NULL,
	`config` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
