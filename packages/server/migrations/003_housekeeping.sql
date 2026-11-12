-- Housekeeping: lets the daily prune and the budget guard find old and recent chunks without scanning the table.
-- Idempotent like the others.
CREATE INDEX IF NOT EXISTS chunks_by_age ON chunks (created_at);
