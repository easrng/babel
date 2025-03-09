System.register(["foo", "foo"], function (_export, _context) {
  "use strict";

  var foo, foo2, bar, test2;
  return {
    setters: [function (_foo) {
      _export({
        foo3: _foo,
        bar2: _foo.default
      });
    }, function (_foo2) {
      foo = _foo2.default;
      foo2 = _foo2;
      bar = _foo2.default;
      _export({
        foo2: _foo2,
        bar: _foo2.default,
        foo: _foo2.default
      });
    }],
    execute: function () {
      _export("test2", test2 = 5);
      _context.import("foo", {
        assert: {
          type: "json"
        }
      });
      _export("default", foo);
    }
  };
}, [void 0, {
  assert: {
    "type": "json"
  }
}]);
