/**
 * 今天吃什麼？ — 後端代理（Cloudflare Worker）
 *   1) 距離：店名/地址 → 座標（Google Places API New）；前端再算「車程X分鐘內」級距、不存座標
 *   2) AI 分類：店名 → 上網查證 → 主食/菜系/餐別/價位（OpenAI，含 web search）
 * 金鑰都藏在這裡，而且只允許你的網站呼叫。
 *
 * 部署後在 Worker → Settings → Variables and Secrets 設定：
 *   GOOGLE_KEY     （類型 Secret）= 你的 Google API 金鑰（距離用）
 *   OPENAI_KEY     （類型 Secret）= 你的 OpenAI API 金鑰（AI 分類用）
 *   ALLOWED_ORIGIN （類型 Text）  = 你的網站，例  https://a23860276-jpg.github.io
 */
export default {
  async fetch(request, env) {
    const allow = env.ALLOWED_ORIGIN || "";
    const cors = {
      "Access-Control-Allow-Origin": allow || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method !== "POST") return json({ error: "method" }, 405, cors);

    const origin = request.headers.get("Origin") || "";
    if (allow && origin && origin !== allow) return json({ error: "forbidden" }, 403, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad-json" }, 400, cors); }

    if (body && body.op === "classify") return classify(body, env, cors);
    return geocode(body, env, cors);
  },
};

async function geocode(body, env, cors) {
  const q = (body && body.q ? String(body.q) : "").trim();
  if (!q) return json({ error: "empty" }, 400, cors);
  const gbody = { textQuery: q, maxResultCount: 1, languageCode: "zh-TW", regionCode: "TW" };
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    gbody.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 25000 } };
  }
  const ref = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.replace(/\/+$/, "") + "/" : "";
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: Object.assign(
      { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_KEY, "X-Goog-FieldMask": "places.location,places.displayName" },
      ref ? { "Referer": ref } : {}
    ),
    body: JSON.stringify(gbody),
  });
  if (r.status === 401 || r.status === 403) return json({ error: "google-auth", status: r.status }, r.status, cors);
  if (!r.ok) return json({ error: "google", status: r.status }, 502, cors);
  const j = await r.json();
  const p = (j.places || [])[0];
  if (!p || !p.location) return json({ result: null }, 200, cors);
  return json({ result: { lat: p.location.latitude, lng: p.location.longitude, name: (p.displayName && p.displayName.text) || q } }, 200, cors);
}

async function classify(body, env, cors) {
  if (!env.OPENAI_KEY) return json({ error: "no-openai-key" }, 500, cors);
  const name = (body.name || "").toString().trim();
  if (!name) return json({ error: "empty" }, 400, cors);
  const note = (body.note || "").toString().trim();
  const opt = body.options || {};
  const prompt = [
    "你是台灣餐飲分類助理。請『上網查證』這間餐廳的實際資訊（菜單、餐點類型、人均消費、營業時段）後再分類。",
    '餐廳：「' + name + '」' + (note ? "（備註：" + note + "）" : "") + "，位於台灣台中。",
    "只能從下列『允許值』中選，不可自創、不可翻譯：",
    "主食(可多選)：" + (opt.staple || []).join("、"),
    "菜系(可多選)：" + (opt.cuisine || []).join("、"),
    "餐別(可多選)：" + (opt.meals || []).join("、"),
    "價位(單選，人均一餐)：" + (opt.price || []).join("、"),
    "只輸出一個 JSON 物件（不要任何其他文字、不要 markdown）：",
    '{"staple":[],"cuisine":[],"meals":[],"price":""}',
    "查不到或不確定的欄位就留空（空陣列或空字串），不要硬填。",
  ].join("\n");

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.OPENAI_KEY },
    // 若你的帳號回報 web_search 不支援，把 tools 的 type 改成 "web_search_preview"
    body: JSON.stringify({ model: "gpt-4o-mini", tools: [{ type: "web_search" }], input: prompt }),
  });
  if (r.status === 401 || r.status === 403) return json({ error: "openai-auth", status: r.status }, r.status, cors);
  if (!r.ok) { const t = await r.text(); return json({ error: "openai", status: r.status, detail: t.slice(0, 300) }, 502, cors); }
  const j = await r.json();
  return json({ result: parseTags(extractText(j), opt) }, 200, cors);
}

function extractText(j) {
  if (typeof j.output_text === "string" && j.output_text) return j.output_text;
  let t = "";
  for (const item of (j.output || [])) {
    if (item && item.type === "message" && Array.isArray(item.content)) {
      for (const c of item.content) { if (c && c.type === "output_text" && c.text) t += c.text; }
    }
  }
  return t;
}

function parseTags(text, opt) {
  let obj = null;
  const m = text && text.match(/\{[\s\S]*\}/);
  if (m) { try { obj = JSON.parse(m[0]); } catch (e) {} }
  if (!obj) return null;
  const arr = (v, allowed) => (Array.isArray(v) ? v : (typeof v === "string" ? v.split(/[、,，/]/) : []))
    .map((x) => String(x).trim()).filter((x) => (allowed || []).indexOf(x) >= 0);
  const one = (v, allowed) => { const s = Array.isArray(v) ? v[0] : v; const z = String(s || "").trim(); return (allowed || []).indexOf(z) >= 0 ? z : ""; };
  return {
    staple: arr(obj.staple != null ? obj.staple : obj["主食"], opt.staple),
    cuisine: arr(obj.cuisine != null ? obj.cuisine : obj["菜系"], opt.cuisine),
    meals: arr(obj.meals != null ? obj.meals : obj["餐別"], opt.meals),
    price: one(obj.price != null ? obj.price : obj["價位"], opt.price),
  };
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({}, cors, { "Content-Type": "application/json" }) });
}
