import assert from 'node:assert/strict';
import test from 'node:test';
import { adoptMethods } from './adoptMethods.js';

test("a panel's methods, getters and setters run on the host's state", () => {
  class Host {
    constructor() {
      this.count = 1;
    }

    own() {
      return 'own';
    }
  }
  class Panel {
    increment(by = 1) {
      this.count += by;
      return this.count;
    }

    get doubled() {
      return this.count * 2;
    }

    set doubled(value) {
      this.count = value / 2;
    }
  }
  adoptMethods(Host, Panel);
  const host = new Host();

  assert.equal(host.increment(2), 3);
  assert.equal(host.doubled, 6);
  host.doubled = 10;
  assert.equal(host.count, 5);
  assert.equal(host.own(), 'own');
  // Adopted members stay unenumerable, like the host's own, and the host keeps
  // its constructor.
  assert.deepEqual(Object.keys(Host.prototype), []);
  assert.equal(Host.prototype.constructor, Host);
});

test('a panel cannot replace a member the host already has', () => {
  class Host {
    render() {}
  }
  class Panel {
    render() {}
  }
  assert.throws(() => adoptMethods(Host, Panel), /Host already has render/);
});
