CREATE TABLE "things" ("id" INTEGER PRIMARY KEY, "body" TEXT NOT NULL);

-- a dollar-quoted body holds semicolons of its own
DO $body$
BEGIN
  INSERT INTO "things" ("id", "body") VALUES (1, 'a');
  INSERT INTO "things" ("id", "body") VALUES (2, 'b');
END
$body$;
