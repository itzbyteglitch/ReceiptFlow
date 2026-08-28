CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  merchant_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  customer_json TEXT NOT NULL,
  amounts_json TEXT NOT NULL,
  payment_json TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS receipt_items (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES receipts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  unit_price REAL NOT NULL,
  total_price REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_receipts_user_date ON receipts(user_id, uploaded_at);
CREATE INDEX IF NOT EXISTS idx_items_receipt ON receipt_items(receipt_id);
