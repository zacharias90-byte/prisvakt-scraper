const https = require("https");
const http = require("http");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

// ── KENDAR PRÍSIR (fallback) ──────────────────────
const KNOWN_PRICES = {
  Thomsen: { gassoil: "10.350", diesel: null,     bensin: null,     updatedAt: "26/03/2026" },
  Magn:    { gassoil: "12.313", diesel: "14.360",  bensin: "14.700", updatedAt: "31/03/2026" },
  Effo:    { gassoil: "12.313", diesel: "14.360",  bensin: "14.700", updatedAt: "01/04/2026" }
};

let cachedPrices = null;
let lastFetch = null;

// ── HTTP fetch helper ─────────────────────────────
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Prisvakt/1.0)",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*"
      },
      timeout: 12000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve(data));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── MAGN ─────────────────────────────────────────
// Magn uses Webflow CMS - prices are in the HTML as text
async function scrapeMagn() {
  try {
    const html = await fetchUrl("https://www.magn.fo/oljuprisir");

    // Extract latest date block - look for price patterns in HTML
    // Magn shows prices like "14.700" and "14.360" as numbers in the page

    // Find all price-like numbers in the page (format: XX.XXX)
    const pricePattern = /\b(\d{1,2}\.\d{3})\b/g;
    const datePattern = /(\d{1,2})\s*\.\s*(March|April|May|June|July|August|September|October|November|December|January|February)\s*(\d{4})/i;

    // Find date
    const dateMatch = html.match(datePattern);
    let updatedAt = "";
    if (dateMatch) {
      updatedAt = dateMatch[1] + ". " + dateMatch[2] + " " + dateMatch[3];
    }

    // Find bensin, diesel, gassolja sections
    // Look for the first occurrence of each near price indicators
    let bensin = null, diesel = null, gassoil = null;

    // Bensin section - find "Bensin" followed by price
    const bensinMatch = html.match(/Bensin[\s\S]{0,500}?\b(1[0-9]\.\d{3})\b/);
    if (bensinMatch) bensin = bensinMatch[1];

    // Diesel section
    const dieselMatch = html.match(/Diesel[\s\S]{0,300}?\b(1[0-9]\.\d{3})\b/);
    if (dieselMatch) diesel = dieselMatch[1];

    // Gassolja - pr 1000 litrar, so value like 12.313
    const gasMatch = html.match(/Gassolja[\s\S]{0,500}?\b(1[0-2]\.\d{3})\b/);
    if (gasMatch) gassoil = gasMatch[1];

    // Validate
    const g = parseFloat(gassoil);
    const d = parseFloat(diesel);
    const b = parseFloat(bensin);

    if (g > 5 && g < 25 && d > 5 && b > 5) {
      console.log("Magn OK:", gassoil, diesel, bensin, updatedAt);
      return { source: "Magn", gassoil, diesel, bensin, updatedAt };
    }
    throw new Error("Prices out of range: " + gassoil + "/" + diesel + "/" + bensin);
  } catch (e) {
    console.log("Magn feilst:", e.message, "— nýti kendar prísir");
    return { source: "Magn", ...KNOWN_PRICES.Magn };
  }
}

