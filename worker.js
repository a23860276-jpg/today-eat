/**
 * 今天吃什麼？ — 後端代理（Cloudflare Worker）
 *   1) 距離：店名/地址 → 座標（Google Places API New）；前端再算「車程X分鐘內」級距、不存座標
 *   2) AI 分類：以 Google Places 的事實資料為主（類型→主食/菜系、價位等級→價位、營業時間→餐別），
 *      在 Worker 內用程式對應、用完即丟；補不齊的欄位才用「只看店名」的小模型（gpt-5-mini，不開 web search、
 *      不傳任何 Google 資料）→ 既快又便宜，也不把 Google 內容外傳給第三方。
 * 金鑰都藏在這裡，而且只允許你的網站呼叫。
 *
 * Worker → Settings → Variables and Secrets：
 *   GOOGLE_KEY     （Secret）= 你的 Google API 金鑰
 *   OPENAI_KEY     （Secret）= 你的 OpenAI API 金鑰（補漏用，可不設，沒有就只用 Google）
 *   ALLOWED_ORIGIN （Text）  = 你的網站，例  https://a23860276-jpg.github.io
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

/* ---------- 距離 ---------- */
async function geocode(body, env, cors) {
  const q = (body && body.q ? String(body.q) : "").trim();
  if (!q) return json({ error: "empty" }, 400, cors);
  const gbody = { textQuery: q, maxResultCount: 1, languageCode: "zh-TW", regionCode: "TW" };
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    gbody.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 25000 } };
  }
  const fields = body.withArea
    ? "places.location,places.displayName,places.addressComponents"
    : "places.location,places.displayName";
  const r = await placesSearch(gbody, fields, env);
  if (r.err) return json({ error: r.err, status: r.status }, r.status === 401 || r.status === 403 ? r.status : 502, cors);
  const p = r.place;
  if (!p || !p.location) return json({ result: null }, 200, cors);
  let area = "";
  if (body.withArea && Array.isArray(p.addressComponents)) {
    const ac = p.addressComponents.find((c) => (c.types || []).indexOf("administrative_area_level_1") >= 0);
    if (ac) area = ac.longText || ac.shortText || "";
  }
  return json({ result: { lat: p.location.latitude, lng: p.location.longitude, name: (p.displayName && p.displayName.text) || q, area: area } }, 200, cors);
}

/* ---------- 分類：Google 事實為主，店名小模型補漏 ---------- */
async function classify(body, env, cors) {
  const name = (body.name || "").toString().trim();
  if (!name) return json({ error: "empty" }, 400, cors);
  const opt = body.options || {};

  // 1) Google Places 事實資料（locationBias 偏好住家附近 → 自動挑最近的分店）
  let place = null;
  const gbody = { textQuery: name, maxResultCount: 1, languageCode: "zh-TW", regionCode: "TW" };
  if (typeof body.lat === "number" && typeof body.lng === "number") {
    gbody.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 30000 } };
  }
  const r = await placesSearch(gbody, "places.types,places.primaryType,places.priceLevel,places.regularOpeningHours", env);
  if (!r.err) place = r.place;
  const tags = mapGoogleToTags(place, opt);

  // 2) 還有空欄 → 只看店名的小模型補（不傳 Google 任何資料）
  const needLLM = tags.staple.length === 0 || tags.cuisine.length === 0 || tags.meals.length === 0 || !tags.price;
  if (needLLM && env.OPENAI_KEY) {
    try {
      const ai = await nameOnlyLLM(name, body.note || "", body.area || "", opt, env);
      if (ai) {
        if (tags.staple.length === 0) tags.staple = ai.staple;
        if (tags.cuisine.length === 0) tags.cuisine = ai.cuisine;
        if (tags.meals.length === 0) tags.meals = ai.meals;
        if (!tags.price) tags.price = ai.price;
      }
    } catch (e) {}
  }
  return json({ result: tags }, 200, cors);
}

async function placesSearch(gbody, fields, env) {
  const ref = env.ALLOWED_ORIGIN ? env.ALLOWED_ORIGIN.replace(/\/+$/, "") + "/" : "";
  const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
    method: "POST",
    headers: Object.assign(
      { "Content-Type": "application/json", "X-Goog-Api-Key": env.GOOGLE_KEY, "X-Goog-FieldMask": fields },
      ref ? { "Referer": ref } : {}
    ),
    body: JSON.stringify(gbody),
  });
  if (!r.ok) return { err: r.status === 401 || r.status === 403 ? "google-auth" : "google", status: r.status };
  const j = await r.json();
  return { place: (j.places || [])[0] || null };
}

