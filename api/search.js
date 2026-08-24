const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number(n) || min));
}

function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const toRad = (x) => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function cleanJson(text) {
  const raw = String(text || "").trim();
  try { return JSON.parse(raw); } catch (_) {}
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(raw.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

function simpleInterpretation(prompt) {
  const p = String(prompt || "").trim();
  const distanceMatch = p.match(/(?:within|under|less than|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/i);
  const distanceMiles = distanceMatch ? clamp(distanceMatch[1], 1, 30) : null;
  return {
    summary: p || "something fun nearby",
    searchQueries: [p || "fun things to do", "things to do", "popular places"],
    distanceMiles,
    openNow: /open now|right now|currently open|tonight|late night/i.test(p)
  };
}

async function interpretWithAI(prompt, maxDistanceMiles) {
  const fallback = simpleInterpretation(prompt);
  if (!process.env.GROQ_API_KEY) return fallback;

  const system = `You interpret a user's natural-language request for real-world places near their GPS location.
Return ONLY valid JSON with this shape:
{
  "summary": "short human description of what they want",
  "searchQueries": ["Google Places text query 1", "query 2", "query 3"],
  "distanceMiles": number|null,
  "openNow": boolean
}
Rules:
- Produce 2-3 useful Google Places text queries, most specific first.
- Do NOT put a city/state/country in the query because GPS coordinates are supplied separately.
- Preserve named businesses if the user asks for one.
- Convert vague intent into place categories. Example: "something fun with friends" -> "arcades bowling mini golf", "escape rooms", "entertainment centers".
- If the user gives a distance, extract it. Otherwise null.
- Set openNow true only if the user clearly asks for now/currently/tonight/late-night.
- Never invent a specific business name.`;

  try {
    const response = await fetch(GROQ_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-20b",
        temperature: 0.25,
        max_completion_tokens: 500,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: `Request: ${prompt}\nUI max distance: ${maxDistanceMiles} miles` }
        ]
      })
    });
    if (!response.ok) return fallback;
    const data = await response.json();
    const parsed = cleanJson(data?.choices?.[0]?.message?.content);
    if (!parsed) return fallback;
    const queries = Array.isArray(parsed.searchQueries)
      ? parsed.searchQueries.map(x => String(x || "").trim()).filter(Boolean).slice(0, 3)
      : [];
    return {
      summary: String(parsed.summary || fallback.summary).slice(0, 160),
      searchQueries: queries.length ? queries : fallback.searchQueries,
      distanceMiles: parsed.distanceMiles == null ? fallback.distanceMiles : clamp(parsed.distanceMiles, 1, 30),
      openNow: Boolean(parsed.openNow)
    };
  } catch (_) {
    return fallback;
  }
}

async function googleTextSearch(query, lat, lng, radiusMeters, openNow) {
  const body = {
    textQuery: query,
    pageSize: 20,
    locationBias: {
      circle: {
        center: { latitude: lat, longitude: lng },
        radius: Math.min(50000, Math.max(500, radiusMeters))
      }
    }
  };
  if (openNow) body.openNow = true;

  const r = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": process.env.GOOGLE_MAPS_API_KEY,
      "X-Goog-FieldMask": [
        "places.id",
        "places.displayName",
        "places.formattedAddress",
        "places.location",
        "places.googleMapsUri",
        "places.websiteUri",
        "places.rating",
        "places.userRatingCount",
        "places.priceLevel",
        "places.primaryType",
        "places.businessStatus",
        "places.currentOpeningHours"
      ].join(",")
    },
    body: JSON.stringify(body)
  });

  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`Google Places ${r.status}: ${detail.slice(0, 180)}`);
  }
  return r.json();
}

