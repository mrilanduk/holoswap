const pool = require('../db');

// Lazy-init web-push (only if VAPID keys are configured)
let webPush = null;
function getWebPush() {
  if (webPush) return webPush;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  webPush = require('web-push');
  webPush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:alerts@holoswap.io',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  return webPush;
}

// Log notification delivery attempt
async function logNotification(userId, alertId, channel, title, body, status, errorMessage) {
  try {
    await pool.query(
      `INSERT INTO notification_log (user_id, alert_id, channel, title, body, status, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, alertId, channel, title, body, status, errorMessage || null]
    );
  } catch (err) {
    console.error('[Notifications] Failed to log:', err.message);
  }
}

// ─── Channel Dispatchers ─────────────────────────────────────

async function sendWebPush(subscription, title, body) {
  const wp = getWebPush();
  if (!wp) throw new Error('Web Push not configured (missing VAPID keys)');

  const payload = JSON.stringify({
    title,
    body,
    icon: '/logo192.png',
    url: '/price-watch'
  });

  await wp.sendNotification(subscription, payload);
}

async function sendTelegram(chatId, title, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('Telegram not configured (missing TELEGRAM_BOT_TOKEN)');

  const text = `*${title}*\n${body}`;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown'
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram API error: ${res.status} ${err}`);
  }
}

async function sendPushover(userKey, title, body) {
  const apiToken = process.env.PUSHOVER_API_TOKEN;
  if (!apiToken) throw new Error('Pushover not configured (missing PUSHOVER_API_TOKEN)');

  const res = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: apiToken,
      user: userKey,
      title,
      message: body
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Pushover API error: ${res.status} ${err}`);
  }
}

async function sendNtfy(topic, title, body) {
  const res = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      'Title': title,
      'Priority': 'default'
    },
    body
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`ntfy error: ${res.status} ${err}`);
  }
}

// ─── Main Dispatch ───────────────────────────────────────────

async function dispatchNotification(userId, alertId, { title, body }) {
  // Get user's notification settings
  const result = await pool.query(
    'SELECT * FROM notification_settings WHERE user_id = $1',
    [userId]
  );

  if (result.rows.length === 0) {
    console.log(`[Notifications] No settings for user ${userId}, skipping`);
    return;
  }

  const settings = result.rows[0];
  const channels = settings.channels_enabled || [];

  for (const channel of channels) {
    try {
      switch (channel) {
        case 'web_push':
          if (settings.web_push_sub) {
            const sub = typeof settings.web_push_sub === 'string'
              ? JSON.parse(settings.web_push_sub)
              : settings.web_push_sub;
            await sendWebPush(sub, title, body);
            await logNotification(userId, alertId, 'web_push', title, body, 'sent');
          }
          break;

        case 'telegram':
          if (settings.telegram_chat_id) {
            await sendTelegram(settings.telegram_chat_id, title, body);
            await logNotification(userId, alertId, 'telegram', title, body, 'sent');
          }
          break;

        case 'pushover':
          if (settings.pushover_user_key) {
            await sendPushover(settings.pushover_user_key, title, body);
            await logNotification(userId, alertId, 'pushover', title, body, 'sent');
          }
          break;

        case 'ntfy':
          if (settings.ntfy_topic) {
            await sendNtfy(settings.ntfy_topic, title, body);
            await logNotification(userId, alertId, 'ntfy', title, body, 'sent');
          }
          break;
      }
    } catch (err) {
      console.error(`[Notifications] ${channel} failed for user ${userId}:`, err.message);
      await logNotification(userId, alertId, channel, title, body, 'failed', err.message);
    }
  }
}

module.exports = { dispatchNotification, sendWebPush, sendTelegram, sendPushover, sendNtfy };
