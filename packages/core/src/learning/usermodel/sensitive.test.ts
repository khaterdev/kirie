import { describe, it, expect } from "vitest";
import {
  USER_MODEL_SENSITIVE_CATEGORIES,
  detectUserModelSensitive,
  isUserModelSensitive,
  userModelExcludedCategories,
  type UserModelSensitiveCategory,
} from "./sensitive.js";

// One statement that must be caught and one near miss that must pass, per category.
const CASES: Record<UserModelSensitiveCategory, { hit: string; miss: string }> = {
  health: { hit: "Was diagnosed with diabetes last year", miss: "Runs health checks on the daemon every morning" },
  sexuality: { hit: "Has a girlfriend in Alexandria", miss: "Prefers transparent communication" },
  religion: { hit: "Prays five times a day", miss: "Works with the Islamabad team on Fridays" },
  politics: { hit: "Voted for the liberal party candidates", miss: "Prefers conservative estimates for deadlines" },
  ethnicity: { hit: "Is of Nubian descent", miss: "Fixes race conditions in the scheduler" },
  legal_status: { hit: "Is waiting for a residence permit", miss: "Writes the visualization layer of the dashboard" },
  finances: { hit: "Earns a monthly salary in dollars", miss: "Is learning Rust in the evenings" },
  government_id: { hit: "Keeps the passport number in a notes file", miss: "Uses passport.js in the auth service" },
  credentials: { hit: "Reuses the same password for test accounts", miss: "Prefers token-efficient replies" },
  home_address: { hit: "Lives at 12 Nile Street", miss: "Lives in Cairo" },
  third_party_private: { hit: "Ahmed shared his phone number with the team", miss: "Works with Ahmed on the billing service" },
};

describe("sensitive filter", () => {
  for (const category of USER_MODEL_SENSITIVE_CATEGORIES) {
    it(`${category}: catches the positive, passes the near miss`, () => {
      const c = CASES[category];
      expect(detectUserModelSensitive(c.hit)).toBe(category);
      expect(detectUserModelSensitive(c.miss)).toBeNull();
    });
  }

  it("catches phone numbers and emails as contact data, not dates or ports", () => {
    expect(isUserModelSensitive("Can be reached at +20 100 123 4567")).toBe(true);
    expect(isUserModelSensitive("Uses the address someone@example.org for invoices")).toBe(true);
    expect(isUserModelSensitive("Shipped the release on 2026-11-23")).toBe(false);
    expect(isUserModelSensitive("Runs the gateway on port 18789")).toBe(false);
  });

  it("a secret the scrubber recognises counts as credentials", () => {
    const fake = ["sk", "-ant-", "api03-", "Q".repeat(40)].join("");
    expect(detectUserModelSensitive(`Keeps ${fake} in the shell profile`)).toBe("credentials");
  });

  it("custom excludeCategories narrow the list, but credentials and ids always apply", () => {
    const narrowed = userModelExcludedCategories(["finances", "not-a-category"]);
    expect(narrowed).toEqual(["finances", "government_id", "credentials"]);
    expect(isUserModelSensitive("Prays five times a day", narrowed)).toBe(false);
    expect(isUserModelSensitive("Earns a monthly salary in dollars", narrowed)).toBe(true);
    expect(isUserModelSensitive("Reuses the same password for test accounts", [])).toBe(true);
    expect(isUserModelSensitive("Keeps the passport number in a notes file", [])).toBe(true);
  });

  it("the default config list is the full set", () => {
    expect(userModelExcludedCategories([...USER_MODEL_SENSITIVE_CATEGORIES])).toEqual([...USER_MODEL_SENSITIVE_CATEGORIES]);
  });
});
