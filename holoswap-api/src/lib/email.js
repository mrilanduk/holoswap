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
    const offered = item.asking_price ? `£${parseFloat(item.asking_price).toFixed(2)}` : 'N/A';
    const imgCell = item.image_url
      ? `<td style="padding:12px 12px 12px 0;border-bottom:1px solid #f0f0f0;width:64px;vertical-align:top;">
           <img src="${item.image_url}" alt="${item.card_name || ''}" width="64" style="display:block;border-radius:6px;" />
         </td>`
      : `<td style="padding:12px 12px 12px 0;border-bottom:1px solid #f0f0f0;width:64px;vertical-align:top;">
           <div style="width:64px;height:90px;background:#f0f0f0;border-radius:6px;">&nbsp;</div>
         </td>`;

    return `
      <tr>
        ${imgCell}
        <td style="padding:12px 0;border-bottom:1px solid #f0f0f0;vertical-align:top;">
          <div style="font-weight:700;font-size:15px;color:#1a1a1a;margin-bottom:2px;">${item.card_name || 'Unknown'}</div>
          <div style="font-size:13px;color:#888;margin-bottom:6px;">${item.set_name || ''} #${item.card_number || ''}</div>
          <table cellpadding="0" cellspacing="0" border="0"><tr><td style="background:${condColor};color:#fff;font-size:11px;font-weight:700;padding:2px 8px;border-radius:10px;line-height:18px;">${condition}</td></tr></table>
        </td>
        <td style="padding:12px 0 12px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;text-align:right;width:80px;">
          <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Offered</div>
          <div style="font-size:17px;font-weight:700;color:#1a1a1a;">${offered}</div>
        </td>
      </tr>`;
  }).join('');

  const totalOffered = items.reduce((sum, i) => sum + (parseFloat(i.asking_price) || 0), 0);

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
          <td style="background:#e53e3e;border-radius:16px 16px 0 0;padding:28px;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              <tr>
                <td>
                  <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">New Trade-In Submission</h1>
                  <p style="margin:4px 0 0;color:rgba(255,255,255,0.8);font-size:14px;">TrainerMart Trade</p>
                </td>
              </tr>
              <tr>
                <td style="padding-top:16px;">
                  <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:rgba(255,255,255,0.15);border-radius:10px;">
                    <tr>
                      <td style="padding:14px 16px;">
                        <div style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.5px;">Reference</div>
                        <div style="font-size:15px;color:#fff;font-weight:600;font-family:monospace;margin-top:2px;">${submission.submission_id}</div>
                      </td>
                      <td style="padding:14px 16px;text-align:right;">
                        <div style="font-size:11px;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.5px;">Cards</div>
                        <div style="font-size:24px;color:#fff;font-weight:700;margin-top:2px;">${items.length}</div>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Seller info -->
        <tr>
          <td style="background:#fff;padding:24px 28px;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;border-bottom:1px solid #f0f0f0;">
            <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:12px;">Seller Details</div>
            <table cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td style="padding-right:32px;vertical-align:top;">
                  <div style="font-size:12px;color:#999;margin-bottom:2px;">Name</div>
                  <div style="font-size:16px;font-weight:600;color:#1a1a1a;">${submission.seller_name}</div>
                </td>
                ${submission.seller_email ? `
                <td style="padding-right:32px;vertical-align:top;">
                  <div style="font-size:12px;color:#999;margin-bottom:2px;">Email</div>
                  <div style="font-size:15px;"><a href="mailto:${submission.seller_email}" style="color:#e53e3e;text-decoration:none;">${submission.seller_email}</a></div>
                </td>` : ''}
                ${submission.seller_phone ? `
                <td style="vertical-align:top;">
                  <div style="font-size:12px;color:#999;margin-bottom:2px;">Phone</div>
                  <div style="font-size:15px;"><a href="tel:${submission.seller_phone}" style="color:#e53e3e;text-decoration:none;">${submission.seller_phone}</a></div>
                </td>` : ''}
              </tr>
            </table>
          </td>
        </tr>

        <!-- Cards -->
        <tr>
          <td style="background:#fff;padding:24px 28px 8px;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;">
            <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:16px;">Cards Submitted</div>
            <table cellpadding="0" cellspacing="0" border="0" width="100%">
              ${itemCards}
            </table>
          </td>
        </tr>

        <!-- Total -->
        <tr>
          <td style="background:#fff;padding:20px 28px 28px;border-left:1px solid #e8e8e8;border-right:1px solid #e8e8e8;">
            <table cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafafa;border-radius:12px;">
              <tr>
                <td style="padding:16px 20px;">
                  <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Total Offered</div>
                  <div style="font-size:24px;font-weight:700;color:#1a1a1a;">£${totalOffered.toFixed(2)}</div>
                </td>
                <td style="padding:16px 20px;text-align:right;">
                  <div style="font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Items</div>
                  <div style="font-size:24px;font-weight:700;color:#1a1a1a;">${items.length}</div>
                </td>
              </tr>
            </table>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="background:#fafafa;border-radius:0 0 16px 16px;padding:16px 28px;border:1px solid #e8e8e8;border-top:none;text-align:center;">
            <p style="margin:0;color:#bbb;font-size:12px;">TrainerMart Trade &mdash; Automated submission notification</p>
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
    subject: `New Submission: ${items.length} card${items.length !== 1 ? 's' : ''} from ${submission.seller_name} (${submission.submission_id})`,
    html,
  });

  console.log(`[Email] Submission notification sent to ${vendorEmail} for ${submission.submission_id}`);
}

module.exports = { sendSubmissionEmail };
