// api/chat.js — ElektrixStore Bot Proxy
// Chat + Transcription Whisper pour Safari/tous navigateurs

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;
const WC_STORE_URL = process.env.WC_STORE_URL;

// ─── CORS helper ─────────────────────────────────────────────────────────────
function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "https://elektrixstore.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// ─── Récupère les produits WooCommerce ───────────────────────────────────────
async function fetchProducts(query) {
  try {
    const auth = Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString("base64");
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

// ─── Système prompt ───────────────────────────────────────────────────────────
function buildSystemPrompt(products, lang) {
  const productList =
    products.length > 0
      ? products
          .map(
            (p) =>
              `- ${p.name} | ${p.price}${p.sale_price ? ` (nuolaida: ${p.sale_price})` : ""} | ${p.stock}${p.stock_quantity ? ` (${p.stock_quantity} vnt.)` : ""} | ${p.category} | ${p.url}`
          )
          .join("\n")
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
- Mokėjimas: Visa, Mastercard, Google Pay, Apple Pay, banko pavedimas
- 100% saugūs mokėjimai (PCI-DSS, SSL/TLS 256 bitų)

PRODUKTAI (atnaujinta realiuoju laiku):
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

// ─── HANDLER PRINCIPAL ────────────────────────────────────────────────────────
export default async function handler(req, res) {
  setCors(res);
  if (req.method === "OPTIONS") return res.status(200).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // ── ROUTE : Transcription Whisper ──────────────────────────────────────────
  // On détecte si c'est une requête de transcription audio
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("multipart/form-data")) {
    try {
      // Récupère le body brut
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buffer = Buffer.concat(chunks);

      // Recrée un FormData pour Groq Whisper
      const boundary = contentType.split("boundary=")[1];
      const formData = new FormData();

      // Extrait le fichier audio du buffer multipart
      const boundaryBuffer = Buffer.from(`--${boundary}`);
      const parts = [];
      let start = 0;

      for (let i = 0; i < buffer.length; i++) {
        if (buffer.slice(i, i + boundaryBuffer.length).equals(boundaryBuffer)) {
          if (start > 0) parts.push(buffer.slice(start, i - 2));
          start = i + boundaryBuffer.length + 2;
        }
      }

      // Trouve la partie audio
      let audioBuffer = null;
      let audioType = "audio/webm";

      for (const part of parts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd).toString();
        const body = part.slice(headerEnd + 4);

        if (headers.includes('name="audio"')) {
          audioBuffer = body;
          if (headers.includes("audio/mp4")) audioType = "audio/mp4";
          else if (headers.includes("audio/ogg")) audioType = "audio/ogg";
          else if (headers.includes("audio/wav")) audioType = "audio/wav";
          break;
        }
      }

      if (!audioBuffer) {
        return res.status(400).json({ error: "No audio found" });
      }

      // Envoie à Groq Whisper
      const whisperForm = new FormData();
      const blob = new Blob([audioBuffer], { type: audioType });
      whisperForm.append("file", blob, `audio.${audioType.split("/")[1]}`);
      whisperForm.append("model", "whisper-large-v3");
      whisperForm.append("language", req.headers["x-lang"] === "en" ? "en" : "lt");
      whisperForm.append("response_format", "text");

      const whisperRes = await fetch(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
          body: whisperForm,
        }
      );

      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        console.error("Whisper error:", err);
        return res.status(500).json({ error: "Whisper error" });
      }

      const transcript = await whisperRes.text();
      return res.status(200).json({ transcript: transcript.trim() });

    } catch (e) {
      console.error("Transcription error:", e);
      return res.status(500).json({ error: "Transcription failed" });
    }
  }

  // ── ROUTE : Chat classique ─────────────────────────────────────────────────
  try {
    const { messages, lang = "lt" } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: "Invalid messages format" });
    }

    const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
    const userQuery = lastUserMessage?.content || "";

    const products = await fetchProducts(userQuery);
    const systemPrompt = buildSystemPrompt(products, lang);

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
          ...messages.slice(-10),
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
