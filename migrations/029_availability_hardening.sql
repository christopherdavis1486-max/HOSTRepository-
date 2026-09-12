-- Batch 14B: constrain availability state to the combinations used by
-- host blocking and genuine booking reservations.

ALTER TABLE availability_blocks
  DROP CONSTRAINT IF EXISTS availability_blocks_status_check;

ALTER TABLE availability_blocks
  ADD CONSTRAINT availability_blocks_status_check
  CHECK (
    status IN (
      'available',
      'blocked',
      'booked'
    )
  );

ALTER TABLE availability_blocks
  DROP CONSTRAINT IF EXISTS availability_blocks_source_check;

ALTER TABLE availability_blocks
  ADD CONSTRAINT availability_blocks_source_check
  CHECK (
    source IN (
      'host',
      'booking',
      'ical_sync'
    )
  );

ALTER TABLE availability_blocks
  DROP CONSTRAINT IF EXISTS availability_blocks_state_source_check;

ALTER TABLE availability_blocks
  ADD CONSTRAINT availability_blocks_state_source_check
  CHECK (
    (status = 'booked' AND source = 'booking')
    OR
    (status = 'blocked' AND source IN ('host', 'ical_sync'))
    OR
    (status = 'available' AND source IN ('host', 'ical_sync'))
  );