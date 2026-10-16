import { describe, expect, it } from "vitest";

import {
  browserPartitionForScope,
  browserTabNameForUrl,
  browserUrlOrigin,
  normalizeBrowserUrl,
  isComputerLocalUrl,
  isPrivateNetworkUrl,
  normalizeAgentBrowserUrl,
} from "./browserUrl";

describe("normalizeBrowserUrl", () => {
  it("возвращает null для пустого ввода", () => {
    expect(normalizeBrowserUrl("")).toBeNull();
    expect(normalizeBrowserUrl("   ")).toBeNull();
  });

  it("пропускает полные http(s) URL как есть", () => {
    expect(normalizeBrowserUrl("https://getuno.xyz/pricing")).toBe("https://getuno.xyz/pricing");
    expect(normalizeBrowserUrl("http://example.com")).toBe("http://example.com/");
  });

  it("отклоняет не-веб схемы", () => {
    expect(normalizeBrowserUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeBrowserUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeBrowserUrl("chrome://settings")).toBeNull();
  });

  it("добавляет https к голым доменам", () => {
    expect(normalizeBrowserUrl("getuno.xyz")).toBe("https://getuno.xyz/");
    expect(normalizeBrowserUrl("docs.github.com/en")).toBe("https://docs.github.com/en");
  });

  it("использует http для localhost и loopback", () => {
    expect(normalizeBrowserUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeBrowserUrl("127.0.0.1:8081/api")).toBe("http://127.0.0.1:8081/api");
  });

  it("отправляет поисковые запросы в поисковик", () => {
    expect(normalizeBrowserUrl("как настроить caddy")).toContain("google.com/search?q=");
  });
});

describe("browserTabNameForUrl", () => {
  it("показывает хост без www", () => {
    expect(browserTabNameForUrl("https://www.github.com/uno")).toBe("github.com");
    expect(browserTabNameForUrl("http://localhost:5173/")).toBe("localhost");
  });
});

describe("browserUrlOrigin", () => {
  it("возвращает origin для http(s)", () => {
    expect(browserUrlOrigin("https://github.com/login?next=/")).toBe("https://github.com");
  });
  it("возвращает null для пустых и невалидных значений", () => {
    expect(browserUrlOrigin(undefined)).toBeNull();
    expect(browserUrlOrigin("")).toBeNull();
    expect(browserUrlOrigin("not a url")).toBeNull();
  });
});

describe("browserPartitionForScope", () => {
  it("общий профиль для аккаунта", () => {
    expect(browserPartitionForScope({ scope: "account", projectKey: "x" })).toBe(
      "persist:uno-browser",
    );
  });
  it("отдельная партиция на проект с санитизацией ключа", () => {
    expect(
      browserPartitionForScope({ scope: "project", projectKey: "repo:/Users/m/uno project" }),
    ).toBe("persist:uno-browser-p-repo__Users_m_uno_project");
  });
  it("без ключа проекта падает обратно на общий профиль", () => {
    expect(browserPartitionForScope({ scope: "project", projectKey: null })).toBe(
      "persist:uno-browser",
    );
  });
});

describe("isPrivateNetworkUrl", () => {
  it("recognises this computer and local networks", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://app.localhost/",
      "http://127.0.0.1:13773/",
      "http://10.1.2.3/",
      "http://172.20.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.1.1/",
      "http://0.0.0.0:8080/",
      "http://[::1]:3000/",
      "http://[fd12:3456::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(isPrivateNetworkUrl(url), url).toBe(true);
    }
  });
  it("leaves public addresses alone", () => {
    for (const url of ["https://example.com/", "http://8.8.8.8/", "http://172.32.0.1/"]) {
      expect(isPrivateNetworkUrl(url), url).toBe(false);
    }
  });
});

describe("normalizeAgentBrowserUrl", () => {
  it("allows only http(s)", () => {
    expect(normalizeAgentBrowserUrl("example.com")).toBe("https://example.com/");
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "devtools://devtools/bundled/inspector.html",
      "",
      undefined,
    ]) {
      expect(normalizeAgentBrowserUrl(url)).toBeNull();
    }
  });
});

describe("isComputerLocalUrl", () => {
  it("knows the computer's own addresses (open them in its browser on the web)", () => {
    expect(isComputerLocalUrl("http://localhost:5173/")).toBe(true);
    expect(isComputerLocalUrl("http://app.localhost:3000/x")).toBe(true);
    expect(isComputerLocalUrl("http://127.0.0.1:8081")).toBe(true);
    expect(isComputerLocalUrl("http://127.1.2.3/")).toBe(true);
    expect(isComputerLocalUrl("http://0.0.0.0:4000/")).toBe(true);
    expect(isComputerLocalUrl("http://[::1]:3000/")).toBe(true);
  });

  it("leaves public and local-network addresses alone", () => {
    expect(isComputerLocalUrl("https://getuno.xyz/")).toBe(false);
    expect(isComputerLocalUrl("https://my-site.uno4.me/")).toBe(false);
    expect(isComputerLocalUrl("http://192.168.1.10:3000/")).toBe(false);
    expect(isComputerLocalUrl("http://localhost.example.com/")).toBe(false);
    expect(isComputerLocalUrl("file:///etc/hosts")).toBe(false);
    expect(isComputerLocalUrl("not a url")).toBe(false);
  });
});
