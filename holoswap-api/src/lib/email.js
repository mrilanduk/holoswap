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

  const itemRows = items.map(item => {
    const condition = item.condition || 'NM';
    const condColor = conditionColors[condition] || '#888';
    const market = item.market_price ? parseFloat(item.market_price) : 0;
    const offered = item.asking_price ? parseFloat(item.asking_price) : 0;
    const profit = market - offered;
    const marketStr = market ? `£${market.toFixed(2)}` : 'N/A';
    const offeredStr = offered ? `£${offered.toFixed(2)}` : 'N/A';
    const profitStr = (market && offered) ? `£${profit.toFixed(2)}` : '-';
    const profitColor = profit >= 0 ? '#16a34a' : '#dc2626';

    return `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;vertical-align:top;">
          <div style="font-weight:700;font-size:14px;color:#1a1a1a;margin-bottom:2px;">${item.card_name || 'Unknown'}</div>
          <div style="font-size:12px;color:#888;">${item.set_name || ''} #${item.card_number || ''}</div>
        </td>
        <td style="padding:10px 6px;border-bottom:1px solid #eee;vertical-align:top;text-align:center;width:40px;">
          <table cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;"><tr><td style="background:${condColor};color:#fff;font-size:10px;font-weight:700;padding:2px 7px;border-radius:10px;line-height:16px;">${condition}</td></tr></table>
        </td>
        <td style="padding:10px 6px;border-bottom:1px solid #eee;vertical-align:top;text-align:right;width:70px;">
          <div style="font-size:13px;color:#555;">${marketStr}</div>
        </td>
        <td style="padding:10px 6px;border-bottom:1px solid #eee;vertical-align:top;text-align:right;width:70px;">
          <div style="font-size:13px;font-weight:700;color:#1a1a1a;">${offeredStr}</div>
        </td>
        <td style="padding:10px 8px 10px 6px;border-bottom:1px solid #eee;vertical-align:top;text-align:right;width:65px;">
          <div style="font-size:13px;font-weight:600;color:${profitColor};">${profitStr}</div>
        </td>
      </tr>`;
  }).join('');

  const totalMarket = items.reduce((sum, i) => sum + (parseFloat(i.market_price) || 0), 0);
  const totalOffered = items.reduce((sum, i) => sum + (parseFloat(i.asking_price) || 0), 0);
  const totalProfit = totalMarket - totalOffered;

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
</head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f0f2f5;-webkit-font-smoothing:antialiased;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0f2f5;">
    <tr><td align="center" style="padding:16px;">
      <table cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;">

        <!-- Header -->
        <tr>
          <td style="background:#444;border-radius:16px 16px 0 0;padding:24px 28px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td>
                  <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">New Trade-In Submission</h1>
                  <p style="margin:4px 0 0;color:rgba(255,255,255,0.6);font-size:13px;">TrainerMart Trade</p>
                </td>
                <td style="text-align:right;vertical-align:top;">
                  <div style="font-size:11px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.5px;">Ref</div>
                  <div style="font-size:13px;color:#fff;font-weight:600;font-family:monospace;margin-top:2px;">${submission.submission_id}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Seller info -->
        <tr>
          <td style="background:#fff;padding:20px 28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;border-bottom:1px solid #eee;">
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:28px;vertical-align:top;">
                  <div style="font-size:11px;color:#999;margin-bottom:2px;">Name</div>
                  <div style="font-size:15px;font-weight:600;color:#1a1a1a;">${submission.seller_name}</div>
                </td>
                ${submission.seller_email ? `
                <td style="padding-right:28px;vertical-align:top;">
                  <div style="font-size:11px;color:#999;margin-bottom:2px;">Email</div>
                  <div style="font-size:14px;"><a href="mailto:${submission.seller_email}" style="color:#333;text-decoration:none;">${submission.seller_email}</a></div>
                </td>` : ''}
                ${submission.seller_phone ? `
                <td style="vertical-align:top;">
                  <div style="font-size:11px;color:#999;margin-bottom:2px;">Phone</div>
                  <div style="font-size:14px;"><a href="tel:${submission.seller_phone}" style="color:#333;text-decoration:none;">${submission.seller_phone}</a></div>
                </td>` : ''}
              </tr>
            </table>
          </td>
        </tr>

        <!-- Cards table -->
        <tr>
          <td style="background:#fff;padding:20px 28px 0;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
            <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:12px;">${items.length} Card${items.length !== 1 ? 's' : ''} Submitted</div>
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr style="border-bottom:2px solid #ddd;">
                <th style="padding:6px 8px;text-align:left;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:2px solid #ddd;">Card</th>
                <th style="padding:6px;text-align:center;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:2px solid #ddd;">Cond</th>
                <th style="padding:6px;text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:2px solid #ddd;">Market</th>
                <th style="padding:6px;text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:2px solid #ddd;">Offered</th>
                <th style="padding:6px 8px 6px 6px;text-align:right;font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;border-bottom:2px solid #ddd;">Profit</th>
              </tr>
              ${itemRows}
            </table>
          </td>
        </tr>

        <!-- Totals -->
        <tr>
          <td style="background:#fff;padding:16px 28px 24px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f7f7f7;border-radius:10px;">
              <tr>
                <td style="padding:14px 16px;">
                  <div style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Market Total</div>
                  <div style="font-size:18px;color:#555;">£${totalMarket.toFixed(2)}</div>
                </td>
                <td style="padding:14px 16px;text-align:center;">
                  <div style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Offered</div>
                  <div style="font-size:18px;font-weight:700;color:#1a1a1a;">£${totalOffered.toFixed(2)}</div>
                </td>
                <td style="padding:14px 16px;text-align:right;">
                  <div style="font-size:10px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Profit</div>
                  <div style="font-size:18px;font-weight:700;color:${totalProfit >= 0 ? '#16a34a' : '#dc2626'};">£${totalProfit.toFixed(2)}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#444;border-radius:0 0 16px 16px;padding:14px 28px;text-align:center;">
            <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;">TrainerMart Trade &mdash; Automated submission notification</p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  await transporter.sendMail({
    from: `"TrainerMart Trade" <${fromAddr}>`,
    to: vendorEmail,
    replyTo: submission.seller_email || undefined,
    subject: `New Submission: ${items.length} card${items.length !== 1 ? 's' : ''} from ${submission.seller_name} (${submission.submission_id})`,
    html,
  });

  console.log(`[Email] Submission notification sent to ${vendorEmail} for ${submission.submission_id}`);
}

