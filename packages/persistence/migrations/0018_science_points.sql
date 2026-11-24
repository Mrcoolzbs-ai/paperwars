ALTER TABLE countries
  ADD COLUMN science_points integer NOT NULL DEFAULT 0
  CHECK (science_points >= 0);
