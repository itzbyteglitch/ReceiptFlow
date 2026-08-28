import { z } from "zod";

interface Env {
  DB: D1Database;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL?: string;
}

const S = z.object({
  merchant: z.object({
    name: z.string(), address: z.string(), city: z.string(), state: z.string(), country: z.string(), phone: z.string(), gstin: z.string()
  }),
  receipt: z.object({
    type: z.string(), invoice_number: z.string(), shopping_date: z.string(), shopping_time: z.string(), currency: z.string()
  }),
  customer: z.object({ name: z.string(), id: z.string(), address: z.string() }),
  amounts: z.object({
    subtotal: z.number(), discount: z.number(), tax: z.number(), round_off: z.number(), total: z.number(), paid: z.number(), pending: z.number()
  }),
  payment: z.object({ method: z.string(), status: z.string() }),
  items: z.array(z.object({
    name: z.string(), description: z.string(), category: z.string(), quantity: z.number(), unit: z.string(), unit_price: z.number(), total_price: z.number()
  })),
  metadata: z.object({
    receipt_owner: z.string(), tags: z.array(z.string()), notes: z.string(), confidence: z.number().min(0).max(1), warnings: z.array(z.string())
  })
});

type Receipt = z.infer<typeof S>;

const SYSTEM_PROMPT = `You are ReceiptFlow, a receipt and invoice extraction engine.

Read the provided receipt image carefully, including printed text, tables, totals, handwritten marks, dates, payment information and tax sections.

Return ONLY valid JSON matching the supplied schema.

Rules:
1. Never fabricate information.
2. If a field is not present, not readable, or cannot be determined from the receipt, return the exact string "unspecified" for string fields.
3. For numeric amount fields that are absent, use 0.
4. For an absent item list, return [].
5. Preserve the receipt's actual shopping/payment date. Do not use the upload date.
6. receipt_owner may only be populated when the receipt itself clearly provides a person's identity or association. Otherwise use "unspecified".
7. Notes must summarize only observable facts. Do not turn guesses into facts.
8. Add concise warnings for important unreadable or inconsistent fields.
9. Category should be a useful broad product type such as Groceries, Food, Shopping, Education, Clothing, Transport, Utilities, Healthcare, Entertainment, Services, or Other. Use "Other" for incidental receipt charges/items that do not reasonably fit another category, including carry bags, shopping bags, packaging charges, convenience fees, small miscellaneous charges, and similar items.
10. total_price should correspond to the line total visible on the receipt. Do not invent missing prices.
11. If taxes are shown separately, capture them. If they are included in prices and no separate amount is shown, use 0.
12. Never force a product into an unrelated category just to avoid "Other". "Other" is a valid category and should be preferred when no category is a sensible fit.
13. Keep each item category independent; classify every line item separately.
14. receipt.type should classify the document, for example retail_receipt, invoice, school_invoice, restaurant_bill, utility_bill, pharmacy_receipt, or other.
`;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "Content-Type, Authorization",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS"
  }});
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function pick(value: any, keys: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(value, k)).map((k) => [k, value[k]]));
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signSession(payload: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return base64Url(new Uint8Array(signature));
}

async function verifySession(token: string, env: Env): Promise<string | null> {
  const [payloadPart, signaturePart] = token.split(".");
  if (!payloadPart || !signaturePart) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(payloadPart))) as { userId?: string; codeHash?: string; exp?: number };
    if (!payload.userId || !payload.codeHash || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    const code = await env.DB.prepare("SELECT id, label FROM access_codes WHERE code_hash = ? AND active = 1").bind(payload.codeHash).first<{id:string;label:string}>();
    if (!code) return null;
    const expected = await signSession(payloadPart, payload.codeHash);
    if (expected !== signaturePart) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

async function authenticate(request: Request, env: Env): Promise<string | null> {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return null;
  return verifySession(header.slice(7), env);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
  }
  return btoa(binary);
}

