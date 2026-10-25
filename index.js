// =========================================================================
// ⚙️ ULTIMATE FORCED-CACHE WORKER NODE ENGINE (Manifest + Segment)
// =========================================================================
const ORIGIN_URL = "https://bdix.ottking.top:8082"; 
const BACKEND_TOKEN = "bCO8cs194LW1v1";

// Duplicate request locking map (Single-Flight)
const pendingFetches = new Map();

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname.toLowerCase();

    const isManifest = pathname.endsWith('.m3u8') || pathname.endsWith('.mpd');
    const isSegment = pathname.endsWith('.ts') || pathname.endsWith('.m4a') || pathname.endsWith('.m4s') || pathname.endsWith('.aac');

    if (!isManifest && !isSegment) {
      return new Response("Invalid Endpoint", { status: 403 });
    }

    const backendUrl = new URL(`${ORIGIN_URL}${url.pathname}${url.search}`);
    backendUrl.searchParams.set("token", BACKEND_TOKEN);

    const workerHost = url.hostname; 
    const customUserAgent = `ottking cache cdn 3.0 (${workerHost})`;
    const cache = caches.default;

    // 🎯 Universal Clean Cache Key (Query string ba token bad diye)
    const cleanUrl = new URL(request.url);
    cleanUrl.search = '';
    cleanUrl.hash = '';
    const cacheKeyStr = cleanUrl.toString();
    const cacheKey = new Request(cacheKeyStr, { method: "GET" });

    // 1️⃣ Edge Cache Check (Prothomei cache check korbe)
    let response = await cache.match(cacheKey);
    if (response) {
      const headers = new Headers(response.headers);
      headers.set("CF-Cache-Status", "HIT");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(response.body, { status: response.status, headers });
    }

    // 2️⃣ Single-Flight Check (Same segment duplicate request stop korbe)
    if (pendingFetches.has(cacheKeyStr)) {
      const sharedResponse = await pendingFetches.get(cacheKeyStr);
      const headers = new Headers(sharedResponse.headers);
      headers.set("CF-Cache-Status", "SHARED-HIT");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(sharedResponse.body.clone(), { status: sharedResponse.status, headers });
    }

    // 3️⃣ Fetch from Origin
    const fetchPromise = (async () => {
      return await fetch(backendUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": customUserAgent,
          "Accept": "*/*"
        }
      });
    })();

    pendingFetches.set(cacheKeyStr, fetchPromise);

    try {
      const originResponse = await fetchPromise;

      if (!originResponse.ok) {
        pendingFetches.delete(cacheKeyStr);
        return new Response(`Origin Error: ${originResponse.status}`, { status: originResponse.status });
      }

      let bodyContent = null;
      if (isManifest) {
        let text = await originResponse.text();
        const tokenRegex = new RegExp(`[?&]token=${BACKEND_TOKEN}`, 'g');
        text = text.replace(tokenRegex, '');
        bodyContent = text;
      } else {
        bodyContent = originResponse.body;
      }

      // 🚨 FORCE OVERWRITE HEADERS (Main server-er no-cache ignore korar jonno)
      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", "*");
      
      if (isManifest) {
        headers.set("Content-Type", originResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
        // Manifest-er jonno short cache (jemon 10 second, take live stream update thake kintu main server hit kome jay)
        headers.set("Cache-Control", "public, max-age=10, s-maxage=10");
      } else {
        headers.set("Content-Type", originResponse.headers.get("Content-Type") || "video/MP2T");
        // Segment-er jonno long cache (jemon 300 second ba 5 min)
        headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
      }

      if (originResponse.headers.get("X-Sid")) {
        headers.set("X-Sid", originResponse.headers.get("X-Sid"));
      }
      headers.set("CF-Cache-Status", "MISS");

      const responseToClient = new Response(bodyContent, { status: originResponse.status, headers });
      const responseToCache = responseToClient.clone();

      // 4️⃣ Background Cache Save
      ctx.waitUntil(cache.put(cacheKey, responseToCache));

      return responseToClient;

    } catch (err) {
      return new Response(`Fetch Exception: ${err.message}`, { status: 500 });
    } finally {
      pendingFetches.delete(cacheKeyStr);
    }
  }
};
