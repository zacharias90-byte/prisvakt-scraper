    const https = require("https");
const http = require("http");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const KNOWN_PRICES = {
  Thomsen: { gassoil: "10.350", diesel: null,     bensin: null,     updatedAt: "08/04/2026" },
  Magn:    { gassoil: "12.313", diesel: "14.360",  bensin: "14.700", updatedAt: "08/04/2026" },
  Effo:    { gassoil: "12.000", diesel: "14.050",  bensin: "14.200", updatedAt: "08/04/2026" }
};

let cachedPrices = null;
let lastFetch = null;

function fetchUrl(url, extraHeaders) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120",
        "Accept": "text/html,application/xhtml+xml,application/json,*/*;q=0.9",
        "Accept-Language": "fo,da;q=0.9,en;q=0.8",
        ...extraHeaders
      },
      timeout: 20000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, extraHeaders).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
  });
}

// ── MAGN via Webflow CMS API ──────────────────────
async function scrapeMagn() {
  try {
    // Magn uses Webflow - try their CMS API endpoint
    const r = await fetchUrl("https://www.magn.fo/oljuprisir", {
      "Accept": "application/json, text/javascript, */*"
    });

    const html = r.body;

    // Magn Webflow renders via JS - but the CMS data is often in a script tag as JSON
    // Look for JSON data in script tags
    const scriptMatch = html.match(/window\.__WEBFLOW_DATA__|"oljuprisir"[\s\S]{0,2000}?"price"/i)
      || html.match(/"gassoil"\s*:\s*"?([\d.]+)"?/i)
      || html.match(/"diesel"\s*:\s*"?([\d.]+)"?/i);

    // Try to find prices embedded in page source as JSON
    const jsonMatches = html.match(/"totalPrice"\s*:\s*([\d.]+)/g)
      || html.match(/totalPrice['":\s]+([\d.]+)/g);
    
    if (jsonMatches) {
      console.log("Magn JSON fundin:", jsonMatches);
    }

    // Webflow sometimes embeds CMS data in script tag
    const scriptData = html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/gi);
    if (scriptData) {
      for (const s of scriptData) {
        if (s.includes("price") || s.includes("diesel") || s.includes("bensin")) {
          console.log("Magn script JSON:", s.substring(0, 200));
        }
      }
    }

    // Last resort - look for Vue/Webflow rendered prices in specific format
    // The page shows: "14.700" "14.360" "12.313" as plain text nodes
    // These appear AFTER the JS renders, so they won't be in static HTML
    // BUT Webflow CMS pages often have the data in a JSON payload
    
    const payloadMatch = html.match(/\[{"source":"Magn"[\s\S]*?\}]/);
    if (payloadMatch) {
      const data = JSON.parse(payloadMatch[0]);
      return { source: "Magn", ...data[0] };
    }

    throw new Error("Webflow JS-rendered - ikke i statisk HTML");
  } catch (e) {
    console.log("Magn feilst:", e.message, "— nýti kendar prísir");
    return { source: "Magn", ...KNOWN_PRICES.Magn };
  }
}

// ── EFFO via prisir side ──────────────────────────
async function scrapeEffo() {
  try {
    const r = await fetchUrl("https://www.effo.fo/prisir/");
    const html = r.body;

    // Effo uses WordPress/Vue - prices in table
    // Look for the table markdown format: "| Blýfrítt | 14,70 KR. |"
    const bensinMatch = html.match(/Blýfrítt[^|]*\|[^|]*?([\d,]+)\s*KR/i)
      || html.match(/bl[yý]fr[ií]tt[\s\S]{0,100}?(1[34]\.\d{2,3}|1[34],\d{2,3})/i);
    const dieselMatch = html.match(/\|\s*Diesel\s*\|\s*([\d,]+)\s*KR/i)
      || html.match(/(?:^|\|)\s*Diesel\s*(?:\||\n)\s*(1[34][,\.]\d{2,3})/im);
    const gasMatch = html.match(/Gassolja[^|]*\|[^|]*?([\d,\.]+)\s*KR/i);

    // Effo WordPress often has prices in script/JSON too
    const effoJson = html.match(/totalPrice['":\s]+([\d.]+)/g);
    if (effoJson) console.log("Effo JSON tal:", effoJson);

    // Try Vue.js rendered data pattern
    const vueData = html.match(/formatPrice\(activeProduct\.totalPrice\)/g);
    console.log("Effo Vue pattern:", !!vueData);

    // Check for any price-like numbers near KR
    const krPrices = [...html.matchAll(/(1[0-9][,\.]\d{2,3})\s*(?:KR|kr)/gi)].map(m => m[1]);
    console.log("Effo KR prísir:", krPrices.slice(0, 10));

    const bensin = bensinMatch ? bensinMatch[1].replace(",", ".") : null;
    const diesel = dieselMatch ? dieselMatch[1].replace(",", ".") : null;
    let gassoil = null;
    if (gasMatch) {
      const raw = parseFloat(gasMatch[1].replace(",", "."));
      gassoil = raw > 100 ? (raw / 1000).toFixed(3) : raw.toFixed(3);
    }

    // Use krPrices if direct matches failed
    if (krPrices.length >= 2 && (!bensin || !diesel)) {
      const vals = krPrices.map(v => parseFloat(v.replace(",", ".")));
      const sorted = [...new Set(vals)].filter(v => v > 10 && v < 20).sort((a,b) => a-b);
      console.log("Effo sorterede prísir:", sorted);
    }

    // Dato
    const dateMatch = html.match(/(\d{1,2})\.\s+(apríl|mars|februar|januar|mai|juni|juli|august|september|oktober|november|desember)\s+(\d{4})/i);
    const updatedAt = dateMatch ? dateMatch[1] + "/" + dateMatch[2].substring(0,3) + "/" + dateMatch[3] : "";

    console.log("Effo:", { gassoil, diesel, bensin, updatedAt });

    if (parseFloat(gassoil) > 5 && parseFloat(diesel) > 5 && parseFloat(bensin) > 5) {
      return { source: "Effo", gassoil, diesel, bensin, updatedAt };
    }

    throw new Error("Effo - líkliga JS-rendered: " + JSON.stringify({ bensin, diesel, gassoil }));
  } catch (e) {
    console.log("Effo feilst:", e.message);
    return { source: "Effo", ...KNOWN_PRICES.Effo };
  }
}

// ── THOMSEN ───────────────────────────────────────
async function scrapeThomsen() {
  try {
    const r = await fetchUrl("https://thomsen.fo/oljuprisur");
    const html = r.body;
    const m = html.match(/DAGSPRÍSUR\s+([\d,\.]+)\s*kr/i)
      || html.match(/\b(10\.\d{3})\b/);
    const d = html.match(/(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{4})/);
    if (m) {
      const val = parseFloat(m[1].replace(",", "."));
      if (val > 5 && val < 20) {
        return { source: "Thomsen", gassoil: val.toFixed(3), diesel: null, bensin: null, updatedAt: d ? d[1] : "" };
      }
    }
    throw new Error("Fann ikki prís");
  } catch (e) {
    console.log("Thomsen feilst:", e.message);
    return { source: "Thomsen", ...KNOWN_PRICES.Thomsen };
  }
}

async function fetchAllPrices() {
  console.log("Sækji prísir...", new Date().toISOString());
  const [thomsen, magn, effo] = await Promise.all([scrapeThomsen(), scrapeMagn(), scrapeEffo()]);
  const result = { fetchedAt: new Date().toISOString(), sources: [thomsen, magn, effo] };
  cachedPrices = result;
  lastFetch = new Date();
  return result;
}

app.get("/api/fuel-prices", async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (cachedPrices && lastFetch && (Date.now() - lastFetch) < 30 * 60 * 1000) {
    return res.json(cachedPrices);
  }
  res.json(await fetchAllPrices());
});

app.get("/health", (req, res) => res.json({ ok: true, lastFetch }));

app.listen(PORT, async () => {
  console.log("Server koyrir á port", PORT);
  await fetchAllPrices();
  setInterval(fetchAllPrices, 3 * 60 * 60 * 1000);
});