function extractJson(text: string): unknown {
  // Free vision models may prepend safety/status text or markdown around JSON.
  // Extract the JSON object rather than assuming the entire response is JSON.
  const cleaned = text
    .replace(/^\s*\`\`\`(?:json)?\s*/i, "")
    .replace(/\s*\`\`\`\s*$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) {
      throw new Error(`AI raw response: ${cleaned}`);
    }
    return JSON.parse(cleaned.slice(start, end + 1));
  }
}

async function processReceipt(file: File, env: Env): Promise<Receipt> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > 15 * 1024 * 1024) throw new Error("Receipt image must be 15 MB or smaller.");
  if (!file.type.startsWith("image/")) throw new Error("Only image receipts are supported.");

  const base64 = bytesToBase64(bytes);
  const imageUrl = `data:${file.type};base64,${base64}`;
  const model = env.OPENROUTER_MODEL || "dots-studio/dots-3-note-preview:free";

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://receiptflow.app",
      "X-Title": "ReceiptFlow"
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      top_p: 1,
      seed: 42,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: [
          { type: "text", text: "Extract this receipt into the ReceiptFlow schema." },
          { type: "image_url", image_url: { url: imageUrl } }
        ]}
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "receiptflow_receipt",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              merchant:{type:"object",additionalProperties:false,properties:{name:{type:"string"},address:{type:"string"},city:{type:"string"},state:{type:"string"},country:{type:"string"},phone:{type:"string"},gstin:{type:"string"}},required:["name","address","city","state","country","phone","gstin"]},
              receipt:{type:"object",additionalProperties:false,properties:{type:{type:"string"},invoice_number:{type:"string"},shopping_date:{type:"string"},shopping_time:{type:"string"},currency:{type:"string"}},required:["type","invoice_number","shopping_date","shopping_time","currency"]},
              customer:{type:"object",additionalProperties:false,properties:{name:{type:"string"},id:{type:"string"},address:{type:"string"}},required:["name","id","address"]},
              amounts:{type:"object",additionalProperties:false,properties:{subtotal:{type:"number"},discount:{type:"number"},tax:{type:"number"},round_off:{type:"number"},total:{type:"number"},paid:{type:"number"},pending:{type:"number"}},required:["subtotal","discount","tax","round_off","total","paid","pending"]},
              payment:{type:"object",additionalProperties:false,properties:{method:{type:"string"},status:{type:"string"}},required:["method","status"]},
              items:{type:"array",items:{type:"object",additionalProperties:false,properties:{name:{type:"string"},description:{type:"string"},category:{type:"string"},quantity:{type:"number"},unit:{type:"string"},unit_price:{type:"number"},total_price:{type:"number"}},required:["name","description","category","quantity","unit","unit_price","total_price"]}},
              metadata:{type:"object",additionalProperties:false,properties:{receipt_owner:{type:"string"},tags:{type:"array",items:{type:"string"}},notes:{type:"string"},confidence:{type:"number"},warnings:{type:"array",items:{type:"string"}}},required:["receipt_owner","tags","notes","confidence","warnings"]}
            },
            required:["merchant","receipt","customer","amounts","payment","items","metadata"]
          }
        }
      }
    })
  });

  const payload = await response.json() as any;
  if (!response.ok) throw new Error(payload?.error?.message || "OpenRouter request failed.");
  const message = payload?.choices?.[0]?.message;
  let text = message?.content;
  if (Array.isArray(text)) text = text.map((part: any) => typeof part === "string" ? part : part?.text || "").join("");
  if (typeof text !== "string" || !text.trim()) throw new Error("AI returned no structured content.");
  let extracted: unknown;
  try {
    extracted = extractJson(text);
  } catch (error) {
    // During development, surface the complete model response so we can inspect
    // what the free vision model actually returned instead of hiding it.
    throw error;
  }
  const parsed = S.safeParse(extracted);
  if (!parsed.success) {
    throw new Error(`AI raw response: ${text}`);
  }
  return parsed.data;
}

async function saveReceipt(env: Env, userId: string, data: Receipt, uploadedAt: string) {
  const id = crypto.randomUUID();
  const receipt: ReceiptRecord = { id, ...data, uploaded_at: uploadedAt };
  await env.DB.prepare(`INSERT INTO receipts (id,user_id,merchant_json,receipt_json,customer_json,amounts_json,payment_json,metadata_json,uploaded_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .bind(id,userId,JSON.stringify(data.merchant),JSON.stringify(data.receipt),JSON.stringify(data.customer),JSON.stringify(data.amounts),JSON.stringify(data.payment),JSON.stringify(data.metadata),uploadedAt,uploadedAt).run();

  for (const item of data.items) {
    await env.DB.prepare(`INSERT INTO receipt_items (id,receipt_id,name,description,category,quantity,unit,unit_price,total_price) VALUES (?,?,?,?,?,?,?,?,?)`)
      .bind(crypto.randomUUID(),id,item.name,item.description,item.category,item.quantity,item.unit,item.unit_price,item.total_price).run();
  }
  return receipt;
}

type ReceiptRecord = Receipt & { id: string; uploaded_at: string };

async function listReceipts(env: Env, userId: string): Promise<ReceiptRecord[]> {
  const rows = await env.DB.prepare("SELECT * FROM receipts WHERE user_id = ? ORDER BY uploaded_at DESC").bind(userId).all<any>();
  const out: ReceiptRecord[] = [];
  for (const row of rows.results) {
    const items = await env.DB.prepare("SELECT * FROM receipt_items WHERE receipt_id = ? ORDER BY rowid").bind(row.id).all<any>();
    out.push({
      id: row.id,
      merchant: JSON.parse(row.merchant_json),
      receipt: JSON.parse(row.receipt_json),
      customer: JSON.parse(row.customer_json),
      amounts: JSON.parse(row.amounts_json),
      payment: JSON.parse(row.payment_json),
      metadata: JSON.parse(row.metadata_json),
      items: items.results.map((i:any)=>({id:i.id,name:i.name,description:i.description,category:i.category,quantity:i.quantity,unit:i.unit,unit_price:i.unit_price,total_price:i.total_price})),
      uploaded_at: row.uploaded_at
    });
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") return jsonResponse({ ok: true });
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") return jsonResponse({ ok: true, service: "receiptflow" });

      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        const body = await request.json().catch(() => null) as { code?: unknown } | null;
        const code = typeof body?.code === "string" ? body.code.trim() : "";
        if (!code) return jsonResponse({ error: "Access string is required." }, 400);
        const codeHash = await sha256Hex(code);
        const account = await env.DB.prepare("SELECT id, label FROM access_codes WHERE code_hash = ? AND active = 1").bind(codeHash).first<{id:string;label:string}>();
        if (!account) return jsonResponse({ error: "Invalid access string." }, 401);
        const payload = base64Url(new TextEncoder().encode(JSON.stringify({
          userId: account.id,
          codeHash,
          exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
        })));
        const signature = await signSession(payload, codeHash);
        return jsonResponse({ token: payload + "." + signature, label: account.label });
      }

      if (url.pathname === "/api/receipts" && request.method === "GET") {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "Authentication required" }, 401);
        return jsonResponse(await listReceipts(env, userId));
      }

      if (url.pathname === "/api/receipts" && request.method === "POST") {
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "Authentication required" }, 401);
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return jsonResponse({ error: "Image file is required" }, 400);

        const uploadedAt = new Date().toISOString();
        const data = await processReceipt(file, env);
        const record = await saveReceipt(env, userId, data, uploadedAt);
        return jsonResponse(record, 201);
      }

      const match = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
      if (match && (request.method === "PATCH" || request.method === "POST")) {
        const id = match[1];
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "Authentication required" }, 401);
        const body = await request.json().catch(() => null) as any;
        if (!body || typeof body !== "object") return jsonResponse({ error: "Invalid update" }, 400);
        // Financial amounts and item prices are intentionally not editable.
        const current = await env.DB.prepare("SELECT merchant_json, receipt_json, customer_json, payment_json, metadata_json FROM receipts WHERE id = ? AND user_id = ?").bind(id,userId).first<any>();
        if (!current) return jsonResponse({ error: "Receipt not found" }, 404);
        const merchant = { ...JSON.parse(current.merchant_json), ...pick(body.merchant, ["name","address","city","state","country","phone","gstin"]) };
        const receipt = { ...JSON.parse(current.receipt_json), ...pick(body.receipt, ["type","invoice_number","shopping_date","shopping_time","currency"]) };
        const customer = { ...JSON.parse(current.customer_json), ...pick(body.customer, ["name","id","address"]) };
        const payment = { ...JSON.parse(current.payment_json), ...pick(body.payment, ["method","status"]) };
        const metadata = { ...JSON.parse(current.metadata_json), ...pick(body.metadata, ["receipt_owner","tags","notes"]) };
        const incomingItems = Array.isArray(body.items) ? body.items : null;
        await env.DB.prepare("UPDATE receipts SET merchant_json=?, receipt_json=?, customer_json=?, payment_json=?, metadata_json=? WHERE id=? AND user_id=?")
          .bind(JSON.stringify(merchant),JSON.stringify(receipt),JSON.stringify(current.customer_json ? customer : customer),JSON.stringify(payment),JSON.stringify(metadata),id,userId).run();
        if (incomingItems) {
          const existingItems = await env.DB.prepare("SELECT id FROM receipt_items WHERE receipt_id = ?").bind(id).all<{id:string}>();
          const allowed = new Set(existingItems.results.map((item) => item.id));
          for (const item of incomingItems) {
            if (!item || !allowed.has(item.id) || typeof item.category !== "string") continue;
            await env.DB.prepare("UPDATE receipt_items SET category = ? WHERE id = ? AND receipt_id = ?")
              .bind(item.category, item.id, id).run();
          }
        }
        return jsonResponse((await listReceipts(env,userId)).find((r) => r.id === id));
      }


      if (match && request.method === "DELETE") {
        const id = match[1];
        const userId = await authenticate(request, env);
        if (!userId) return jsonResponse({ error: "Authentication required" }, 401);
        const result = await env.DB.prepare("DELETE FROM receipts WHERE id = ? AND user_id = ?").bind(id,userId).run();
        return result.meta.changes ? jsonResponse({ ok: true }) : jsonResponse({ error: "Receipt not found" }, 404);
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error(error);
      return jsonResponse({ error: error instanceof Error ? error.message : "Unexpected server error" }, 500);
    }
  }
};
