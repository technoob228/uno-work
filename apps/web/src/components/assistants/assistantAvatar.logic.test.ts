import { describe, expect, it } from "vitest";

import {
  EMOJI_GROUPS,
  PERSONAS,
  PERSONA_FACES,
  avatarFileProblem,
  base64OfDataUrl,
  centerSquare,
  randomPersonaFace,
} from "./assistantAvatar.logic";

describe("a picture for its face", () => {
  it("takes PNG, JPG and WebP up to 2 MB", () => {
    expect(avatarFileProblem({ type: "image/png", size: 1000 })).toBeNull();
    expect(avatarFileProblem({ type: "image/jpeg", size: 2 * 1024 * 1024 })).toBeNull();
    expect(avatarFileProblem({ type: "image/webp", size: 10 })).toBeNull();
    expect(avatarFileProblem({ type: "image/gif", size: 10 })).toBe(
      "Use a PNG, JPG or WebP picture.",
    );
    expect(avatarFileProblem({ type: "image/svg+xml", size: 10 })).not.toBeNull();
    expect(avatarFileProblem({ type: "image/png", size: 2 * 1024 * 1024 + 1 })).toBe(
      "The picture is bigger than 2 MB.",
    );
    expect(avatarFileProblem({ type: "image/png", size: 0 })).toBe("That file is empty.");
  });

  it("keeps the centered square of a photo", () => {
    expect(centerSquare(400, 300)).toEqual({ x: 50, y: 0, side: 300 });
    expect(centerSquare(300, 500)).toEqual({ x: 0, y: 100, side: 300 });
    expect(centerSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
  });

  it("sends the daemon the base64 of the picture, nothing else", () => {
    expect(base64OfDataUrl("data:image/webp;base64,AAAA")).toBe("AAAA");
    expect(base64OfDataUrl("data:image/png;base64,iVBO")).toBe("iVBO");
    expect(base64OfDataUrl("data:text/html;base64,PGI+")).toBeNull();
    expect(base64OfDataUrl("https://example.com/a.png")).toBeNull();
  });
});

describe("faces", () => {
  it("four personas: human, animal, robot, alien", () => {
    expect(PERSONAS.map((persona) => persona.id)).toEqual(["human", "animal", "robot", "alien"]);
  });

  it("the emoji set starts with people, animals, robots and aliens", () => {
    expect(EMOJI_GROUPS.map((group) => group.label).slice(0, 3)).toEqual([
      "People",
      "Animals",
      "Robots & aliens",
    ]);
    expect(EMOJI_GROUPS.flatMap((group) => group.emojis).length).toBeGreaterThanOrEqual(40);
  });

  it("a new assistant gets a persona face, not a generic one, and not one already taken", () => {
    expect(PERSONA_FACES).not.toContain("🙂");
    const first = randomPersonaFace(() => 0);
    expect(first.emoji).toBe(PERSONA_FACES[0]);
    const next = randomPersonaFace(() => 0, [first.emoji]);
    expect(next.emoji).not.toBe(first.emoji);
    // random() close to 1 still picks a face.
    expect(PERSONA_FACES).toContain(randomPersonaFace(() => 0.999999).emoji);
  });
});