// ── EFFO ─────────────────────────────────────────
async function scrapeEffo() {
  try {
    const html = await fetchUrl("https://www.effo.fo/prisir/");

    // Effo shows prices in a table with dates as h5 headers
    // Look for the latest date section and extract prices

    // Find date (format: "1. apríl 2026" or "1. April 2026")
    const datePattern = /(\d{1,2})\.\s+(april|mars|februar|januar|mai|juni|juli|august|september|oktober|november|desember|January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i;
    const dateMatch = html.match(datePattern);
    let updatedAt = "";
    if (dateMatch) {
      updatedAt = dateMatch[1] + "/" + (dateMatch[3]);
    }

    // Extract from table - look for KR. values after known fuel types
    // Pattern: "Blýfrítt | 14,70 KR." or similar
    let bensin = null, diesel = null, gassoil = null;

    // Blýfrítt (bensin)
    const bensinMatch = html.match(/Blýfrítt[\s\S]{0,200}?(1[0-9][,\.]\d{2,3})\s*KR/i);
    if (bensinMatch) bensin = bensinMatch[1].replace(",", ".");

    // Diesel
    const dieselMatch = html.match(/(?<!\w)Diesel[\s\S]{0,200}?(1[0-9][,\.]\d{2,3})\s*KR/i);
    if (dieselMatch) diesel = dieselMatch[1].replace(",", ".");

    // Gassolja - pr 1000 litrar
    const gasMatch = html.match(/Gassolja[\s\S]{0,300}?(1[0-2][,\.]\d{3})\s*KR/i);
    if (gasMatch) {
      const raw = parseFloat(gasMatch[1].replace(",", "."));
      gassoil = raw > 100 ? (raw / 1000).toFixed(3) : raw.toFixed(3);
    }

    // Also try simpler pattern for gassolja
    if (!gassoil) {
      const gasMatch2 = html.match(/12[,\.](\d{3})\s*KR/i);
      if (gasMatch2) gassoil = "12." + gasMatch2[1];
    }

    const g = parseFloat(gassoil);
    const d = parseFloat(diesel);
    const b = parseFloat(bensin);

    if (g > 5 && g < 25 && d > 5 && b > 5) {
      console.log("Effo OK:", gassoil, diesel, bensin, updatedAt);
      return { source: "Effo", gassoil, diesel, bensin, updatedAt };
    }
    throw new Error("Prices out of range: " + gassoil + "/" + diesel + "/" + bensin);
  } catch (e) {
    console.log("Effo feilst:", e.message, "— nýti kendar prísir");
    return { source: "Effo", ...KNOWN_PRICES.Effo };
  }
}

// ── THOMSEN ───────────────────────────────────────
async function scrapeThomsen() {
  try {
    const html = await fetchUrl("https://thomsen.fo/oljuprisur");

    // Look for price pattern
    const priceMatch = html.match(/DAGSPRÍSUR\s+([\d,\.]+)\s*kr/i) ||
                       html.match(/([\d,\.]+)\s*kr\.?\s*(?:pr\.?\s*litr|\/L)/i) ||
                       html.match(/\b(7|8|9|10|11)\.\d{2,3}\b/);

    const dateMatch = html.match(/(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{4})/);

    if (priceMatch) {
      const val = parseFloat(priceMatch[1].replace(",", "."));
      if (val > 5 && val < 20) {
        const updatedAt = dateMatch ? dateMatch[1] : "";
        console.log("Thomsen OK:", val.toFixed(3));
        return { source: "Thomsen", gassoil: val.toFixed(3), diesel: null, bensin: null, updatedAt };
      }
    }
    throw new Error("Fann ikki prís");
  } catch (e) {
    console.log("Thomsen feilst:", e.message, "— nýti kendar prísir");
    return { source: "Thomsen", ...KNOWN_PRICES.Thomsen };
  }
}

// ── FETCH ALL PRICES ──────────────────────────────
async function fetchAllPrices() {
  console.log("Sækji prísir...", new Date().toISOString());
  try {
    const [thomsen, magn, effo] = await Promise.all([
      scrapeThomsen(),
      scrapeMagn(),
      scrapeEffo()
    ]);
    const result = {
      fetchedAt: new Date().toISOString(),
      sources: [thomsen, magn, effo]
    };
    cachedPrices = result;
    lastFetch = new Date();
    console.log("Prísir sóttir:", JSON.stringify(result));
    return result;
  } catch (e) {
    console.error("Feil við at sækja prísir:", e.message);
    return {
      fetchedAt: new Date().toISOString(),
      sources: [
        { source: "Thomsen", ...KNOWN_PRICES.Thomsen },
        { source: "Magn",    ...KNOWN_PRICES.Magn    },
        { source: "Effo",    ...KNOWN_PRICES.Effo    }
      ]
    };
  }
}

// ── API ENDPOINT ──────────────────────────────────
app.get("/api/fuel-prices", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  // Return cached if less than 30 min old
  if (cachedPrices && lastFetch && (Date.now() - lastFetch) < 30 * 60 * 1000) {
    return res.json(cachedPrices);
  }

  const prices = await fetchAllPrices();
  res.json(prices);
});

app.get("/health", (req, res) => res.json({ ok: true, lastFetch }));

// ── START ─────────────────────────────────────────
app.listen(PORT, async () => {
  console.log("Server koyrir á port", PORT);
  // Fetch immediately on start
  await fetchAllPrices();
  // Then every 3 hours
  setInterval(fetchAllPrices, 3 * 60 * 60 * 1000);
});
