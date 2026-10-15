// Kalshi signed client. Run with: node test/kalshi.test.mjs
import { generateKeyPairSync, verify, constants } from "node:crypto";
import { pemToDer, wrapPkcs1ToPkcs8, normalizeKey, signingMessage, importKalshiKey, signKalshi, kalshiHeaders, kalshiAuthConfigured, kalshiFetch } from "../src/kalshi.js";
let pass = 0, fail = 0;
const check = (n, c, x) => { if (c) pass++; else { fail++; console.error("FAIL:", n, x ?? ""); } };

check("message: prefix added, query stripped, method upper-cased", signingMessage("1700000000000", "get", "/markets?series_ticker=KXNFLGAME&limit=5") === "1700000000000GET/trade-api/v2/markets" && signingMessage(1, "POST", "/trade-api/v2/portfolio/balance") === "1POST/trade-api/v2/portfolio/balance");

const ed = generateKeyPairSync("ed25519");
const edPem = ed.privateKey.export({ type: "pkcs8", format: "pem" });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPkcs1 = rsa.privateKey.export({ type: "pkcs1", format: "pem" });
const rsaPkcs8 = rsa.privateKey.export({ type: "pkcs8", format: "pem" });

check("pem: labels parsed, escaped newlines accepted", pemToDer(edPem).label === "PRIVATE KEY" && pemToDer(rsaPkcs1).label === "RSA PRIVATE KEY" && pemToDer(rsaPkcs1.replace(/\n/g, "\\n")).der.length === pemToDer(rsaPkcs1).der.length);
check("normalize: types detected; PKCS#1 wrapped to PKCS#8 byte-for-byte", normalizeKey(edPem).type === "ed25519" && normalizeKey(rsaPkcs8).type === "rsa" && normalizeKey(rsaPkcs1).type === "rsa" && Buffer.compare(Buffer.from(wrapPkcs1ToPkcs8(pemToDer(rsaPkcs1).der)), Buffer.from(pemToDer(rsaPkcs8).der)) === 0);
let threw = false; try { normalizeKey("-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----"); } catch (e) { threw = /unsupported/.test(e.message); } check("normalize: unsupported PEM rejected", threw);

{
  const msg = signingMessage("1700000000000", "GET", "/markets");
  const kEd = await importKalshiKey(edPem);
  const sigEd = Buffer.from(await signKalshi(kEd, msg), "base64");
  check("ed25519: 64-byte signature verifies with the public key", sigEd.length === 64 && verify(null, Buffer.from(msg), ed.publicKey, sigEd) === true);
  const kRsa = await importKalshiKey(rsaPkcs1);
  const sigRsa = Buffer.from(await signKalshi(kRsa, msg), "base64");
  check("rsa (PKCS#1 pem): RSA-PSS/SHA-256/salt=32 signature verifies", sigRsa.length === 256 && verify("sha256", Buffer.from(msg), { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, sigRsa) === true);
  check("rsa: wrong salt length does not verify (sanity)", verify("sha256", Buffer.from(msg), { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 20 }, sigRsa) === false);
}
{
  const env = { KALSHI_API_KEY_ID: " key-123 ", KALSHI_PRIVATE_KEY: edPem };
  check("auth configured only with both secrets", kalshiAuthConfigured(env) && !kalshiAuthConfigured({ KALSHI_API_KEY_ID: "x" }) && !kalshiAuthConfigured({}));
  const h = await kalshiHeaders(env, "GET", "/markets?tickers=A,B", 1700000000123);
  const sig = Buffer.from(h.headers["KALSHI-ACCESS-SIGNATURE"], "base64");
  check("headers: key id trimmed, ms timestamp, signature over the query-less path, UA kept", h.authed && h.keyType === "ed25519" && h.headers["KALSHI-ACCESS-KEY"] === "key-123" && h.headers["KALSHI-ACCESS-TIMESTAMP"] === "1700000000123" && /edgerunner-xvenue/.test(h.headers["user-agent"]) && verify(null, Buffer.from("1700000000123GET/trade-api/v2/markets"), ed.publicKey, sig) === true, JSON.stringify(h.headers));
  const u = await kalshiHeaders({}, "GET", "/markets");
  check("headers: unauthenticated -> identification only", !u.authed && !u.headers["KALSHI-ACCESS-KEY"] && u.headers.accept === "application/json");
  let seen = null; globalThis.fetch = async (url, opts) => { seen = { url: String(url), opts }; return { ok: true, status: 200, json: async () => ({}) }; };
  await kalshiFetch(env, "/markets?limit=1");
  check("fetch: signed GET hits the v2 host", seen.url === "https://api.elections.kalshi.com/trade-api/v2/markets?limit=1" && seen.opts.method === "GET" && !!seen.opts.headers["KALSHI-ACCESS-SIGNATURE"] && seen.opts.body === undefined);
  await kalshiFetch(env, "/portfolio/orders", { method: "POST", body: { a: 1 } });
  check("fetch: POST carries a JSON body and content-type", seen.opts.method === "POST" && seen.opts.body === '{"a":1}' && seen.opts.headers["content-type"] === "application/json");
}
console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
