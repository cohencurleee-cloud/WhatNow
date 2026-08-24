const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEOAPIFY_URL = "https://api.geoapify.com/v2/places";

const INTENTS = {
  restaurant: {
    words: ["food","eat","restaurant","dinner","lunch","breakfast","brunch","hungry","meal"],
    geo: ["catering.restaurant","catering.fast_food"],
    osm: [['amenity','restaurant'],['amenity','fast_food']]
  },
  pizza: {
    words: ["pizza","pizzeria"],
    geo: ["catering.restaurant.pizza","catering.fast_food.pizza"],
    osm: [['cuisine','pizza']]
  },
  cafe: {
    words: ["coffee","cafe","café","latte","tea"],
    geo: ["catering.cafe","catering.cafe.coffee"],
    osm: [['amenity','cafe']]
  },
  dessert: {
    words: ["dessert","ice cream","donut","bakery","sweet"],
    geo: ["catering.cafe.dessert","catering.cafe.ice_cream","commercial.food_and_drink.bakery"],
    osm: [['amenity','ice_cream'],['shop','bakery']]
  },
  bowling: {
    words: ["bowling","bowl"],
    geo: ["entertainment.bowling_alley"],
    osm: [['leisure','bowling_alley']]
  },
  arcade: {
    words: ["arcade","video games","game place","gaming"],
    geo: ["entertainment.amusement_arcade","commercial.toy_and_game"],
    osm: [['leisure','amusement_arcade']]
  },
  cinema: {
    words: ["movie","movies","cinema","theater","theatre"],
    geo: ["entertainment.cinema"],
    osm: [['amenity','cinema']]
  },
  park: {
    words: ["park","outside","outdoors","walk","nature","scenic","view","trail"],
    geo: ["leisure.park","leisure.park.nature_reserve","tourism.attraction"],
    osm: [['leisure','park'],['leisure','nature_reserve'],['tourism','viewpoint']]
  },
  thrift: {
    words: ["thrift","second hand","secondhand","used store"],
    geo: ["commercial.second_hand"],
    osm: [['shop','second_hand']]
  },
  museum: {
    words: ["museum","gallery","art"],
    geo: ["entertainment.museum","entertainment.culture.gallery"],
    osm: [['tourism','museum'],['tourism','gallery']]
  },
  library: {
    words: ["library","books"],
    geo: ["education.library","commercial.books"],
    osm: [['amenity','library'],['shop','books']]
  },
  gym: {
    words: ["gym","fitness","workout","exercise"],
    geo: ["sport.fitness.fitness_centre","sport.fitness.gym"],
    osm: [['leisure','fitness_centre']]
  },
  mini_golf: {
    words: ["mini golf","minigolf","putt putt"],
    geo: ["entertainment.miniature_golf"],
    osm: [['leisure','miniature_golf']]
  },
  escape_room: {
    words: ["escape room","escape game"],
    geo: ["entertainment.escape_game"],
    osm: [['leisure','escape_game']]
  },
  shopping: {
    words: ["shopping","mall","store","shops"],
    geo: ["commercial.shopping_mall","commercial"],
    osm: [['shop',null],['shop','mall']]
  },
  attraction: {
    words: ["fun","something to do","activity","adventure","entertainment","friends","date idea","cool place"],
    geo: ["entertainment","tourism.attraction","leisure.park"],
    osm: [['tourism','attraction'],['leisure',null],['amenity','cinema']]
  }
};

