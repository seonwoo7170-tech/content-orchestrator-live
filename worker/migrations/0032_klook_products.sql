CREATE TABLE IF NOT EXISTS klook_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  activity_id TEXT NOT NULL UNIQUE,
  country_name TEXT,
  city_name TEXT,
  product_name TEXT NOT NULL,
  product_image TEXT,
  currency TEXT,
  sell_price REAL,
  commission_rate REAL,
  instant_confirmation INTEGER NOT NULL DEFAULT 0,
  affiliate_link TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_klook_products_city
  ON klook_products(city_name);
