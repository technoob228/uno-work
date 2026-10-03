import { describe, expect, it } from "vitest";

import { isServiceMachineName, personMachineName } from "./machineName.ts";

describe("machine names a person may see", () => {
  it.each(["img-208-warm", "img-177-warm", "IMG-208-WARM", "img-208", "uno-work-golden-v53-build"])(
    "%s is a service name",
    (name) => {
      expect(isServiceMachineName(name)).toBe(true);
      expect(personMachineName(name)).toBeNull();
    },
  );

  it.each(["uno-work", "Misha's MacBook Pro", "box-2326", "imgur", "img-studio"])(
    "%s is a computer's own name",
    (name) => {
      expect(isServiceMachineName(name)).toBe(false);
      expect(personMachineName(` ${name} `)).toBe(name);
    },
  );

  it("empty is nobody's name", () => {
    expect(personMachineName("  ")).toBeNull();
    expect(personMachineName(undefined)).toBeNull();
  });
});
