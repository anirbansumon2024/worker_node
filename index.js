// =========================================================================
// ⚙️ WORKER NODE ENGINE (Strict Single-Flight & Force Cache)
// =========================================================================
const ORIGIN_URL = "https://bdix.ottking.top:8082"; 
const BACKEND_TOKEN = "bCO8cs194LW1v1";

// গ্লোবাল ডুপ্লিকেট রিকোয়েস্ট লকিং ম্যাপ (Single-Flight)
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

    const workerHost = url.hostname; 
    const customUserAgent = `ottking cache cdn 1.1 (${workerHost})`;

    // 📺 2. Manifest Handling (.m3u8 / .mpd)
    if (isManifest) {
      const originResponse = await fetch(backendUrl.toString(), {
        method: "GET",
        headers: {
          "User-Agent": customUserAgent,
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

    // ⚡ 3. Strict Segment Handling with Force Cache & Single-Flight
    if (isSegment) {
      const cache = caches.default;
      
      // ইউনিক ক্যাশ কি তৈরি (কুয়েরি স্ট্রিং বা টোকেন বাদ দিয়ে)
      const cleanUrl = new URL(request.url);
      cleanUrl.search = '';
      cleanUrl.hash = '';
      
      const cacheKeyStr = cleanUrl.toString();
      const cacheKey = new Request(cacheKeyStr, { method: "GET" });

      // ক) প্রথমে ক্লাউডফ্লেয়ার এজ ক্যাশ চেক করা
      let response = await cache.match(cacheKey);

      if (response) {
        // ক্যাশ হিট হলে অরিজিনে যাওয়ার কোনো প্রশ্নই নেই
        const headers = new Headers(response.headers);
        headers.set("CF-Cache-Status", "HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(response.body, { status: response.status, headers });
      }

      // খ) ক্যাশ মিস হলে সিঙ্গেল-ফ্লাইট লকিং চেক করা
      if (pendingFetches.has(cacheKeyStr)) {
        // ইতিমধ্যে সেইম সেগমেন্টের রিকোয়েস্ট অরিজিনে روان রয়েছে, তাই নতুন রিকোয়েস্ট না পাঠিয়ে আগেরটার রেসপন্স ক্লোন করে দেওয়া হবে
        const sharedResponse = await pendingFetches.get(cacheKeyStr);
        const headers = new Headers(sharedResponse.headers);
        headers.set("CF-Cache-Status", "SHARED-HIT");
        headers.set("Access-Control-Allow-Origin", "*");
        return new Response(sharedResponse.body.clone(), { status: sharedResponse.status, headers });
      }

      // গ) যদি ক্যাশ বা রানিং প্রমিজ দুটোর কোনটা-ই না থাকে, তবে এক্সাক্টলি মাত্র ১টি রিকোয়েস্ট অরিজিনে যাবে
      const fetchPromise = (async () => {
        const originResponse = await fetch(backendUrl.toString(), {
          method: "GET",
          headers: {
            "User-Agent": customUserAgent,
            "Accept": "*/*"
          }
        });
        return originResponse;
      })();

      pendingFetches.set(cacheKeyStr, fetchPromise);

      try {
        const originResponse = await fetchPromise;

        if (!originResponse.ok) {
          pendingFetches.delete(cacheKeyStr);
          return new Response(`Segment Error: ${originResponse.status}`, { status: originResponse.status });
        }

        // রেসপন্স হেডার রি-রাইট করে ফোর্সেবল ক্যাশ এনাবল করা
        const headers = new Headers();
        headers.set("Content-Type", originResponse.headers.get("Content-Type") || "video/MP2T");
        headers.set("Access-Control-Allow-Origin", "*");
        // ব্রাউজার এবং ক্লাউডফ্লেয়ার এজের জন্য ক্যাশ টাইম বাড়িয়ে দেওয়া হলো (যেমন: ৩ মিনিট বা ১৮০ সেকেন্ড)
        headers.set("Cache-Control", "public, max-age=180, s-maxage=180");
        headers.set("CF-Cache-Status", "MISS");

        const responseToClient = new Response(originResponse.body, { status: originResponse.status, headers });
        const responseToCache = responseToClient.clone();

        // ব্যাকগ্রাউন্ডে ক্লাউডফ্লেয়ার ক্যাশে সেভ করে দেওয়া
        ctx.waitUntil(cache.put(cacheKey, responseToCache));

        return responseToClient;

      } catch (err) {
        return new Response(`Fetch Exception: ${err.message}`, { status: 500 });
      } finally {
        // কাজ শেষ হলে ম্যাপ থেকে রিমুভ করে দেওয়া যাতে মেমরি লিক না হয়
        pendingFetches.delete(cacheKeyStr);
      }
    }
  }
};
