import "foo";
import "foo" assert {};
import "foo" assert { type: "json" };
import foo from "foo" assert { type: "json" };
import * as foo2 from "foo" assert { "type": "json" };
import { default as bar } from "foo" assert { type: "json" };

export * as foo2 from "foo" assert { "type": "json" };
export { default as bar } from "foo" assert { type: "json" };
export * as foo3 from "foo";
export { default as bar2 } from "foo";

export { foo };
export var test2 = 5;

import("foo", { assert: { type: "json" } });

export default foo;
