-- Migration 024: Add Password Hash Support and Per-Challenge OTP Salt
-- Establishes secure password storage for administrative accounts and unique per-challenge salts for OTPs.

-- 1. Add per-challenge salt to otp_challenges
ALTER TABLE otp_challenges ADD COLUMN IF NOT EXISTS salt VARCHAR(64);

-- 2. Add password authentication and security lockout columns to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255);
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_updated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_password_attempts INT DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_locked_until TIMESTAMPTZ;

-- 3. Create index on password status for quick administrative account lookup
CREATE INDEX IF NOT EXISTS idx_users_password_hash ON users(id) WHERE password_hash IS NOT NULL;
