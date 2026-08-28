import test from 'node:test';
import assert from 'node:assert/strict';
import {
  accessHosts,
  bindHostForAccessMode,
  buildAccessUrls,
  normalizeAccessMode,
  parseAccessModeArgs,
  privateIpv4Hosts,
} from '../scripts/access-mode.mjs';

test('access mode defaults safely and parses explicit launcher options', () => {
  assert.equal(normalizeAccessMode(undefined), 'local');
  assert.equal(parseAccessModeArgs([]), null);
  assert.equal(parseAccessModeArgs(['--access=lan']), 'lan');
  assert.equal(parseAccessModeArgs(['--access', 'local']), 'local');
  assert.equal(bindHostForAccessMode('local'), '127.0.0.1');
  assert.equal(bindHostForAccessMode('lan'), '0.0.0.0');
  assert.throws(() => parseAccessModeArgs(['--access=public']), /Unsupported access mode/u);
});

test('LAN access exposes only loopback plus distinct private IPv4 URLs', () => {
  const interfaces = {
    Ethernet: [
      { family: 'IPv4', internal: false, address: '192.168.1.20' },
      { family: 'IPv4', internal: false, address: '8.8.8.8' },
    ],
    WiFi: [
      { family: 'IPv4', internal: false, address: '10.0.0.8' },
      { family: 'IPv6', internal: false, address: 'fd00::1' },
    ],
  };
  assert.deepEqual(privateIpv4Hosts(interfaces), ['10.0.0.8', '192.168.1.20']);
  const hosts = accessHosts('lan', interfaces);
  assert.deepEqual(hosts, ['127.0.0.1', '10.0.0.8', '192.168.1.20']);
  assert.deepEqual(buildAccessUrls({ mode: 'lan', port: 4567, token: 'a b', hosts }), [
    'http://127.0.0.1:4567/#token=a%20b',
    'http://10.0.0.8:4567/#token=a%20b',
    'http://192.168.1.20:4567/#token=a%20b',
  ]);
});
