-- ULD Scanner 0.4 (Pallets mode): run ONCE on a database that was created
-- with an earlier install.sql. A new installation does not need this file.
--
--   mysql -u USER -p DATABASE < upgrade-0.4.sql
--
-- Nothing is deleted and no scan data is touched. Until this is run the
-- scanner still works, but pallets with a 3-letter owner code ("PAJ 0606 TRA")
-- are rejected as invalid and R9 / C6 / TG / EK show as unknown operators.

-- Pallets are counted when scanned in Pallets mode.
UPDATE uld_prefixes SET operational = 1 WHERE category = 'PALLET';

-- Owner codes seen on pallets so far. Add your own the same way.
INSERT IGNORE INTO operator_codes (code) VALUES ('R9'),('C6'),('TG'),('EK'),('TRA');

-- Pallets also carry 3-letter owner codes, with 4- or 5-digit serials.
INSERT IGNORE INTO validation_rules (rule_id, rule_version, name, prefixes, serial_length, serial_type, code_length, code_type,
    allowed_codes, excluded_codes, priority, effective_from, created_by) VALUES
  ('rule-pallet-owner3-4', 1, 'Pallet, 3-letter owner: 4-digit serial', '["PAG","PAJ","PKC","PMC","PLA"]', 4, 'N', 3, 'A', NULL, '[]', 30, '2026-01-01 00:00:00', 'system'),
  ('rule-pallet-owner3-5', 1, 'Pallet, 3-letter owner: 5-digit serial', '["PAG","PAJ","PKC","PMC","PLA"]', 5, 'N', 3, 'A', NULL, '[]', 40, '2026-01-01 00:00:00', 'system');

INSERT IGNORE INTO ocr_correction_rules (correction_rule_id, source_character, suggested_character, context, created_by) VALUES
  ('corr-11','Z','2','N','system'), ('corr-12','2','Z','A','system');
