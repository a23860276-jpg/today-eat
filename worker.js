/**
 * 今天吃什麼？ — 距離查詢代理（Cloudflare Worker）
 *
 * 作用：把前端的「店名 → 座標」查詢轉給 Google Places API (New)。
 *       Google 金鑰藏在這個 Worker 裡（不會出現在前端網頁），而且只允許你的網站呼叫。
 *
 * 部署後要在 Worker → Settings → Variables and Secrets 設定兩個變數：
 *   GOOGLE_KEY      （類型選 Secret）= 你的 Google API 金鑰
 *   ALLOWED_ORIGIN  （類型選 Text）  = 你的網站來源，例如  https://a23860276-jpg.github.io
 *                                     （只到網域，不要結尾斜線、不要路徑）
 *
 * 前端 index.html 最上面的 DISTANCE_PROXY 要改成這個 Worker 的網址。
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

    // 只接受來自你自己網站的請求
    const origin = request.headers.get("Origin") || "";
    if (allow && origin && origin !== allow) return json({ error: "forbidden" }, 403, cors);

    let body;
    try { body = await request.json(); } catch (e) { return json({ error: "bad-json" }, 400, cors); }
    const q = (body && body.q ? String(body.q) : "").trim();
    if (!q) return json({ error: "empty" }, 400, cors);

    const gbody = { textQuery: q, maxResultCount: 1, languageCode: "zh-TW", regionCode: "TW" };
    if (typeof body.lat === "number" && typeof body.lng === "number") {
      gbody.locationBias = { circle: { center: { latitude: body.lat, longitude: body.lng }, radius: 25000 } };
    }

    // 帶上 Referer，讓你 Google 金鑰原本的「網站限制」仍然通過（不必更動金鑰設定）
    const ref = allow ? allow.replace(/\/+$/, "") + "/" : "";
    const r = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: Object.assign(
        {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": env.GOOGLE_KEY,
          "X-Goog-FieldMask": "places.location,places.displayName",
        },
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
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), { status, headers: Object.assign({}, cors, { "Content-Type": "application/json" }) });
}
