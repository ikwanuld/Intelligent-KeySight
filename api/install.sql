-- ULD Scanner: MySQL 8 / MariaDB 10.4+ schema (InnoDB, utf8mb4).
-- Import once into an empty database (phpMyAdmin > Import, or `mysql db < install.sql`).
-- Primary keys for device-created records are UUIDs generated on the device,
-- which is what makes offline creation and idempotent sync possible.
-- Timestamps from devices are stored as sent (UTC); *_received_at is the
-- server clock and never replaces them.

SET NAMES utf8mb4;

CREATE TABLE stations (
  station_id    VARCHAR(36) PRIMARY KEY,
  station_code  VARCHAR(8)  NOT NULL UNIQUE,
  station_name  VARCHAR(100) NOT NULL,
  active        TINYINT(1)  NOT NULL DEFAULT 1,      -- never hard-deleted
  created_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE zones (
  zone_id     VARCHAR(36) PRIMARY KEY,
  station_id  VARCHAR(36) NOT NULL,
  zone_name   VARCHAR(100) NOT NULL,
  active      TINYINT(1)  NOT NULL DEFAULT 1,        -- never hard-deleted
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_zone_station FOREIGN KEY (station_id) REFERENCES stations(station_id)
) ENGINE=InnoDB;

CREATE TABLE users (
  user_id            VARCHAR(64) PRIMARY KEY,
  email              VARCHAR(255) NOT NULL UNIQUE,   -- presence + active = whitelisted
  name               VARCHAR(150) NOT NULL,
  role               ENUM('STAFF','ADMIN') NOT NULL DEFAULT 'STAFF',
  rule_manager       TINYINT(1) NOT NULL DEFAULT 0,  -- may edit validation / OCR rules
  active             TINYINT(1) NOT NULL DEFAULT 1,
  default_station_id VARCHAR(36) NULL,
  created_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at         DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_user_station FOREIGN KEY (default_station_id) REFERENCES stations(station_id)
) ENGINE=InnoDB;

CREATE TABLE user_stations (                          -- authorized stations
  user_id    VARCHAR(64) NOT NULL,
  station_id VARCHAR(36) NOT NULL,
  PRIMARY KEY (user_id, station_id),
  CONSTRAINT fk_us_user FOREIGN KEY (user_id) REFERENCES users(user_id),
  CONSTRAINT fk_us_station FOREIGN KEY (station_id) REFERENCES stations(station_id)
) ENGINE=InnoDB;

CREATE TABLE auth_login_codes (                       -- one-time codes from the redirect
  code_hash  CHAR(64) PRIMARY KEY,
  user_id    VARCHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL
) ENGINE=InnoDB;

CREATE TABLE auth_tokens (
  token_hash CHAR(64) PRIMARY KEY,                    -- store a hash, not the token
  user_id    VARCHAR(64) NOT NULL,
  device_id  VARCHAR(36) NULL,
  issued_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  INDEX ix_token_user (user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------- rules --

CREATE TABLE uld_prefixes (
  prefix       CHAR(3) PRIMARY KEY,
  category     ENUM('CONTAINER','PALLET','OTHER') NOT NULL,
  operational  TINYINT(1) NOT NULL DEFAULT 0,         -- counted when scanned in its own scan mode (Containers / Pallets)
  active       TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE operator_codes (
  code    VARCHAR(3) PRIMARY KEY,
  active  TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB;

CREATE TABLE validation_rules (                       -- one row per version, never updated in place
  rule_id         VARCHAR(36) NOT NULL,
  rule_version    INT NOT NULL,
  name            VARCHAR(150) NOT NULL,
  prefixes        LONGTEXT NULL,                          -- NULL = any prefix
  prefix_length   TINYINT NOT NULL DEFAULT 3,
  serial_length   TINYINT NOT NULL,
  serial_type     ENUM('N','A','AN') NOT NULL DEFAULT 'N',
  code_length     TINYINT NOT NULL,
  code_type       ENUM('N','A','AN') NOT NULL DEFAULT 'AN',
  allowed_codes   LONGTEXT NULL,
  excluded_codes  LONGTEXT NULL,
  full_pattern    VARCHAR(255) NULL,                  -- optional regex mirror, for reporting
  priority        INT NOT NULL DEFAULT 100,
  active          TINYINT(1) NOT NULL DEFAULT 1,
  effective_from  DATETIME(3) NOT NULL,
  effective_until DATETIME(3) NULL,
  created_by      VARCHAR(64) NOT NULL,
  created_at      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (rule_id, rule_version)
) ENGINE=InnoDB;

CREATE TABLE ocr_correction_rules (
  correction_rule_id  VARCHAR(36) PRIMARY KEY,
  source_character    CHAR(1) NOT NULL,
  suggested_character CHAR(1) NOT NULL,
  context             ENUM('N','A') NOT NULL,         -- position type the rule applies to
  active              TINYINT(1) NOT NULL DEFAULT 1,
  created_by          VARCHAR(64) NOT NULL,
  created_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE app_settings (                           -- thresholds, queue limit, retention, cloud OCR
  setting_key   VARCHAR(64) PRIMARY KEY,
  setting_value LONGTEXT NOT NULL,
  updated_by    VARCHAR(64) NULL,
  updated_at    DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

-- ------------------------------------------------------------- sessions --

CREATE TABLE scan_sessions (
  session_id        VARCHAR(36) PRIMARY KEY,
  session_reference VARCHAR(40) NOT NULL,
  created_by        VARCHAR(64) NOT NULL,
  resumed_by        VARCHAR(64) NULL,
  station_id        VARCHAR(36) NOT NULL,
  station_code      VARCHAR(8)  NOT NULL,             -- as it was at scan time
  zone_id           VARCHAR(36) NOT NULL,
  zone_name         VARCHAR(100) NOT NULL,            -- as it was at scan time (survives renames)
  day               DATE NOT NULL,                    -- device-local calendar day
  started_at        DATETIME(3) NOT NULL,
  completed_at      DATETIME(3) NULL,
  completed_by      VARCHAR(64) NULL,
  last_activity_at  DATETIME(3) NOT NULL,
  status            ENUM('DRAFT','IN_PROGRESS','COMPLETED','AUTO_COMPLETED') NOT NULL,
  completion_type   ENUM('MANUAL','AUTO') NULL,
  device_id         VARCHAR(36) NOT NULL,
  duplicates_count  INT NOT NULL DEFAULT 0,
  multi_scans_count INT NOT NULL DEFAULT 0,
  config_version    INT NULL,
  data  LONGTEXT NOT NULL,   -- the record exactly as the device sent it (JSON); columns above are for querying
  rev               INT NOT NULL,                     -- device revision
  server_rev        INT NOT NULL DEFAULT 1,           -- optimistic-lock revision
  received_at       DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_session_day (station_id, day, status),
  INDEX ix_session_user (created_by, day),
  CONSTRAINT fk_session_station FOREIGN KEY (station_id) REFERENCES stations(station_id),
  CONSTRAINT fk_session_zone FOREIGN KEY (zone_id) REFERENCES zones(zone_id)
) ENGINE=InnoDB;

CREATE TABLE scan_records (
  scan_id              VARCHAR(36) PRIMARY KEY,
  session_id           VARCHAR(36) NOT NULL,
  state                ENUM('PENDING','CONFIRMED','REJECTED','AUTO_SAVED') NOT NULL,
  uld_number           VARCHAR(16) NULL,              -- set once confirmed / auto-saved
  value                VARCHAR(16) NOT NULL,          -- current working value
  raw_ocr              VARCHAR(16) NULL,              -- NULL for manual entries
  manual_input         VARCHAR(16) NULL,              -- what staff originally typed
  suggested_correction VARCHAR(16) NULL,
  correction_accepted  TINYINT(1) NULL,               -- NULL = no suggestion or not decided
  final_value          VARCHAR(16) NULL,
  category             ENUM('CONTAINER','PALLET','OTHER') NULL,
  prefix               CHAR(3) NULL,
  operational          TINYINT(1) NOT NULL DEFAULT 0,
  validation_status    ENUM('VALID','NEEDS_REVIEW','INVALID') NOT NULL,
  review_reasons       LONGTEXT NULL,
  confidence_status    ENUM('HIGH','REVIEW','UNCERTAIN') NULL,
  rule_id              VARCHAR(36) NULL,              -- rule + version the scan was judged by
  rule_version         INT NULL,
  manually_added       TINYINT(1) NOT NULL DEFAULT 0,
  manually_corrected   TINYINT(1) NOT NULL DEFAULT 0,
  confirmed            TINYINT(1) NOT NULL DEFAULT 0,
  review_acknowledged  TINYINT(1) NOT NULL DEFAULT 0,
  confirmed_by         VARCHAR(64) NULL,
  confirmed_at         DATETIME(3) NULL,
  image_reference      VARCHAR(36) NULL,              -- object-storage key; no binary here
  source               ENUM('SINGLE','MULTI','MANUAL') NOT NULL,
  engine               VARCHAR(32) NULL,
  cloud_fallback       TINYINT(1) NOT NULL DEFAULT 0,
  overall_confidence   TINYINT UNSIGNED NULL,         -- admin analytics only
  min_confidence       TINYINT UNSIGNED NULL,
  character_confidence LONGTEXT NULL,
  detection_confidence TINYINT UNSIGNED NULL,
  image_quality        TINYINT UNSIGNED NULL,
  lighting             ENUM('VERY_LOW_LIGHT','LOW_LIGHT','GOOD','BRIGHT','GLARE') NULL,
  env                  LONGTEXT NULL,                     -- luma, glare, sharpness, motion, text size, tilt, perspective
  first_seen_at        DATETIME(3) NULL,              -- scan time   = shown_at - first_seen_at
  shown_at             DATETIME(3) NULL,              -- confirm time = confirmed_at - shown_at
  ocr_ms               INT NULL,
  frames               INT NULL,
  flags                LONGTEXT NULL,
  history              LONGTEXT NOT NULL,                 -- per-scan audit trail (who / what / when)
  created_by           VARCHAR(64) NOT NULL,
  created_at           DATETIME(3) NOT NULL,
  updated_at           DATETIME(3) NOT NULL,
  data  LONGTEXT NOT NULL,   -- the record exactly as the device sent it (JSON); columns above are for querying
  rev                  INT NOT NULL,
  server_rev           INT NOT NULL DEFAULT 1,
  received_at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_scan_session (session_id, state),
  INDEX ix_scan_uld (uld_number),
  INDEX ix_scan_created (created_at),
  CONSTRAINT fk_scan_session FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
) ENGINE=InnoDB;

CREATE TABLE ocr_observations (
  observation_id        BIGINT AUTO_INCREMENT PRIMARY KEY,
  scan_id               VARCHAR(36) NOT NULL,
  raw_text              VARCHAR(24) NOT NULL,
  frames                INT NOT NULL DEFAULT 1,
  overall_confidence    TINYINT UNSIGNED NULL,
  character_confidence  LONGTEXT NULL,
  source                VARCHAR(16) NOT NULL DEFAULT 'local',
  INDEX ix_obs_scan (scan_id),
  CONSTRAINT fk_obs_scan FOREIGN KEY (scan_id) REFERENCES scan_records(scan_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE session_events (                          -- append-only
  event_id    VARCHAR(36) PRIMARY KEY,
  session_id  VARCHAR(36) NOT NULL,
  type        VARCHAR(40) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  at          DATETIME(3) NOT NULL,
  data  LONGTEXT NOT NULL,   -- the record exactly as the device sent it (JSON); columns above are for querying
  detail      LONGTEXT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_event_session (session_id, at),
  CONSTRAINT fk_event_session FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
) ENGINE=InnoDB;

CREATE TABLE device_analytics (                        -- one row per session + device
  session_id        VARCHAR(36) NOT NULL,
  device_id         VARCHAR(36) NOT NULL,
  device_model      VARCHAR(80) NULL,
  os                VARCHAR(20) NULL,
  os_version        VARCHAR(20) NULL,
  browser           VARCHAR(30) NULL,
  browser_version   VARCHAR(30) NULL,
  camera_resolution VARCHAR(16) NULL,
  screen_resolution VARCHAR(16) NULL,
  performance_class ENUM('STANDARD','LIMITED') NULL,
  avg_ocr_ms        INT NULL,
  PRIMARY KEY (session_id, device_id),
  CONSTRAINT fk_dev_session FOREIGN KEY (session_id) REFERENCES scan_sessions(session_id)
) ENGINE=InnoDB;

CREATE TABLE images (
  image_reference VARCHAR(36) PRIMARY KEY,
  scan_id         VARCHAR(36) NOT NULL,
  session_id      VARCHAR(36) NOT NULL,
  storage_key     VARCHAR(255) NOT NULL,               -- path / object key in private storage
  bytes           INT NOT NULL,
  captured_at     DATETIME(3) NOT NULL,
  received_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at      DATETIME(3) NOT NULL,                -- captured_at + retention; purge job deletes file + row
  INDEX ix_image_expiry (expires_at)
) ENGINE=InnoDB;

-- ------------------------------------------------------------------ sync --

CREATE TABLE sync_ops (                                -- idempotency: one row per op_id
  op_id       VARCHAR(100) PRIMARY KEY,
  device_id   VARCHAR(36) NOT NULL,
  user_id     VARCHAR(64) NOT NULL,
  status      ENUM('applied','conflict','rejected') NOT NULL,
  server_rev  INT NULL,
  received_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE sync_conflicts (                          -- both versions kept for admin review
  conflict_id   BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity        ENUM('session','scan') NOT NULL,
  entity_id     VARCHAR(36) NOT NULL,
  device_id     VARCHAR(36) NOT NULL,
  user_id       VARCHAR(64) NOT NULL,
  base_rev      INT NULL,
  server_rev    INT NOT NULL,
  incoming_data LONGTEXT NOT NULL,                         -- the device's version
  current_data  LONGTEXT NOT NULL,                         -- the server's version at that moment
  detected_at   DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  resolved_at   DATETIME(3) NULL,
  resolved_by   VARCHAR(64) NULL,
  resolution    ENUM('KEEP_SERVER','KEEP_DEVICE','MERGED') NULL,
  INDEX ix_conflict_open (resolved_at, entity, entity_id)
) ENGINE=InnoDB;

-- ----------------------------------------------------------------- audit --

CREATE TABLE audit_log (                               -- administrative changes
  audit_id    BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id     VARCHAR(64) NOT NULL,
  action      VARCHAR(60) NOT NULL,                    -- e.g. RULE_CREATED, ZONE_DEACTIVATED, USER_STATION_ADDED
  entity      VARCHAR(40) NOT NULL,
  entity_id   VARCHAR(64) NOT NULL,
  old_value   LONGTEXT NULL,
  new_value   LONGTEXT NULL,
  at          DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX ix_audit_entity (entity, entity_id, at)
) ENGINE=InnoDB;

-- ================================================================= seed ==
-- Starting configuration. Everything below is data you can change later.
-- ⚠ Stations, zones and operator codes are placeholders: replace with the real lists.

INSERT INTO stations (station_id, station_code, station_name) VALUES
  ('stn-kul','KUL','Kuala Lumpur'), ('stn-pen','PEN','Penang'), ('stn-jhb','JHB','Johor Bahru');
INSERT INTO zones (zone_id, station_id, zone_name) VALUES
  ('kul-a','stn-kul','Zone A'), ('kul-b','stn-kul','Zone B'), ('kul-c','stn-kul','Zone C'),
  ('pen-1','stn-pen','Zone 1'), ('pen-2','stn-pen','Zone 2'), ('jhb-1','stn-jhb','Zone 1');

INSERT INTO uld_prefixes (prefix, category, operational) VALUES
  ('AKE','CONTAINER',1), ('AAY','CONTAINER',1), ('AKH','CONTAINER',1),
  ('PAG','PALLET',1), ('PAJ','PALLET',1), ('PKC','PALLET',1), ('PMC','PALLET',1), ('PLA','PALLET',1);
INSERT INTO operator_codes (code) VALUES ('AK'),('D7'),('FD'),('QZ'),('Z2'),('XJ'),('MH'),('R7'),
  ('R9'),('C6'),('TG'),('EK'),('TRA');   -- read off the reference pallet photos

INSERT INTO validation_rules (rule_id, rule_version, name, prefixes, serial_length, serial_type, code_length, code_type,
    allowed_codes, excluded_codes, priority, effective_from, created_by) VALUES
  ('rule-ai-sv', 1, 'AI / SV: 4-digit serial', NULL, 4, 'N', 2, 'A', '["AI","SV"]', '[]', 10, '2026-01-01 00:00:00', 'system'),
  ('rule-standard', 1, 'Other operators: 5-digit serial', NULL, 5, 'N', 2, 'AN', NULL, '["AI","SV"]', 20, '2026-01-01 00:00:00', 'system'),
  -- Pallets also carry 3-letter owner codes, with 4- or 5-digit serials ("PAJ 0606 TRA").
  ('rule-pallet-owner3-4', 1, 'Pallet, 3-letter owner: 4-digit serial', '["PAG","PAJ","PKC","PMC","PLA"]', 4, 'N', 3, 'A', NULL, '[]', 30, '2026-01-01 00:00:00', 'system'),
  ('rule-pallet-owner3-5', 1, 'Pallet, 3-letter owner: 5-digit serial', '["PAG","PAJ","PKC","PMC","PLA"]', 5, 'N', 3, 'A', NULL, '[]', 40, '2026-01-01 00:00:00', 'system');

INSERT INTO ocr_correction_rules (correction_rule_id, source_character, suggested_character, context, created_by) VALUES
  ('corr-1','O','0','N','system'), ('corr-2','0','O','A','system'), ('corr-3','I','1','N','system'), ('corr-4','1','I','A','system'),
  ('corr-5','S','5','N','system'), ('corr-6','5','S','A','system'), ('corr-7','B','8','N','system'), ('corr-8','8','B','A','system'),
  ('corr-9','G','6','N','system'), ('corr-10','6','G','A','system'), ('corr-11','Z','2','N','system'), ('corr-12','2','Z','A','system');

INSERT INTO app_settings (setting_key, setting_value) VALUES
  ('config_version', '1'),
  ('thresholds', '{"high":90,"review":70}'),
  ('tracking', '{"minFrames":2,"singleFrameIfHigh":true,"invalidMinFrames":3,"trackTtlMs":1500}'),
  ('queue', '{"overflowThreshold":8}'),
  ('images', '{"retentionDays":30}'),
  ('cloudOcr', '{"enabled":false}');

-- Daily Activity (all of a user's sessions on one day treated as one unit):
--   SELECT s.created_by, s.day, s.station_code, s.zone_name,
--          SUM(r.state = 'CONFIRMED' AND r.operational = 1 AND r.category = 'CONTAINER') AS containers,
--          SUM(r.state = 'CONFIRMED' AND r.operational = 1 AND r.category = 'PALLET') AS pallets,
--          SUM(r.state = 'AUTO_SAVED' OR (r.state = 'CONFIRMED' AND r.operational = 0)) AS other_ulds
--   FROM scan_sessions s JOIN scan_records r USING (session_id)
--   GROUP BY s.created_by, s.day, s.station_code, s.zone_name;