function mapPlace(place, origin) {
  const lat = place?.location?.latitude;
  const lng = place?.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const name = place?.displayName?.text || "Place";
  const distanceMiles = milesBetween(origin.lat, origin.lng, lat, lng);
  const mapsUri = place.googleMapsUri || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${place.formattedAddress || ""}`)}`;
  return {
    id: place.id || `${lat},${lng}`,
    name,
    address: place.formattedAddress || "Address unavailable",
    lat,
    lng,
    distanceMiles,
    rating: Number.isFinite(place.rating) ? place.rating : null,
    ratingCount: Number.isFinite(place.userRatingCount) ? place.userRatingCount : null,
    priceLevel: place.priceLevel || null,
    type: place.primaryType || null,
    businessStatus: place.businessStatus || null,
    openNow: typeof place?.currentOpeningHours?.openNow === "boolean" ? place.currentOpeningHours.openNow : null,
    mapsUri,
    websiteUri: place.websiteUri || null,
    webSearchUri: `https://www.google.com/search?q=${encodeURIComponent(`${name} ${place.formattedAddress || ""}`)}`
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { prompt, lat, lng, maxDistanceMiles = 10, maxResults = 12 } = req.body || {};
    const text = String(prompt || "").trim();
    const latitude = Number(lat);
    const longitude = Number(lng);

    if (!text) return res.status(400).json({ error: "Tell WhatNow what you want to do." });
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ error: "Your location is required for nearby results." });
    }
    if (!process.env.GOOGLE_MAPS_API_KEY) {
      return res.status(500).json({ error: "GOOGLE_MAPS_API_KEY is not configured on the server." });
    }

    const uiDistance = clamp(maxDistanceMiles, 1, 30);
    const limit = Math.round(clamp(maxResults, 4, 20));
    const ai = await interpretWithAI(text, uiDistance);
    const radiusMiles = ai.distanceMiles ? Math.min(uiDistance, ai.distanceMiles) : uiDistance;
    const radiusMeters = radiusMiles * 1609.344;

    const dedup = new Map();
    const triedQueries = [];
    let lastPlacesError = null;

    for (const query of ai.searchQueries.slice(0, 3)) {
      if (!query || triedQueries.includes(query.toLowerCase())) continue;
      triedQueries.push(query.toLowerCase());
      try {
        const data = await googleTextSearch(query, latitude, longitude, radiusMeters, ai.openNow);
        for (const raw of data.places || []) {
          const p = mapPlace(raw, { lat: latitude, lng: longitude });
          if (!p || p.distanceMiles > radiusMiles) continue;
          const key = p.id || `${p.name.toLowerCase()}|${p.address.toLowerCase()}`;
          if (!dedup.has(key)) dedup.set(key, p);
        }
        if (dedup.size >= limit) break;
      } catch (e) {
        lastPlacesError = e;
      }
    }

    let places = [...dedup.values()]
      .sort((a, b) => {
        const ratingA = a.rating || 0;
        const ratingB = b.rating || 0;
        const scoreA = a.distanceMiles - ratingA * 0.12;
        const scoreB = b.distanceMiles - ratingB * 0.12;
        return scoreA - scoreB;
      })
      .slice(0, limit);

    if (!places.length) {
      try {
        const broad = await googleTextSearch("things to do", latitude, longitude, radiusMeters, false);
        places = (broad.places || [])
          .map(p => mapPlace(p, { lat: latitude, lng: longitude }))
          .filter(Boolean)
          .filter(p => p.distanceMiles <= radiusMiles)
          .sort((a, b) => a.distanceMiles - b.distanceMiles)
          .slice(0, limit);
      } catch (e) {
        lastPlacesError = lastPlacesError || e;
      }
    }

    const mapsFallbackQuery = ai.searchQueries[0] || text;
    const fallbackMapUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapsFallbackQuery)}&query_place_id=`;

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      understood: ai.summary,
      queries: ai.searchQueries,
      radiusMiles,
      places,
      fallbackMapUrl,
      warning: places.length ? null : (lastPlacesError ? "Google Places did not return a usable nearby result." : "No nearby results matched this request.")
    });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "WhatNow search failed. Check the server API keys and try again." });
  }
}
