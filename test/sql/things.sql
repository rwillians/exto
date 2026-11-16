-- two statements; the semicolon in this comment, and the one in the value
-- below, don't split them
CREATE TABLE "things" ("id" INTEGER PRIMARY KEY, "body" TEXT NOT NULL);
INSERT INTO "things" ("id", "body") VALUES (1, 'a; b');