function clamp(n, min, max) { return Math.min(max, Math.max(min, Number(n) || min)); }
function milesBetween(lat1, lon1, lat2, lon2) {
  const R = 3958.8, rad = n => n * Math.PI / 180;
  const dLat = rad(lat2-lat1), dLon = rad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function cleanJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const a = raw.indexOf('{'), b = raw.lastIndexOf('}');
  if (a >= 0 && b > a) { try { return JSON.parse(raw.slice(a,b+1)); } catch (_) {} }
  return null;
}
function detectIntentKeys(prompt) {
  const p = prompt.toLowerCase();
  const hits = [];
  for (const [key, spec] of Object.entries(INTENTS)) {
    if (spec.words.some(w => p.includes(w))) hits.push(key);
  }
  if (!hits.length) hits.push('attraction');
  if (hits.includes('pizza')) return ['pizza'];
  return [...new Set(hits)].slice(0,3);
}
function simpleInterpretation(prompt) {
  const p = String(prompt || '').trim();
  const dm = p.match(/(?:within|under|less than|no more than)?\s*(\d+(?:\.\d+)?)\s*(?:mi|mile|miles)\b/i);
  const distanceMiles = dm ? clamp(dm[1],1,30) : null;
  const intentKeys = detectIntentKeys(p);
  const summary = p || 'something fun nearby';
  return { summary, intentKeys, distanceMiles, openNow:/open now|right now|currently open|tonight|late night/i.test(p) };
}
async function interpretWithAI(prompt) {
  const fallback = simpleInterpretation(prompt);
  if (!process.env.GROQ_API_KEY) return fallback;
  const allowed = Object.keys(INTENTS).join(', ');
  const system = `Interpret a request for nearby real-world places. Return ONLY JSON: {"summary":"...","intentKeys":["..."],"distanceMiles":number|null,"openNow":boolean}. Allowed intentKeys: ${allowed}. Pick 1-3. Never invent business names. Use attraction for vague fun/activity requests.`;
  try {
    const r = await fetch(GROQ_URL,{method:'POST',headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({model:'openai/gpt-oss-20b',temperature:.2,max_completion_tokens:350,response_format:{type:'json_object'},messages:[{role:'system',content:system},{role:'user',content:prompt}]})});
    if (!r.ok) return fallback;
    const data = await r.json();
    const j = cleanJson(data?.choices?.[0]?.message?.content);
    if (!j) return fallback;
    const keys = Array.isArray(j.intentKeys) ? j.intentKeys.filter(k=>INTENTS[k]).slice(0,3) : [];
    return {summary:String(j.summary||fallback.summary).slice(0,180),intentKeys:keys.length?keys:fallback.intentKeys,distanceMiles:j.distanceMiles==null?fallback.distanceMiles:clamp(j.distanceMiles,1,30),openNow:Boolean(j.openNow)};
  } catch (_) { return fallback; }
}
function withTimeout(promise, ms=8500) {
  return Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error('timeout')),ms))]);
}
function sourceQueryLabel(keys) { return keys.map(k=>k.replaceAll('_',' ')).join(', '); }

async function geoapifySearch(keys, lat, lng, radiusMeters, limit) {
  if (!process.env.GEOAPIFY_API_KEY) throw new Error('geoapify key missing');
  const categories = [...new Set(keys.flatMap(k=>INTENTS[k]?.geo||[]))].slice(0,8).join(',');
  const u = new URL(GEOAPIFY_URL);
  u.searchParams.set('categories', categories || 'entertainment,tourism.attraction');
  u.searchParams.set('filter', `circle:${lng},${lat},${Math.round(radiusMeters)}`);
  u.searchParams.set('bias', `proximity:${lng},${lat}`);
  u.searchParams.set('limit', String(Math.min(40,Math.max(limit*2,12))));
  u.searchParams.set('apiKey', process.env.GEOAPIFY_API_KEY);
  const r = await withTimeout(fetch(u),9000);
  if (!r.ok) throw new Error(`Geoapify ${r.status}`);
  const data = await r.json();
  return (data.features||[]).map(f=>{
    const p=f.properties||{}, c=f.geometry?.coordinates||[];
    const lon=Number(c[0]??p.lon), la=Number(c[1]??p.lat);
    if(!Number.isFinite(la)||!Number.isFinite(lon))return null;
    const name=p.name||p.address_line1||'Place';
    return {id:p.place_id||`${la},${lon}`,name,address:p.formatted||p.address_line2||'Address unavailable',lat:la,lng:lon,type:(p.categories||[])[0]||'place',websiteUri:p.website||p.datasource?.raw?.website||null,rating:null,ratingCount:null,openNow:null,priceLevel:null};
  }).filter(Boolean);
}

