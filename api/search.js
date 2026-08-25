const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const GEOAPIFY_URL = "https://api.geoapify.com/v2/places";
const ROUTE_MATRIX_URL = "https://api.geoapify.com/v1/routematrix";

const INTENTS = {
  restaurant:{words:["food","eat","restaurant","dinner","lunch","breakfast","brunch","hungry","meal"],geo:["catering.restaurant","catering.fast_food"],osm:[["amenity","restaurant"],["amenity","fast_food"]]},
  pizza:{words:["pizza","pizzeria"],geo:["catering.restaurant.pizza","catering.fast_food.pizza"],osm:[["cuisine","pizza"]]},
  cafe:{words:["coffee","cafe","café","latte","tea"],geo:["catering.cafe","catering.cafe.coffee"],osm:[["amenity","cafe"]]},
  dessert:{words:["dessert","ice cream","donut","bakery","sweet"],geo:["catering.cafe.dessert","catering.cafe.ice_cream","commercial.food_and_drink.bakery"],osm:[["amenity","ice_cream"],["shop","bakery"]]},
  bowling:{words:["bowling","bowl"],geo:["entertainment.bowling_alley"],osm:[["leisure","bowling_alley"]]},
  arcade:{words:["arcade","video games","game place","gaming"],geo:["entertainment.amusement_arcade","commercial.toy_and_game"],osm:[["leisure","amusement_arcade"]]},
  cinema:{words:["movie","movies","cinema","theater","theatre"],geo:["entertainment.cinema"],osm:[["amenity","cinema"]]},
  park:{words:["park","outside","outdoors","walk","nature","scenic","view","trail"],geo:["leisure.park","leisure.park.nature_reserve","tourism.attraction"],osm:[["leisure","park"],["leisure","nature_reserve"],["tourism","viewpoint"]]},
  thrift:{words:["thrift","second hand","secondhand","used store"],geo:["commercial.second_hand"],osm:[["shop","second_hand"]]},
  museum:{words:["museum","gallery","art"],geo:["entertainment.museum","entertainment.culture.gallery"],osm:[["tourism","museum"],["tourism","gallery"]]},
  library:{words:["library","books"],geo:["education.library","commercial.books"],osm:[["amenity","library"],["shop","books"]]},
  gym:{words:["gym","fitness","workout","exercise"],geo:["sport.fitness.fitness_centre","sport.fitness.gym"],osm:[["leisure","fitness_centre"]]},
  mini_golf:{words:["mini golf","minigolf","putt putt"],geo:["entertainment.miniature_golf"],osm:[["leisure","miniature_golf"]]},
  escape_room:{words:["escape room","escape game"],geo:["entertainment.escape_game"],osm:[["leisure","escape_game"]]},
  shopping:{words:["shopping","mall","store","shops"],geo:["commercial.shopping_mall","commercial"],osm:[["shop",null],["shop","mall"]]},
  attraction:{words:["fun","something to do","activity","adventure","entertainment","friends","date idea","cool place","bored"],geo:["entertainment","tourism.attraction","leisure.park"],osm:[["tourism","attraction"],["leisure",null],["amenity","cinema"]]}
};

const FUN_VARIETY_KEYS=["arcade","bowling","mini_golf","escape_room","cinema","museum","park","attraction"];

