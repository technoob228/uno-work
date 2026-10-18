import { describe, expect, it } from "vitest";

import {
  computerLocalPort,
  isComputerLocalUrl,
  localUrlToPortPreviewUrl,
  parsePortPreviewHost,
  portPreviewUrlToLocalUrl,
} from "./portPreview.ts";

const ORIGIN = "https://p5173--abc123.uno4.work";

describe("port preview addresses", () => {
  it("reads a port's host", () => {
    expect(parsePortPreviewHost("p5173--abc123.uno4.work")).toEqual({
      port: 5173,
      label: "abc123",
      domain: "uno4.work",
    });
    expect(parsePortPreviewHost("P3000--ABC.uno4.work:443")?.port).toBe(3000);
    expect(parsePortPreviewHost("abc123.uno4.work")).toBeNull();
    expect(parsePortPreviewHost("p80--abc.uno4.work")).toBeNull();
  });

  it("maps the computer's localhost to the port's address and back", () => {
    expect(localUrlToPortPreviewUrl("http://localhost:5173/about?x=1#top", ORIGIN)).toBe(
      `${ORIGIN}/about?x=1#top`,
    );
    expect(localUrlToPortPreviewUrl("http://127.0.0.1:5173/", ORIGIN)).toBe(`${ORIGIN}/`);
    // Another port is another link.
    expect(localUrlToPortPreviewUrl("http://localhost:3000/", ORIGIN)).toBeNull();
    expect(localUrlToPortPreviewUrl("https://example.com/", ORIGIN)).toBeNull();
    expect(portPreviewUrlToLocalUrl(`${ORIGIN}/about?x=1#top`)).toBe(
      "http://localhost:5173/about?x=1#top",
    );
    expect(portPreviewUrlToLocalUrl("https://abc123.uno4.work/")).toBeNull();
  });

  it("knows the computer's own addresses and their ports", () => {
    expect(isComputerLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isComputerLocalUrl("http://app.localhost/")).toBe(true);
    expect(isComputerLocalUrl("http://[::1]:8080/")).toBe(true);
    expect(isComputerLocalUrl("http://127.4.0.1/")).toBe(true);
    expect(isComputerLocalUrl("http://192.168.1.2/")).toBe(false);
    expect(isComputerLocalUrl("https://example.com/")).toBe(false);
    expect(computerLocalPort("http://localhost/")).toBe(80);
    expect(computerLocalPort("http://localhost:8124/x")).toBe(8124);
    expect(computerLocalPort("https://example.com/")).toBeNull();
  });
});
