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
9. Category should be a useful broad category such as Groceries, Food, Shopping, Education, Clothing, Transport, Utilities, Healthcare, Entertainment, Services, or Other.
10. total_price should correspond to the line total visible on the receipt. Do not invent missing prices.
11. If taxes are shown separately, capture them. If they are included in prices and no separate amount is shown, use 0.
12. receipt.type should classify the document, for example retail_receipt, invoice, school_invoice, restaurant_bill, utility_bill, pharmacy_receipt, or other.
`;

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-headers": "Content-Type", "access-control-allow-methods": "GET,POST,DELETE,OPTIONS" }});
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
  const cleaned = text.replace(/^\s*\`\`\`json\s*/i, "").replace(/\s*\`\`\`\s*$/i, "").trim();
  return JSON.parse(cleaned);
}

async function processReceipt(file: File, env: Env): Promise<Receipt> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > 15 * 1024 * 1024) throw new Error("Receipt image must be 15 MB or smaller.");
  if (!file.type.startsWith("image/")) throw new Error("Only image receipts are supported.");

  const base64 = bytesToBase64(bytes);
  const imageUrl = `data:${file.type};base64,${base64}`;
  const model = env.OPENROUTER_MODEL || "openrouter/free";

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
  const text = payload?.choices?.[0]?.message?.content;
  if (typeof text !== "string") throw new Error("AI returned no structured content.");
  const parsed = S.safeParse(extractJson(text));
  if (!parsed.success) throw new Error("AI output failed ReceiptFlow validation.");
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
      if (url.pathname === "/api/health") return jsonResponse({ ok: true, service: "receiptflow-api" });

      if (url.pathname === "/api/receipts" && request.method === "GET") {
        const userId = url.searchParams.get("userId");
        if (!userId) return jsonResponse({ error: "userId is required" }, 400);
        return jsonResponse(await listReceipts(env, userId));
      }

      if (url.pathname === "/api/receipts" && request.method === "POST") {
        const form = await request.formData();
        const userId = String(form.get("userId") || "");
        const file = form.get("file");
        if (!userId || !(file instanceof File)) return jsonResponse({ error: "userId and image file are required" }, 400);

        const key = `temporary-receipts/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g,"_")}`;
        await env.RECEIPTS.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

        try {
          const uploadedAt = new Date().toISOString();
          const data = await processReceipt(file, env);
          const record = await saveReceipt(env, userId, data, uploadedAt);
          return jsonResponse(record, 201);

      }

      const match = url.pathname.match(/^\/api\/receipts\/([^/]+)$/);
      if (match && request.method === "DELETE") {
        const id = match[1];
        const userId = url.searchParams.get("userId");
        if (!userId) return jsonResponse({ error: "userId is required" }, 400);
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
