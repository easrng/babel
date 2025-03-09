System.register(["foo"], function (_export, _context) {
  "use strict";

  var a;
  return {
    setters: [function (_foo) {
      a = _foo["some imports"];
      _export("some exports", _foo["some imports"]);
    }],
    execute: function () {}
  };
});
