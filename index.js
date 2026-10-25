// =========================================================================
// ⚙️ ULTIMATE CDN ORIGIN-SHIELD WORKER ENGINE (FORCE CACHE LOCK)
// =========================================================================
const ORIGIN_URL = "https://bdix.ottking.top:8082"; 
const BACKEND_TOKEN = "bCO8cs194LW1v1";

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

    const cache = caches.default;

    // 🎯 PERFECT GLOBAL CACHE KEY (Header/Query neutral Request object)
    const cleanUrl = new URL(request.url);
    cleanUrl.search = '';
    cleanUrl.hash = '';

    // Cache key-te header completely stripped rakha jate edge cache conflict na kore
    const cacheKey = new Request(cleanUrl.toString(), {
      method: "GET"
    });

    // 1️⃣ GLOBAL EDGE CACHE MATCH CHECK
    let cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      const headers = new Headers(cachedResponse.headers);
      headers.set("CF-Cache-Status", "HIT");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(cachedResponse.body, { status: cachedResponse.status, headers });
    }

    // 2️⃣ SINGLE-FLIGHT LOCKING (Concurrent edge fetch prevention)
    const cacheKeyStr = cacheKey.url;
    if (pendingFetches.has(cacheKeyStr)) {
      const sharedResponse = await pendingFetches.get(cacheKeyStr);
      const headers = new Headers(sharedResponse.headers);
      headers.set("CF-Cache-Status", "SHARED-HIT");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(sharedResponse.body.clone(), { status: sharedResponse.status, headers });
    }

    // 3️⃣ ORIGIN FETCH
    const backendUrl = new URL(`${ORIGIN_URL}${url.pathname}${url.search}`);
    backendUrl.searchParams.set("token", BACKEND_TOKEN);

    const workerHost = url.hostname; 
    const customUserAgent = `ottking cdn-shield 5.0 (${workerHost})`;

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
        return new Response(`Origin Down/Error: ${originResponse.status}`, { status: originResponse.status });
      }

      let responseBody;
      if (isManifest) {
        let text = await originResponse.text();
        const tokenRegex = new RegExp(`[?&]token=${BACKEND_TOKEN}`, 'g');
        responseBody = text.replace(tokenRegex, '');
      } else {
        responseBody = originResponse.body;
      }

      // 🚨 STRIP ORIGIN NO-CACHE HEADERS & FORCE PUBLIC CACHE
      const forcedHeaders = new Headers();
      forcedHeaders.set("Access-Control-Allow-Origin", "*");
      forcedHeaders.set("Access-Control-Allow-Headers", "*");
      
      if (isManifest) {
        forcedHeaders.set("Content-Type", originResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
        forcedHeaders.set("Cache-Control", "public, max-age=6, s-maxage=6");
      } else {
        forcedHeaders.set("Content-Type", originResponse.headers.get("Content-Type") || "video/MP2T");
        forcedHeaders.set("Cache-Control", "public, max-age=2592000, s-maxage=2592000, immutable");
      }

      forcedHeaders.set("CF-Cache-Status", "MISS");

      const responseToClient = new Response(responseBody, { 
        status: originResponse.status, 
        headers: forcedHeaders 
      });

      // 4️⃣ MANDATORY CLOUDFLARE EDGE SAVE
      ctx.waitUntil(cache.put(cacheKey, responseToClient.clone()));

      return responseToClient;

    } catch (err) {
      return new Response(`CDN Exception: ${err.message}`, { status: 500 });
    } finally {
      pendingFetches.delete(cacheKeyStr);
    }
  }
};
