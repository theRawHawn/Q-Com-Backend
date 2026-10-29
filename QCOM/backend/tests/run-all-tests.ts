process.env.NODE_ENV = 'test';

import { testMigrations } from './migrations.test.js';
import { testSeeds } from './seeds.test.js';
import { testConstraints } from './constraints.test.js';
import { testMiddleware } from './middleware.test.js';
import { testRedisCache } from './redis-cache.test.js';
import { testAppHealth } from './app-health.test.js';
import { testJwtSecurity } from './jwt-security.test.js';
import { testAuthAndRbac } from './auth-rbac.test.js';
import { testIdorAndResourceOwnership } from './idor-resource.test.js';
import { testPricingAndTaxEngine } from './pricing-tax.test.js';
import { testBusinessModelRequirements } from './business-model.test.js';
import { runSprint4MigrationTests } from './sprint4-migration.test.js';
import { runSprint5DispatchTests } from './sprint5-dispatch.test.js';
import { runSprint6PaymentsTests } from './sprint6-payments.test.js';
import { runSprint7SettlementsTests } from './sprint7-settlements.test.js';
import { runSprint8RealtimeNotificationsTests } from './sprint8-realtime-notifications.test.js';
import { runSprint9ReturnsCancellationsTests } from './sprint9-returns-cancellations.test.js';
import { runSprint91ResilienceTests } from './sprint9-1-bloom-resilience.test.js';
import { runSprint91RemediationTests } from './sprint9-1-remediation.test.js';
import { runSprint92SubscriberCacheResilienceTests } from './sprint9-2-subscriber-cache-resilience.test.js';
import { testAuthRemediation } from './auth-remediation.test.js';
import { runSprint10DecouplingTests } from './sprint10-1a-decoupling.test.js';
import { runSprint10CRecoveryAndWebhookTests } from './sprint10-1c-recovery-webhooks.test.js';
import { runSprint11_5RemediationTests } from './sprint11-5-inventory-remediation.test.js';
import { runSprint11_6RemediationTests } from './sprint11-6-payment-inventory-remediation.test.js';
import { runSprint11_7SelectiveReservationsAndStockAlertsTests } from './sprint11-7-selective-reservations-and-stock-alerts.test.js';
import { runSprint11_8ConcurrencyAndIntegrityTests } from './sprint11-8-concurrency-and-integrity.test.js';
import { runSprint12PaymentProviderAgnosticTests } from './sprint12-payment-provider-agnostic.test.js';
import { runSprint12_5RecoveryConcurrencyAndProviderNeutralityTests } from './sprint12-5-recovery-concurrency-and-provider-neutrality.test.js';
import { runSprint13CrossPanelIntegrationTests } from './sprint13-cross-panel-integration.test.js';
import { runSprint13_1ProductionSecurityAndRecoveryTests } from './sprint13-1-production-security-and-recovery.test.js';
import { runSprint14StagingValidationTests } from './sprint14-staging-validation.test.js';
import { runFourAppCompatibilityTests } from './four-app-compatibility.test.js';
import { runSprint14_1RealPostgreSql16Tests } from './sprint14-1-real-postgresql16.test.js';
import { runSprint14_2WorkflowClosureTests } from './sprint14-2-workflow-closure.test.js';
import { runSprint14_3StagingReleaseCandidateTests } from './sprint14-3-staging-release-candidate.test.js';
import { runSprint14_4AuthIdorSecurityGateTests } from './sprint14-4-auth-idor-security-gate.test.js';
import { runSprint14_5PaymentIdempotencyTests } from './sprint14-5-payment-idempotency-and-integrity.test.js';
import { runSprint14_6ScalabilityAndMultiInstanceTests } from './sprint14-6-scalability-and-multi-instance.test.js';
import { runSprint14_7AuthenticationSecurityTests } from './sprint14-7-authentication-and-credential-security.test.js';

