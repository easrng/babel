import { declare } from "@babel/helper-plugin-utils";
import { template, types as t } from "@babel/core";
import type { PluginPass, NodePath, Scope, Visitor } from "@babel/core";
import { getModuleName, rewriteThis } from "@babel/helper-module-transforms";
import type { PluginOptions } from "@babel/helper-module-transforms";
import { isIdentifierName } from "@babel/helper-validator-identifier";

const buildTemplate = template.statement(`
  SYSTEM_REGISTER(MODULE_NAME, SOURCES, function (EXPORT_IDENTIFIER, CONTEXT_IDENTIFIER) {
    "use strict";
    BEFORE_BODY;
    return {
      setters: SETTERS,
      execute: EXECUTE,
    };
  }, METAS);
`);

const buildExportAll = template.statement(`
  for (var KEY in TARGET) {
    if (KEY !== "default") EXPORT_OBJ[KEY] = TARGET[KEY];
  }
`);

const MISSING_PLUGIN_WARNING = `\
WARNING: Dynamic import() transformation must be enabled using the
         @babel/plugin-transform-dynamic-import plugin. Babel 8 will
         no longer transform import() without using that plugin.
`;

const MISSING_PLUGIN_ERROR = `\
ERROR: Dynamic import() transformation must be enabled using the
       @babel/plugin-transform-dynamic-import plugin. Babel 8
       no longer transforms import() without using that plugin.
`;

//todo: use getExportSpecifierName in `helper-module-transforms` when this library is refactored to NodePath usage.

export function getExportSpecifierName(
  node: t.Node,
  stringSpecifiers: Set<string>,
): string {
  if (node.type === "Identifier") {
    return node.name;
  } else if (node.type === "StringLiteral") {
    const stringValue = node.value;
    // add specifier value to `stringSpecifiers` only when it can not be converted to an identifier name
    // i.e In `import { "foo" as bar }`
    // we do not consider `"foo"` to be a `stringSpecifier` because we can treat it as
    // `import { foo as bar }`
    // This helps minimize the size of `stringSpecifiers` and reduce overhead of checking valid identifier names
    // when building transpiled code from metadata
    if (!isIdentifierName(stringValue)) {
      stringSpecifiers.add(stringValue);
    }
    return stringValue;
  } else {
    throw new Error(
      `Expected export specifier to be either Identifier or StringLiteral, got ${node.type}`,
    );
  }
}

type PluginState = {
  contextIdent: string;
  // List of names that should only be printed as string literals.
  // i.e. `import { "any unicode" as foo } from "some-module"`
  // `stringSpecifiers` is Set(1) ["any unicode"]
  // In most cases `stringSpecifiers` is an empty Set
  stringSpecifiers: Set<string>;
};

type ModuleIdentity = {
  source: string;
  assert: [string, string][] | null;
  with: [string, string][] | null;
};
function moduleIdentity(
  node:
    | t.ExportAllDeclaration
    | (t.ExportNamedDeclaration & { source: t.StringLiteral })
    | t.ImportDeclaration,
): ModuleIdentity {
  return {
    source: node.source.value,
    assert: node.assertions?.length
      ? node.assertions.map(e => [
          t.isIdentifier(e.key) ? e.key.name : e.key.value,
          e.value.value,
        ])
      : null,
    with: node.attributes?.length
      ? node.attributes.map(e => [
          t.isIdentifier(e.key) ? e.key.name : e.key.value,
          e.value.value,
        ])
      : null,
  };
}
function moduleAttributesEqual(
  a: [string, string][] | null,
  b: [string, string][] | null,
) {
  if (a === b) return true;
  if (
    (a === null && b !== null) ||
    (a !== null && b === null) ||
    a.length !== b.length
  )
    return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i][0] !== b[i][0] || a[i][1] !== b[i][1]) return false;
  }
  return true;
}
function moduleIdentitiesEqual(a: ModuleIdentity, b: ModuleIdentity) {
  return (
    a === b ||
    (a.source === b.source &&
      moduleAttributesEqual(a.assert, b.assert) &&
      moduleAttributesEqual(a.with, b.with))
  );
}

