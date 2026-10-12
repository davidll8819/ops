-- Preserve old manual records; new workflow submissions are explicitly recorded as automatic.
ALTER TABLE operations_publications ADD COLUMN execution_mode text NOT NULL DEFAULT 'manual' CHECK(execution_mode IN ('manual','automatic'));
