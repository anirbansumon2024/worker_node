// =========================================================================
// ⚙️ ADVANCED AGGRESSIVE CACHE WORKER NODE (Manifest + Segment Caching)
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

    const backendUrl = new URL(`${ORIGIN_URL}${url.pathname}${url.search}`);
    backendUrl.searchParams.set("token", BACKEND_TOKEN);

    const workerHost = url.hostname; 
    const customUserAgent = `ottking cache cdn 2.0 (${workerHost})`;
    const cache = caches.default;

    // =========================================================================
    // 📺 1. MANIFEST HANDLING WITH AGGRESSIVE CACHING (.m3u8 / .mpd)
    // =========================================================================
    if (isManifest) {
      // Manifest-er khetreo query string ba token bad diye clean cache key toiri kora
      const cleanUrl = new URL(request.url);
      cleanUrl.search = '';
      cleanUrl.hash = '';
      
      const cacheKey = new Request(cleanUrl.toString(), { method: "GET" });
      let response = await cache.match(cacheKey);

      if (response) {
        const headers = new Headers(response.headers);
        headers.set("CF-Cache-Status", "HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, { status: response.status, headers });
      }

      // Single-flight for manifest to prevent simultaneous hits
      if (pendingFetches.has(cacheKey.url)) {
        const sharedResponse = await pendingFetches.get(cacheKey.url);
        const headers = new Headers(sharedResponse.headers);
        headers.set("CF-Cache-Status", "SHARED-HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(sharedResponse.body.clone(), { status: sharedResponse.status, headers });
      }

      const fetchPromise = (async () => {
        return await fetch(backendUrl.toString(), {
          method: "GET",
          headers: { "User-Agent": customUserAgent, "Accept": "*/*" }
        });
      })();

      pendingFetches.set(cacheKey.url, fetchPromise);

      try {
        const originResponse = await fetchPromise;
        if (!originResponse.ok) {
          return new Response(`Origin Error: ${originResponse.status}`, { status: originResponse.status });
        }

        let content = await originResponse.text();
        const tokenRegex = new RegExp(`[?&]token=${BACKEND_TOKEN}`, 'g');
        content = content.replace(tokenRegex, '');

        const headers = new Headers();
        headers.set("Content-Type", originResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
        headers.set("Access-Control-Allow-Origin", "*");
        // Manifest-keo alpo shomoyer jonno cache kora (jemon 4 second, jate bar bar origin-e na jay)
        headers.set("Cache-Control", "public, max-age=4, s-maxage=4");
        headers.set("CF-Cache-Status", "MISS");

        const responseToClient = new Response(content, { status: originResponse.status, headers });
        ctx.waitUntil(cache.put(cacheKey, responseToClient.clone()));

        return responseToClient;
      } finally {
        pendingFetches.delete(cacheKey.url);
      }
    }

    // =========================================================================
    // ⚡ 2. SEGMENT HANDLING WITH PERMANENT CACHE & SINGLE-FLIGHT (.ts/.m4s)
    // =========================================================================
    if (isSegment) {
      const cleanUrl = new URL(request.url);
      cleanUrl.search = '';
      cleanUrl.hash = '';
      
      const cacheKeyStr = cleanUrl.toString();
      const cacheKey = new Request(cacheKeyStr, { method: "GET" });

      // K) Cache Check
      let response = await cache.match(cacheKey);
      if (response) {
        const headers = new Headers(response.headers);
        headers.set("CF-Cache-Status", "HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, { status: response.status, headers });
      }

      // Kh) Single-Flight Check
      if (pendingFetches.has(cacheKeyStr)) {
        const sharedResponse = await pendingFetches.get(cacheKeyStr);
        const headers = new Headers(sharedResponse.headers);
        headers.set("CF-Cache-Status", "SHARED-HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(sharedResponse.body.clone(), { status: sharedResponse.status, headers });
      }

      // G) Fetch from Origin
      const fetchPromise = (async () => {
        return await fetch(backendUrl.toString(), {
          method: "GET",
          headers: { "User-Agent": customUserAgent, "Accept": "*/*" }
        });
      })();

      pendingFetches.set(cacheKeyStr, fetchPromise);

      try {
        const originResponse = await fetchPromise;
        if (!originResponse.ok) {
          return new Response(`Segment Error: ${originResponse.status}`, { status: originResponse.status });
        }

        const headers = new Headers();
        headers.set("Content-Type", originResponse.headers.get("Content-Type") || "video/MP2T");
        headers.set("Access-Control-Allow-Origin", "*");
        // Segment-er cache time bariye dewa holo (jemon 300 second ba 5 min), jate notun IP theke ashleo cache thake
        headers.set("Cache-Control", "public, max-age=300, s-maxage=300");
        headers.set("CF-Cache-Status", "MISS");

        const responseToClient = new Response(originResponse.body, { status: originResponse.status, headers });
        const responseToCache = responseToClient.clone();

        ctx.waitUntil(cache.path ? cache.put(cacheKey, responseToCache) : cache.put(cacheKey, responseToCache));

        return responseToClient;
      } catch (err) {
        return new Response(`Fetch Exception: ${err.message}`, { status: 500 });
      } finally {
        pendingFetches.delete(cacheKeyStr);
      }
    }
  }
};
