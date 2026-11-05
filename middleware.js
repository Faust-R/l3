// Vercel Routing Middleware: issues short-lived Cloudflare Realtime TURN credentials at /api/turn.
// The Cloudflare TURN key ID and API token stay in Vercel environment variables and never reach the browser:
//   CLOUDFLARE_TURN_KEY_ID     — "Turn Token ID" of the TURN key (Cloudflare dashboard → Realtime → TURN Server)
//   CLOUDFLARE_TURN_API_TOKEN  — API token of that TURN key
//   TURN_TTL_SECONDS           — optional credential lifetime, default 43200 (12 h)
export const config={matcher:'/api/turn'};

const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json','cache-control':'no-store'}});

export default async function middleware(request){
 if(request.method!=='GET')return json(405,{error:'method'});
 // Browsers mark cross-site requests; refuse them so other sites cannot spend this TURN quota from their pages.
 // "none" = the address was opened directly (useful for checking the setup).
 const site=request.headers.get('sec-fetch-site');
 if(site&&site!=='same-origin'&&site!=='none')return json(403,{error:'origin'});
 const id=process.env.CLOUDFLARE_TURN_KEY_ID,token=process.env.CLOUDFLARE_TURN_API_TOKEN;
 if(!id||!token)return json(503,{error:'not-configured'});
 const ttl=Math.max(600,Math.min(86400,Number(process.env.TURN_TTL_SECONDS)||43200));
 try{
  const response=await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(id)}/credentials/generate-ice-servers`,{
   method:'POST',
   headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
   body:JSON.stringify({ttl}),
   signal:AbortSignal.timeout(8000)
  });
  if(!response.ok)return json(502,{error:'cloudflare-'+response.status});
  const body=await response.json();
  const list=[].concat(body?.iceServers||[]).filter(Boolean).map(server=>({
   ...server,
   // Cloudflare documents that its alternate port 53 is blocked by browsers and only causes timeouts.
   urls:[].concat(server.urls||[]).filter(url=>typeof url==='string'&&!/:53(\?|$)/.test(url))
  })).filter(server=>server.urls.length);
  if(!list.length)return json(502,{error:'cloudflare-empty'});
  return json(200,{iceServers:list,ttl});
 }catch{
  return json(502,{error:'cloudflare-unreachable'});
 }
}
