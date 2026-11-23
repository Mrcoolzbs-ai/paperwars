ALTER TABLE orders
  ADD COLUMN resolution_status TEXT,
  ADD COLUMN result_code TEXT,
  ADD COLUMN result_message TEXT,
  ADD COLUMN result_data JSONB;

ALTER TABLE orders
  ADD CONSTRAINT orders_resolution_status_check
    CHECK (resolution_status IS NULL OR resolution_status IN ('accepted', 'rejected', 'superseded')),
  ADD CONSTRAINT orders_resolution_fields_check
    CHECK (
      (resolution_status IS NULL AND result_code IS NULL AND result_message IS NULL AND result_data IS NULL)
      OR (resolution_status IS NOT NULL AND result_code IS NOT NULL)
    );
