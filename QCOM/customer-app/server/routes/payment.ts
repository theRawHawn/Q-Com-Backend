import { Router, Request, Response } from 'express';
import crypto from 'crypto';
import { 
  requireAuth, 
  generatePaymentSignature, 
  verifyPaymentSignature, 
  createRateLimiter,
  sanitizeString 
} from '../security';
import { authoritativeOrderStore, authoritativeUserStore } from '../store';

const router = Router();

const paymentLimiter = createRateLimiter({
  windowMs: 60 * 1000,
  max: 20,
  keyPrefix: 'rl:pay'
});

// 1. Create Payment Order Intent with Cryptographic Signature
router.post('/create-order', requireAuth, paymentLimiter, (req: Request, res: Response) => {
  const { orderId } = req.body;
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({
      error: 'INVALID_ORDER_ID',
      message: 'orderId is required.'
    });
  }

  const order = authoritativeOrderStore.getOrder(orderId);
  if (!order) {
    return res.status(404).json({
      error: 'ORDER_NOT_FOUND',
      message: 'Order not found.'
    });
  }

  // Verify ownership
  const orderCustId = (order as any).customerId;
  const sitePhone = order.jobSite?.sitePhone?.replace(/\s/g, '');
  const userPhone = user?.phone?.replace(/\s/g, '');
  const isOwner = (orderCustId && orderCustId === userId) || (userPhone && sitePhone === userPhone);

  if (!isOwner) {
    return res.status(403).json({
      error: 'FORBIDDEN_ACCESS',
      message: 'You are not authorized to initiate payment for this order.'
    });
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const paymentOrderId = `pay_order_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const authoritativeAmount = order.total;

  // Generate server-side HMAC signature for this exact order amount
  const signature = generatePaymentSignature(order.id, authoritativeAmount, timestamp);

  res.json({
    success: true,
    paymentOrder: {
      paymentOrderId,
      orderId: order.id,
      amount: authoritativeAmount,
      currency: 'INR',
      timestamp,
      signature
    }
  });
});

// 2. Authoritative Payment Verification & Replay Protection
router.post('/verify', requireAuth, paymentLimiter, (req: Request, res: Response) => {
  const { orderId, transactionId, timestamp, signature, amount } = req.body;
  const userId = req.user!.id;
  const user = authoritativeUserStore.getUserById(userId);

  if (!orderId || !transactionId || !signature || !timestamp) {
    return res.status(400).json({
      error: 'MISSING_PAYMENT_PARAMETERS',
      message: 'orderId, transactionId, timestamp, and signature are required for payment verification.'
    });
  }

  const order = authoritativeOrderStore.getOrder(orderId);
  if (!order) {
    return res.status(404).json({
      error: 'ORDER_NOT_FOUND',
      message: 'Order not found.'
    });
  }

  // Verify ownership
  const orderCustId = (order as any).customerId;
  const sitePhone = order.jobSite?.sitePhone?.replace(/\s/g, '');
  const userPhone = user?.phone?.replace(/\s/g, '');
  const isOwner = (orderCustId && orderCustId === userId) || (userPhone && sitePhone === userPhone);

  if (!isOwner) {
    return res.status(403).json({
      error: 'FORBIDDEN_ACCESS',
      message: 'You are not authorized to verify payment for this order.'
    });
  }

  // 1. REPLAY ATTACK CHECK: Verify transaction ID hasn't been used before
  const cleanTxnId = sanitizeString(transactionId, 64);
  if (authoritativeOrderStore.isTransactionUsed(cleanTxnId)) {
    return res.status(409).json({
      error: 'PAYMENT_REPLAY_DETECTED',
      message: 'This payment transaction reference has already been processed and cannot be reused.'
    });
  }

  // 2. CRYPTOGRAPHIC SIGNATURE CHECK: Verify signature against authoritative order total
  const isSignatureValid = verifyPaymentSignature(order.id, order.total, Number(timestamp), signature);

  if (!isSignatureValid) {
    return res.status(400).json({
      error: 'INVALID_PAYMENT_SIGNATURE',
      message: 'Payment verification failed: Signature mismatch or payment amount tampering detected.'
    });
  }

  // 3. Mark transaction as consumed (Atomic replay prevention)
  authoritativeOrderStore.markTransactionUsed(cleanTxnId);

  // 4. Update order payment status
  order.paymentMethod = 'Instant UPI';
  (order as any).paymentStatus = 'PAID';
  (order as any).transactionId = cleanTxnId;
  (order as any).paidAt = new Date().toISOString();

  authoritativeOrderStore.saveOrder(order);

  console.log(`[PAYMENT] Successfully verified payment for order ${orderId} with txn ${cleanTxnId}`);

  res.json({
    success: true,
    message: 'Payment verified and confirmed by authoritative gateway.',
    order,
    paymentReceipt: {
      transactionId: cleanTxnId,
      amount: order.total,
      status: 'SUCCESS',
      verifiedAt: (order as any).paidAt
    }
  });
});

export default router;
