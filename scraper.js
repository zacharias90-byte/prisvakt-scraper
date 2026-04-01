const puppeteer = require("puppeteer");
const cron = require("node-cron");
const express = require("express");
const fs = require("fs");
 
const app = express();
const PORT = process.env.PORT || 3000;
const PRICES_FILE = "prices.json";
 
// ── KENDAR PRÍSIR (fallback) ──────────────────────
const KNOWN_PRICES = {
  Thomsen: { gassoil: "10.350", diesel: null,    bensin: null,    updatedAt: "26/03/2026" },
  Magn:    { gassoil: "12.313", diesel: "14.360", bensin: "14.700", updatedAt: "31/03/2026" },
  Effo:    { gassoil: "12.313", diesel: "14.360", bensin: "14.700", updatedAt: "01/04/2026" }
};
 
// ── THOMSEN (vanlig scraping virkar) ─────────────
async function scrapeThomsen(page) {
  try {
    await page.goto("https://thomsen.fo/oljuprisur", { waitUntil: "domcontentloaded", timeout: 15000 });
    const result = await page.evaluate(() => {
      const h2s = Array.from(document.querySelectorAll("h2"));
      for (const h2 of h2s) {
        const m = h2.textContent.match(/DAGSPRÍSUR\s+([\d,\.]+)\s*kr/i);
        if (m) {
          const dateEl = document.querySelector("table td");
          return {
            gassoil: m[1].replace(",", "."),
            updatedAt: dateEl ? dateEl.textContent.trim() : ""
          };
        }
      }
      return null;
    });
    if (result && parseFloat(result.gassoil) > 5) {
      console.log("Thomsen OK:", result.gassoil);
      return { source: "Thomsen", gassoil: parseFloat(result.gassoil).toFixed(3), diesel: null, bensin: null, updatedAt: result.updatedAt };
    }
    throw new Error("Fann ikki prís");
  } catch (e) {
    console.log("Thomsen feilst:", e.message, "— nýti kendar prísir");
    return { source: "Thomsen", ...KNOWN_PRICES.Thomsen };
  }
}
 
// ── EFFO (JavaScript-rendered — nýtir Puppeteer) ─
async function scrapeEffo(page) {
  try {
    await page.goto("https://www.effo.fo/prisir/", { waitUntil: "networkidle2", timeout: 30000 });
    // Bíð eftir at Vue.js renderar prísirnar
    await page.waitForSelector(".fuel-price--total", { timeout: 15000 });
    const result = await page.evaluate(() => {
      const items = document.querySelectorAll(".fuel-prices--elm");
      const prices = {};
      items.forEach(item => {
        const type = item.querySelector(".fuel-price--type")?.textContent?.trim()?.toLowerCase() || "";
        const total = item.querySelector(".fuel-price--total")?.textContent?.trim() || "";
        const m = total.match(/([\d,\.]+)/);
        if (!m) return;
        const val = parseFloat(m[1].replace(",", "."));
        if (type.includes("diesel") && !type.includes("báta")) prices.diesel = val;
        else if (type.includes("blý") || type.includes("bensin") || type.includes("oktan")) prices.bensin = val;
        else if (type.includes("gass")) {
          prices.gassoil = val > 100 ? val / 1000 : val;
        }
      });
      // Finn dato
      const dateEl = document.querySelector(".fuel-prices-block h5, .fuel-prices h5");
      return { ...prices, updatedAt: dateEl ? dateEl.textContent.trim() : "" };
    });
    if (result.gassoil && result.gassoil > 5) {
      console.log("Effo OK:", result);
      return {
        source: "Effo",
        gassoil: result.gassoil.toFixed(3),
        diesel: result.diesel ? result.diesel.toFixed(3) : null,
        bensin: result.bensin ? result.bensin.toFixed(3) : null,
        updatedAt: result.updatedAt
      };
    }
    throw new Error("Ógildur prísur: " + result.gassoil);
  } catch (e) {
    console.log("Effo feilst:", e.message, "— nýti kendar prísir");
    return { source: "Effo", ...KNOWN_PRICES.Effo };
  }
}
 
