const https = require('https');
const http = require('http');
const { URL } = require('url');

function postJSON(webhookUrl, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(webhookUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const data = JSON.stringify(body);

    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(buf);
        else reject(new Error(`Discord returned ${res.statusCode}: ${buf}`));
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function sendSubmissionDiscord(webhookUrl, submission, items) {
  if (!webhookUrl) {
    console.log('[Discord] No webhook URL — skipping');
    return;
  }

  const conditionEmoji = { NM: '🟢', LP: '🔵', MP: '🟡', HP: '🔴' };

  const totalMarket = items.reduce((s, i) => s + (parseFloat(i.market_price) || 0), 0);
  const totalOffered = items.reduce((s, i) => s + (parseFloat(i.asking_price) || 0), 0);
  const totalProfit = totalMarket - totalOffered;

  const cardLines = items.map(item => {
    const cond = item.condition || 'NM';
    const emoji = conditionEmoji[cond] || '⚪';
    const market = item.market_price ? `£${parseFloat(item.market_price).toFixed(2)}` : 'N/A';
    const offered = item.asking_price ? `£${parseFloat(item.asking_price).toFixed(2)}` : 'N/A';
    return `${emoji} **${item.card_name || 'Unknown'}** (${item.set_name || ''} #${item.card_number || ''}) — ${cond}\n　Market: ${market} · Offered: ${offered}`;
  });

  // Discord embeds have a 4096 char description limit — truncate if needed
  let description = cardLines.join('\n');
  if (description.length > 3800) {
    const shown = [];
    let len = 0;
    for (const line of cardLines) {
      if (len + line.length > 3600) break;
      shown.push(line);
      len += line.length + 1;
    }
    description = shown.join('\n') + `\n\n*...and ${cardLines.length - shown.length} more card(s)*`;
  }

  const contactParts = [];
  if (submission.seller_email) contactParts.push(`📧 ${submission.seller_email}`);
  if (submission.seller_phone) contactParts.push(`📱 ${submission.seller_phone}`);

  const embed = {
    title: `New Trade-In: ${items.length} card${items.length !== 1 ? 's' : ''} from ${submission.seller_name}`,
    description,
    color: 0x444444,
    fields: [
      { name: 'Contact', value: contactParts.join(' · ') || 'Not provided', inline: false },
      { name: 'Market Total', value: `£${totalMarket.toFixed(2)}`, inline: true },
      { name: 'Offered Total', value: `£${totalOffered.toFixed(2)}`, inline: true },
      { name: 'Profit', value: `£${totalProfit.toFixed(2)}`, inline: true },
    ],
    footer: { text: `Ref: ${submission.submission_id}` },
    timestamp: new Date().toISOString(),
  };

  await postJSON(webhookUrl, { embeds: [embed] });
  console.log(`[Discord] Submission notification sent for ${submission.submission_id}`);
}

async function sendTestDiscord(webhookUrl) {
  if (!webhookUrl) {
    return { success: false, error: 'No Discord webhook URL set' };
  }
  try {
    await postJSON(webhookUrl, {
      embeds: [{
        title: 'Test Notification',
        description: 'If you can see this, Discord notifications are working correctly.',
        color: 0x444444,
        footer: { text: 'TrainerMart Trade' },
        timestamp: new Date().toISOString(),
      }],
    });
    console.log(`[Discord] Test webhook sent`);
    return { success: true };
  } catch (err) {
    console.error(`[Discord] Test webhook failed:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { sendSubmissionDiscord, sendTestDiscord };
