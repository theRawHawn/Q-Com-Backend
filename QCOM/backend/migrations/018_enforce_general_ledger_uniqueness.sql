-- Migration 018: Enforce General Ledger Entry Uniqueness and Idempotent Financial Line Identities
-- Ensures that duplicate journal entry lines cannot be posted for the same logical transaction, account, and entry side.

CREATE UNIQUE INDEX IF NOT EXISTS uq_gl_ref_account_side
ON general_ledger_entries (transaction_reference, account_code, entry_side);