async function runAllTests() {
  console.log('===========================================================');
  console.log('  QCOM Unified Backend Engine — Automated Test Suite (Sprint 1–10.1A)');
  console.log('===========================================================');
  const start = Date.now();
  try {
    // Sprint 1 Test Suites
    await testMigrations();
    await testSeeds();
    await testConstraints();
    await testMiddleware();
    await testRedisCache();
    await testAppHealth();

    // Sprint 2 Test Suites
    await testJwtSecurity();
    await testAuthAndRbac();
    await testIdorAndResourceOwnership();
    await testAuthRemediation();

    // Sprint 3 Test Suites
    await testPricingAndTaxEngine();

    // Final Business Model Verification (Section 40 Requirements)
    await testBusinessModelRequirements();

    // Sprint 4 Consolidated Domain Migration Tests
    await runSprint4MigrationTests();

    // Sprint 5 Dispatch & Rider Assignment Tests
    await runSprint5DispatchTests();

    // Sprint 6 Payments & Payment Webhooks Tests
    await runSprint6PaymentsTests();

    // Sprint 7 Marketplace Settlement, Seller Payouts & Rider Earnings Tests
    await runSprint7SettlementsTests();

    // Sprint 8 Realtime WebSockets, Transactional Outbox & Rich Push Notifications Tests
    await runSprint8RealtimeNotificationsTests();

    // Sprint 9 Returns, Cancellations, Refunds & Reverse Logistics Tests
    await runSprint9ReturnsCancellationsTests();

    // Sprint 9.1 Database Overload Protection, Bloom Filter & Resilience Tests
    await runSprint91ResilienceTests();

    // Sprint 9.1 Remediation, Multi-Instance Synchronization & Critical Invariant Tests
    await runSprint91RemediationTests();

    // Sprint 9.2 Redis Subscriber, Stampede Protection & Cache Resilience Tests
    await runSprint92SubscriberCacheResilienceTests();

    // Sprint 10.1A Financial Transaction Decoupling & Concurrency Remediation Tests
    await runSprint10DecouplingTests();

    // Sprint 10.1C Durable Financial Recovery & Webhook Ingestion Tests
    await runSprint10CRecoveryAndWebhookTests();

    // Sprint 11.5 Critical Inventory Remediation Tests
    await runSprint11_5RemediationTests();

    // Sprint 11.6.1 Critical Payment-Inventory Remediation Tests
    await runSprint11_6RemediationTests();

    // Sprint 11.7 Selective Stock Reservation & Seller Stock Alert Tests
    await runSprint11_7SelectiveReservationsAndStockAlertsTests();

    // Sprint 11.8 Concurrency Stress Testing & Financial Integrity Verification Tests
    await runSprint11_8ConcurrencyAndIntegrityTests();

    // Sprint 12.0 Payment-Provider-Agnostic Architecture Tests
    await runSprint12PaymentProviderAgnosticTests();

    // Sprint 12.5 Recovery Worker Concurrency & Provider-Neutral Configuration Tests
    await runSprint12_5RecoveryConcurrencyAndProviderNeutralityTests();

    // Sprint 13.0 Cross-Panel Backend Integration & Workflow Integrity Tests
    await runSprint13CrossPanelIntegrationTests();

    // Sprint 13.1 Production Security, Concurrency & Failure-Recovery Tests
    await runSprint13_1ProductionSecurityAndRecoveryTests();

    // Sprint 14.0 Staging Environment, Real PostgreSQL 16 Validation & Release Readiness Tests
    await runSprint14StagingValidationTests();

    // Four-Application Backend Compatibility Verification Tests
    await runFourAppCompatibilityTests();

    // Sprint 14.1 Real PostgreSQL 16 Validation & Concurrency Tests
    await runSprint14_1RealPostgreSql16Tests();

    // Sprint 14.2 Backend Feature Completeness & Cross-App Workflow Closure Tests
    await runSprint14_2WorkflowClosureTests();
    // Sprint 14.3 Four-Application Staging Integration & Release Candidate Tests
    await runSprint14_3StagingReleaseCandidateTests();
    // Sprint 14.4 Authentication, IDOR & Browser Security Gate Tests
    await runSprint14_4AuthIdorSecurityGateTests();
    // Sprint 14.5 Payment Idempotency & Financial Integrity Tests
    await runSprint14_5PaymentIdempotencyTests();
    // Sprint 14.6 Scalability, Multi-Instance Safety & Performance Baseline Tests
    await runSprint14_6ScalabilityAndMultiInstanceTests();
    // Sprint 14.7 Authentication, Password Hashing & Credential Security Tests
    await runSprint14_7AuthenticationSecurityTests();

    const duration = ((Date.now() - start) / 1000).toFixed(2);
    console.log('\n===========================================================');
    console.log(`✓ ALL TESTS & FOUR-APPLICATION COMPATIBILITY PASSED in ${duration}s!`);
    console.log('===========================================================\n');
    process.exit(0);
  } catch (err: any) {
    console.error('\n❌ TEST SUITE FAILED:');
    console.error(err.stack || err.message);
    process.exit(1);
  }
}

runAllTests();
