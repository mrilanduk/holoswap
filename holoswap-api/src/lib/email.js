const nodemailer = require('nodemailer');

const transporter = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    })
  : null;

async function sendSubmissionEmail(vendorEmail, submission, items) {
  if (!transporter) {
    console.log('[Email] SMTP not configured — skipping email');
    return;
  }
  if (!vendorEmail) {
    console.log('[Email] No vendor email set — skipping');
    return;
  }

  const conditionColors = {
    NM: '#16a34a',
    LP: '#2563eb',
    MP: '#d97706',
    HP: '#dc2626',
  };

  const itemCards = items.map(item => {
    const condition = item.condition || 'NM';
    const condColor = conditionColors[condition] || '#888';
    const market = item.market_price ? `£${parseFloat(item.market_price).toFixed(2)}` : 'N/A';
    const asking = item.asking_price ? `£${parseFloat(item.asking_price).toFixed(2)}` : 'N/A';
    const imgHtml = item.image_url
      ? `<img src="${item.image_url}" alt="${item.card_name || ''}" style="width:64px;height:90px;object-fit:contain;border-radius:6px;flex-shrink:0;" />`
      : `<div style="width:64px;height:90px;background:#f0f0f0;border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:#ccc;font-size:1.5rem;">?</div>`;

    return `
      <tr>
        <td style="padding:10px 0;border-bottom:1px solid #f0f0f0;">
          <div style="display:flex;align-items:center;gap:12px;">
            ${imgHtml}
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:0.95rem;color:#1a1a1a;margin-bottom:2px;">${item.card_name || 'Unknown'}</div>
              <div style="font-size:0.8rem;color:#888;margin-bottom:6px;">${item.set_name || ''} #${item.card_number || ''}</div>
              <div style="display:inline-block;background:${condColor};color:#fff;font-size:0.7rem;font-weight:700;padding:2px 8px;border-radius:10px;letter-spacing:0.5px;">${condition}</div>
            </div>
            <div style="text-align:right;flex-shrink:0;">
              <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Market</div>
              <div style="font-size:0.9rem;color:#555;margin-bottom:8px;">${market}</div>
              <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Asking</div>
              <div style="font-size:1.05rem;font-weight:700;color:#1a1a1a;">${asking}</div>
            </div>
          </div>
        </td>
      </tr>`;
  }).join('');

  const totalAsking = items.reduce((sum, i) => sum + (parseFloat(i.asking_price) || 0), 0);
  const totalMarket = items.reduce((sum, i) => sum + (parseFloat(i.market_price) || 0), 0);

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f0f2f5;-webkit-font-smoothing:antialiased;">
  <div style="max-width:600px;margin:0 auto;padding:16px;">

    <!-- Header -->
    <div style="background:linear-gradient(135deg,#e53e3e 0%,#c53030 100%);border-radius:16px 16px 0 0;padding:28px 28px 24px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:40px;height:40px;background:rgba(255,255,255,0.2);border-radius:10px;display:flex;align-items:center;justify-content:center;">
          <span style="font-size:1.4rem;">&#9878;</span>
        </div>
        <div>
          <h1 style="margin:0;color:#fff;font-size:1.3rem;font-weight:700;">New Trade-In Submission</h1>
          <p style="margin:2px 0 0;color:rgba(255,255,255,0.8);font-size:0.85rem;">TrainerMart Trade</p>
        </div>
      </div>
      <div style="background:rgba(255,255,255,0.15);border-radius:10px;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;">
        <div>
          <div style="font-size:0.7rem;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Reference</div>
          <div style="font-size:0.95rem;color:#fff;font-weight:600;font-family:monospace;">${submission.submission_id}</div>
        </div>
        <div style="text-align:right;">
          <div style="font-size:0.7rem;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px;">Cards</div>
          <div style="font-size:1.4rem;color:#fff;font-weight:700;">${items.length}</div>
        </div>
      </div>
    </div>

    <!-- Body -->
    <div style="background:#fff;padding:0 28px;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;">

      <!-- Seller info -->
      <div style="padding:24px 0;border-bottom:1px solid #f0f0f0;">
        <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:12px;">Seller Details</div>
        <div style="display:flex;gap:24px;flex-wrap:wrap;">
          <div>
            <div style="font-size:0.75rem;color:#999;margin-bottom:2px;">Name</div>
            <div style="font-size:1rem;font-weight:600;color:#1a1a1a;">${submission.seller_name}</div>
          </div>
          ${submission.seller_email ? `
          <div>
            <div style="font-size:0.75rem;color:#999;margin-bottom:2px;">Email</div>
            <div style="font-size:0.95rem;color:#1a1a1a;"><a href="mailto:${submission.seller_email}" style="color:#e53e3e;text-decoration:none;">${submission.seller_email}</a></div>
          </div>` : ''}
          ${submission.seller_phone ? `
          <div>
            <div style="font-size:0.75rem;color:#999;margin-bottom:2px;">Phone</div>
            <div style="font-size:0.95rem;color:#1a1a1a;"><a href="tel:${submission.seller_phone}" style="color:#e53e3e;text-decoration:none;">${submission.seller_phone}</a></div>
          </div>` : ''}
        </div>
      </div>

      <!-- Cards -->
      <div style="padding:24px 0 8px;">
        <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:16px;">Cards Submitted</div>
        <table style="width:100%;border-collapse:collapse;">
          <tbody>
            ${itemCards}
          </tbody>
        </table>
      </div>

      <!-- Totals -->
      <div style="padding:20px 0 28px;">
        <div style="background:#fafafa;border-radius:12px;padding:16px 20px;display:flex;justify-content:space-between;align-items:center;">
          <div>
            <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Market Value</div>
            <div style="font-size:1.1rem;color:#555;">£${totalMarket.toFixed(2)}</div>
          </div>
          <div style="text-align:right;">
            <div style="font-size:0.7rem;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Asking</div>
            <div style="font-size:1.4rem;font-weight:700;color:#1a1a1a;">£${totalAsking.toFixed(2)}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div style="background:#fafafa;border-radius:0 0 16px 16px;padding:16px 28px;border:1px solid #e8e8e8;border-top:none;text-align:center;">
      <p style="margin:0;color:#bbb;font-size:0.75rem;">TrainerMart Trade &mdash; Automated submission notification</p>
    </div>

  </div>
</body>
</html>`;

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from: `"TrainerMart Trade" <${fromAddr}>`,
    to: vendorEmail,
    subject: `New Submission: ${items.length} card${items.length !== 1 ? 's' : ''} from ${submission.seller_name} (${submission.submission_id})`,
    html,
  });

  console.log(`[Email] Submission notification sent to ${vendorEmail} for ${submission.submission_id}`);
}

module.exports = { sendSubmissionEmail };
