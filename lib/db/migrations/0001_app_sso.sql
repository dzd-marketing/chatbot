-- TheStudent app <-> web SSO: app accounts are keyed by their opaque numeric
-- users.id ("sub"), never by email.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "appSub" varchar(20);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_appSub_unique" ON "User" ("appSub");
