#!/bin/bash
set -e

echo "[START] Ensuring PostgreSQL 16 and Redis 7 services are running..."

# 0. Install binaries if not present
if ! which psql >/dev/null 2>&1 || ! which redis-server >/dev/null 2>&1; then
  echo "[INSTALL] Installing postgresql-16 and redis-server..."
  mount -t tmpfs -o size=100M tmpfs /var/log 2>/dev/null || true
  echo "deb [trusted=yes] http://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o Dpkg::Options::="--force-confold" --no-install-recommends postgresql-16 redis-server
fi

# 1. Start Redis 7
if ! redis-cli ping >/dev/null 2>&1; then
  echo "[Redis] Starting redis-server daemonized..."
  redis-server --daemonize yes
fi

# 2. Start PostgreSQL 16
if ! su - postgres -c "pg_isready" >/dev/null 2>&1; then
  echo "[PostgreSQL] Starting cluster 16/main..."
  su - postgres -c "pg_ctlcluster 16 main start" || true
fi

# 3. Provision user and databases if not present
su - postgres -c "psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='qcom_user'\"" | grep -q 1 || \
  su - postgres -c "psql -c \"CREATE USER qcom_user WITH PASSWORD 'qcom_password' SUPERUSER;\""

for db in qcom_test qcom_staging qcom_db; do
  su - postgres -c "psql -tc \"SELECT 1 FROM pg_database WHERE datname='$db'\"" | grep -q 1 || \
    su - postgres -c "psql -c \"CREATE DATABASE $db OWNER qcom_user;\""
done

# 4. Verify Redis exact version (7.0.15) without silently replacing existing installs
REQUIRED_REDIS_VERSION="7.0.15"
ACTUAL_REDIS_VERSION=$(redis-cli -h 127.0.0.1 -p 6379 INFO server | awk -F: '/^redis_version:/ { gsub("\r", "", $2); print $2 }')
echo "[Redis] Expected version: ${REQUIRED_REDIS_VERSION} | Actual version: ${ACTUAL_REDIS_VERSION:-unknown}"
if [ "${ACTUAL_REDIS_VERSION}" != "${REQUIRED_REDIS_VERSION}" ]; then
  echo "[ERROR] Redis version mismatch: expected ${REQUIRED_REDIS_VERSION}, found ${ACTUAL_REDIS_VERSION:-unknown}." >&2
  echo "        Do not use unpinned versions or in-memory fallback for integration testing." >&2
  echo "        Provision Redis 7.0.15 via: docker run -d --name qcom-redis -p 6379:6379 redis:7.0.15-alpine" >&2
  exit 1
fi

echo "[SUCCESS] PostgreSQL 16 and Redis ${REQUIRED_REDIS_VERSION} are active and provisioned."
