import { expect, it } from "vitest";
import { validateExternalBrowserUrl } from "./externalBrowserUrl";

it("hands only plain web pages to the default browser", () => {
  expect(validateExternalBrowserUrl("https://accounts.example.test/sign-in?state=1")).toBe(
    "https://accounts.example.test/sign-in?state=1",
  );
  expect(validateExternalBrowserUrl("http://localhost:3000/")).toBe("http://localhost:3000/");
});

it("refuses local files, scripts, other apps' schemes and embedded credentials", () => {
  for (const value of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "octant://code/thread/00000000-0000-4000-8000-000000000001",
    "x-apple.systempreferences:com.apple.preference.security",
    "data:text/html,hello",
    "https://person:secret@example.test/",
    "not a url",
    `https://example.test/${"a".repeat(4_096)}`,
    42,
    undefined,
  ])
    expect(() => validateExternalBrowserUrl(value)).toThrow(
      "Octant rejected an invalid external Browser URL.",
    );
});
