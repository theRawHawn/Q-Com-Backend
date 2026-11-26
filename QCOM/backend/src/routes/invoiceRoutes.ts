import { Router, Request, Response } from 'express';
import { invoiceService } from '../modules/invoices/invoiceService.js';
import { pdfGenerator } from '../modules/invoices/pdfGenerator.js';
import { authenticate } from '../middleware/auth.js';
import { requireOrderOwnership } from '../middleware/resourceOwnership.js';

export const invoiceRouter = Router();

/**
 * GET /api/invoices/order/:orderId & GET /api/v1/invoices/order/:orderId
 */
invoiceRouter.get('/order/:orderId', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const invoices = await invoiceService.getOrCreateOrderInvoices(orderId);

    res.status(200).json({
      success: true,
      invoices,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'INVOICE_FETCH_FAILED',
      message: err.message || 'Failed to generate statutory invoice.',
    });
  }
});

/**
 * GET /api/invoices/order/:orderId/text
 */
invoiceRouter.get('/order/:orderId/text', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const invoices = await invoiceService.getOrCreateOrderInvoices(orderId);
    const textSummaries = invoices.map(inv => pdfGenerator.generateInvoiceTextSummary(inv));

    res.type('text/plain').send(textSummaries.join('\n\n\n'));
  } catch (err: any) {
    res.status(500).send(`Failed to generate invoice summary: ${err.message}`);
  }
});

/**
 * GET /api/invoices/order/:orderId/credit-notes & GET /api/v1/invoices/order/:orderId/credit-notes
 */
invoiceRouter.get('/order/:orderId/credit-notes', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const creditNotes = await invoiceService.getOrderCreditNotes(orderId);
    res.status(200).json({
      success: true,
      creditNotes,
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: 'CREDIT_NOTES_FETCH_FAILED',
      message: err.message || 'Failed to retrieve order credit notes.',
    });
  }
});

/**
 * GET /api/invoices/order/:orderId/credit-notes/text
 */
invoiceRouter.get('/order/:orderId/credit-notes/text', authenticate, requireOrderOwnership('orderId'), async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const creditNotes = await invoiceService.getOrderCreditNotes(orderId);
    const textSummaries = creditNotes.map(cn => pdfGenerator.generateCreditNoteTextSummary(cn));
    res.type('text/plain').send(textSummaries.join('\n\n\n'));
  } catch (err: any) {
    res.status(500).send(`Failed to generate credit note summary: ${err.message}`);
  }
});
