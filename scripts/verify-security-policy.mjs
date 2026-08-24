import { readFileSync } from "node:fs";

const expectedProduction = new Map([
  ["default-src", ["'none'"]],
  ["base-uri", ["'none'"]],
  ["object-src", ["'none'"]],
  ["script-src", ["'self'", "'wasm-unsafe-eval'"]],
  ["style-src", ["'self'"]],
  ["img-src", ["'self'"]],
  ["connect-src", ["'self'", "https://backend.telecrypt.io", "https://backend.stage.telecrypt.io"]],
  ["form-action", ["'self'"]],
]);

function parsePolicy(policy) {
  const directives = new Map();
  for (const rawDirective of policy.split(";")) {
    const fields = rawDirective.trim().split(/\s+/u).filter(Boolean);
    if (fields.length === 0) continue;
    const [name, ...sources] = fields;
    if (!/^[a-z][a-z-]*$/u.test(name) || directives.has(name)) {
      throw new Error(`CSP contains an invalid or duplicate directive: ${name}`);
    }
    directives.set(name, sources);
  }
  return directives;
}

function requireExactPolicy(actual, expected) {
  if (actual.size !== expected.size) throw new Error("CSP contains an unexpected directive set");
  for (const [name, sources] of expected) {
    if (JSON.stringify(actual.get(name)) !== JSON.stringify(sources)) {
      throw new Error(`CSP directive does not match the exact contract: ${name}`);
    }
  }
}

const indexHtml = readFileSync("index.html", "utf8");
const matches = [...indexHtml.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/giu)];
if (matches.length !== 1) throw new Error("index.html must contain exactly one CSP meta policy");
requireExactPolicy(parsePolicy(matches[0][1]), expectedProduction);

const viteConfig = readFileSync("vite.config.ts", "utf8");
for (const exact of [
  `"connect-src 'self' https://backend.telecrypt.io https://backend.stage.telecrypt.io;";`,
  `"connect-src 'self' http://localhost:* ws://localhost:*;";`,
]) {
  if (!viteConfig.includes(exact)) {
    throw new Error("Vite development CSP transform differs from its exact contract");
  }
}
if (!viteConfig.includes("return html.replace(productionConnectSrc, developmentConnectSrc);")) {
  throw new Error("Vite must replace only the exact production connect-src directive in development");
}
