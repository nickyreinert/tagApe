import assert from 'node:assert/strict';
import { detect, maskRequest, parseRequest } from '../extension/lib/parse.js';

const url = 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view&dl=https%3A%2F%2Fexample.com%2Fcart&dt=Cart&cid=1.2&ep.section=checkout';
assert.equal(detect(url, []), 'ga4');
assert.equal(detect('https://example.com/g/collect?v=1&tid=G-ABC123&en=page_view', []), null);
assert.equal(detect('https://example.com/g/collect?v=2&tid=UA-123&en=page_view', []), null);

const [page] = parseRequest({ url, method: 'GET', body: null }, 'ga4');
assert.equal(page.source, 'ga4');
assert.equal(page.hit_type, 'page_view');
assert.equal(page.measurement_id, 'G-ABC123');
assert.equal(page.page_url, 'https://example.com/cart');
assert.equal(page.page_name, 'Cart');
assert.deepEqual(page.events.map((event) => event.name), ['page_view']);
assert.equal(page.other_params['ep.section'], 'checkout');
assert.equal(page.visitor_ids.cid, '1.2');

const [posted] = parseRequest({
  url: 'https://analytics.example.com/g/collect?v=2&tid=G-ABC123', method: 'POST',
  body: { kind: 'raw', encoding: 'utf8', data: 'en=add_to_cart&dl=https%3A%2F%2Fexample.com%2Fcart&epn.value=24' },
}, 'ga4');
assert.equal(detect('https://analytics.example.com/g/collect?v=2&tid=G-ABC123', []), 'ga4');
assert.equal(posted.hit_type, 'ga4_event');
assert.equal(posted.link_name, 'add_to_cart');
assert.equal(posted.other_params['epn.value'], '24');
assert.equal(posted.parse_status, 'complete');

const [partial] = parseRequest({ url: 'https://example.com/g/collect?v=2&tid=G-ABC123', method: 'POST', body: null }, 'ga4');
assert.equal(partial.parse_status, 'partial');
assert.ok(partial.parse_messages.some((message) => message.includes('body not exposed')));
assert.ok(partial.parse_messages.some((message) => message.includes('event name')));

const uaUrl = 'https://www.google-analytics.com/collect?v=1&tid=UA-123-1&t=event&ec=Video&ea=Play&ev=1&cid=1.2';
assert.equal(detect(uaUrl, []), 'universal');
assert.equal(detect('https://analytics.example.com/r/collect?v=1&tid=UA-123-1&t=pageview', []), 'universal');
const [ua] = parseRequest({ url: uaUrl, method: 'GET', body: null }, 'universal');
assert.equal(ua.measurement_id, 'UA-123-1');
assert.equal(ua.link_name, 'Video:Play');
assert.deepEqual(ua.events, [{ name: 'Video:Play', value: '1', serial: null }]);

const gtmUrl = 'https://www.googletagmanager.com/gtm.js?id=GTM-ABC123';
assert.equal(detect(gtmUrl, []), null);
assert.equal(detect('https://example.com/gtm.js?id=GTM-ABC123', []), null);

const mpUrl = 'https://www.google-analytics.com/mp/collect?measurement_id=G-ABC123&api_secret=do-not-store';
assert.equal(detect(mpUrl, []), 'ga4mp');
const masked = maskRequest({ url: mpUrl, body: { kind: 'raw', encoding: 'utf8', data: JSON.stringify({ client_id: '1.2', events: [{ name: 'purchase', params: { value: 24 } }, { name: 'page_view', params: { page_location: 'https://example.com' } }] }) } }, []);
assert.equal(new URL(masked.url).searchParams.get('api_secret'), '[masked]');
const bodySecret = maskRequest({ url: mpUrl, body: { kind: 'raw', encoding: 'utf8', data: '{"api_secret":"do-not-store"}' } }, []);
assert.equal(JSON.parse(bodySecret.body.data).api_secret, '[masked]');
const mp = parseRequest({ ...masked, method: 'POST' }, 'ga4mp');
assert.deepEqual(mp.map((e) => e.event_type), ['purchase', 'page_view']);
assert.equal(mp[0].measurement_id, 'G-ABC123');
assert.equal(mp[1].page_url, 'https://example.com');
