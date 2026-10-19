import {readFile} from 'node:fs/promises'

// Only operator-owned runtime bindings may expand media loading. Tenant requests
// cannot add CSP sources, scripts, connections, wildcards, or credential URLs.
export function mediaOrigins(registry){
 const origins=new Set()
 for(const entry of Object.values(registry)){
  const endpoint=entry.infrastructure?.assets?.cdnEndpoint
  if(!endpoint)continue
  const url=new URL(endpoint)
  if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname))))
   throw Error('Runtime media storage requires a credential-free HTTPS or loopback URL')
  origins.add(url.origin)
 }
 return [...origins]
}
export async function loadMediaOrigins(env){
 return env.OPERATIONS_RUNTIMES_FILE?mediaOrigins(JSON.parse(await readFile(env.OPERATIONS_RUNTIMES_FILE,'utf8'))):[]
}
