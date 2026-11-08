/** Runs only inside the existing desktop capsule; the host independently authenticates and bounds every request. */
export const HOST_LOCAL_PREVIEW_PROXY = String.raw`
import http from 'node:http';
import net from 'node:net';
let input = '';
let initialized = false;
let stopping = false;
let server;
let deadline;
let parentWatch;
const sockets = new Set();
function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  clearInterval(parentWatch);
  for (const socket of sockets) socket.destroy();
  if (server) server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.stdin.on('data', chunk => {
  if (initialized) return;
  input += chunk;
  if (Buffer.byteLength(input) > 2048) process.exit(1);
  const newline = input.indexOf('\n');
  if (newline < 0) return;
  initialized = true;
  let config;
  try { config = JSON.parse(input.slice(0, newline)); } catch { process.exit(1); }
  input = '';
  if (!/^[a-z0-9-]+\.sock$/.test(config.socketName) ||
      !/^[A-Za-z0-9_-]{43}$/.test(config.nonce) ||
      !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) process.exit(1);
  const remaining = Date.parse(config.expiresAt) - Date.now();
  if (!(remaining > 0 && remaining <= 14400000)) process.exit(1);
  process.chdir(process.env.HOME);
  const socketPath = config.socketName;
  const headers = request => {
    const output = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (name !== 'x-octant-preview-key' && name !== 'host' && !name.startsWith('x-forwarded-') && name !== 'forwarded') output[name] = value;
    }
    output['x-octant-preview-key'] = config.nonce;
    return output;
  };
  const own = socket => {
    if (stopping || sockets.size >= 16) { socket.destroy(); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  };
  server = http.createServer({maxHeaderSize:16384}, (request, response) => {
    const upstream = http.request({socketPath, method:request.method, path:request.url, headers:headers(request)}, answered => {
      response.writeHead(answered.statusCode || 502, answered.headers);
      answered.pipe(response);
      answered.on('error', () => response.destroy());
    });
    upstream.on('error', () => { if (!response.headersSent) response.writeHead(502).end('Preview unavailable.'); else response.destroy(); });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  });
  server.maxHeadersCount = 64;
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.on('connection', own);
  server.on('upgrade', (request, socket, head) => {
    const upstream = net.connect({path:socketPath});
    own(upstream);
    upstream.once('connect', () => {
      upstream.write(request.method + ' ' + request.url + ' HTTP/1.1\r\n' +
        Object.entries(headers(request)).map(([name,value]) => name + ': ' + value).join('\r\n') + '\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
    socket.on('close', () => upstream.destroy());
  });
  server.once('error', () => process.exit(1));
  server.listen(config.port, '127.0.0.1', () => process.stdout.write('ready ' + config.port + '\n'));
  deadline = setTimeout(stop, remaining);
  const parent = process.ppid;
  parentWatch = setInterval(() => { if (process.ppid !== parent) stop(); }, 1000);
});
process.stdin.on('end', () => { if (!initialized) process.exit(1); });
`;
