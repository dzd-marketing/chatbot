ALTER TABLE "User" ALTER COLUMN "email" TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "thestudentId" integer;--> statement-breakpoint
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "profile" json;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "User_thestudentId_unique" ON "User" ("thestudentId");