// ── MAGN (JavaScript-rendered — nýtir Puppeteer) ─
async function scrapeMagn(page) {
  try {
    await page.goto("https://magn.fo/oljuprisir", { waitUntil: "networkidle2", timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000)); // Bíð eftir JS
    const result = await page.evaluate(() => {
      // Prova ymiskar CSS selectors
      const selectors = [".fuel-price--total", ".price", ".pris", "[class*='price']", "[class*='pris']"];
      const prices = {};
      for (const sel of selectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          els.forEach(el => {
            const text = el.textContent.trim();
            const parent = el.closest("[class*='fuel'], [class*='olja'], [class*='oil']");
            const typeEl = parent?.querySelector("[class*='type'], [class*='name'], [class*='slag']");
            const type = typeEl?.textContent?.toLowerCase() || "";
            const m = text.match(/([\d,\.]+)/);
            if (!m) return;
            const val = parseFloat(m[1].replace(",", "."));
            if (val < 5 || val > 10000) return;
            if (type.includes("diesel")) prices.diesel = val > 100 ? val / 1000 : val;
            else if (type.includes("blý") || type.includes("bensin")) prices.bensin = val > 100 ? val / 1000 : val;
            else if (type.includes("gass")) prices.gassoil = val > 100 ? val / 1000 : val;
          });
          if (prices.gassoil) break;
        }
      }
      // Fallback: finn allar talur á síðuni
      if (!prices.gassoil) {
        const allText = document.body.innerText;
        const nums = [...allText.matchAll(/(\d+)[,\.](\d{3})/g)].map(m => parseFloat(m[0].replace(",", ".")));
        const valid = nums.filter(n => n > 8 && n < 25);
        if (valid.length >= 1) prices.gassoil = valid[0];
        if (valid.length >= 2) prices.diesel = valid[1];
        if (valid.length >= 3) prices.bensin = valid[2];
      }
      return prices;
    });
    if (result.gassoil && result.gassoil > 5) {
      console.log("Magn OK:", result);
      return {
        source: "Magn",
        gassoil: result.gassoil.toFixed(3),
        diesel: result.diesel ? result.diesel.toFixed(3) : null,
        bensin: result.bensin ? result.bensin.toFixed(3) : null,
        updatedAt: new Date().toLocaleDateString("fo-FO")
      };
    }
    throw new Error("Ógildur prísur");
  } catch (e) {
    console.log("Magn feilst:", e.message, "— nýti kendar prísir");
    return { source: "Magn", ...KNOWN_PRICES.Magn };
  }
}
 
// ── KEYRI SCRAPING ────────────────────────────────
async function runScraper() {
  console.log("Byrjar scraping:", new Date().toISOString());
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
      headless: "new"
    });
    const page = await browser.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36");
 
    const thomsen = await scrapeThomsen(page);
    const effo = await scrapeEffo(page);
    const magn = await scrapeMagn(page);
 
    const result = {
      fetchedAt: new Date().toISOString(),
      sources: [thomsen, magn, effo]
    };
 
    fs.writeFileSync(PRICES_FILE, JSON.stringify(result, null, 2));
    console.log("Prísir goymdar:", PRICES_FILE);
  } catch (e) {
    console.error("Scraping villa:", e.message);
  } finally {
    if (browser) await browser.close();
  }
}
 
// ── EXPRESS SERVER ────────────────────────────────
app.get("/api/fuel-prices", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Cache-Control", "public, max-age=3600");
  if (fs.existsSync(PRICES_FILE)) {
    res.json(JSON.parse(fs.readFileSync(PRICES_FILE)));
  } else {
    // Fallback um ongin fil er til
    res.json({
      fetchedAt: new Date().toISOString(),
      sources: [
        { source: "Thomsen", ...KNOWN_PRICES.Thomsen },
        { source: "Magn",    ...KNOWN_PRICES.Magn    },
        { source: "Effo",    ...KNOWN_PRICES.Effo    }
      ]
    });
  }
});
 
app.get("/", (req, res) => res.send("Prísvakt scraper keyrir!"));
 
app.listen(PORT, () => {
  console.log("Server keyrir á port", PORT);
  // Keyri straks
  runScraper();
  // Keyri hvønn 6. tíma: kl. 00, 06, 12, 18
  cron.schedule("0 */6 * * *", runScraper);
});
