import "foo";
import "foo" with {};
import "foo" with { type: "json" };
import foo from "foo" with { type: "json" };
import * as foo2 from "foo" with { "type": "json" };
import { bar } from "foo" with { type: "json" };
import { foo as bar2 } from "foo" with { type: "json" };

export * as foo2 from "foo" with { "type": "json" };
export { bar } from "foo" with { type: "json" };
export { foo as bar2 } from "foo" with { type: "json" };
export * as foo3 from "foo";
export { bar as bar3 } from "foo";
export { foo as bar4 } from "foo";

export { foo };
export var test2 = 5;

import("foo", { with: { type: "json" } });

export default foo;
