-- Migration 001: Enable Required PostgreSQL Extensions
DO $$ 
BEGIN
  BEGIN
    CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'uuid-ossp extension already exists or cannot be created: %', SQLERRM;
  END;
  
  BEGIN
    CREATE EXTENSION IF NOT EXISTS "postgis";
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'postgis extension already exists or cannot be created in current environment: %', SQLERRM;
  END;
END $$;
