const { Router } = require('express');
const pool = require('../db');
const auth = require('../middleware/auth');

const router = Router();

const ROYAL_MAIL_API = 'https://api.parcel.royalmail.com/api/v1';
const ROYAL_MAIL_KEY = process.env.ROYAL_MAIL_API_KEY || 'a9d519f6-c9eb-4a44-a7d9-8a2bc7da016b';

// Middleware: check if user is admin
async function requireAdmin(req, res, next) {
  try {
    const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [req.user.id]);
    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}

// POST /api/shipping/create-order — create Royal Mail order for a trade
router.post('/create-order', auth, requireAdmin, async (req, res) => {
  try {
    const { trade_id, service_code, weight } = req.body;

    // Get trade with buyer address
    const trade = await pool.query(
      `SELECT t.*,
        buyer.display_name as buyer_name, buyer.email as buyer_email,
        buyer.address_line1, buyer.address_line2, buyer.city as buyer_city,
        buyer.county as buyer_county, buyer.postcode as buyer_postcode,
        buyer.country as buyer_country,
        c.card_name, c.card_set, c.card_number
       FROM trades t
       JOIN users buyer ON t.buyer_id = buyer.id
       JOIN cards c ON t.card_id = c.id
       WHERE t.id = $1`,
      [trade_id]
    );

    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    const t = trade.rows[0];

    if (!t.address_line1 || !t.buyer_city || !t.buyer_postcode) {
      return res.status(400).json({ error: 'Buyer has no delivery address' });
    }

    // Build Royal Mail order
    const orderData = {
      items: [{
        orderReference: `HS-${t.id}`,
        recipient: {
          address: {
            fullName: t.buyer_name || 'Pokemon Trainer',
            addressLine1: t.address_line1,
            addressLine2: t.address_line2 || '',
            city: t.buyer_city,
            county: t.buyer_county || '',
            postcode: t.buyer_postcode,
            countryCode: 'GB',
          },
          emailAddress: t.buyer_email || '',
        },
        billing: {
          address: {
            fullName: t.buyer_name || 'Pokemon Trainer',
            addressLine1: t.address_line1,
            city: t.buyer_city,
            postcode: t.buyer_postcode,
            countryCode: 'GB',
          },
        },
        packages: [{
          weightInGrams: weight || 100,
          packageFormatIdentifier: 'letter',
          dimensions: {
            heightInMms: 5,
            widthInMms: 100,
            depthInMms: 150,
          },
          contents: [{
            name: `${t.card_name} - ${t.card_set} #${t.card_number}`,
            quantity: 1,
            unitValue: parseFloat(t.price) || 5.00,
            unitWeightInGrams: weight || 100,
          }],
        }],
        orderDate: new Date().toISOString(),
        subtotal: parseFloat(t.price) || 5.00,
        shippingCostCharged: 0,
        total: parseFloat(t.price) || 5.00,
        currencyCode: 'GBP',
        label: {
          includeLabelInResponse: true,
        },
      }],
    };

    // If a specific service is requested
    if (service_code) {
      orderData.items[0].packages[0].serviceCode = service_code;
    }

    const response = await fetch(`${ROYAL_MAIL_API}/orders`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ROYAL_MAIL_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderData),
    });

    const result = await response.json();

    if (!response.ok) {
      console.error('Royal Mail error:', JSON.stringify(result));
      return res.status(400).json({ error: 'Royal Mail API error', details: result });
    }

    // Extract order info
    const createdOrder = result.createdOrders?.[0];
    const rmOrderId = createdOrder?.orderIdentifier;
    const trackingNumber = createdOrder?.trackingNumber || null;
    const label = createdOrder?.label || null;

    // Store Royal Mail order ID and tracking on the trade
    await pool.query(
      `UPDATE trades SET
        outbound_tracking = COALESCE($1, outbound_tracking),
        notes = COALESCE(notes, '') || $2,
        updated_at = NOW()
       WHERE id = $3`,
      [
        trackingNumber,
        ` | RM Order: ${rmOrderId || 'pending'}`,
        trade_id,
      ]
    );

    res.json({
      message: 'Royal Mail order created',
      orderIdentifier: rmOrderId,
      trackingNumber,
      label,
      fullResponse: result,
    });
  } catch (err) {
    console.error('Create shipping order error:', err);
    res.status(500).json({ error: 'Failed to create shipping order' });
  }
});

// GET /api/shipping/label/:orderIdentifier — download label PDF
router.get('/label/:orderIdentifier', auth, requireAdmin, async (req, res) => {
  try {
    const response = await fetch(
      `${ROYAL_MAIL_API}/orders/${req.params.orderIdentifier}/label?documentType=postageLabel&includeReturnsLabel=false&includeCN=false`,
      {
        headers: {
          'Authorization': `Bearer ${ROYAL_MAIL_KEY}`,
        },
      }
    );

    if (!response.ok) {
      const err = await response.json();
      return res.status(400).json({ error: 'Failed to get label', details: err });
    }

    const pdfBuffer = await response.arrayBuffer();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=label-${req.params.orderIdentifier}.pdf`);
    res.send(Buffer.from(pdfBuffer));
  } catch (err) {
    console.error('Get label error:', err);
    res.status(500).json({ error: 'Failed to get label' });
  }
});

// GET /api/shipping/tracking/:trackingNumber — get tracking info
router.get('/tracking/:trackingNumber', auth, async (req, res) => {
  try {
    // Royal Mail tracking URL for users
    const trackingUrl = `https://www.royalmail.com/track-your-item#/tracking-results/${req.params.trackingNumber}`;

    // We could also hit the Royal Mail Tracking API v2 here if we have access
    // For now, return the tracking URL
    res.json({
      trackingNumber: req.params.trackingNumber,
      trackingUrl,
    });
  } catch (err) {
    console.error('Tracking error:', err);
    res.status(500).json({ error: 'Failed to get tracking info' });
  }
});

// GET /api/shipping/orders/:tradeId — get Royal Mail order status
router.get('/orders/:tradeId', auth, requireAdmin, async (req, res) => {
  try {
    const trade = await pool.query(
      `SELECT notes FROM trades WHERE id = $1`,
      [req.params.tradeId]
    );

    if (trade.rows.length === 0) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    // Extract RM order ID from notes
    const notes = trade.rows[0].notes || '';
    const match = notes.match(/RM Order: (\d+)/);

    if (!match) {
      return res.status(404).json({ error: 'No Royal Mail order found for this trade' });
    }

    const rmOrderId = match[1];

    const response = await fetch(`${ROYAL_MAIL_API}/orders/${rmOrderId}`, {
      headers: {
        'Authorization': `Bearer ${ROYAL_MAIL_KEY}`,
      },
    });

    const result = await response.json();
    res.json(result);
  } catch (err) {
    console.error('Get RM order error:', err);
    res.status(500).json({ error: 'Failed to get order status' });
  }
});

module.exports = router;
