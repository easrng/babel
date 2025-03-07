/**
 * Entry point for @babel/standalone. This wraps Babel's API in a version that's
 * friendlier for use in web browsers. It removes the automagical detection of
 * plugins, instead explicitly registering all the available plugins, and
 * requiring custom ones to be registered through `registerPlugin`.
 */

/* global VERSION */
/// <reference lib="dom" />

import {
  transformSync as babelTransformSync,
  type PluginObject,
} from "@babel/core";
import { all } from "./generated/plugins.ts";

import type { InputOptions } from "@babel/core";

const availablePlugins: typeof all = {};

// All the plugins we should bundle
// Want to get rid of this long list of allowed plugins?
// Wait! Please read https://github.com/babel/babel/pull/6177 first.
registerPlugins(all);

const isArray =
  Array.isArray ||
  (arg => Object.prototype.toString.call(arg) === "[object Array]");

/**
 * Loads the given name (or [name, options] pair) from the given table object
 * holding the available plugins.
 *
 * Returns undefined if the plugin is not available; passes through
 * name unmodified if it (or the first element of the pair) is not a string.
 */
function loadBuiltin(builtinTable: Record<string, unknown>, name: any) {
  if (isArray(name) && typeof name[0] === "string") {
    if (Object.hasOwn(builtinTable, name[0])) {
      return [builtinTable[name[0]]].concat(name.slice(1));
    }
    return;
  } else if (typeof name === "string") {
    return builtinTable[name];
  }
  // Could be an actual plugin module
  return name;
}

/**
 * Parses plugin names from the specified options.
 */
function processOptions(options: InputOptions) {
  // Parse plugin names
  const plugins = (options.plugins || []).map(pluginName => {
    const plugin = loadBuiltin(availablePlugins, pluginName);

    if (!plugin) {
      throw new Error(
        `Invalid plugin specified in Babel options: "${pluginName}"`,
      );
    }
    return plugin;
  });

  return {
    babelrc: false,
    ...options,
    presets: [] as const,
    plugins,
  };
}

export function transform(code: string, options: InputOptions) {
  return babelTransformSync(code, processOptions(options));
}

/**
 * Registers a named plugin for use with Babel.
 */
function registerPlugin(name: string, plugin: () => PluginObject): void {
  if (Object.hasOwn(availablePlugins, name)) {
    console.warn(
      `A plugin named "${name}" is already registered, it will be overridden`,
    );
  }
  availablePlugins[name] = plugin;
}
/**
 * Registers multiple plugins for use with Babel. `newPlugins` should be an object where the key
 * is the name of the plugin, and the value is the plugin itself.
 */
function registerPlugins(newPlugins: {
  [x: string]: () => PluginObject;
}): void {
  Object.keys(newPlugins).forEach(name =>
    registerPlugin(name, newPlugins[name]),
  );
}

// @ts-expect-error VERSION is to be replaced by rollup
export const version: string = VERSION;
