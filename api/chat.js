// api/chat.js — ElektrixStore Bot Proxy
// Déployé sur Vercel — NE PAS exposer ce fichier côté client

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const WC_STORE_URL = process.env.WC_STORE_URL;

// ─── Récupère les produits WooCommerce ───────────────────────────────────────
async function fetchProducts(query) {
  try {
    const auth = Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString("base64");
    
    // Recherche par mot-clé si fourni, sinon les 50 premiers produits
    const searchParam = query ? `&search=${encodeURIComponent(query)}` : "";
    const url = `${WC_STORE_URL}/wp-json/wc/v3/products?per_page=20&status=publish${searchParam}`;
    
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${auth}` },
    });

    if (!res.ok) return [];

    const products = await res.json();

    return products.map((p) => ({
      name: p.name,
      price: p.price ? `${p.price} €` : "kaina nenurodyta",
      regular_price: p.regular_price ? `${p.regular_price} €` : null,
      sale_price: p.sale_price ? `${p.sale_price} €` : null,
      stock: p.stock_status === "instock" ? "sandėlyje" : "išparduota",
      stock_quantity: p.stock_quantity || null,
      category: p.categories?.map((c) => c.name).join(", ") || "",
      short_description: p.short_description
        ? p.short_description.replace(/<[^>]*>/g, "").slice(0, 150)
        : "",
      url: p.permalink || "",
    }));
  } catch (e) {
    console.error("WooCommerce fetch error:", e);
    return [];
  }
}

// ─── Système prompt avec infos boutique ──────────────────────────────────────
function buildSystemPrompt(products, lang) {
  const productList = products.length > 0
    ? products.map((p) =>
        `- ${p.name} | ${p.price}${p.sale_price ? ` (nuolaida: ${p.sale_price})` : ""} | ${p.stock}${p.stock_quantity ? ` (${p.stock_quantity} vnt.)` : ""} | ${p.category} | ${p.url}`
      ).join("\n")
    : "Produktų sąrašas šiuo metu nepasiekiamas.";

  const isLT = lang === "lt";

  return isLT
    ? `Tu esi ElektrixStore virtualus asistentas. ElektrixStore yra lietuviškas elektronikos ir mobilumo parduotuvė.

APIE PARDUOTUVĘ:
- Svetainė: https://elektrixstore.com
- El. paštas: Kontaktai@elektrixstore.com
- Telefonas: +33 8 92 83 94 9
- Darbo laikas: Pirm–Penk 9–18 val., Šeš–Sek 9–15 val.
- Adresas: 10 Rue de la Capelle, 62280 Saint-Martin-Boulogne, Prancūzija

PRISTATYMAS IR GRĄŽINIMAS:
- Pristatymas greitas ir nemokamas
- Grąžinimas per 30 dienų nuo gavimo
- Pinigų grąžinimas per 30 dienų po grąžintos prekės gavimo

GARANTIJA IR MOKĖJIMAS:
- 24 mėnesių nemokama garantija
- Mokėjimas: banko pavedimas,  Visa, Mastercard, Google Pay, Apple Pay
- 100% saugūs mokėjimai (PCI-DSS, SSL/TLS 256 bitų)

PRODUKTAI (atnaujinta realiuoju laiku iš WooCommerce):
${productList}

TAISYKLĖS:
- Atsakyk TIKTAI lietuviškai arba angliškai pagal kliento kalbą
- Būk draugiškas, trumpas ir aiškus
- Jei produkto nėra sąraše, pasiūlyk susisiekti el. paštu
- Niekada neminėk, kad esi AI arba Groq
- Pristatyk save kaip "ElektrixStore asistentas"
- Jei klientas kalba angliškai, atsakyk angliškai`
    : `You are the ElektrixStore virtual assistant. ElektrixStore is a Lithuanian electronics and mobility store.

ABOUT THE STORE:
- Website: https://elektrixstore.com
- Email: Kontaktai@elektrixstore.com
- Phone: +33 8 92 83 94 9
- Hours: Mon–Fri 9am–6pm, Sat–Sun 9am–3pm
- Address: 10 Rue de la Capelle, 62280 Saint-Martin-Boulogne, France

SHIPPING & RETURNS:
- Fast and free shipping
- 30-day return policy from receipt
- Refund within 30 days after return received

WARRANTY & PAYMENT:
- 24-month free warranty
- Payment: Visa, Mastercard, Google Pay, Apple Pay, bank transfer
- 100% secure payments (PCI-DSS, SSL/TLS 256-bit)

PRODUCTS (live from WooCommerce):
${productList}

RULES:
- Reply in the language the customer uses (Lithuanian or English)
- Be friendly, concise and clear
- If a product is not listed, suggest contacting by email
- Never mention you are an AI or Groq
- Introduce yourself as "ElektrixStore assistant"`;
}

// ─── Handler principal ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // CORS — autorise votre site Hostinger
  res.setHeader("Access-Control-Allow-Origin", "https://elektrixstore.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { messages, lang = "lt" } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format" });
    }

    // Extrait le dernier message utilisateur pour la recherche produits
    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";

    // Récupère les produits WooCommerce en temps réel
    const products = await fetchProducts(userQuery);

    // Construit le système prompt avec les données fraîches
    const systemPrompt = buildSystemPrompt(products, lang);

    // Appelle Groq
    const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemPrompt },
          ...messages.slice(-10), // garde les 10 derniers messages pour le contexte
        ],
        max_tokens: 500,
        temperature: 0.7,
      }),
    });

    if (!groqRes.ok) {
      const err = await groqRes.text();
      console.error("Groq error:", err);
      return res.status(500).json({ error: "Groq API error" });
    }

    const data = await groqRes.json();
    const reply = data.choices?.[0]?.message?.content || "Atsiprašau, įvyko klaida.";

    return res.status(200).json({ reply });

  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
}
