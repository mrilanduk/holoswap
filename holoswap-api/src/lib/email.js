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

  const itemRows = items.map(item => {
    const condition = item.condition || 'NM';
    const market = item.market_price ? `£${parseFloat(item.market_price).toFixed(2)}` : 'N/A';
    const asking = item.asking_price ? `£${parseFloat(item.asking_price).toFixed(2)}` : 'N/A';
    return `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;">
          <strong>${item.card_name || 'Unknown'}</strong><br/>
          <span style="color:#888;font-size:0.85em;">${item.set_name || ''} #${item.card_number || ''}</span>
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:center;">${condition}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${market}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #eee;text-align:right;">${asking}</td>
      </tr>`;
  }).join('');

  const totalAsking = items.reduce((sum, i) => sum + (parseFloat(i.asking_price) || 0), 0);
  const totalMarket = items.reduce((sum, i) => sum + (parseFloat(i.market_price) || 0), 0);

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;background:#f4f4f7;">
  <div style="max-width:600px;margin:0 auto;padding:20px;">
    <div style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <div style="background:#e53e3e;padding:24px 28px;">
        <h1 style="margin:0;color:#fff;font-size:1.4rem;">New Trade-In Submission</h1>
        <p style="margin:4px 0 0;color:rgba(255,255,255,0.85);font-size:0.9rem;">Ref: ${submission.submission_id}</p>
      </div>

      <div style="padding:24px 28px;">
        <h3 style="margin:0 0 12px;color:#333;">Seller Details</h3>
        <table style="width:100%;margin-bottom:24px;">
          <tr>
            <td style="padding:4px 0;color:#888;width:100px;">Name</td>
            <td style="padding:4px 0;font-weight:600;">${submission.seller_name}</td>
          </tr>
          ${submission.seller_email ? `<tr><td style="padding:4px 0;color:#888;">Email</td><td style="padding:4px 0;">${submission.seller_email}</td></tr>` : ''}
          ${submission.seller_phone ? `<tr><td style="padding:4px 0;color:#888;">Phone</td><td style="padding:4px 0;">${submission.seller_phone}</td></tr>` : ''}
        </table>

        <h3 style="margin:0 0 12px;color:#333;">Cards (${items.length})</h3>
        <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
          <thead>
            <tr style="background:#f8f8f8;">
              <th style="padding:8px 12px;text-align:left;font-size:0.8rem;color:#888;text-transform:uppercase;">Card</th>
              <th style="padding:8px 12px;text-align:center;font-size:0.8rem;color:#888;text-transform:uppercase;">Cond</th>
              <th style="padding:8px 12px;text-align:right;font-size:0.8rem;color:#888;text-transform:uppercase;">Market</th>
              <th style="padding:8px 12px;text-align:right;font-size:0.8rem;color:#888;text-transform:uppercase;">Asking</th>
            </tr>
          </thead>
          <tbody>
            ${itemRows}
          </tbody>
          <tfoot>
            <tr style="font-weight:700;">
              <td style="padding:12px;border-top:2px solid #ddd;" colspan="2">Total</td>
              <td style="padding:12px;border-top:2px solid #ddd;text-align:right;">£${totalMarket.toFixed(2)}</td>
              <td style="padding:12px;border-top:2px solid #ddd;text-align:right;">£${totalAsking.toFixed(2)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div style="padding:16px 28px;background:#f8f8f8;border-top:1px solid #eee;text-align:center;">
        <p style="margin:0;color:#aaa;font-size:0.8rem;">TrainerMart Trade — Automated notification</p>
      </div>
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
