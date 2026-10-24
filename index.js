// =========================================================================
// ⚙️ WORKER NODE ENGINE (Wrangler ES Module Format with Custom UA)
// =========================================================================
const ORIGIN_URL = "https://bdix.ottking.top:8082"; 
const BACKEND_TOKEN = "bCO8cs194LW1v1";

// ডুপ্লিকেট রিকোয়েস্ট লকিং ম্যাপ
const pendingFetches = new Map();

export default {
  async fetch(request, env, ctx) {
    // 1. CORS Preflight
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

    // 🎯 কাস্টম ইউজার এজেন্ট তৈরি (মনিটরিংয়ের সুবিধার জন্য)
    // আপনি চাইলে wrangler.toml থেকে env ভেরিয়েবল বা ডোমেইন নাম দিয়েও নোড নাম্বার আলাদা করতে পারেন
    // আপাতত ওয়ার্কারের নিজস্ব হোস্ট বা সাবডোমেইন থেকে নোড আইডি চেনার ব্যবস্থা রাখা হয়েছে
    const workerHost = url.hostname; 
    const customUserAgent = `ottking cache cdn 1.1 (${workerHost})`;

    // 📺 2. Manifest Handling (.m3u8 / .mpd)
    if (isManifest) {
      const originResponse = await fetch(backendUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": customUserAgent, // কাস্টম ইউজার এজেন্ট ইনজেক্ট করা হলো
          "Accept": "*/*"
        }
      });

      if (!originResponse.ok) {
        return new Response(`Origin Error: ${originResponse.status}`, { status: originResponse.status });
      }

      let content = await originResponse.text();
      const tokenRegex = new RegExp(`[?&]token=${BACKEND_TOKEN}`, 'g');
      content = content.replace(tokenRegex, '');

      const headers = new Headers();
      headers.set("Content-Type", originResponse.headers.get("Content-Type") || "application/vnd.apple.mpegurl");
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "no-cache, no-store, must-revalidate, max-age=0");

      return new Response(content, { status: originResponse.status, headers });
    }

    // ⚡ 3. Segment Handling with In-Memory Single Flight + Universal Cache Key
    if (isSegment) {
      const cache = caches.default;
      
      const cleanUrl = new URL(request.url);
      cleanUrl.search = '';
      cleanUrl.hash = '';
      
      const cacheKeyStr = cleanUrl.toString();
      const cacheKey = new Request(cacheKeyStr, { method: "GET" });

      let response = await cache.match(cacheKey);

      if (!response) {
        // একই সেগমেন্টের রিকোয়েস্ট অলরেডি অরিজিনে পেন্ডিং থাকলে নতুন রিকোয়েস্ট না পাঠিয়ে পূর্বের রিকোয়েস্টের প্রমিজ শেয়ার করবে
        if (pendingFetches.has(cacheKeyStr)) {
          const sharedResponse = await pendingFetches.get(cacheKeyStr);
          response = sharedResponse.clone();
        } else {
          const fetchPromise = (async () => {
            const originResponse = await fetch(backendUrl.toString(), {
              method: "GET",
              headers: {
                "User-Agent": customUserAgent, // কাস্টম ইউজার এজেন্ট ইনজেক্ট করা হলো
                "Accept": "*/*"
              }
            });
            return originResponse;
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
            headers.set("Cache-Control", "public, max-age=120, s-maxage=120");
            headers.set("CF-Cache-Status", "MISS");

            response = new Response(originResponse.body, { status: originResponse.status, headers });

            if (originResponse.status === 200) {
              ctx.waitUntil(cache.put(cacheKey, response.clone()));
            }
          } finally {
            pendingFetches.delete(cacheKeyStr);
          }
        }
      } else {
        const headers = new Headers(response.headers);
        headers.set("CF-Cache-Status", "HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        response = new Response(response.body, { status: response.status, headers });
      }

      return response;
    }
  }
};
