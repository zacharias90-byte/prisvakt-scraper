const https = require("https");
const http = require("http");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

const KNOWN_PRICES = {
  Thomsen: { gassoil: "10.350", diesel: null,     bensin: null,     updatedAt: "26/03/2026" },
  Magn:    { gassoil: "12.313", diesel: "14.360",  bensin: "14.700", updatedAt: "31/03/2026" },
  Effo:    { gassoil: "12.313", diesel: "14.360",  bensin: "14.700", updatedAt: "01/04/2026" }
};

let cachedPrices = null;
let lastFetch = null;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 15000
    }, (res) => {
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
// Magn Webflow HTML struktur:
// "Bensin\nVið MVG\nkr.\n\n14.700\nMVG..."
// "Diesel\nVið MVG\nkr.\n\n14.360\nMVG..."
// "Gassolja\nVið MVG\nkr.\n\n12.313\nMVG..."
// Dato: "31\n.\nMarch\n2026"
async function scrapeMagn() {
  try {
    const html = await fetchUrl("https://www.magn.fo/oljuprisir");

    // Dato
    const dateMatch = html.match(/(\d{1,2})\s*\.\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s*(\d{4})/i);
    let updatedAt = "";
    if (dateMatch) {
      const mn = {january:"01",february:"02",march:"03",april:"04",may:"05",june:"06",july:"07",august:"08",september:"09",october:"10",november:"11",december:"12"};
      updatedAt = dateMatch[1] + "/" + (mn[dateMatch[2].toLowerCase()]||"??") + "/" + dateMatch[3];
    }

    // Finna prísir - Magn sýnir "kr.\n\n14.700" format
    // Bensin kemur fyrst, so Diesel, so Gassolja
    const sections = html.split(/(?=Bensin|Diesel|Gassolja)/);
    let bensin = null, diesel = null, gassoil = null;

    for (const sec of sections) {
      const priceMatch = sec.match(/kr\.\s*\n\s*\n?\s*(1[0-9]\.\d{3})/);
      if (!priceMatch) continue;
      const val = priceMatch[1];
      if (sec.startsWith("Bensin") && !bensin && parseFloat(val) > 13) bensin = val;
      else if (sec.startsWith("Diesel") && !diesel && parseFloat(val) > 13) diesel = val;
      else if (sec.startsWith("Gassolja") && !gassoil) gassoil = val;
    }

    // Fallback: udtræk alle XX.XXX tal og brug de rigtige
    if (!bensin || !diesel || !gassoil) {
      // Find "Við MVG\nkr.\n\nXX.XXX" patterns
      const magnPrices = [...html.matchAll(/Við MVG\s*\nkr\.\s*\n\s*(1[0-9]\.\d{3})/g)].map(m => m[1]);
      console.log("Magn prístalva:", magnPrices);
      // Fyrsti prísur = Bensin, annar = Diesel, síðsti = Gassolja
      if (magnPrices.length >= 2) {
        if (!bensin) bensin = magnPrices[0];
        if (!diesel) diesel = magnPrices[1];
      }
      // Gassolja er pr 1000L so gildi er líkari 12.313
      const gasVals = magnPrices.filter(v => parseFloat(v) < 14);
      if (!gassoil && gasVals.length) gassoil = gasVals[gasVals.length - 1];
    }

    console.log("Magn:", { gassoil, diesel, bensin, updatedAt });

    if (parseFloat(gassoil) > 5 && parseFloat(diesel) > 5 && parseFloat(bensin) > 5) {
      return { source: "Magn", gassoil, diesel, bensin, updatedAt };
    }
    throw new Error("Ógildur prísur");
  } catch (e) {
    console.log("Magn feilst:", e.message);
    return { source: "Magn", ...KNOWN_PRICES.Magn };
  }
}

// ── EFFO ─────────────────────────────────────────
// Effo tabell: "| Blýfrítt | 14,70 KR. |"
async function scrapeEffo() {
  try {
    const html = await fetchUrl("https://www.effo.fo/prisir/");

    // Dato: "##### 1. apríl 2026"
    const dateMatch = html.match(/(\d{1,2})\.\s+(apríl|mars|februar|januar|mai|juni|juli|august|september|oktober|november|desember)\s+(\d{4})/i);
    let updatedAt = "";
    if (dateMatch) {
      const mn = {januar:"01",februar:"02",mars:"03","apríl":"04",mai:"05",juni:"06",juli:"07",august:"08",september:"09",oktober:"10",november:"11",desember:"12"};
      updatedAt = dateMatch[1] + "/" + (mn[dateMatch[2].toLowerCase()]||"??") + "/" + dateMatch[3];
    }

    // Effo tabellar: "| Blýfrítt | 14,70 KR. | 2,94 KR. | 3,00 KR. |"
    const bensinMatch = html.match(/Blýfrítt\s*\|\s*([\d,]+)\s*KR/i);
    const dieselMatch = html.match(/\|\s*Diesel\s*\|\s*([\d,]+)\s*KR/i);
    const gasMatch    = html.match(/Gassolja\s*\|\s*([\d,\.]+)\s*KR/i);

    const bensin  = bensinMatch  ? bensinMatch[1].replace(",",".")  : null;
    const diesel  = dieselMatch  ? dieselMatch[1].replace(",",".")  : null;
    let gassoil   = null;
    if (gasMatch) {
      const raw = parseFloat(gasMatch[1].replace(",","."));
      gassoil = raw > 100 ? (raw/1000).toFixed(3) : raw.toFixed(3);
    }

    console.log("Effo:", { gassoil, diesel, bensin, updatedAt });

    if (parseFloat(gassoil) > 5 && parseFloat(diesel) > 5 && parseFloat(bensin) > 5) {
      return { source: "Effo", gassoil, diesel, bensin, updatedAt };
    }
    throw new Error("Ógildur prísur: " + gassoil + "/" + diesel + "/" + bensin);
  } catch (e) {
    console.log("Effo feilst:", e.message);
    return { source: "Effo", ...KNOWN_PRICES.Effo };
  }
}

// ── THOMSEN ───────────────────────────────────────
async function scrapeThomsen() {
  try {
    const html = await fetchUrl("https://thomsen.fo/oljuprisur");
    const m = html.match(/DAGSPRÍSUR\s+([\d,\.]+)\s*kr/i) || html.match(/\b(10\.\d{3})\b/);
    const d = html.match(/(\d{1,2}[\.\/]\d{1,2}[\.\/]\d{4})/);
    if (m) {
      const val = parseFloat(m[1].replace(",","."));
      if (val > 5 && val < 20) {
        console.log("Thomsen OK:", val.toFixed(3));
        return { source: "Thomsen", gassoil: val.toFixed(3), diesel: null, bensin: null, updatedAt: d ? d[1] : "" };
      }
    }
    throw new Error("Fann ikki prís");
  } catch (e) {
    console.log("Thomsen feilst:", e.message);
    return { source: "Thomsen", ...KNOWN_PRICES.Thomsen };
  }
}

// ── FETCH ALL ─────────────────────────────────────
async function fetchAllPrices() {
  console.log("Sækji prísir...", new Date().toISOString());
  const [thomsen, magn, effo] = await Promise.all([scrapeThomsen(), scrapeMagn(), scrapeEffo()]);
  const result = { fetchedAt: new Date().toISOString(), sources: [thomsen, magn, effo] };
  cachedPrices = result;
  lastFetch = new Date();
  return result;
}

// ── API ───────────────────────────────────────────
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
