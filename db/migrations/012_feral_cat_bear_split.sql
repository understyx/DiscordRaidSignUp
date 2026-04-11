-- Migration 012: Split Feral into Feral (Cat) and Feral (Bear) for druid spec aliases
UPDATE spec_aliases SET canonical = 'Feral (Cat)'  WHERE char_class = 'druid' AND alias IN ('feral', 'cat', 'kitty', 'feral cat');
UPDATE spec_aliases SET canonical = 'Feral (Bear)' WHERE char_class = 'druid' AND alias IN ('bear', 'feral bear', 'beardin', 'guardian');
