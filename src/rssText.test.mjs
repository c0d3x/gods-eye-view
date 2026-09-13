import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeRssText } from '../vite.config.js';

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
