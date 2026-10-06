// "PocketPay": a tiny built-in demo product with deliberate bugs, used by `--mock` so the whole
// pipeline can be exercised with no API key and no external site.
//
// Planted issues: signup accepts an invalid/empty email, sent money never shows in Recent activity,
// the balance can go negative, and the footer Settings link is a 404.

import { createServer } from 'node:http';

const css = `*{box-sizing:border-box}body{margin:0;font:18px/1.5 -apple-system,Segoe UI,sans-serif;background:#f5f7fb;color:#13203a}
nav{display:flex;gap:28px;align-items:center;padding:18px 48px;background:#fff;border-bottom:1px solid #dde3ee}nav b{font-size:22px;margin-right:auto}
nav a,footer a{color:#3b5bdb;text-decoration:none}main{max-width:760px;margin:70px auto;padding:0 24px}
h1{font-size:46px;line-height:1.1;margin:0 0 16px}p.lead{font-size:20px;color:#41506b}
button,.btn{display:inline-block;background:#3b5bdb;color:#fff;border:0;border-radius:10px;padding:16px 28px;font-size:19px;cursor:pointer;text-decoration:none;margin-top:18px}
input{display:block;width:100%;padding:14px;margin:8px 0 14px;font-size:18px;border:1px solid #b9c3d6;border-radius:8px}
label{font-weight:600}.card{background:#fff;border:1px solid #dde3ee;border-radius:14px;padding:28px;margin:22px 0}
#balance{font-size:54px;font-weight:700}footer{padding:40px 48px;color:#7a869c}#toast{color:#0a8f4d;font-weight:600;min-height:28px}`;

const layout = (title, body, script = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head>
<body><nav><b>PocketPay</b><a href="/">Home</a><a href="/app">Wallet</a></nav>${body}<footer>(c) PocketPay demo &middot; <a href="/settings">Settings</a></footer><script>${script}</script></body></html>`;

const pages = {
  '/': layout('PocketPay - send money instantly', `<main><h1>Send money to anyone, instantly.</h1><p class="lead">PocketPay is a demo wallet. Create an account and send your first $10 in under a minute.</p><a class="btn" id="cta" href="/signup">Get started</a></main>`),
  '/signup': layout('Sign up - PocketPay', `<main><h1>Create your account</h1><form id="f" class="card"><label for="email">Email</label><input id="email" name="email" placeholder="you@example.com"><label for="password">Password</label><input id="password" name="password" type="password"><button id="submit" type="submit">Create account</button></form></main>`,
    `document.getElementById('f').addEventListener('submit', e => { e.preventDefault(); localStorage.setItem('pp', JSON.stringify({email: document.getElementById('email').value, balance: 100, activity: []})); location.assign('/app'); });`),
  '/app': layout('Wallet - PocketPay', `<main><h1 id="hello">Welcome</h1><div class="card"><div>Balance</div><div id="balance">$100.00</div><button id="send">Send $10 to Sam</button><div id="toast"></div></div><div class="card"><h3>Recent activity</h3><ul id="activity"><li>No activity yet</li></ul></div></main>`,
    `const s = JSON.parse(localStorage.getItem('pp') || '{"email":"guest","balance":100}');
document.getElementById('hello').textContent = 'Welcome, ' + (s.email || 'guest');
const show = () => { document.getElementById('balance').textContent = (s.balance < 0 ? '-$' + (-s.balance).toFixed(2) : '$' + s.balance.toFixed(2)); };
show();
document.getElementById('send').addEventListener('click', () => { s.balance -= 10; localStorage.setItem('pp', JSON.stringify(s)); show(); document.getElementById('toast').textContent = 'Sent $10 to Sam'; });`)
};

export async function startDemoSite(port = 0) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    const page = pages[path];
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page ?? layout('Not found', '<main><h1>404</h1><p class="lead">This page could not be found.</p></main>'));
  });
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  const actual = server.address().port;
  return { url: `http://127.0.0.1:${actual}/`, port: actual, close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
