import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildNodesFromSource,
  dedupeNodes,
  filterDynamicIPs,
  generateClashConfig,
  generateHomePage,
  handleSubscriptionRequest,
  handleStatusRequest,
  mergeWetestHistory,
  nodeToURI,
  pruneWetestHistory,
  selectBalancedCarrierIPs,
  selectWetestIPs,
} from '../_worker.js';

const UUID = '73392f92-d1ea-4305-882f-7b91acf72fb3';

test('运营商筛选使用集合交集，全部关闭时不返回地址', () => {
  const items = [
    { ip: '1.1.1.1', isp: '移动/联通' },
    { ip: '1.1.1.2', isp: '电信' },
    { ip: '1.1.1.3', isp: '三网' },
  ];
  assert.deepEqual(
    filterDynamicIPs(items, true, false, false, true, false).map(item => item.ip),
    ['1.1.1.1', '1.1.1.3'],
  );
  assert.equal(filterDynamicIPs(items, true, true, false, false, false).length, 0);
});

test('三网选择会轮询运营商而不是被单一来源占满', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => ({ ip: `1.1.1.${i + 1}`, isp: '移动' })),
    { ip: '2.2.2.2', isp: '联通' },
    { ip: '3.3.3.3', isp: '电信' },
  ];
  const picked = selectBalancedCarrierIPs(items, 3);
  assert.deepEqual(picked.map(item => item.isp), ['移动', '联通', '电信']);
});

test('IPv6优先比例与三网均衡可以同时生效', () => {
  const now = new Date().toISOString();
  const items = [
    ...Array.from({ length: 10 }, (_, i) => ({ ip: `2606:4700::${i + 1}`, isp: ['移动', '联通', '电信'][i % 3], lastSeen: now, missingCycles: 0 })),
    ...Array.from({ length: 3 }, (_, i) => ({ ip: `1.1.1.${i + 1}`, isp: ['移动', '联通', '电信'][i], lastSeen: now, missingCycles: 0 })),
  ];
  const picked = selectWetestIPs(items, 10, '', true, true, true, true, true);
  assert.equal(picked.filter(item => item.ip.includes(':')).length, 9);
  assert.equal(picked.filter(item => !item.ip.includes(':')).length, 1);
  const onlyV6Candidates = items.filter(item => item.ip.includes(':'));
  assert.equal(selectWetestIPs(onlyV6Candidates, 10, '', true, true, true, true, true).length, 10);
});

test('普通历史48小时过期，受保护HKG/NRT IPv6最多保留7天', () => {
  const now = Date.now();
  const ago = days => new Date(now - days * 86400000).toISOString();
  const result = pruneWetestHistory([
    { ip: '1.1.1.1', lastSeen: ago(3), missingCycles: 1 },
    { ip: '2606:4700::1', colo: 'NRT', lastSeen: ago(3), missingCycles: 1 },
    { ip: '2606:4700::2', colo: 'HKG', lastSeen: ago(8), missingCycles: 1 },
    { ip: '2.2.2.2', lastSeen: ago(0), missingCycles: 0 },
  ], 500, now);
  assert.deepEqual(result.map(item => item.ip).sort(), ['2.2.2.2', '2606:4700::1'].sort());
});

test('KV合并保存稳定性字段并淘汰过期记录', async () => {
  const values = new Map([['wetest-ip-history-v1', [{ ip: '1.1.1.1', lastSeen: new Date().toISOString(), seenCount: 2, consecutiveSeen: 2, missingCycles: 0 }]]]);
  const kv = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, JSON.parse(value)); },
  };
  const result = await mergeWetestHistory({ WETEST_HISTORY: kv }, [{ ip: '1.1.1.1', isp: '移动' }]);
  assert.equal(result[0].seenCount, 3);
  assert.equal(result[0].consecutiveSeen, 3);
  assert.equal(result[0].missingCycles, 0);
  assert.equal(values.get('wetest-ip-history-v1')[0].seenCount, 3);
  assert.equal(values.get('wetest-status-v1').status, 'ok');
});

test('统一节点模型正确生成IPv6的三种协议及Clash配置', () => {
  const nodes = buildNodesFromSource(
    [{ ip: '2606:4700::1', isp: '电信', colo: 'NRT' }],
    ['vless', 'trojan', 'vmess'], UUID, 'node.example.com', true, '/ws', null,
  );
  assert.equal(nodes.length, 3);
  assert.match(nodeToURI(nodes[0]), /@\[2606:4700::1\]:443/);
  const clash = generateClashConfig(nodes);
  assert.match(clash, /type: vless/);
  assert.match(clash, /type: trojan/);
  assert.match(clash, /type: vmess/);
  assert.match(clash, /server: "2606:4700::1"/);
});

test('语义去重忽略显示名称', () => {
  const nodes = buildNodesFromSource([{ ip: '1.1.1.1', name: 'A' }], ['vless'], UUID, 'node.example.com', true);
  const duplicate = { ...nodes[0], name: 'B' };
  assert.equal(dedupeNodes([nodes[0], duplicate]).length, 1);
});

test('并发订阅的优选域名开关互不串值', async () => {
  const request = new Request(`https://worker.example/${UUID}/sub?domain=node.example.com`);
  const args = [request, {}, UUID, 'node.example.com', '', true, true, true, true, true, true, false, false, true, '/', null];
  const [withoutDomains, withDomains] = await Promise.all([
    handleSubscriptionRequest(...args, false, false, false),
    handleSubscriptionRequest(...args, true, false, false),
  ]);
  const decodeCount = async response => Buffer.from(await response.text(), 'base64').toString('utf8').trim().split('\n').length;
  assert.equal(await decodeCount(withoutDomains), 1);
  assert.equal(await decodeCount(withDomains), 12);
});

test('最终候选可以稳定限制为50个节点', () => {
  const items = Array.from({ length: 70 }, (_, i) => ({ ip: `104.16.${Math.floor(i / 254)}.${(i % 254) + 1}`, name: `N${i}` }));
  const nodes = buildNodesFromSource(items, ['vless'], UUID, 'node.example.com', true);
  assert.equal(dedupeNodes(nodes).slice(0, 50).length, 50);
});

test('公开状态接口只返回汇总信息且不暴露IP明细', async () => {
  const history = [{ ip: '1.1.1.1' }, { ip: '2606:4700::1', colo: 'HKG' }];
  const kv = { async get(key) { return key.includes('status') ? { status: 'ok' } : history; } };
  const response = await handleStatusRequest({ WETEST_HISTORY: kv });
  const payload = await response.json();
  assert.equal(payload.history.total, 2);
  assert.equal(JSON.stringify(payload).includes('1.1.1.1'), false);
});

test('首页包含自动刷新的可视化采集状态卡片', () => {
  const html = generateHomePage('https://url.v1.mk/sub');
  assert.match(html, /id="systemStatusCard"/);
  assert.match(html, /采集状态/);
  assert.match(html, /fetch\('\/status'/);
});
