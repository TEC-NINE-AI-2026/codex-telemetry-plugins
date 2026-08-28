import { networkInterfaces } from 'node:os';

export const ACCESS_MODES = new Set(['local', 'lan']);

export function normalizeAccessMode(value, fallback = 'local') {
  const normalized = String(value || fallback).trim().toLowerCase();
  if (!ACCESS_MODES.has(normalized)) throw new Error(`Unsupported access mode: ${value}. Expected local or lan.`);
  return normalized;
}

export function parseAccessModeArgs(args = []) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = String(args[index]);
    if (argument.startsWith('--access=')) return normalizeAccessMode(argument.slice('--access='.length));
    if (argument === '--access') {
      if (index + 1 >= args.length) throw new Error('--access requires local or lan.');
      return normalizeAccessMode(args[index + 1]);
    }
    throw new Error(`Unknown launcher option: ${argument}`);
  }
  return null;
}

export function bindHostForAccessMode(mode) {
  return normalizeAccessMode(mode) === 'lan' ? '0.0.0.0' : '127.0.0.1';
}

export function privateIpv4Hosts(interfaces = networkInterfaces()) {
  const hosts = [];
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (entry?.family !== 'IPv4' || entry.internal || !isPrivateIpv4(entry.address)) continue;
      hosts.push(entry.address);
    }
  }
  return [...new Set(hosts)].sort((left, right) => left.localeCompare(right, 'en', { numeric: true }));
}

export function accessHosts(mode, interfaces) {
  return normalizeAccessMode(mode) === 'lan'
    ? ['127.0.0.1', ...privateIpv4Hosts(interfaces)]
    : ['127.0.0.1'];
}

export function buildAccessUrls({ mode, port, token, hosts }) {
  const resolvedHosts = hosts?.length ? hosts : accessHosts(mode);
  return resolvedHosts.map((host) => `http://${host}:${Number(port)}/#token=${encodeURIComponent(String(token))}`);
}

function isPrivateIpv4(address) {
  const octets = String(address).split('.').map(Number);
  if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false;
  return octets[0] === 10
    || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
    || (octets[0] === 192 && octets[1] === 168);
}
