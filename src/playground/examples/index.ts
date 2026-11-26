import type { ExampleDefinition } from "../types";

import saturnsMoonsMain from "./language/saturns-moons/main.titan?raw";
import saturnsMoonsMoons from "./language/saturns-moons/moons.titan?raw";
import optionsAndMapsMain from "./language/options-and-maps/main.titan?raw";
import genericsMain from "./language/generics/main.titan?raw";

import errorsAndTracesMain from "./runtime/errors-and-traces/main.titan?raw";
import tasksAndTimersMain from "./runtime/tasks-and-timers/main.titan?raw";
import jsonRoundtripMain from "./runtime/json-roundtrip/main.titan?raw";

import miniReactMain from "./browser/mini-react/main.titan?raw";
import miniReactRuntime from "./browser/mini-react/react.titan?raw";
import miniReactBindings from "./browser/mini-react/bindings.js?raw";

import huygensLanderMain from "./browser/huygens-lander/main.titan?raw";
import huygensLanderPhysics from "./browser/huygens-lander/physics.titan?raw";
import huygensLanderBindings from "./browser/huygens-lander/bindings.js?raw";

import gravityAssistMain from "./browser/gravity-assist/main.titan?raw";
import gravityAssistOrbit from "./browser/gravity-assist/orbit.titan?raw";
import gravityAssistBindings from "./browser/gravity-assist/bindings.js?raw";

import fetchJsonMain from "./browser/fetch-json/main.titan?raw";

/**
 * Curated Playground gallery. The first entry (`saturns-moons`) is the default project.
 * Every source file is imported verbatim with `?raw` so the browser UI and Node CI
 * compile and test the exact same authored files.
 */
export const examples: readonly ExampleDefinition[] = [
  {
    slug: "saturns-moons",
    title: "Saturn’s moons",
    category: "Language",
    summary: "Multi-module records, tagged unions with case, methods, and named calls.",
    bookLink: "/book/tour/",
    previewMode: "console",
    files: {
      "main.titan": saturnsMoonsMain,
      "moons.titan": saturnsMoonsMoons,
    },
  },
  {
    slug: "options-and-maps",
    title: "Options & maps",
    category: "Language",
    summary: "Option types (T?), nil-preserving locals (local x?), and typed Maps over telemetry.",
    bookLink: "/book/arrays-maps/",
    previewMode: "console",
    files: {
      "main.titan": optionsAndMapsMain,
    },
  },
  {
    slug: "generics",
    title: "Generics & interfaces",
    category: "Language",
    summary: "Parametric Pair<|T, U|>, type-argument inference, and structural Interface constraints.",
    bookLink: "/book/generics/",
    previewMode: "console",
    files: {
      "main.titan": genericsMain,
    },
  },
  {
    slug: "errors-and-traces",
    title: "Errors & traces",
    category: "Runtime",
    summary: "Typed error records, LIFO defer cleanup, catch recovery, and clickable stack frames.",
    bookLink: "/book/error-handling/",
    previewMode: "console",
    files: {
      "main.titan": errorsAndTracesMain,
    },
  },
  {
    slug: "tasks-and-timers",
    title: "Tasks & timers",
    category: "Runtime",
    summary: "Cooperative async Tasks, bounded channels, timer.ticker, all_three, and cancellation.",
    bookLink: "/book/async-io/",
    previewMode: "console",
    files: {
      "main.titan": tasksAndTimersMain,
    },
  },
  {
    slug: "json-roundtrip",
    title: "JSON round-trip",
    category: "Runtime",
    summary: "Records and tagged unions encoded to JSON, decoded via titan.reflect, and validated.",
    bookLink: "/book/standard-library-json/",
    previewMode: "console",
    files: {
      "main.titan": jsonRoundtripMain,
    },
  },
  {
    slug: "mini-react",
    title: "Mini-React",
    category: "Browser",
    summary: "Virtual DOM diffing, useState and useEffect hooks, and named-argument syntax in lieu of JSX.",
    bookLink: "/book/functions/#named-calls",
    previewMode: "dom",
    files: {
      "main.titan": miniReactMain,
      "react.titan": miniReactRuntime,
      "bindings.js": miniReactBindings,
    },
  },
  {
    slug: "huygens-lander",
    title: "Huygens Landing on Titan",
    category: "Browser",
    summary: "Pixel-art 2D descent over Titan’s tholin haze, methane lakes, and water-ice pads — records, unions, and editable canvas bindings.",
    bookLink: "/book/standard-library-browser/",
    previewMode: "canvas2d",
    files: {
      "main.titan": huygensLanderMain,
      "physics.titan": huygensLanderPhysics,
      "bindings.js": huygensLanderBindings,
    },
  },
  {
    slug: "gravity-assist",
    title: "3D Gravity Assist Simulator",
    category: "Browser",
    summary: "Two-body Saturn + Titan 3D slingshot simulator in Three.js — Velocity Verlet physics, live trajectory prediction, and Δv scoring.",
    bookLink: "/book/standard-library-browser/",
    previewMode: "three",
    files: {
      "main.titan": gravityAssistMain,
      "orbit.titan": gravityAssistOrbit,
      "bindings.js": gravityAssistBindings,
    },
  },
  {
    slug: "fetch-json",
    title: "Fetch & JSON",
    category: "Browser",
    summary: "Streaming http.get over browser fetch, decoding /play/data/moons.json into typed records.",
    bookLink: "/book/standard-library-http/#on-the-browser",
    previewMode: "console",
    files: {
      "main.titan": fetchJsonMain,
    },
  },
];

export function findExample(slug: string): ExampleDefinition | undefined {
  return examples.find((entry) => entry.slug === slug);
}