type ModuleMetadata = {
  source: string;
  assert: [string, string][] | null;
  with: [string, string][] | null;
  imports: (
    | t.ImportDefaultSpecifier
    | t.ImportNamespaceSpecifier
    | t.ImportSpecifier
  )[];
  exports: (
    | {
        type: "ExportSpecifier";
        local: t.Identifier | t.StringLiteral;
        exported: t.Identifier | t.StringLiteral;
      }
    | {
        type: "ExportNamespaceSpecifier";
        exported: t.Identifier | t.StringLiteral;
      }
    | t.ExportDefaultSpecifier
    | t.ExportAllDeclaration
  )[];
};

function constructExportCall(
  path: NodePath<t.Program>,
  exportIdent: t.Identifier,
  exportNames: string[],
  exportValues: t.Expression[],
  exportStarTarget: t.Identifier | null,
  stringSpecifiers: Set<string>,
) {
  const statements = [];
  if (!exportStarTarget) {
    if (exportNames.length === 1) {
      statements.push(
        t.expressionStatement(
          t.callExpression(exportIdent, [
            t.stringLiteral(exportNames[0]),
            exportValues[0],
          ]),
        ),
      );
    } else {
      const objectProperties = [];
      for (let i = 0; i < exportNames.length; i++) {
        const exportName = exportNames[i];
        const exportValue = exportValues[i];
        objectProperties.push(
          t.objectProperty(
            stringSpecifiers.has(exportName)
              ? t.stringLiteral(exportName)
              : t.identifier(exportName),
            exportValue,
          ),
        );
      }
      statements.push(
        t.expressionStatement(
          t.callExpression(exportIdent, [t.objectExpression(objectProperties)]),
        ),
      );
    }
  } else {
    const exportObj = path.scope.generateUid("exportObj");

    statements.push(
      t.variableDeclaration("var", [
        t.variableDeclarator(t.identifier(exportObj), t.objectExpression([])),
      ]),
    );

    statements.push(
      buildExportAll({
        KEY: path.scope.generateUidIdentifier("key"),
        EXPORT_OBJ: t.identifier(exportObj),
        TARGET: exportStarTarget,
      }),
    );

    for (let i = 0; i < exportNames.length; i++) {
      const exportName = exportNames[i];
      const exportValue = exportValues[i];

      statements.push(
        t.expressionStatement(
          t.assignmentExpression(
            "=",
            t.memberExpression(
              t.identifier(exportObj),
              t.identifier(exportName),
            ),
            exportValue,
          ),
        ),
      );
    }

    statements.push(
      t.expressionStatement(
        t.callExpression(exportIdent, [t.identifier(exportObj)]),
      ),
    );
  }
  return statements;
}

export interface Options extends PluginOptions {
  allowTopLevelThis?: boolean;
  systemGlobal?: string;
}

type ReassignmentVisitorState = {
  scope: Scope;
  exports: Record<string, string[]>;
  buildCall: (name: string, value: t.Expression) => t.ExpressionStatement;
};

