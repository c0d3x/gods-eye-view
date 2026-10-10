import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSyntheticCctvSvg } from '../../server/providers/cctv/media.js';
import { decodeRssText } from '../../server/providers/regional/news.js';
import { aisKeyFingerprint } from '../../server/providers/vessels/ais-live.js';
import { createDebugSessionId } from '../voice/realtimeDiagnostics.js';

test('RSS text is decoded once, with tags dropped and whitespace collapsed', () => {
  assert.equal(
    decodeRssText('Tom &amp; Jerry &quot;live&quot; &#39;now&#39;'),
    'Tom & Jerry "live" \'now\'',
  );
  assert.equal(
    decodeRssText('<![CDATA[Breaking: <b>storm</b> nears]]>'),
    'Breaking: storm nears',
  );
  assert.equal(
    decodeRssText('&lt;p&gt;Hello&lt;/p&gt;\n  world'),
    'Hello world',
  );
  // Escaped twice, the text is decoded once: the entity survives as text
  // instead of turning into a tag.
  assert.equal(
    decodeRssText('AT&amp;amp;T &amp;lt;b&amp;gt;'),
    'AT&amp;T &lt;b&gt;',
  );
  assert.equal(decodeRssText(undefined), '');
});

test('the AIS key fingerprint moves when the key does, and never carries the key', (t) => {
  const saved = process.env.AISSTREAM_API_KEY;
  t.after(() => {
    if (saved === undefined) delete process.env.AISSTREAM_API_KEY;
    else process.env.AISSTREAM_API_KEY = saved;
  });

  delete process.env.AISSTREAM_API_KEY;
  assert.equal(aisKeyFingerprint(), null);

  process.env.AISSTREAM_API_KEY = 'secret-key-a';
  const first = aisKeyFingerprint();
  assert.match(first, /^key-\d+$/);
  assert.equal(aisKeyFingerprint(), first, 'the same key keeps its name');

  process.env.AISSTREAM_API_KEY = 'secret-key-b';
  const second = aisKeyFingerprint();
  assert.match(second, /^key-\d+$/);
  assert.notEqual(second, first, 'a new key gets a new name');
});

test('the synthetic CCTV frame is stamped to the second, ending in Z', () => {
  const svg = buildSyntheticCctvSvg({ cameraId: 'cam-1', label: 'Test' });
  assert.match(svg, />\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z</);
});

test('debug session ids come from the crypto random source', (t) => {
  const random = t.mock.method(Math, 'random', () => {
    throw new Error('Math.random must not be used');
  });
  const ids = new Set(Array.from({ length: 20 }, createDebugSessionId));
  assert.equal(random.mock.callCount(), 0);
  assert.equal(ids.size, 20);
  for (const id of ids) assert.match(id, /^gev-[0-9a-z]+-[0-9a-f]{12}$/);
});
