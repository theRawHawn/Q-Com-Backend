-- Migration 002: Create Users, Roles, Permissions, Saved GSTINs, and Addresses

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone VARCHAR(20) UNIQUE NOT NULL,
    name VARCHAR(120),
    email VARCHAR(180) UNIQUE,
    is_phone_verified BOOLEAN DEFAULT FALSE,
    account_type VARCHAR(20) DEFAULT 'individual' CHECK (account_type IN ('individual', 'business')),
    pan_number VARCHAR(10),
    pan_status VARCHAR(40) DEFAULT 'VALID_PAN' CHECK (pan_status IN ('VALID_PAN', 'INVALID_OR_MISSING_PAN', 'INOPERATIVE_PAN')),
    default_address_id UUID,
    is_suspended BOOLEAN DEFAULT FALSE,
    suspension_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);

CREATE TABLE IF NOT EXISTS roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code VARCHAR(50) UNIQUE NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key VARCHAR(100) UNIQUE NOT NULL,
    module VARCHAR(50) NOT NULL,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    assigned_at TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS saved_gstins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    gstin VARCHAR(15) NOT NULL,
    legal_business_name VARCHAR(255) NOT NULL,
    trade_name VARCHAR(255),
    billing_address TEXT NOT NULL,
    state VARCHAR(80) NOT NULL,
    state_code VARCHAR(10) NOT NULL,
    pincode VARCHAR(10) NOT NULL,
    is_default BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_gstins_user ON saved_gstins(user_id);

CREATE TABLE IF NOT EXISTS saved_addresses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    address TEXT NOT NULL,
    landmark VARCHAR(180),
    floor_unit VARCHAR(80),
    gate_code VARCHAR(40),
    site_contact_name VARCHAR(120) NOT NULL,
    site_phone VARCHAR(20) NOT NULL,
    trade_type VARCHAR(50),
    job_tag VARCHAR(80),
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    accessible_entrance_latitude NUMERIC(10,7),
    accessible_entrance_longitude NUMERIC(10,7),
    dropoff_instructions TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_saved_addresses_user ON saved_addresses(user_id);