export default declare<PluginState>((api, options: Options) => {
  api.assertVersion(REQUIRED_VERSION(7));

  const { systemGlobal = "System", allowTopLevelThis = false } = options;
  const reassignmentVisited = new WeakSet();

  const reassignmentVisitor: Visitor<ReassignmentVisitorState> = {
    "AssignmentExpression|UpdateExpression"(
      path: NodePath<t.AssignmentExpression | t.UpdateExpression>,
    ) {
      if (reassignmentVisited.has(path.node)) return;
      reassignmentVisited.add(path.node);

      const arg = path.isAssignmentExpression()
        ? path.get("left")
        : path.get("argument");

      if (arg.isObjectPattern() || arg.isArrayPattern()) {
        const exprs: t.SequenceExpression["expressions"] = [path.node];
        for (const name of Object.keys(arg.getBindingIdentifiers())) {
          if (this.scope.getBinding(name) !== path.scope.getBinding(name)) {
            return;
          }
          const exportedNames = this.exports[name];
          if (!exportedNames) continue;
          for (const exportedName of exportedNames) {
            exprs.push(
              this.buildCall(exportedName, t.identifier(name)).expression,
            );
          }
        }
        path.replaceWith(t.sequenceExpression(exprs));
        return;
      }

      if (!arg.isIdentifier()) return;

      const name = arg.node.name;

      // redeclared in this scope
      if (this.scope.getBinding(name) !== path.scope.getBinding(name)) return;

      const exportedNames = this.exports[name];
      if (!exportedNames) return;

      let node: t.Expression = path.node;

      // if it is a non-prefix update expression (x++ etc)
      // then we must replace with the expression (_export('x', x + 1), x++)
      // in order to ensure the same update expression value
      let isPostUpdateExpression;
      if (
        (isPostUpdateExpression = t.isUpdateExpression(node, {
          prefix: false,
        }))
      ) {
        node = t.binaryExpression(
          node.operator === "++" ? "+" : "-",
          t.unaryExpression("+", t.cloneNode(node.argument)),
          t.numericLiteral(1),
        );
      }

      for (const exportedName of exportedNames) {
        node = this.buildCall(exportedName, node).expression;
      }

      if (isPostUpdateExpression) {
        node = t.sequenceExpression([node, path.node]);
      }

      path.replaceWith(node);
    },
  };

  return {
    name: "transform-modules-systemjs",

    pre() {
      this.file.set("@babel/plugin-transform-modules-*", "systemjs");
    },

    visitor: {
      ["CallExpression" +
        (api.types.importExpression ? "|ImportExpression" : "")](
        this: PluginPass & PluginState,
        path: NodePath<t.CallExpression | t.ImportExpression>,
        state: PluginState,
      ) {
        if (path.isCallExpression() && !t.isImport(path.node.callee)) return;
        if (path.isCallExpression()) {
          if (!this.file.has("@babel/plugin-proposal-dynamic-import")) {
            if (process.env.BABEL_8_BREAKING) {
              throw new Error(MISSING_PLUGIN_ERROR);
            } else {
              console.warn(MISSING_PLUGIN_WARNING);
            }
          }
        } else {
          // when createImportExpressions is true, we require the dynamic import transform
          if (!this.file.has("@babel/plugin-proposal-dynamic-import")) {
            throw new Error(MISSING_PLUGIN_ERROR);
          }
        }
        path.replaceWith(
          t.callExpression(
            t.memberExpression(
              t.identifier(state.contextIdent),
              t.identifier("import"),
            ),
            path.node.type === "CallExpression"
              ? path.node.arguments
              : [path.node.source].concat(path.node.options || []),
          ),
        );
      },

      MetaProperty(path, state: PluginState) {
        if (
          path.node.meta.name === "import" &&
          path.node.property.name === "meta"
        ) {
          path.replaceWith(
            t.memberExpression(
              t.identifier(state.contextIdent),
              t.identifier("meta"),
            ),
          );
        }
      },

      Program: {
        enter(path, state) {
          state.contextIdent = path.scope.generateUid("context");
          state.stringSpecifiers = new Set();
          if (!allowTopLevelThis) {
            rewriteThis(path);
          }
        },
        exit(path, state) {
          const scope = path.scope;
          const exportIdent = scope.generateUid("export");
          const { contextIdent, stringSpecifiers } = state;

          const exportMap: Record<string, string[]> = Object.create(null);
          const modules: ModuleMetadata[] = [];

          const beforeBody = [];
          const setters: t.Expression[] = [];
          const dependencies: ModuleIdentity[] = [];
          let dependenciesNeedMetas = false;
          const variableIds = [];
          const removedPaths = [];

          function addExportName(key: string, val: string) {
            exportMap[key] = exportMap[key] || [];
            exportMap[key].push(val);
          }

          function pushModule(
            ...[identity, key, specifiers]:
              | [
                  /* identity */ ModuleIdentity,
                  /* key */ "imports",
                  /* specifiers */ (
                    | t.ImportDefaultSpecifier
                    | t.ImportNamespaceSpecifier
                    | t.ImportSpecifier
                  )[],
                ]
              | [
                  /* identity */ ModuleIdentity,
                  /* key */ "exports",
                  /* specifiers */ specifiers: (
                    | t.ExportSpecifier
                    | t.ExportNamespaceSpecifier
                    | t.ExportDefaultSpecifier
                    | t.ExportAllDeclaration
                  )[],
                ]
          ): void {
            let module: ModuleMetadata;
            modules.forEach(function (m) {
              if (moduleIdentitiesEqual(m, identity)) {
                module = m;
              }
            });
            if (!module) {
              modules.push(
                (module = {
                  source: identity.source,
                  assert: identity.assert,
                  with: identity.with,
                  imports: [],
                  exports: [],
                }),
              );
            }
            if (key === "imports") {
              module[key] = module[key].concat(specifiers);
            } else {
              module[key] = module[key].concat(specifiers);
            }
          }

          function buildExportCall(name: string, val: t.Expression) {
            return t.expressionStatement(
              t.callExpression(t.identifier(exportIdent), [
                t.stringLiteral(name),
                val,
              ]),
            );
          }

          const exportNames = [];
          const exportValues: t.Expression[] = [];

          const body = path.get("body");

          for (const path of body) {
            if (path.isFunctionDeclaration()) {
              beforeBody.push(path.node);
              removedPaths.push(path);
            } else if (path.isClassDeclaration()) {
              variableIds.push(t.cloneNode(path.node.id));
              path.replaceWith(
                t.expressionStatement(
                  t.assignmentExpression(
                    "=",
                    t.cloneNode(path.node.id),
                    t.toExpression(path.node),
                  ),
                ),
              );
            } else if (path.isVariableDeclaration()) {
              // Convert top-level variable declarations to "var",
              // because they must be hoisted
              path.node.kind = "var";
            } else if (path.isImportDeclaration()) {
              pushModule(
                moduleIdentity(path.node),
                "imports",
                path.node.specifiers,
              );
              for (const name of Object.keys(path.getBindingIdentifiers())) {
                scope.removeBinding(name);
                variableIds.push(t.identifier(name));
              }
              path.remove();
            } else if (path.isExportAllDeclaration()) {
              pushModule(moduleIdentity(path.node), "exports", [path.node]);
              path.remove();
            } else if (path.isExportDefaultDeclaration()) {
              const declar = path.node.declaration;
              if (t.isClassDeclaration(declar)) {
                const id = declar.id;
                if (id) {
                  exportNames.push("default");
                  exportValues.push(scope.buildUndefinedNode());
                  variableIds.push(t.cloneNode(id));
                  addExportName(id.name, "default");
                  path.replaceWith(
                    t.expressionStatement(
                      t.assignmentExpression(
                        "=",
                        t.cloneNode(id),
                        t.toExpression(declar),
                      ),
                    ),
                  );
                } else {
                  exportNames.push("default");
                  exportValues.push(t.toExpression(declar));
                  removedPaths.push(path);
                }
              } else if (t.isFunctionDeclaration(declar)) {
                const id = declar.id;
                if (id) {
                  beforeBody.push(declar);
                  exportNames.push("default");
                  exportValues.push(t.cloneNode(id));
                  addExportName(id.name, "default");
                } else {
                  exportNames.push("default");
                  exportValues.push(t.toExpression(declar));
                }
                removedPaths.push(path);
              } else {
                if (t.isTSDeclareFunction(declar)) t.assertExpression(declar);
                path.replaceWith(buildExportCall("default", declar));
              }
            } else if (path.isExportNamedDeclaration()) {
              const declar = path.node.declaration;

              if (declar) {
                path.replaceWith(declar);

                if (t.isFunction(declar)) {
                  const name = declar.id.name;
                  addExportName(name, name);
                  beforeBody.push(declar);
                  exportNames.push(name);
                  exportValues.push(t.cloneNode(declar.id));
                  removedPaths.push(path);
                } else if (t.isClass(declar)) {
                  const name = declar.id.name;
                  exportNames.push(name);
                  exportValues.push(scope.buildUndefinedNode());
                  variableIds.push(t.cloneNode(declar.id));
                  path.replaceWith(
                    t.expressionStatement(
                      t.assignmentExpression(
                        "=",
                        t.cloneNode(declar.id),
                        t.toExpression(declar),
                      ),
                    ),
                  );
                  addExportName(name, name);
                } else {
                  if (t.isVariableDeclaration(declar)) {
                    // Convert top-level variable declarations to "var",
                    // because they must be hoisted
                    declar.kind = "var";
                  }
                  for (const name of Object.keys(
                    t.getBindingIdentifiers(declar),
                  )) {
                    addExportName(name, name);
                  }
                }
              } else {
                const specifiers = path.node.specifiers;
                if (specifiers?.length) {
                  if (path.node.source) {
                    pushModule(
                      moduleIdentity(
                        path.node as typeof path.node & {
                          source: t.StringLiteral;
                        },
                      ),
                      "exports",
                      specifiers,
                    );
                    path.remove();
                  } else {
                    const nodes = [];

                    for (const specifier of specifiers) {
                      t.assertExportSpecifier(specifier);
                      const { local, exported } = specifier;

                      let wasImported = false;
                      for (const module of modules) {
                        for (const importSpecifier of module.imports) {
                          if (importSpecifier.local.name === local.name) {
                            module.exports.push(
                              t.isImportNamespaceSpecifier(importSpecifier)
                                ? {
                                    type: "ExportNamespaceSpecifier",
                                    exported: t.cloneNode(exported),
                                  }
                                : {
                                    type: "ExportSpecifier",
                                    local: t.isImportDefaultSpecifier(
                                      importSpecifier,
                                    )
                                      ? t.identifier("default")
                                      : t.cloneNode(importSpecifier.imported),
                                    exported: t.cloneNode(exported),
                                  },
                            );
                            wasImported = true;
                            break;
                          }
                        }
                        if (wasImported) break;
                      }

                      if (!wasImported) {
                        const binding = scope.getBinding(local.name);
                        const exportedName = getExportSpecifierName(
                          exported,
                          stringSpecifiers,
                        );
                        // hoisted function export
                        if (
                          binding &&
                          t.isFunctionDeclaration(binding.path.node)
                        ) {
                          exportNames.push(exportedName);
                          exportValues.push(t.cloneNode(local));
                        }
                        // only globals also exported this way
                        else if (!binding) {
                          nodes.push(buildExportCall(exportedName, local));
                        }
                        addExportName(local.name, exportedName);
                      }
                    }

                    path.replaceWithMultiple(nodes);
                  }
                } else {
                  path.remove();
                }
              }
            }
          }

          modules.forEach(function (specifiers) {
            const setterBody = [];
            const target = scope.generateUid(specifiers.source);

            for (const specifier of specifiers.imports) {
              if (t.isImportNamespaceSpecifier(specifier)) {
                setterBody.push(
                  t.expressionStatement(
                    t.assignmentExpression(
                      "=",
                      specifier.local,
                      t.identifier(target),
                    ),
                  ),
                );
              } else if (
                t.isImportSpecifier(specifier) ||
                t.isImportDefaultSpecifier(specifier)
              ) {
                const imported = t.isImportDefaultSpecifier(specifier)
                  ? t.identifier("default")
                  : specifier.imported;
                setterBody.push(
                  t.expressionStatement(
                    t.assignmentExpression(
                      "=",
                      specifier.local,
                      t.memberExpression(
                        t.identifier(target),
                        imported,
                        /* computed */ imported.type === "StringLiteral",
                      ),
                    ),
                  ),
                );
              } else {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const _typeAssertion: never = specifier;
              }
            }

            if (specifiers.exports.length) {
              const exportNames = [];
              const exportValues = [];
              let hasExportStar = false;

              for (const node of specifiers.exports) {
                if (node.type === "ExportAllDeclaration") {
                  hasExportStar = true;
                } else if (node.type === "ExportSpecifier") {
                  const exportedName = getExportSpecifierName(
                    node.exported,
                    stringSpecifiers,
                  );
                  exportNames.push(exportedName);
                  exportValues.push(
                    t.memberExpression(
                      t.identifier(target),
                      node.local,
                      t.isStringLiteral(node.local),
                    ),
                  );
                } else if (node.type === "ExportNamespaceSpecifier") {
                  const exportedName = getExportSpecifierName(
                    node.exported,
                    stringSpecifiers,
                  );
                  exportNames.push(exportedName);
                  exportValues.push(t.identifier(target));
                } else if (node.type === "ExportDefaultSpecifier") {
                  const exportedName = getExportSpecifierName(
                    node.exported,
                    stringSpecifiers,
                  );
                  exportNames.push(exportedName);
                  exportValues.push(
                    t.memberExpression(
                      t.identifier(target),
                      t.identifier("default"),
                      false,
                    ),
                  );
                } else {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars
                  const _typeAssertion: never = node;
                }
              }

              setterBody.push(
                ...constructExportCall(
                  path,
                  t.identifier(exportIdent),
                  exportNames,
                  exportValues,
                  hasExportStar ? t.identifier(target) : null,
                  stringSpecifiers,
                ),
              );
            }

            dependencies.push(specifiers);
            if (specifiers.assert || specifiers.with) {
              dependenciesNeedMetas = true;
            }
            setters.push(
              t.functionExpression(
                null,
                [t.identifier(target)],
                t.blockStatement(setterBody),
              ),
            );
          });

          const moduleName = getModuleName(this.file.opts, options);

          if (!process.env.BABEL_8_BREAKING && !USE_ESM && !IS_STANDALONE) {
            // polyfill when being run by an older Babel version
            path.scope.hoistVariables ??=
              // eslint-disable-next-line no-restricted-globals
              require("@babel/traverse").Scope.prototype.hoistVariables;
          }

          path.scope.hoistVariables((id, hasInit) => {
            variableIds.push(id);
            if (!hasInit && id.name in exportMap) {
              for (const exported of exportMap[id.name]) {
                exportNames.push(exported);
                exportValues.push(t.buildUndefinedNode());
              }
            }
          });

          if (variableIds.length) {
            beforeBody.unshift(
              t.variableDeclaration(
                "var",
                variableIds.map(id => t.variableDeclarator(id)),
              ),
            );
          }

          if (exportNames.length) {
            beforeBody.push(
              ...constructExportCall(
                path,
                t.identifier(exportIdent),
                exportNames,
                exportValues,
                null,
                stringSpecifiers,
              ),
            );
          }

          path.traverse(reassignmentVisitor, {
            exports: exportMap,
            buildCall: buildExportCall,
            scope,
          });

          for (const path of removedPaths) {
            path.remove();
          }

          let hasTLA = false;
          path.traverse({
            AwaitExpression(path) {
              hasTLA = true;
              path.stop();
            },
            ForAwaitStatement() {
              hasTLA = true;
              path.stop();
            },
            Function(path) {
              path.skip();
            },
            // @ts-expect-error - todo: add noScope to type definitions
            noScope: true,
          });

          path.node.body = [
            buildTemplate({
              SYSTEM_REGISTER: t.memberExpression(
                t.identifier(systemGlobal),
                t.identifier("register"),
              ),
              BEFORE_BODY: beforeBody,
              MODULE_NAME: moduleName ? t.stringLiteral(moduleName) : null,
              SETTERS: t.arrayExpression(setters),
              EXECUTE: t.functionExpression(
                null,
                [],
                t.blockStatement(path.node.body),
                false,
                hasTLA,
              ),
              SOURCES: t.arrayExpression(
                dependencies.map(e => t.stringLiteral(e.source)),
              ),
              METAS: dependenciesNeedMetas
                ? t.arrayExpression(
                    dependencies.map(e =>
                      e.assert || e.with
                        ? t.objectExpression(
                            (e.assert
                              ? [
                                  t.objectProperty(
                                    t.identifier("assert"),
                                    t.objectExpression(
                                      e.assert.map(e =>
                                        t.objectProperty(
                                          t.stringLiteral(e[0]),
                                          t.stringLiteral(e[1]),
                                        ),
                                      ),
                                    ),
                                  ),
                                ]
                              : []
                            ).concat(
                              e.with
                                ? [
                                    t.objectProperty(
                                      t.identifier("with"),
                                      t.objectExpression(
                                        e.with.map(e =>
                                          t.objectProperty(
                                            t.stringLiteral(e[0]),
                                            t.stringLiteral(e[1]),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ]
                                : [],
                            ),
                          )
                        : t.buildUndefinedNode(),
                    ),
                  )
                : null,
              EXPORT_IDENTIFIER: t.identifier(exportIdent),
              CONTEXT_IDENTIFIER: t.identifier(contextIdent),
            }),
          ];
          path.requeue(path.get("body.0"));
        },
      },
    },
  };
});
