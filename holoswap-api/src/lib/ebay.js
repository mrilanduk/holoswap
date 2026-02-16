// eBay Finding API integration for sold listings
const pool = require('../db');

// Fetch sold listings from eBay Finding API
async function fetchEbaySoldListings(cardName, setName, cardNumber) {
  const appId = process.env.EBAY_APP_ID;
  if (!appId) {
    console.error('[eBay] EBAY_APP_ID not configured');
    return [];
  }

  try {
    // Build search query
    const searchTerms = `${cardName} ${setName || ''} ${cardNumber || ''} pokemon`.trim();

    // eBay Finding API endpoint
    const url = new URL('https://svcs.ebay.com/services/search/FindingService/v1');
    url.searchParams.set('OPERATION-NAME', 'findCompletedItems');
    url.searchParams.set('SERVICE-VERSION', '1.0.0');
    url.searchParams.set('SECURITY-APPNAME', appId);
    url.searchParams.set('RESPONSE-DATA-FORMAT', 'JSON');
    url.searchParams.set('REST-PAYLOAD', '');
    url.searchParams.set('keywords', searchTerms);
    url.searchParams.set('categoryId', '183454'); // Pokemon TCG category
    url.searchParams.set('sortOrder', 'EndTimeSoonest');
    url.searchParams.set('paginationInput.entriesPerPage', '50');

    // Filters: sold items only, UK only
    url.searchParams.set('itemFilter(0).name', 'SoldItemsOnly');
    url.searchParams.set('itemFilter(0).value', 'true');
    url.searchParams.set('itemFilter(1).name', 'LocatedIn');
    url.searchParams.set('itemFilter(1).value', 'GB');

    const response = await fetch(url.toString());
    const data = await response.json();

    // Parse response
    const searchResult = data.findCompletedItemsResponse?.[0]?.searchResult?.[0];
    const items = searchResult?.item || [];

    if (items.length === 0) {
      console.log(`[eBay] No sold listings found for: ${searchTerms}`);
      return [];
    }

    // Transform to our format
    const listings = items.map(item => {
      const sellingStatus = item.sellingStatus?.[0];
      const listingInfo = item.listingInfo?.[0];

      return {
        ebay_item_id: item.itemId?.[0],
        title: item.title?.[0],
        sold_price: parseFloat(sellingStatus?.currentPrice?.[0]?.__value__ || 0),
        sold_date: listingInfo?.endTime?.[0],
        condition: item.condition?.[0]?.conditionDisplayName?.[0] || null,
        listing_url: item.viewItemURL?.[0],
      };
    }).filter(listing => listing.sold_price > 0 && listing.sold_date);

    console.log(`[eBay] Found ${listings.length} sold listings for: ${searchTerms}`);
    return listings;

  } catch (err) {
    console.error('[eBay] API error:', err.message);
    return [];
  }
}

// Save eBay listings to database
async function saveEbayListings(setId, cardNumber, cardName, listings) {
  if (!listings || listings.length === 0) return { saved: 0, duplicates: 0 };

  let saved = 0;
  let duplicates = 0;

  for (const listing of listings) {
    try {
      await pool.query(
        `INSERT INTO ebay_sold_listings
          (set_id, card_number, card_name, title, sold_price, sold_date, condition, listing_url, ebay_item_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (ebay_item_id) DO NOTHING`,
        [
          setId,
          cardNumber,
          cardName,
          listing.title,
          listing.sold_price,
          listing.sold_date,
          listing.condition,
          listing.listing_url,
          listing.ebay_item_id
        ]
      );
      saved++;
    } catch (err) {
      if (err.code === '23505') { // unique violation
        duplicates++;
      } else {
        console.error('[eBay] Save error:', err.message);
      }
    }
  }

  console.log(`[eBay] Saved ${saved} listings, ${duplicates} duplicates for ${cardName}`);
  return { saved, duplicates };
}

// Get eBay sold stats for a card
async function getEbaySoldStats(setId, cardNumber, cardName, days = 30) {
  try {
    const result = await pool.query(
      `SELECT
        COUNT(*) as sale_count,
        AVG(sold_price) as avg_price,
        MIN(sold_price) as min_price,
        MAX(sold_price) as max_price,
        MAX(sold_date) as last_sold
       FROM ebay_sold_listings
       WHERE (set_id = $1 OR set_id IS NULL)
         AND (card_number = $2 OR card_number IS NULL)
         AND LOWER(card_name) = LOWER($3)
         AND sold_date >= NOW() - $4::interval`,
      [setId, cardNumber, cardName, `${days} days`]
    );

    const stats = result.rows[0];
    return {
      count: parseInt(stats.sale_count) || 0,
      avg_price: parseFloat(stats.avg_price) || null,
      min_price: parseFloat(stats.min_price) || null,
      max_price: parseFloat(stats.max_price) || null,
      last_sold: stats.last_sold,
    };
  } catch (err) {
    console.error('[eBay] Stats error:', err.message);
    return { count: 0, avg_price: null, min_price: null, max_price: null, last_sold: null };
  }
}

// Fetch and save eBay data for a card
async function trackCardOnEbay(setId, cardNumber, cardName, setName) {
  const listings = await fetchEbaySoldListings(cardName, setName, cardNumber);
  const result = await saveEbayListings(setId, cardNumber, cardName, listings);
  return { ...result, total_found: listings.length };
}

module.exports = {
  fetchEbaySoldListings,
  saveEbayListings,
  getEbaySoldStats,
  trackCardOnEbay
};
