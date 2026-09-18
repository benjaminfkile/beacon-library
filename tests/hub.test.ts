// The SignalR Node client refuses ws://* and wss://*; the connection builder
// maps them to http/https before handing them to HubConnectionBuilder.

import { describe, expect, it } from "vitest";
import { mapHubUrlForNode } from "../src/hub.js";

describe("mapHubUrlForNode", () => {
  it("maps wss:// to https://", () => {
    expect(mapHubUrlForNode("wss://gateway.example.com/hub")).toBe(
      "https://gateway.example.com/hub",
    );
  });

  it("maps ws:// to http://", () => {
    expect(mapHubUrlForNode("ws://gateway.example.com/hub")).toBe(
      "http://gateway.example.com/hub",
    );
  });

  it("passes http:// and https:// through unchanged", () => {
    expect(mapHubUrlForNode("https://gateway.example.com/hub")).toBe(
      "https://gateway.example.com/hub",
    );
    expect(mapHubUrlForNode("http://gateway.example.com/hub")).toBe(
      "http://gateway.example.com/hub",
    );
  });

  it("only rewrites the scheme prefix, not other occurrences", () => {
    expect(mapHubUrlForNode("wss://host/path?ref=wss://x")).toBe(
      "https://host/path?ref=wss://x",
    );
  });
});
