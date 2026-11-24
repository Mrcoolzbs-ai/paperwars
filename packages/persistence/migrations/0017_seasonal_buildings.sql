-- Add the seasonal and textile-economy main building types.
ALTER TABLE country_buildings
  DROP CONSTRAINT country_buildings_type_check,
  ADD CONSTRAINT country_buildings_type_check CHECK (
    building_type IN (
      'factory', 'field', 'rice_field', 'field_level_2', 'cotton_field',
      'textile_workshop', 'textile_workshop_level_2', 'hunter', 'fisher',
      'gold_mine', 'capital', 'religious_building', 'science', 'barracks', 'tower'
    )
  );
