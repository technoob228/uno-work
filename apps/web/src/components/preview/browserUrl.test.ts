import { describe, expect, it } from "vitest";

import {
  browserPartitionForScope,
  browserTabNameForUrl,
  browserUrlOrigin,
  normalizeBrowserUrl,
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
