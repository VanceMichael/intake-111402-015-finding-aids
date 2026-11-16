import {createServer} from 'node:http';

const FILTERS = {
  originals:record => record.acquisition?.holdsOriginal === true,
  catalog:record => record.acquisition?.catalogOnly === true,
  restricted:record => record.acquisition?.hasRestrictedObjects === true
};

export async function createApi(archive,port = 0) {
  const server = createServer(async (request,response) => {
    try {
      const url = new URL(request.url,'http://127.0.0.1');
      if (request.method !== 'GET') {response.writeHead(404);return response.end();}
      const send = (status,body) => {
        response.writeHead(status,{'content-type':'application/json; charset=utf-8'});
        response.end(JSON.stringify(body,null,2));
      };
      if (url.pathname === '/health') return send(200,{status:'ok'});
      if (url.pathname === '/records') return send(200,await archive.list());
      if (url.pathname === '/entries') {
        let entries = await archive.entries();
        const filter = url.searchParams.get('status');
        if (filter) {
          const predicate = FILTERS[filter];
          if (!predicate) return send(400,{error:'unknown status filter',allowed:Object.keys(FILTERS)});
          entries = entries.filter(predicate);
        }
        const guide = url.searchParams.get('guide');
        if (guide) entries = entries.filter(entry => entry.guideId === guide);
        return send(200,entries);
      }
      const history = url.pathname.match(/^\/entries\/([^/]+)\/history$/);
      if (history) return send(200,await archive.history(decodeURIComponent(history[1])));
      response.writeHead(404);response.end();
    } catch(error) {response.writeHead(500);response.end(JSON.stringify({error:error.message}));}
  });
  await new Promise((resolve,reject) => {server.once('error',reject);server.listen(port,'0.0.0.0',resolve);});
  return {origin:`http://127.0.0.1:${server.address().port}`,close:() => new Promise(resolve => server.close(resolve))};
}