async function sendTestEmail(toAddress) {
  if (!transporter) {
    return { success: false, error: 'SMTP not configured — check SMTP_HOST in .env' };
  }

  const fromAddr = process.env.SMTP_FROM || process.env.SMTP_USER;

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;background:#f0f2f5;">
  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f0f2f5;">
    <tr><td align="center" style="padding:32px 16px;">
      <table cellpadding="0" cellspacing="0" border="0" width="480" style="max-width:480px;">
        <tr><td style="background:#444;border-radius:16px 16px 0 0;padding:24px 28px;">
          <h1 style="margin:0;color:#fff;font-size:20px;font-weight:700;">Test Email</h1>
          <p style="margin:4px 0 0;color:rgba(255,255,255,0.6);font-size:13px;">TrainerMart Trade</p>
        </td></tr>
        <tr><td style="background:#fff;padding:28px;border-left:1px solid #e0e0e0;border-right:1px solid #e0e0e0;">
          <p style="margin:0;font-size:15px;color:#1a1a1a;">If you're reading this, email delivery is working correctly.</p>
          <p style="margin:12px 0 0;font-size:13px;color:#888;">From: ${fromAddr}</p>
          <p style="margin:4px 0 0;font-size:13px;color:#888;">To: ${toAddress}</p>
          <p style="margin:4px 0 0;font-size:13px;color:#888;">Sent: ${new Date().toLocaleString('en-GB')}</p>
        </td></tr>
        <tr><td style="background:#444;border-radius:0 0 16px 16px;padding:14px 28px;text-align:center;">
          <p style="margin:0;color:rgba(255,255,255,0.5);font-size:11px;">TrainerMart Trade &mdash; Test email</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const info = await transporter.sendMail({
      from: `"TrainerMart Trade" <${fromAddr}>`,
      to: toAddress,
      subject: 'TrainerMart Trade — Test Email',
      html,
    });
    console.log(`[Email] Test email sent to ${toAddress}`, info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (err) {
    console.error(`[Email] Test email failed:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendSubmissionEmail, sendTestEmail };