function clamp(n,min,max){return Math.min(max,Math.max(min,Number(n)||min));}
function milesBetween(lat1,lon1,lat2,lon2){
  const R=3958.8,rad=n=>n*Math.PI/180;
  const dLat=rad(lat2-lat1),dLon=rad(lon2-lon1);
  const a=Math.sin(dLat/2)**2+Math.cos(rad(lat1))*Math.cos(rad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}
function cleanJson(text){
  const raw=String(text||"").trim();
  try{return JSON.parse(raw);}catch(_){}
  const a=raw.indexOf("{"),b=raw.lastIndexOf("}");
  if(a>=0&&b>a){try{return JSON.parse(raw.slice(a,b+1));}catch(_){}}
  return null;
}
function normalizeMode(mode){return ["drive","walk","bicycle"].includes(mode)?mode:"drive";}
function norm(s){return String(s||"").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g," ").trim();}
function detectIntentKeys(prompt){
  const p=prompt.toLowerCase(),hits=[];
  for(const [key,spec] of Object.entries(INTENTS)) if(spec.words.some(w=>p.includes(w))) hits.push(key);
  if(!hits.length) hits.push("attraction");
  if(hits.includes("pizza")) return ["pizza"];
  return [...new Set(hits)].slice(0,3);
}
function simpleInterpretation(prompt){
  const p=String(prompt||"").trim();
  const tm=p.match(/(?:within|under|less than|no more than|about)?\s*(\d+(?:\.\d+)?)\s*(?:min|mins|minute|minutes)\b/i);
  let travelMode=null;
  if(/\b(walk|walking|on foot)\b/i.test(p)) travelMode="walk";
  else if(/\b(bike|biking|bicycle|cycling|cycle)\b/i.test(p)) travelMode="bicycle";
  else if(/\b(drive|driving|car)\b/i.test(p)) travelMode="drive";
  return {summary:p||"something fun nearby",intentKeys:detectIntentKeys(p),maxTravelMinutes:tm?clamp(tm[1],5,90):null,travelMode,openNow:/open now|right now|currently open|tonight|late night/i.test(p)};
}
async function interpretWithAI(prompt){
  const fallback=simpleInterpretation(prompt);
  if(!process.env.GROQ_API_KEY) return fallback;
  const allowed=Object.keys(INTENTS).join(", ");
  const system=`Interpret a request for nearby real-world places. Return ONLY JSON: {"summary":"...","intentKeys":["..."],"maxTravelMinutes":number|null,"travelMode":"drive"|"walk"|"bicycle"|null,"openNow":boolean}. Allowed intentKeys: ${allowed}. Pick 1-3. Never invent business names. Use attraction for vague fun/activity requests. Extract a minute limit only when the user actually gives one.`;
  try{
    const r=await fetch(GROQ_URL,{method:"POST",headers:{Authorization:`Bearer ${process.env.GROQ_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:"openai/gpt-oss-20b",temperature:.2,max_completion_tokens:400,response_format:{type:"json_object"},messages:[{role:"system",content:system},{role:"user",content:prompt}]})});
    if(!r.ok) return fallback;
    const data=await r.json(),j=cleanJson(data?.choices?.[0]?.message?.content);
    if(!j) return fallback;
    const keys=Array.isArray(j.intentKeys)?j.intentKeys.filter(k=>INTENTS[k]).slice(0,3):[];
    return {summary:String(j.summary||fallback.summary).slice(0,180),intentKeys:keys.length?keys:fallback.intentKeys,maxTravelMinutes:j.maxTravelMinutes==null?fallback.maxTravelMinutes:clamp(j.maxTravelMinutes,5,90),travelMode:j.travelMode?normalizeMode(j.travelMode):fallback.travelMode,openNow:Boolean(j.openNow)};
  }catch(_){return fallback;}
}
function withTimeout(promise,ms=8500){return Promise.race([promise,new Promise((_,rej)=>setTimeout(()=>rej(new Error("timeout")),ms))]);}
function sourceQueryLabel(keys){return keys.map(k=>k.replaceAll("_"," ")).join(", ");}
function searchRadiusFor(minutes,mode){
  const metersPerMinute=mode==="walk"?145:mode==="bicycle"?430:1550;
  return Math.min(50000,Math.max(1800,Math.round(minutes*metersPerMinute)));
}
function isBroadFun(keys){return keys.length===1&&keys[0]==="attraction" || keys.includes("attraction")&&keys.length<=2;}
function expandedKeys(keys){return isBroadFun(keys)?FUN_VARIETY_KEYS:[...new Set(keys)];}
function typeBucket(type){
  const t=norm(type);
  if(t.includes("arcade")||t.includes("game")) return "arcade";
  if(t.includes("bowling")) return "bowling";
  if(t.includes("miniature golf")||t.includes("mini golf")) return "mini golf";
  if(t.includes("escape")) return "escape room";
  if(t.includes("cinema")||t.includes("movie")) return "movies";
  if(t.includes("museum")||t.includes("gallery")) return "museum";
  if(t.includes("park")||t.includes("nature")||t.includes("viewpoint")) return "park";
  if(t.includes("restaurant")||t.includes("food")) return "food";
  return t.split(" ").slice(0,2).join(" ")||"other";
}

async function geoapifySearch(keys,lat,lng,radiusMeters,limit){
  if(!process.env.GEOAPIFY_API_KEY) throw new Error("geoapify key missing");
  const categories=[...new Set(keys.flatMap(k=>INTENTS[k]?.geo||[]))].slice(0,18).join(",");
  const u=new URL(GEOAPIFY_URL);
  u.searchParams.set("categories",categories||"entertainment,tourism.attraction");
  u.searchParams.set("filter",`circle:${lng},${lat},${Math.round(radiusMeters)}`);
  u.searchParams.set("bias",`proximity:${lng},${lat}`);
  u.searchParams.set("limit",String(Math.min(60,Math.max(limit*4,28))));
  u.searchParams.set("apiKey",process.env.GEOAPIFY_API_KEY);
  const r=await withTimeout(fetch(u),9000);
  if(!r.ok) throw new Error(`Geoapify ${r.status}`);
  const data=await r.json();
  return (data.features||[]).map(f=>{
    const p=f.properties||{},c=f.geometry?.coordinates||[];
    const lon=Number(c[0]??p.lon),la=Number(c[1]??p.lat);
    if(!Number.isFinite(la)||!Number.isFinite(lon)) return null;
    const name=p.name||p.address_line1||"Place";
    const address=p.formatted||p.address_line2||"Address unavailable";
    const addressKey=norm([p.housenumber,p.street,p.city,p.postcode].filter(Boolean).join(" ")||p.address_line2||address);
    const categories=Array.isArray(p.categories)?p.categories:[];
    return {id:p.place_id||`${la},${lon}`,name,address,addressKey,lat:la,lng:lon,type:categories[0]||"place",categories,websiteUri:p.website||p.datasource?.raw?.website||null};
  }).filter(Boolean);
}
function osmClauses(keys,radius,lat,lng){
  const parts=[],seen=new Set();
  for(const key of keys){
    for(const [tag,val] of (INTENTS[key]?.osm||[])){
      const sig=`${tag}:${val||"*"}`; if(seen.has(sig)) continue; seen.add(sig);
      const filter=val==null?`["${tag}"]`:`["${tag}"="${val}"]`;
      parts.push(`nwr${filter}(around:${radius},${lat},${lng});`);
    }
  }
  return parts.length?parts:[`nwr["tourism"="attraction"](around:${radius},${lat},${lng});`];
}
async function overpassSearch(keys,lat,lng,radiusMeters){
  const query=`[out:json][timeout:8];(${osmClauses(keys,Math.round(radiusMeters),lat,lng).join("")});out center tags;`;
  const endpoints=["https://overpass.private.coffee/api/interpreter","https://overpass-api.de/api/interpreter","https://maps.mail.ru/osm/tools/overpass/api/interpreter"];
  let last;
  for(const ep of endpoints){
    try{
      const r=await withTimeout(fetch(ep,{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8","User-Agent":"WhatNow/2.1"},body:"data="+encodeURIComponent(query)}),7500);
      if(!r.ok) throw new Error(`Overpass ${r.status}`);
      const data=await r.json();
      return (data.elements||[]).map(el=>{
        const la=Number(el.lat??el.center?.lat),lon=Number(el.lon??el.center?.lon),t=el.tags||{};
        if(!Number.isFinite(la)||!Number.isFinite(lon)) return null;
        const name=t.name||t.brand||t.operator; if(!name) return null;
        const address=[t["addr:housenumber"],t["addr:street"],t["addr:city"],t["addr:state"]].filter(Boolean).join(" ")||t["addr:full"]||"Address unavailable";
        const addressKey=norm([t["addr:housenumber"],t["addr:street"],t["addr:city"],t["addr:postcode"]].filter(Boolean).join(" ")||address);
        const type=t.amenity||t.leisure||t.shop||t.tourism||"place";
        return {id:`osm-${el.type}-${el.id}`,name,address,addressKey,lat:la,lng:lon,type,categories:[type],websiteUri:t.website||t["contact:website"]||null};
      }).filter(Boolean);
    }catch(e){last=e;}
  }
  throw last||new Error("Overpass unavailable");
}
function dedupeRaw(raw,origin,radiusMiles,diverse=false){
  const out=[];
  for(const p of raw){
    if(!Number.isFinite(p.lat)||!Number.isFinite(p.lng)) continue;
    const straightMiles=milesBetween(origin.lat,origin.lng,p.lat,p.lng);
    if(straightMiles>radiusMiles) continue;
    const nameKey=norm(p.name),addressKey=p.addressKey||norm(p.address);
    const duplicate=out.some(x=>{
      const separation=milesBetween(x.lat,x.lng,p.lat,p.lng);
      const sameName=nameKey&&nameKey===x._nameKey;
      const sameAddress=addressKey&&addressKey!=="address unavailable"&&addressKey===x._addressKey;
      if(sameName&&separation<0.35) return true;
      if(sameAddress&&separation<0.12) return true;
      if(separation<0.012) return true;
      if(diverse&&separation<0.055) return true;
      return false;
    });
    if(duplicate) continue;
    out.push({...p,straightMiles,_nameKey:nameKey,_addressKey:addressKey,_bucket:typeBucket((p.categories||[]).join(" ")+" "+p.type)});
  }
  return out.slice(0,45);
}
function estimateMinutes(miles,mode){
  if(mode==="walk") return Math.max(2,Math.round((miles/3)*60*1.08));
  if(mode==="bicycle") return Math.max(2,Math.round((miles/12)*60*1.1));
  return Math.max(3,Math.round((miles/28)*60+2));
}
async function addRouteTimes(places,origin,mode){
  if(!places.length) return {places,routeTimeSource:"none"};
  if(process.env.GEOAPIFY_API_KEY){
    try{
      const url=`${ROUTE_MATRIX_URL}?apiKey=${encodeURIComponent(process.env.GEOAPIFY_API_KEY)}`;
      const body={mode,sources:[{location:[origin.lng,origin.lat]}],targets:places.map(p=>({location:[p.lng,p.lat]}))};
      const r=await withTimeout(fetch(url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}),10000);
      if(!r.ok) throw new Error(`Route Matrix ${r.status}`);
      const data=await r.json();
      let row=data.sources_to_targets||[];
      if(Array.isArray(row[0])) row=row[0];
      const routed=places.map((p,i)=>{
        const cell=row[i]||{},seconds=Number(cell.time),distanceMeters=Number(cell.distance);
        if(Number.isFinite(seconds)&&seconds>=0) return {...p,travelMinutes:Math.max(1,Math.round(seconds/60)),routeDistanceMeters:Number.isFinite(distanceMeters)?distanceMeters:null,travelTimeEstimated:false};
        return {...p,travelMinutes:estimateMinutes(p.straightMiles,mode),routeDistanceMeters:null,travelTimeEstimated:true};
      });
      return {places:routed,routeTimeSource:"Geoapify Route Matrix"};
    }catch(_){}
  }
  return {places:places.map(p=>({...p,travelMinutes:estimateMinutes(p.straightMiles,mode),routeDistanceMeters:null,travelTimeEstimated:true})),routeTimeSource:"estimated"};
}
function chooseVaried(sorted,limit,diverse){
  if(!diverse) return sorted.slice(0,limit);
  const chosen=[],leftovers=[],counts=new Map();
  for(const p of sorted){
    const bucket=p._bucket||"other",count=counts.get(bucket)||0;
    if(count<2){chosen.push(p);counts.set(bucket,count+1);}else leftovers.push(p);
    if(chosen.length>=limit) return chosen;
  }
  for(const p of leftovers){if(chosen.length>=limit) break;chosen.push(p);}
  return chosen;
}
function finishPlaces(places,mode,maxMinutes,limit,diverse=false){
  const travelmode=mode==="walk"?"walking":mode==="bicycle"?"bicycling":"driving";
  const sorted=places.filter(p=>Number.isFinite(p.travelMinutes)&&p.travelMinutes<=maxMinutes).sort((a,b)=>a.travelMinutes-b.travelMinutes||a.straightMiles-b.straightMiles);
  return chooseVaried(sorted,limit,diverse).map((p,i)=>({
    id:p.id,name:p.name,address:p.address,lat:p.lat,lng:p.lng,type:p.type,websiteUri:p.websiteUri||null,
    travelMinutes:p.travelMinutes,travelTimeEstimated:p.travelTimeEstimated,routeDistanceMeters:p.routeDistanceMeters||null,bestPick:i===0,
    mapsUri:`https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=${travelmode}`,
    webSearchUri:`https://www.google.com/search?q=${encodeURIComponent(`${p.name} ${p.address||""}`)}`
  }));
}

export default async function handler(req,res){
  if(req.method!=="POST"){res.setHeader("Allow","POST");return res.status(405).json({error:"Method not allowed"});}
  try{
    const {prompt,lat,lng,maxTravelMinutes=20,travelMode="drive",maxResults=12}=req.body||{};
    const text=String(prompt||"").trim(),latitude=Number(lat),longitude=Number(lng);
    if(!text) return res.status(400).json({error:"Tell WhatNow what you want to do."});
    if(!Number.isFinite(latitude)||!Number.isFinite(longitude)) return res.status(400).json({error:"Your location is required."});

    const uiMinutes=clamp(maxTravelMinutes,5,60),limit=Math.round(clamp(maxResults,4,20));
    const ai=await interpretWithAI(text);
    const mode=ai.travelMode||normalizeMode(travelMode);
    const effectiveMinutes=ai.maxTravelMinutes?Math.min(uiMinutes,ai.maxTravelMinutes):uiMinutes;
    const diverse=isBroadFun(ai.intentKeys);
    const searchKeys=expandedKeys(ai.intentKeys);
    const radiusMeters=searchRadiusFor(effectiveMinutes,mode),radiusMiles=radiusMeters/1609.344;

    let raw=[],source="OpenStreetMap",warning=null;
    if(process.env.GEOAPIFY_API_KEY){
      try{raw=await geoapifySearch(searchKeys,latitude,longitude,radiusMeters,limit);source="Geoapify";}catch(_){warning="Geoapify Places had a problem, so I used the OpenStreetMap backup.";}
    }
    if(raw.length<Math.min(12,limit*2)){
      try{
        const osm=await overpassSearch(searchKeys,latitude,longitude,radiusMeters);
        raw=raw.concat(osm);
        if(source==="Geoapify"&&osm.length) source="Geoapify + OpenStreetMap";
        else if(source!=="Geoapify") source="OpenStreetMap";
      }catch(_){if(!raw.length) warning="Live place providers were busy. Use the Maps/web fallbacks below.";}
    }

    const origin={lat:latitude,lng:longitude};
    const candidates=dedupeRaw(raw,origin,radiusMiles,diverse);
    const routed=await addRouteTimes(candidates,origin,mode);
    const places=finishPlaces(routed.places,mode,effectiveMinutes,limit,diverse);
    if(routed.routeTimeSource==="estimated"&&!warning) warning="Travel times are estimated because live routing was unavailable.";

    const query=diverse?"fun things to do":sourceQueryLabel(ai.intentKeys)||text;
    const fallbackMapUrl=`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
    const fallbackWebUrl=`https://www.google.com/search?q=${encodeURIComponent(`${text} near me`)}`;
    res.setHeader("Cache-Control","no-store");
    return res.status(200).json({understood:ai.summary,queries:ai.intentKeys,maxTravelMinutes:effectiveMinutes,travelMode:mode,places,source,routeTimeSource:routed.routeTimeSource,warning:places.length?warning:(warning||`No place matched within ${effectiveMinutes} minutes.`),fallbackMapUrl,fallbackWebUrl,needsGeoapifyKey:!process.env.GEOAPIFY_API_KEY,aiEnabled:Boolean(process.env.GROQ_API_KEY),diversified:diverse});
  }catch(e){
    console.error(e);
    return res.status(500).json({error:"WhatNow search failed. Try again."});
  }
}