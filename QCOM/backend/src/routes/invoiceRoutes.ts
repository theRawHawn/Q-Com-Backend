import { Router, Request, Response } from 'express';
import { invoiceService } from '../modules/invoices/invoiceService.js';
import { pdfGenerator } from '../modules/invoices/pdfGenerator.js';
import { authenticate } from '../middleware/auth.js';

export const invoiceRouter = Router();

/**
 * GET /api/invoices/order/:orderId & GET /api/v1/invoices/order/:orderId
 */
invoiceRouter.get('/order/:orderId', authenticate, async (req: Request, res: Response): Promise<void> => {
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
invoiceRouter.get('/order/:orderId/text', authenticate, async (req: Request, res: Response): Promise<void> => {
  try {
    const { orderId } = req.params;
    const invoices = await invoiceService.getOrCreateOrderInvoices(orderId);
    const textSummaries = invoices.map(inv => pdfGenerator.generateInvoiceTextSummary(inv));

    res.type('text/plain').send(textSummaries.join('\n\n\n'));
  } catch (err: any) {
    res.status(500).send(`Failed to generate invoice summary: ${err.message}`);
  }
});
