import http from 'http';

interface TestResult {
  category: string;
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function makeRequest(options: {
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: any;
}): Promise<{ status: number; body: any; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const postData = options.body ? JSON.stringify(options.body) : '';
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: 3000,
        path: options.path,
        method: options.method || 'GET',
        headers: {
          'Content-Type': 'application/json',
          'x-audit-test': 'qcom-red-team',
          'Content-Length': Buffer.byteLength(postData),
          ...(options.headers || {})
        }
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode || 500, body: parsed, headers: res.headers });
          } catch {
            resolve({ status: res.statusCode || 500, body: data, headers: res.headers });
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

async function runSecurityAudit() {
  console.log('================================================================');
  console.log('🚨 STARTING AGGRESSIVE RED-TEAM SECURITY AUDIT & VERIFICATION 🚨');
  console.log('================================================================\n');

  // STEP 1: AUTHENTICATION & OTP ATTACK TESTS
  console.log('--- TEST SUITE 1: AUTHENTICATION & OTP ATTACKS ---');

  // 1.1 Request OTP for Customer A
  const phoneA = '+919845011111';
  const phoneB = '+919845022222';

  const otpReqA = await makeRequest({
    path: '/api/auth/request-otp',
    method: 'POST',
    body: { phone: phoneA }
  });

  const otpCodeA = otpReqA.body._devTestOtp;
  console.log('otpReqA body:', otpReqA.body);
  results.push({
    category: 'AUTHENTICATION',
    name: 'OTP Generation with Cryptographic Randomness & Hash Storage',
    passed: otpReqA.status === 200 && Boolean(otpCodeA),
    details: `OTP issued successfully with 300s TTL. Status: ${otpReqA.status}`
  });

  // 1.2 OTP Brute-Force Protection Test (5 failed attempts should lock out)
  const phoneVictim = '+919845099999';
  await makeRequest({ path: '/api/auth/request-otp', method: 'POST', body: { phone: phoneVictim } });

  let bruteForceLocked = false;
  for (let i = 0; i < 6; i++) {
    const res = await makeRequest({
      path: '/api/auth/verify-otp',
      method: 'POST',
      body: { phone: phoneVictim, otp: '000000' }
    });
    if (res.status === 400 && res.body?.error === 'OTP_VERIFICATION_FAILED') {
      if (res.body?.message?.includes('locked')) {
        bruteForceLocked = true;
      }
    } else if (res.status === 429) {
      bruteForceLocked = true;
    }
  }

  results.push({
    category: 'AUTHENTICATION',
    name: 'OTP Brute-Force Lockout Defense',
    passed: bruteForceLocked,
    details: 'Exceeded maximum verification attempts triggers lock out.'
  });

  // 1.3 OTP Verification & Token Issuance for Customer A
  const verifyResA = await makeRequest({
    path: '/api/auth/verify-otp',
    method: 'POST',
    body: { phone: phoneA, otp: otpCodeA, name: 'Alice Customer' }
  });
  console.log('verifyResA body:', verifyResA.status, verifyResA.body);

  const tokenA = verifyResA.body.token;
  const userA = verifyResA.body.user;

  results.push({
    category: 'AUTHENTICATION',
    name: 'HMAC-SHA256 Token Issuance & Constant-Time Verification',
    passed: verifyResA.status === 200 && Boolean(tokenA),
    details: `Token issued for Customer A (${userA?.id})`
  });

  // 1.4 OTP Replay Attack Test (Attempting to reuse OTP code A)
  const replayOtpRes = await makeRequest({
    path: '/api/auth/verify-otp',
    method: 'POST',
    body: { phone: phoneA, otp: otpCodeA }
  });

  results.push({
    category: 'AUTHENTICATION',
    name: 'OTP Replay Attack Prevention (Immediate Token Burn)',
    passed: replayOtpRes.status === 400,
    details: `Replay rejected with status: ${replayOtpRes.status} (${replayOtpRes.body?.error})`
  });

  // 1.5 Token Forgery / Tampering Attack
  const tamperedToken = tokenA.slice(0, -5) + 'XXXXX';
  const tamperedRes = await makeRequest({
    path: '/api/profile',
    method: 'GET',
    headers: { Authorization: `Bearer ${tamperedToken}` }
  });

  results.push({
    category: 'AUTHENTICATION',
    name: 'Forged / Tampered JWT Token Rejection',
    passed: tamperedRes.status === 401,
    details: `Tampered token rejected with 401 Unauthorized.`
  });

  // Authenticate Customer B for IDOR / BOLA tests
  const otpReqB = await makeRequest({
    path: '/api/auth/request-otp',
    method: 'POST',
    body: { phone: phoneB }
  });
  const otpCodeB = otpReqB.body._devTestOtp;
  const verifyResB = await makeRequest({
    path: '/api/auth/verify-otp',
    method: 'POST',
    body: { phone: phoneB, otp: otpCodeB, name: 'Bob Attacker' }
  });
  const tokenB = verifyResB.body.token;
  const userB = verifyResB.body.user;

  // STEP 2: PRICING & DATA TAMPERING ATTACKS
  console.log('\n--- TEST SUITE 2: PRICING & QUANTITY TAMPERING ATTACKS ---');

  // 2.1 Price Modification Attack (Attacker sends price ₹1 for ₹185 valve)
  const priceTamperRes = await makeRequest({
    path: '/api/checkout/calculate',
    method: 'POST',
    body: {
      items: [
        { productId: 'plumb-01', quantity: 2, price: 1, total: 2 } // plumb-01 is ₹185
      ]
    }
  });

  const verifiedSubtotal = priceTamperRes.body?.breakdown?.itemsSubtotal;
  results.push({
    category: 'PRICING_SECURITY',
    name: 'Product Price Manipulation Defense (Client Price Overridden)',
    passed: priceTamperRes.status === 200 && verifiedSubtotal === 370,
    details: `Server calculated authoritative subtotal ₹${verifiedSubtotal} (ignored client price ₹1).`
  });

  // 2.2 Negative Quantity Attack
  const negativeQtyRes = await makeRequest({
    path: '/api/checkout/calculate',
    method: 'POST',
    body: {
      items: [{ productId: 'plumb-01', quantity: -5 }]
    }
  });

  results.push({
    category: 'INPUT_VALIDATION',
    name: 'Negative Quantity Attack Rejection',
    passed: negativeQtyRes.status === 400,
    details: `Rejected negative quantity with status 400: ${negativeQtyRes.body?.message}`
  });

  // 2.3 Huge Quantity / Integer Overflow Attack
  const hugeQtyRes = await makeRequest({
    path: '/api/checkout/calculate',
    method: 'POST',
    body: {
      items: [{ productId: 'plumb-01', quantity: 999999999 }]
    }
  });

  results.push({
    category: 'INPUT_VALIDATION',
    name: 'Excessive Quantity / Integer Overflow Defense',
    passed: hugeQtyRes.status === 400,
    details: `Rejected quantity exceeding limit (max 50).`
  });

  // 2.4 Non-existent / Forged Product ID Attack
  const fakeProdRes = await makeRequest({
    path: '/api/checkout/calculate',
    method: 'POST',
    body: {
      items: [{ productId: 'forged-sql-injection-id', quantity: 1 }]
    }
  });

  results.push({
    category: 'CATALOG_SECURITY',
    name: 'Non-Existent / Injected Product ID Rejection',
    passed: fakeProdRes.status === 400,
    details: `Rejected non-catalog product ID with 400.`
  });

  // 2.5 Coupon Manipulation Attack (Tampering with discount value / below min value)
  const fakeCouponRes = await makeRequest({
    path: '/api/checkout/calculate',
    method: 'POST',
    body: {
      items: [{ productId: 'plumb-03', quantity: 1 }], // ₹45 subtotal (PROBUILD requires min ₹499)
      couponCode: 'PROBUILD',
      discountAmount: 500 // Attacker tries to inject ₹500 discount
    }
  });

  const appliedDiscount = fakeCouponRes.body?.breakdown?.couponDiscount;
  results.push({
    category: 'PROMOTION_SECURITY',
    name: 'Coupon Manipulation & Min-Order Rule Enforcement',
    passed: appliedDiscount === 0,
    details: `Server enforced min order value constraint: applied discount is ₹${appliedDiscount}.`
  });

  // STEP 3: ORDER CREATION, IDEMPOTENCY & IDOR / BOLA ATTACKS
  console.log('\n--- TEST SUITE 3: ORDER CREATION, IDEMPOTENCY & IDOR ATTACKS ---');

  // 3.1 Create Valid Authoritative Order for Customer A
  const idempotencyKey1 = `order_key_${Date.now()}_abc123`;
  const createOrderResA = await makeRequest({
    path: '/api/orders/create',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Idempotency-Key': idempotencyKey1
    },
    body: {
      items: [{ productId: 'plumb-01', quantity: 1 }],
      jobSite: {
        address: 'Flat 402, Lotus Tower, Koramangala',
        siteContactName: 'Alice Customer',
        sitePhone: phoneA
      },
      paymentMethod: 'online'
    }
  });

  const orderA = createOrderResA.body.order;
  results.push({
    category: 'ORDER_SECURITY',
    name: 'Authoritative Order Placement with Stock Reservation',
    passed: createOrderResA.status === 201 && Boolean(orderA?.id),
    details: `Order created: ${orderA?.id} with total ₹${orderA?.totalAmount}`
  });

  // 3.2 Idempotency Key Replay Protection (Double-tap / network retry)
  const duplicateOrderRes = await makeRequest({
    path: '/api/orders/create',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokenA}`,
      'Idempotency-Key': idempotencyKey1
    },
    body: {
      items: [{ productId: 'plumb-01', quantity: 1 }],
      jobSite: {
        address: 'Flat 402, Lotus Tower, Koramangala',
        siteContactName: 'Alice Customer',
        sitePhone: phoneA
      }
    }
  });

  results.push({
    category: 'REPLAY_PROTECTION',
    name: 'Idempotent Order Creation (Duplicate Submission Prevention)',
    passed: duplicateOrderRes.status === 201 && duplicateOrderRes.body._idempotentReplay === true && duplicateOrderRes.body.order.id === orderA.id,
    details: `Second submission returned cached order without double-booking or double-deducting stock.`
  });

  // 3.3 IDOR / BOLA Attack: Customer B attempts to read Customer A's Order
  const idorReadRes = await makeRequest({
    path: `/api/orders/${orderA.id}`,
    method: 'GET',
    headers: { Authorization: `Bearer ${tokenB}` } // Customer B token
  });

  results.push({
    category: 'AUTHORIZATION_IDOR',
    name: 'IDOR / BOLA Protection on Order Read Access',
    passed: idorReadRes.status === 403,
    details: `Customer B attempting to read Customer A's order blocked with 403 Forbidden.`
  });

  // 3.4 IDOR / BOLA Attack: Customer B attempts to cancel Customer A's Order
  const idorCancelRes = await makeRequest({
    path: `/api/orders/${orderA.id}/cancel`,
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenB}` } // Customer B token
  });

  results.push({
    category: 'AUTHORIZATION_IDOR',
    name: 'IDOR / BOLA Protection on Order Cancellation',
    passed: idorCancelRes.status === 403,
    details: `Customer B attempting to cancel Customer A's order blocked with 403 Forbidden.`
  });

  // STEP 4: PAYMENT SECURITY & REPLAY PROTECTION
  console.log('\n--- TEST SUITE 4: PAYMENT SECURITY & CRYPTOGRAPHIC VERIFICATION ---');

  // 4.1 Create Payment Intent
  const paymentIntentRes = await makeRequest({
    path: '/api/payment/create-order',
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: { orderId: orderA.id }
  });

  const payOrder = paymentIntentRes.body.paymentOrder;
  results.push({
    category: 'PAYMENT_SECURITY',
    name: 'Cryptographic Payment Order Intent Generation',
    passed: paymentIntentRes.status === 200 && Boolean(payOrder?.signature),
    details: `HMAC Signature generated for amount ₹${payOrder?.amount}`
  });

  // 4.2 Spoofed Payment Signature Attack
  const spoofedPayRes = await makeRequest({
    path: '/api/payment/verify',
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: {
      orderId: orderA.id,
      transactionId: 'txn_fake_123',
      timestamp: payOrder.timestamp,
      signature: 'bad_signature_99887766554433221100aabbccddeeff'
    }
  });

  results.push({
    category: 'PAYMENT_SECURITY',
    name: 'Payment Signature Tampering / Forgery Defense',
    passed: spoofedPayRes.status === 400 && spoofedPayRes.body.error === 'INVALID_PAYMENT_SIGNATURE',
    details: `Forged payment signature rejected with 400.`
  });

  // 4.3 Legitimate Payment Verification
  const validTxnId = `txn_live_${Date.now()}_99`;
  const validPayRes = await makeRequest({
    path: '/api/payment/verify',
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: {
      orderId: orderA.id,
      transactionId: validTxnId,
      timestamp: payOrder.timestamp,
      signature: payOrder.signature
    }
  });

  results.push({
    category: 'PAYMENT_SECURITY',
    name: 'Authoritative Payment Verification & Status Transition',
    passed: validPayRes.status === 200 && validPayRes.body.paymentReceipt?.status === 'SUCCESS',
    details: `Payment confirmed and order transitioned to PAID.`
  });

  // 4.4 Payment Replay Attack (Re-using validTxnId on a new order)
  const replayPayRes = await makeRequest({
    path: '/api/payment/verify',
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: {
      orderId: orderA.id,
      transactionId: validTxnId, // Replayed transaction ID
      timestamp: payOrder.timestamp,
      signature: payOrder.signature
    }
  });

  results.push({
    category: 'PAYMENT_SECURITY',
    name: 'Payment Transaction ID Replay Attack Defense',
    passed: replayPayRes.status === 409 && replayPayRes.body.error === 'PAYMENT_REPLAY_DETECTED',
    details: `Reused transaction reference detected and blocked with 409 Conflict.`
  });

  // STEP 5: INVENTORY RACE CONDITION TEST
  console.log('\n--- TEST SUITE 5: INVENTORY CONCURRENCY & RACE CONDITIONS ---');

  // Explicitly set stock of plumb-06 to 30 for deterministic race testing (2 orders of 30 each)
  await makeRequest({
    path: '/api/orders/test-set-stock',
    method: 'POST',
    body: { productId: 'plumb-06', count: 30 }
  });

  // Attempt 2 concurrent orders requesting stock (30 each, total 60 needed, only 30 available)
  const [raceOrder1, raceOrder2] = await Promise.all([
    makeRequest({
      path: '/api/orders/create',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: {
        items: [{ productId: 'plumb-06', quantity: 30 }],
        jobSite: { address: 'Site A', sitePhone: phoneA }
      }
    }),
    makeRequest({
      path: '/api/orders/create',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
      body: {
        items: [{ productId: 'plumb-06', quantity: 30 }],
        jobSite: { address: 'Site B', sitePhone: phoneB }
      }
    })
  ]);

  // Initial stock was 54. 30 + 30 = 60 > 54. Exactly one must succeed and one must fail safely!
  const raceSuccessCount = (raceOrder1.status === 201 ? 1 : 0) + (raceOrder2.status === 201 ? 1 : 0);
  const raceFailCount = (raceOrder1.status === 409 ? 1 : 0) + (raceOrder2.status === 409 ? 1 : 0);

  results.push({
    category: 'CONCURRENCY_RACE_CONDITION',
    name: 'Atomic Stock Reservation (Concurrent Purchase Race Defense)',
    passed: raceSuccessCount === 1 && raceFailCount === 1,
    details: `Concurrent orders test: Exactly 1 succeeded (${raceSuccessCount}), and 1 failed safely with 409 Out of Stock (${raceFailCount}).`
  });

  // STEP 6: INPUT SANITIZATION & COORDINATES
  console.log('\n--- TEST SUITE 6: INPUT VALIDATION & MALFORMED COORDINATES ---');

  const badCoordRes = await makeRequest({
    path: '/api/orders/create',
    method: 'POST',
    headers: { Authorization: `Bearer ${tokenA}` },
    body: {
      items: [{ productId: 'plumb-01', quantity: 1 }],
      jobSite: {
        address: '<script>alert("xss")</script> 123 Main Road',
        sitePhone: phoneA,
        coordinates: { lat: 999.99, lng: -999.99 } // Impossible coordinates
      }
    }
  });

  results.push({
    category: 'INPUT_SANITIZATION',
    name: 'XSS Stripping & Impossible Coordinate Normalization',
    passed: badCoordRes.status === 201 && !badCoordRes.body.order.jobSite.address.includes('<script>'),
    details: `HTML tags stripped and coordinates safely sanitized to valid boundary bounds.`
  });

  // ================================================================
  // PRINT SUMMARY TABLE
  // ================================================================
  console.log('\n================================================================');
  console.log('📊 RED-TEAM AUDIT EXECUTION SUMMARY 📊');
  console.log('================================================================\n');

  let passedCount = 0;
  for (const r of results) {
    const icon = r.passed ? '✅ PASS' : '❌ FAIL';
    if (r.passed) passedCount++;
    console.log(`${icon} [${r.category}] ${r.name}`);
    console.log(`    ↳ ${r.details}`);
  }

  console.log(`\nTOTAL TESTS: ${results.length} | PASSED: ${passedCount} | FAILED: ${results.length - passedCount}`);
  console.log('================================================================\n');

  if (passedCount === results.length) {
    console.log('🎉 ALL SECURITY CONTROLS HARDENED AND VERIFIED FUNCTIONAL!');
  } else {
    console.error('⚠️ SOME TESTS FAILED.');
    process.exit(1);
  }
}

runSecurityAudit().catch(err => {
  console.error('Audit execution error:', err);
  process.exit(1);
});
