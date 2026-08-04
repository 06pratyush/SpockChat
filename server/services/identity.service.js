/**
 * "Where can other machines reach me?"
 *
 * This is the piece that made cross-network friend requests fail in confusing
 * ways: the old code always advertised a LAN IP, so when Alice added Bob through
 * a tunnel, Bob's server stored `http://192.168.1.42:3000` as her address — an
 * address that means nothing on his network. Replies then went nowhere.
 *
 * Now the reachable address is chosen in priority order:
 *   1. PUBLIC_URL from .env, if the operator set one (reverse proxy, DNS name)
 *   2. the live tunnel URL, if a tunnel is currently open
 *   3. the proxy-provided host, if we are behind one and trust it
 *   4. the best non-internal LAN IPv4
 */

const { networkInterfaces } = require('os');
const { config } = require('../config');

let activeTunnelUrl = null;

function setTunnelUrl(url) { activeTunnelUrl = url || null; }
function getTunnelUrl() { return activeTunnelUrl; }

/** All usable IPv4 addresses, best candidate first. */
function localAddresses() {
  const found = [];
  const interfaces = networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name] || []) {
      if (net.family !== 'IPv4' || net.internal) continue;
      found.push({ name, address: net.address, linkLocal: net.address.startsWith('169.254.') });
    }
  }
  // Link-local (169.254.x.x) means DHCP failed; it is a last resort, never first.
  return found.sort((a, b) => Number(a.linkLocal) - Number(b.linkLocal));
}

function localIP() {
  return localAddresses()[0]?.address || 'localhost';
}

/** True when the machine only has a link-local address — a common LAN failure. */
function hasOnlyLinkLocal() {
  const addresses = localAddresses();
  return addresses.length > 0 && addresses.every(a => a.linkLocal);
}

function lanUrl() {
  return `http://${localIP()}:${config.server.port}`;
}

/**
 * @param {import('express').Request} [req] used only when TRUST_PROXY is on
 * @returns {string} an origin other machines can call
 */
function reachableUrl(req = null) {
  if (config.server.publicUrl) return config.server.publicUrl;
  if (activeTunnelUrl) return activeTunnelUrl.replace(/\/+$/, '');

  if (req && config.server.trustProxy) {
    const forwardedHost = req.headers['x-forwarded-host'];
    if (forwardedHost) {
      const proto = req.headers['x-forwarded-proto'] || 'http';
      return `${proto}://${String(forwardedHost).split(',')[0].trim()}`;
    }
  }

  return lanUrl();
}

function describe(req = null) {
  return {
    app: config.app.name,
    version: config.app.version,
    port: config.server.port,
    localUrl: `http://localhost:${config.server.port}`,
    lanUrl: lanUrl(),
    tunnelUrl: activeTunnelUrl,
    reachableUrl: reachableUrl(req),
    interfaces: localAddresses(),
    warnings: hasOnlyLinkLocal()
      ? ['This machine only has a link-local address (169.254.x.x), which means it did not get an IP from the router. Reconnect to Wi-Fi, or other machines will not be able to reach you.']
      : [],
  };
}

module.exports = {
  setTunnelUrl, getTunnelUrl, localIP, localAddresses,
  hasOnlyLinkLocal, lanUrl, reachableUrl, describe,
};