function mapGoogleToTags(p, opt) {
  const out = { staple: [], cuisine: [], meals: [], price: "" };
  if (!p) return out;
  const types = (p.types || []).concat(p.primaryType ? [p.primaryType] : []);
  const T = types.join(" ");
  const keep = (v, allowed) => ((allowed || []).indexOf(v) >= 0 ? v : "");

  // 菜系
  let cuisine = "";
  if (/japanese|ramen|sushi|udon|izakaya|teppanyaki|yakitori|donburi/.test(T)) cuisine = "日式";
  else if (/korean/.test(T)) cuisine = "韓式";
  else if (/thai|vietnamese|indonesian|asian_restaurant/.test(T)) cuisine = "東南亞";
  else if (/italian|pizza|french|spanish|greek|mediterranean|steak|hamburger|american|sandwich|bakery|cafe|coffee|breakfast|brunch|bar_and_grill|diner|bagel|donut|fast_food/.test(T)) cuisine = "西式";
  else if (/chinese|dim_sum|dumpling/.test(T)) cuisine = "中式";
  else if (/indian|mexican|turkish|middle_eastern|lebanese|african/.test(T)) cuisine = "其他";
  if (cuisine) { const k = keep(cuisine, opt.cuisine); if (k) out.cuisine = [k]; }

  // 主食
  const staple = [];
  if (/ramen|udon|noodle/.test(T)) staple.push("麵");
  if (/sushi|donburi|rice/.test(T)) staple.push("飯");
  if (/hot_pot|hotpot|shabu/.test(T)) staple.push("鍋物");
  if (/pizza|hamburger|sandwich|bakery|bagel|donut|breakfast|brunch/.test(T)) staple.push("麵食");
  out.staple = staple.filter((v) => (opt.staple || []).indexOf(v) >= 0);

  // 價位
  const plMap = { PRICE_LEVEL_INEXPENSIVE: "100~200", PRICE_LEVEL_MODERATE: "200~300", PRICE_LEVEL_EXPENSIVE: "300~500", PRICE_LEVEL_VERY_EXPENSIVE: "500以上" };
  const pl = plMap[p.priceLevel] || "";
  if (pl) out.price = keep(pl, opt.price);

  // 餐別（用營業時間推）
  out.meals = mealsFromHours(p.regularOpeningHours, opt.meals);
  return out;
}

function mealsFromHours(oh, allowed) {
  allowed = allowed || [];
  if (!oh || !Array.isArray(oh.periods) || !oh.periods.length) return [];
  let earliest = 48, latest = 0;
  for (const per of oh.periods) {
    const o = per.open || {};
    if (typeof o.hour !== "number") continue;
    const oHr = o.hour;
    const c = per.close;
    let cHr;
    if (!c || typeof c.hour !== "number") cHr = oHr + 24;            // 24小時
    else { cHr = c.hour; if (c.hour < oHr || (c.day != null && o.day != null && c.day !== o.day)) cHr += 24; } // 跨夜
    earliest = Math.min(earliest, oHr);
    latest = Math.max(latest, cHr);
  }
  if (earliest === 48) return [];
  const m = [];
  if (earliest <= 10) m.push("早餐");
  if (earliest <= 13) m.push("午餐");
  if (latest >= 18) m.push("晚餐");
  if (latest >= 22) m.push("宵夜");
  return m.filter((x) => allowed.indexOf(x) >= 0);
}

/* ---------- 只看店名的小模型（補漏，不開搜尋、不傳 Google 資料）---------- */
async function nameOnlyLLM(name, note, area, opt, env) {
  const prompt = [
    "你是台灣餐飲分類助理。根據你的知識判斷（不用上網）。",
    "餐廳：「" + name + "」" + (note ? "（備註：" + note + "）" : "") + "，位於台灣" + (area || "") + "。",
    "只能從下列允許值選，不可自創、不可翻譯：",
    "主食(可多選)：" + (opt.staple || []).join("、"),
    "菜系(可多選)：" + (opt.cuisine || []).join("、"),
    "餐別(可多選)：" + (opt.meals || []).join("、"),
    "價位(單選，人均一餐)：" + (opt.price || []).join("、"),
    '只輸出 JSON：{"staple":[],"cuisine":[],"meals":[],"price":""}',
    "不確定就留空，不要硬填，不要任何其他文字。",
  ].join("\n");
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + env.OPENAI_KEY },
    body: JSON.stringify({ model: "gpt-5-mini", input: prompt }), // 不開 web search
  });
  if (!r.ok) return null;
  const j = await r.json();
  return parseTags(extractText(j), opt);
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