function osmClauses(keys, radius, lat, lng) {
  const parts=[];
  const seen=new Set();
  for(const key of keys){
    for(const [tag,val] of (INTENTS[key]?.osm||[])){
      const sig=`${tag}:${val||'*'}`; if(seen.has(sig))continue; seen.add(sig);
      const filter=val==null?`["${tag}"]`:`["${tag}"="${val}"]`;
      parts.push(`nwr${filter}(around:${radius},${lat},${lng});`);
    }
  }
  return parts.length?parts:['nwr["tourism"="attraction"](around:'+radius+','+lat+','+lng+');'];
}
async function overpassSearch(keys, lat, lng, radiusMeters) {
  const query=`[out:json][timeout:8];(${osmClauses(keys,Math.round(radiusMeters),lat,lng).join('')});out center tags;`;
  const endpoints=['https://overpass.private.coffee/api/interpreter','https://overpass-api.de/api/interpreter','https://maps.mail.ru/osm/tools/overpass/api/interpreter'];
  let last;
  for(const ep of endpoints){
    try{
      const r=await withTimeout(fetch(ep,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8','User-Agent':'WhatNow/1.0 (nearby-place-finder)'},body:'data='+encodeURIComponent(query)}),7500);
      if(!r.ok)throw new Error(`Overpass ${r.status}`);
      const data=await r.json();
      return (data.elements||[]).map(el=>{
        const la=Number(el.lat??el.center?.lat), lon=Number(el.lon??el.center?.lon), t=el.tags||{};
        if(!Number.isFinite(la)||!Number.isFinite(lon))return null;
        const name=t.name||t.brand||t.operator; if(!name)return null;
        const address=[t['addr:housenumber'],t['addr:street'],t['addr:city'],t['addr:state']].filter(Boolean).join(' ')||t['addr:full']||'Address unavailable';
        return {id:`osm-${el.type}-${el.id}`,name,address,lat:la,lng:lon,type:t.amenity||t.leisure||t.shop||t.tourism||'place',websiteUri:t.website||t['contact:website']||null,rating:null,ratingCount:null,openNow:null,priceLevel:null};
      }).filter(Boolean);
    }catch(e){last=e;}
  }
  throw last||new Error('Overpass unavailable');
}
function enrichPlace(p, origin){
  const d=milesBetween(origin.lat,origin.lng,p.lat,p.lng);
  const mapsUri=`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
  const webSearchUri=`https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.address||''}`)}`;
  return {...p,distanceMiles:d,mapsUri,webSearchUri};
}
function dedupeAndRank(raw, origin, radiusMiles, limit){
  const seen=new Set(), out=[];
  for(const p of raw){
    const x=enrichPlace(p,origin); if(x.distanceMiles>radiusMiles)continue;
    const key=`${x.name.toLowerCase()}|${x.lat.toFixed(4)}|${x.lng.toFixed(4)}`; if(seen.has(key))continue;seen.add(key);out.push(x);
  }
  return out.sort((a,b)=>a.distanceMiles-b.distanceMiles).slice(0,limit);
}

export default async function handler(req,res){
  if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'Method not allowed'});}
  try{
    const {prompt,lat,lng,maxDistanceMiles=10,maxResults=12}=req.body||{};
    const text=String(prompt||'').trim(); const latitude=Number(lat),longitude=Number(lng);
    if(!text)return res.status(400).json({error:'Tell WhatNow what you want to do.'});
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude))return res.status(400).json({error:'Your location is required.'});
    const uiDistance=clamp(maxDistanceMiles,1,30), limit=Math.round(clamp(maxResults,4,20));
    const ai=await interpretWithAI(text); const radiusMiles=ai.distanceMiles?Math.min(uiDistance,ai.distanceMiles):uiDistance; const radiusMeters=radiusMiles*1609.344;
    let raw=[], source='OpenStreetMap', warning=null;
    if(process.env.GEOAPIFY_API_KEY){
      try{raw=await geoapifySearch(ai.intentKeys,latitude,longitude,radiusMeters,limit);source='Geoapify';}catch(e){warning='Geoapify failed, used OpenStreetMap backup.';}
    }
    if(raw.length<Math.min(4,limit)){
      try{const osm=await overpassSearch(ai.intentKeys,latitude,longitude,radiusMeters);raw=raw.concat(osm);if(source!=='Geoapify')source='OpenStreetMap';}catch(e){if(!raw.length)warning='Live place providers were busy. Use the Maps/web fallbacks below.';}
    }
    const places=dedupeAndRank(raw,{lat:latitude,lng:longitude},radiusMiles,limit);
    const query=sourceQueryLabel(ai.intentKeys)||text;
    const fallbackMapUrl=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    const fallbackWebUrl=`https://www.google.com/search?q=${encodeURIComponent(`${text} near me`)}`;
    res.setHeader('Cache-Control','no-store');
    return res.status(200).json({understood:ai.summary,queries:ai.intentKeys,radiusMiles,places,source,warning:places.length?warning:(warning||'No named place matched inside the radius.'),fallbackMapUrl,fallbackWebUrl,needsGeoapifyKey:!process.env.GEOAPIFY_API_KEY,aiEnabled:Boolean(process.env.GROQ_API_KEY)});
  }catch(e){console.error(e);return res.status(500).json({error:'WhatNow search failed. Try again.'});}
}
